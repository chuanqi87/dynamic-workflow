import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunIndex } from "../src/dashboard/run-index.js";
import { RunManager } from "../src/run-manager.js";

async function tmpIndex(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-idx-"));
  return join(dir, "index.jsonl");
}

describe("RunIndex", () => {
  test("last-write-wins per runId, newest first", async () => {
    const path = await tmpIndex();
    const idx = new RunIndex(path);
    idx.record({ runId: "A", name: "a", status: "running", startedAt: 1 });
    idx.record({ runId: "B", name: "b", status: "running", startedAt: 2 });
    idx.record({ runId: "A", name: "a", status: "completed", startedAt: 1, endedAt: 3 });
    await idx.flush();

    const all = await new RunIndex(path).readAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.runId).toBe("B"); // newest startedAt first
    const a = all.find((e) => e.runId === "A")!;
    expect(a.status).toBe("completed");
  });

  test("missing file → empty", async () => {
    const idx = new RunIndex(join(tmpdir(), "does-not-exist-xyz", "index.jsonl"));
    expect(await idx.readAll()).toEqual([]);
  });
});

describe("RunManager", () => {
  test("begin registers a run and returns a cancellable signal", async () => {
    const mgr = new RunManager({ indexPath: await tmpIndex(), now: () => 0 });
    const signal = mgr.begin("R1", "demo", "main-1");
    expect(mgr.registry.get("R1")?.status).toBe("running");
    expect(mgr.isActive("R1")).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(mgr.cancel("R1")).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  test("external signal propagates to the run signal", () => {
    const mgr = new RunManager({ now: () => 0 });
    const ext = new AbortController();
    ext.abort();
    const signal = mgr.begin("R1", "demo", undefined, ext.signal);
    expect(signal.aborted).toBe(true);
  });

  test("finish clears the controller and persists history", async () => {
    const path = await tmpIndex();
    const mgr = new RunManager({ indexPath: path, now: () => 0 });
    mgr.begin("R1", "demo", "main-1");
    mgr.finish("R1", "completed");
    expect(mgr.isActive("R1")).toBe(false);
    expect(mgr.cancel("R1")).toBe(false); // no longer active
    await mgr.flush();
    const history = await mgr.history();
    expect(history.find((e) => e.runId === "R1")?.status).toBe("completed");
  });

  test("finish persists the final result for later retrieval", async () => {
    const path = await tmpIndex();
    const mgr = new RunManager({ indexPath: path, now: () => 0 });
    mgr.begin("R1", "demo", "main-1");
    mgr.finish("R1", "completed", undefined, "the final output");
    await mgr.flush();
    const history = await mgr.history();
    expect(history.find((e) => e.runId === "R1")?.result).toBe("the final output");
  });

  test("ask() pauses and answer() resolves it", async () => {
    const mgr = new RunManager({ now: () => 0 });
    mgr.begin("R1", "demo", "main-1");
    const p = mgr.ask("R1", "proceed?", ["yes", "no"]);
    expect(mgr.registry.get("R1")?.pendingQuestion?.question).toBe("proceed?");
    expect(mgr.answer("R1", "yes")).toBe(true);
    expect(await p).toBe("yes");
    expect(mgr.registry.get("R1")?.pendingQuestion).toBeUndefined();
  });

  test("answer() on a run with no pending question returns false", () => {
    const mgr = new RunManager({ now: () => 0 });
    mgr.begin("R1", "demo", "main-1");
    expect(mgr.answer("R1", "x")).toBe(false);
  });

  test("cancel() unblocks an awaited question with null", async () => {
    const mgr = new RunManager({ now: () => 0 });
    mgr.begin("R1", "demo", "main-1");
    const p = mgr.ask("R1", "proceed?");
    expect(mgr.cancel("R1")).toBe(true);
    expect(await p).toBeNull();
  });

  test("recover flags orphaned 'running' runs as interrupted and imports history", async () => {
    const path = await tmpIndex();
    // Simulate a prior process that crashed mid-run.
    const prior = new RunIndex(path);
    prior.record({ runId: "OLD", name: "old", status: "running", startedAt: 1 });
    await prior.flush();

    const mgr = new RunManager({ indexPath: path, now: () => 99 });
    const orphans = await mgr.recover();
    expect(orphans.map((o) => o.runId)).toContain("OLD");
    // Imported into the live registry as a terminal view.
    expect(mgr.registry.get("OLD")?.status).toBe("interrupted");
    // Persisted as interrupted too.
    await mgr.flush();
    const history = await mgr.history();
    expect(history.find((e) => e.runId === "OLD")?.status).toBe("interrupted");
  });
});
