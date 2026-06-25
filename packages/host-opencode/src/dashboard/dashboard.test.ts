import { describe, expect, test } from "bun:test";
import type { ProgressEvent } from "@workflow/core";
import { RunRegistry } from "./run-registry.js";
import { DashboardServer } from "./server.js";
import { eventSessionId, TranscriptStore } from "./transcript.js";

// ── transcript reducer ──────────────────────────────────────────────────────
describe("TranscriptStore", () => {
  test("reduces part + message events into an ordered transcript", () => {
    const t = new TranscriptStore();
    t.apply({ type: "message.part.updated", properties: { part: { sessionID: "s1", messageID: "m1", id: "p1", type: "text", text: "Hello" } } });
    t.apply({ type: "message.part.updated", properties: { part: { sessionID: "s1", messageID: "m1", id: "p1", type: "text", text: "Hello world" } } });
    t.apply({ type: "message.updated", properties: { info: { id: "m1", sessionID: "s1", role: "assistant", cost: 0.02, tokens: { output: 7 } } } });
    const msgs = t.get("s1");
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", text: "Hello world", tokens: 7, cost: 0.02 });
  });

  test("keeps message order and isolates sessions", () => {
    const t = new TranscriptStore();
    t.apply({ type: "message.part.updated", properties: { part: { sessionID: "s1", messageID: "m1", id: "p", type: "text", text: "first" } } });
    t.apply({ type: "message.part.updated", properties: { part: { sessionID: "s1", messageID: "m2", id: "p", type: "text", text: "second" } } });
    expect(t.get("s1").map((m) => m.text)).toEqual(["first", "second"]);
    expect(t.get("s2")).toEqual([]);
  });

  test("eventSessionId peeks without mutating", () => {
    expect(eventSessionId({ type: "message.updated", properties: { info: { sessionID: "x" } } })).toBe("x");
    expect(eventSessionId({ type: "something.else" })).toBeUndefined();
  });
});

// ── registry ────────────────────────────────────────────────────────────────
const ev = <T extends ProgressEvent>(e: T): T => e;

describe("RunRegistry", () => {
  test("builds a run view from progress events", () => {
    const r = new RunRegistry(() => 0);
    r.startRun("run-1", "demo", "main-1");
    r.applyProgress("run-1", ev({ type: "phase", title: "Find" }));
    r.applyProgress("run-1", ev({ type: "agent-start", label: "a", phase: "Find", sessionId: "s1" }));
    r.applyProgress("run-1", ev({ type: "agent-done", label: "a", tokens: 12, cost: 0.01, sessionId: "s1" }));
    r.applyProgress("run-1", ev({ type: "agent-start", label: "b", sessionId: "s2" }));
    r.applyProgress("run-1", ev({ type: "agent-null", label: "b", reason: "x", category: "apiError", sessionId: "s2" }));
    r.applyProgress("run-1", ev({ type: "run-end", ok: true, spent: 12, agents: 2 }));

    const run = r.get("run-1")!;
    expect(run.mainSessionId).toBe("main-1");
    expect(run.phases).toEqual(["Find"]);
    expect(run.status).toBe("completed");
    expect(run.agents).toHaveLength(2);
    expect(run.agents[0]).toMatchObject({ label: "a", status: "done", tokens: 12 });
    expect(run.agents[1]).toMatchObject({ label: "b", status: "null", nullReason: "apiError" });
  });

  test("only captures transcripts for sessions belonging to a run", () => {
    const r = new RunRegistry(() => 0);
    const seen: string[] = [];
    r.on((c) => c.kind === "session" && seen.push(c.sessionId));
    r.startRun("run-1", "demo", "main-1");
    r.applyProgress("run-1", ev({ type: "agent-start", label: "a", sessionId: "s1" }));

    // belongs to the run → captured + notified
    r.applyOpencodeEvent({ type: "message.part.updated", properties: { part: { sessionID: "s1", messageID: "m", id: "p", type: "text", text: "hi" } } });
    // unrelated chat session → ignored
    r.applyOpencodeEvent({ type: "message.part.updated", properties: { part: { sessionID: "other", messageID: "m", id: "p", type: "text", text: "spam" } } });

    expect(r.transcript("s1").map((m) => m.text)).toEqual(["hi"]);
    expect(r.transcript("other")).toEqual([]);
    expect(seen).toEqual(["s1"]);
  });

  test("captures agent group metadata from agent-start", () => {
    const r = new RunRegistry(() => 0);
    r.startRun("run-1", "demo", "main-1");
    r.applyProgress(
      "run-1",
      ev({
        type: "agent-start",
        label: "p0",
        sessionId: "s1",
        group: { id: "g1", kind: "parallel", index: 0 },
      }),
    );
    expect(r.get("run-1")!.agents[0]!.group).toEqual({ id: "g1", kind: "parallel", index: 0 });
  });
});

// ── server smoke ────────────────────────────────────────────────────────────
describe("DashboardServer", () => {
  test("serves the UI and a live run list", async () => {
    const server = new DashboardServer(new RunRegistry(() => 0));
    const url = await server.ensureStarted(41987);
    try {
      const html = await (await fetch(`${url}/`)).text();
      expect(html).toContain("Workflow Dashboard");

      expect(await (await fetch(`${url}/api/runs`)).json()).toEqual([]);

      server.registry.startRun("run-1", "demo", "main-1");
      const runs = (await (await fetch(`${url}/api/runs`)).json()) as Array<{ runId: string }>;
      expect(runs.map((r) => r.runId)).toEqual(["run-1"]);

      const notFound = await fetch(`${url}/api/runs/nope`);
      expect(notFound.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
