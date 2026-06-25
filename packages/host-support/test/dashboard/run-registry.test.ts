import { describe, expect, test } from "bun:test";
import type { ProgressEvent } from "@workflow/core";
import { RunRegistry } from "../../src/dashboard/run-registry.js";

const meta = { name: "demo", description: "d" };

describe("RunRegistry progress", () => {
  test("builds the run tree from progress events", () => {
    const reg = new RunRegistry(() => 0);
    reg.startRun("R1", "placeholder", "main-1");
    reg.applyProgress("R1", { type: "run-start", meta, runId: "R1" } as ProgressEvent);
    reg.applyProgress("R1", { type: "phase", title: "Find" });
    reg.applyProgress("R1", { type: "agent-start", label: "scout", phase: "Find", sessionId: "a-1" });
    reg.applyProgress("R1", { type: "agent-done", label: "scout", tokens: 10, cost: 0.01, sessionId: "a-1" });
    reg.applyProgress("R1", { type: "agent-start", label: "bad", phase: "Find", sessionId: "a-2" });
    reg.applyProgress("R1", { type: "agent-null", label: "bad", reason: "x", category: "apiError", sessionId: "a-2" });

    const run = reg.get("R1")!;
    expect(run.name).toBe("demo");
    expect(run.mainSessionId).toBe("main-1");
    expect(run.currentPhase).toBe("Find");
    expect(run.agents).toHaveLength(2);
    expect(run.agents[0]).toMatchObject({ label: "scout", status: "done", tokens: 10, sessionId: "a-1" });
    expect(run.agents[1]).toMatchObject({ label: "bad", status: "null", nullReason: "apiError" });
  });

  test("retry updates status and count", () => {
    const reg = new RunRegistry(() => 0);
    reg.startRun("R1", "demo", "main-1");
    reg.applyProgress("R1", { type: "agent-start", label: "x", sessionId: "a-1" });
    reg.applyProgress("R1", { type: "agent-retry", label: "x", attempt: 2, reason: "503", sessionId: "a-1" });
    expect(reg.get("R1")!.agents[0]).toMatchObject({ status: "retrying", retries: 2 });
  });
});

describe("RunRegistry transcripts", () => {
  test("stores transcripts only for sessions belonging to a run", () => {
    const reg = new RunRegistry(() => 0);
    reg.startRun("R1", "demo", "main-1");
    reg.applyProgress("R1", { type: "agent-start", label: "x", sessionId: "a-1" });

    reg.applyTranscript({ sessionId: "a-1", messageId: "M1", role: "assistant", text: "hi" }); // known agent session → stored
    reg.applyTranscript({ sessionId: "unrelated", messageId: "M1", role: "assistant", text: "hi" }); // unknown → ignored

    expect(reg.transcript("a-1").map((m) => m.text)).toEqual(["hi"]);
    expect(reg.transcript("unrelated")).toEqual([]);
  });

  test("notifies listeners on run and session changes", () => {
    const reg = new RunRegistry(() => 0);
    const seen: string[] = [];
    reg.on((c) => seen.push(c.kind));
    reg.startRun("R1", "demo", "main-1");
    reg.applyTranscript({ sessionId: "main-1", messageId: "M1", role: "assistant", text: "hello" });
    expect(seen).toContain("run");
    expect(seen).toContain("session");
  });
});
