import { describe, expect, test } from "bun:test";
import { runWorkflow } from "./engine.js";
import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  HostAgentInfo,
  ProgressEvent,
} from "./types.js";

function fakeAdapter(events: ProgressEvent[]): HostAdapter {
  let n = 0;
  return {
    rootDirectory: "/tmp/wf",
    async runAgent(_req: AgentRequest): Promise<AgentResult> {
      return { text: "ok", tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0, aborted: false, errored: false };
    },
    async createSubSession(): Promise<string> {
      return `s${++n}`;
    },
    async listAgents(): Promise<HostAgentInfo[]> {
      return [];
    },
    report(ev: ProgressEvent): void {
      events.push(ev);
    },
  };
}

const starts = (events: ProgressEvent[]) =>
  events.filter((e): e is Extract<ProgressEvent, { type: "agent-start" }> => e.type === "agent-start");

describe("agent-start group metadata", () => {
  test("top-level agent() carries no group", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await agent("hi", { label: "solo" });`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r1" });
    const s = starts(events).find((e) => e.label === "solo");
    expect(s?.group).toBeUndefined();
  });

  test("parallel children share a groupId, index by position", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await parallel([
        () => agent("a", { label: "p0" }),
        () => agent("b", { label: "p1" }),
      ]);`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r2" });
    const p0 = starts(events).find((e) => e.label === "p0")!;
    const p1 = starts(events).find((e) => e.label === "p1")!;
    expect(p0.group?.kind).toBe("parallel");
    expect(p0.group?.id).toBe(p1.group?.id);
    expect([p0.group?.index, p1.group?.index].sort()).toEqual([0, 1]);
    expect(p0.group?.stageIndex).toBeUndefined();
  });

  test("pipeline stages carry stageIndex and itemIndex within one groupId", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await pipeline([{}],
        (_p, _item, i) => agent("s0", { label: "stage0-" + i }),
        (_p, _item, i) => agent("s1", { label: "stage1-" + i }),
      );`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r3" });
    const s0 = starts(events).find((e) => e.label === "stage0-0")!;
    const s1 = starts(events).find((e) => e.label === "stage1-0")!;
    expect(s0.group?.kind).toBe("pipeline");
    expect(s0.group?.id).toBe(s1.group?.id);
    expect(s0.group?.index).toBe(0);
    expect(s0.group?.stageIndex).toBe(0);
    expect(s1.group?.stageIndex).toBe(1);
  });

  test("parallel nested in a pipeline stage links parentId", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await pipeline([{}],
        (_p, _item, i) => agent("lead", { label: "lead-" + i }),
        () => parallel([ () => agent("x", { label: "child" }) ]),
      );`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r4" });
    const lead = starts(events).find((e) => e.label === "lead-0")!;
    const child = starts(events).find((e) => e.label === "child")!;
    expect(lead.group?.kind).toBe("pipeline");
    expect(child.group?.kind).toBe("parallel");
    expect(child.group?.parentId).toBe(lead.group?.id);
  });

  test("group ids are stable across a re-run (determinism)", async () => {
    const source = `export const meta = { name: "t", description: "d" };
      await parallel([ () => agent("a", { label: "p0" }) ]);`;
    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    await runWorkflow(source, { adapter: fakeAdapter(a), runId: "rA" });
    await runWorkflow(source, { adapter: fakeAdapter(b), runId: "rB" });
    expect(starts(a).find((e) => e.label === "p0")!.group?.id)
      .toBe(starts(b).find((e) => e.label === "p0")!.group?.id);
  });
});
