import { describe, expect, test } from "bun:test";
import type { ProgressEvent } from "@workflow/core";
import { RunRegistry } from "../../src/dashboard/run-registry.js";
import { DashboardServer } from "../../src/dashboard/server.js";
import { TranscriptStore } from "../../src/dashboard/transcript-store.js";

// ── transcript reducer ──────────────────────────────────────────────────────
describe("TranscriptStore", () => {
  test("accumulates messages by last-write-wins per messageId", () => {
    const t = new TranscriptStore();
    t.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "Hello" });
    t.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "Hello world", tokens: 7, cost: 0.02 });
    const msgs = t.get("s1");
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", text: "Hello world", tokens: 7, cost: 0.02 });
  });

  test("keeps message order and isolates sessions", () => {
    const t = new TranscriptStore();
    t.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "first" });
    t.apply({ sessionId: "s1", messageId: "m2", role: "user", text: "second" });
    expect(t.get("s1").map((m) => m.text)).toEqual(["first", "second"]);
    expect(t.get("s2")).toEqual([]);
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
    r.applyTranscript({ sessionId: "s1", messageId: "m", role: "assistant", text: "hi" });
    // unrelated chat session → ignored
    r.applyTranscript({ sessionId: "other", messageId: "m", role: "assistant", text: "spam" });

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
      // Root serves a non-empty body (built SPA or plain build hint).
      const html = await (await fetch(`${url}/`)).text();
      expect(html.length).toBeGreaterThan(0);

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
