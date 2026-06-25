import { describe, expect, test } from "bun:test";
import { runWorkflow } from "./engine.js";
import type { AgentRequest, AgentResult, HostAdapter, JournalSink, ProgressEvent } from "./types.js";

class MemSink implements JournalSink {
  lines: string[] = [];
  append(line: string): void {
    this.lines.push(line);
  }
  async flush(): Promise<void> {}
  text(): string {
    return this.lines.join("\n");
  }
}

class CountingAdapter implements HostAdapter {
  readonly rootDirectory = "/tmp/resume";
  calls = 0;
  private seq = 0;
  async runAgent(req: AgentRequest): Promise<AgentResult> {
    this.calls++;
    return {
      text: `echo:${req.prompt}`,
      tokens: { input: 0, output: 1, reasoning: 0 },
      cost: 0,
      aborted: false,
      errored: false,
    };
  }
  async createSubSession(): Promise<string> {
    return `s-${++this.seq}`;
  }
  async listAgents(): Promise<[]> {
    return [];
  }
  report(_ev: ProgressEvent): void {}
}

const cfg = { sleep: async () => {}, rng: () => 0, now: () => 0 };

describe("P0-3 cross-run resume (keyed)", () => {
  const TWO = `export const meta = { name: "r", description: "d" };
const a = await agent("alpha");
const b = await agent("beta");
return { a, b };`;

  test("a second run with the prior journal reuses all cached results", async () => {
    const sink = new MemSink();
    const a1 = new CountingAdapter();
    const first = await runWorkflow(TWO, { adapter: a1, runId: "run-1", journalSink: sink, config: cfg });
    expect(a1.calls).toBe(2);

    const a2 = new CountingAdapter();
    const second = await runWorkflow(TWO, {
      adapter: a2,
      runId: "run-2",
      config: { ...cfg, resumeFromRunId: "run-1", journalSource: () => sink.text() },
    });
    expect(second.result).toEqual(first.result);
    expect(a2.calls).toBe(0); // everything served from the prior journal
  });

  test("only changed agent() calls run live on resume", async () => {
    const sink = new MemSink();
    const a1 = new CountingAdapter();
    await runWorkflow(TWO, { adapter: a1, runId: "run-1", journalSink: sink, config: cfg });

    const CHANGED = `export const meta = { name: "r", description: "d" };
const a = await agent("alpha");
const b = await agent("BETA-CHANGED");
return { a, b };`;
    const a2 = new CountingAdapter();
    const second = await runWorkflow(CHANGED, {
      adapter: a2,
      runId: "run-2",
      config: { ...cfg, resumeFromRunId: "run-1", journalSource: () => sink.text() },
    });
    expect(a2.calls).toBe(1); // only the changed prompt re-runs
    expect(second.result).toEqual({ a: "echo:alpha", b: "echo:BETA-CHANGED" });
  });

  test("a corrupted/missing journal degrades to a fresh run", async () => {
    const a2 = new CountingAdapter();
    const out = await runWorkflow(TWO, {
      adapter: a2,
      runId: "run-2",
      config: { ...cfg, resumeFromRunId: "missing", journalSource: () => "{not json\n<garbage>" },
    });
    expect(a2.calls).toBe(2); // ran fresh, no crash
    expect(out.result).toEqual({ a: "echo:alpha", b: "echo:beta" });
  });

  test("prefix mode: a changed early call invalidates later cached calls", async () => {
    // Run 1: three sequential agents.
    const THREE = `export const meta = { name: "r", description: "d" };
const a = await agent("alpha");
const b = await agent("beta");
const c = await agent("gamma");
return { a, b, c };`;
    const sink = new MemSink();
    const a1 = new CountingAdapter();
    await runWorkflow(THREE, { adapter: a1, runId: "run-1", journalSink: sink, config: cfg });
    expect(a1.calls).toBe(3);

    // Run 2 (prefix): change the FIRST agent. Even though beta/gamma prompts are
    // unchanged, prefix mode reruns everything from the first mismatch.
    const CHANGED_FIRST = `export const meta = { name: "r", description: "d" };
const a = await agent("ALPHA-CHANGED");
const b = await agent("beta");
const c = await agent("gamma");
return { a, b, c };`;
    const a2 = new CountingAdapter();
    await runWorkflow(CHANGED_FIRST, {
      adapter: a2,
      runId: "run-2",
      config: { ...cfg, resumeFromRunId: "run-1", journalSource: () => sink.text(), replay: "prefix" },
    });
    expect(a2.calls).toBe(3); // all live (keyed mode would have reused beta+gamma)
  });

  test("prefix mode: unchanged prefix is reused, tail runs live", async () => {
    const THREE = `export const meta = { name: "r", description: "d" };
const a = await agent("alpha");
const b = await agent("beta");
const c = await agent("gamma");
return { a, b, c };`;
    const sink = new MemSink();
    await runWorkflow(THREE, { adapter: new CountingAdapter(), runId: "run-1", journalSink: sink, config: cfg });

    const CHANGED_LAST = `export const meta = { name: "r", description: "d" };
const a = await agent("alpha");
const b = await agent("beta");
const c = await agent("GAMMA-CHANGED");
return { a, b, c };`;
    const a2 = new CountingAdapter();
    await runWorkflow(CHANGED_LAST, {
      adapter: a2,
      runId: "run-2",
      config: { ...cfg, resumeFromRunId: "run-1", journalSource: () => sink.text(), replay: "prefix" },
    });
    expect(a2.calls).toBe(1); // alpha+beta reused, only gamma reruns
  });

  test("failed (null) results are NOT seeded, so they re-run on resume", async () => {
    // First run: second agent fails terminally → null, not journaled as success.
    const sink = new MemSink();
    class FlakyAdapter extends CountingAdapter {
      override async runAgent(req: AgentRequest): Promise<AgentResult> {
        this.calls++;
        if (req.prompt === "beta") {
          return { text: "", tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0, aborted: false, errored: true, retriable: false };
        }
        return { text: `echo:${req.prompt}`, tokens: { input: 0, output: 1, reasoning: 0 }, cost: 0, aborted: false, errored: false };
      }
    }
    const a1 = new FlakyAdapter();
    await runWorkflow(TWO, { adapter: a1, runId: "run-1", journalSink: sink, config: cfg });

    // Second run: beta now succeeds; resume should re-run beta (was null) but reuse alpha.
    const a2 = new CountingAdapter();
    const second = await runWorkflow(TWO, {
      adapter: a2,
      runId: "run-2",
      config: { ...cfg, resumeFromRunId: "run-1", journalSource: () => sink.text() },
    });
    expect(a2.calls).toBe(1); // alpha cached, beta re-runs
    expect(second.result).toEqual({ a: "echo:alpha", b: "echo:beta" });
  });
});
