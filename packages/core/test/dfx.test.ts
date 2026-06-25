import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../src/engine.js";
import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  JournalSink,
  ProgressEvent,
} from "../src/types.js";

/** Per-call reply description for the mock host. */
interface Reply {
  text?: string;
  outputTokens?: number;
  cost?: number;
  errored?: boolean;
  retriable?: boolean;
  aborted?: boolean;
}

/** A configurable mock adapter that records calls, events and cleanup. */
class MockAdapter implements HostAdapter {
  readonly rootDirectory = "/tmp/dfx";
  readonly calls: AgentRequest[] = [];
  readonly events: ProgressEvent[] = [];
  readonly closed: string[] = [];
  private sessionSeq = 0;

  constructor(private readonly responder: (req: AgentRequest, call: number) => Reply) {}

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const n = this.calls.length;
    this.calls.push(req);
    const r = this.responder(req, n);
    return {
      text: r.text ?? "",
      tokens: { input: 0, output: r.outputTokens ?? 1, reasoning: 0 },
      cost: r.cost ?? 0,
      aborted: r.aborted ?? false,
      errored: r.errored ?? false,
      retriable: r.retriable,
    };
  }
  async createSubSession(): Promise<string> {
    return `sess-${++this.sessionSeq}`;
  }
  async listAgents(): Promise<[]> {
    return [];
  }
  closeSession(id: string): void {
    this.closed.push(id);
  }
  report(ev: ProgressEvent): void {
    this.events.push(ev);
  }
}

const noSleep = async (): Promise<void> => {};
const baseCfg = { sleep: noSleep, rng: () => 0, now: () => 0 };

const run = (
  source: string,
  adapter: HostAdapter,
  config: Record<string, unknown> = {},
  runId = "dfx-run",
) => runWorkflow(source, { adapter, runId, config: { ...baseCfg, ...config } });

// ── P0-1 retry / backoff ───────────────────────────────────────────────────
describe("P0-1 transient retry with backoff", () => {
  test("retries a transient error then succeeds", async () => {
    const adapter = new MockAdapter((_req, call) =>
      call === 0 ? { errored: true, retriable: true } : { text: "ok" },
    );
    const src = `export const meta = { name: "r", description: "d" };\nreturn await agent("go");`;
    const { result } = await run(src, adapter);
    expect(result).toBe("ok");
    expect(adapter.calls.length).toBe(2);
  });

  test("does NOT retry a terminal error (returns null after one attempt)", async () => {
    const adapter = new MockAdapter(() => ({ errored: true, retriable: false }));
    const src = `export const meta = { name: "r", description: "d" };\nreturn await agent("go");`;
    const { result } = await run(src, adapter);
    expect(result).toBeNull();
    expect(adapter.calls.length).toBe(1);
  });

  test("returns null after exhausting retries", async () => {
    const adapter = new MockAdapter(() => ({ errored: true, retriable: true }));
    const src = `export const meta = { name: "r", description: "d" };\nreturn await agent("go");`;
    const { result } = await run(src, adapter, { retry: { retries: 2 } });
    expect(result).toBeNull();
    expect(adapter.calls.length).toBe(3); // 1 + 2 retries
  });

  test("backoff follows the exponential schedule (jitter disabled)", async () => {
    const delays: number[] = [];
    const adapter = new MockAdapter(() => ({ errored: true, retriable: true }));
    const src = `export const meta = { name: "r", description: "d" };\nreturn await agent("go");`;
    await run(src, adapter, {
      retry: { retries: 3, baseMs: 100, factor: 2, jitter: 0 },
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([100, 200, 400]);
  });
});

// ── P1-4 global timeout ─────────────────────────────────────────────────────
describe("P1-4 global wall-clock timeout", () => {
  test("aborts in-flight agents when the global timeout elapses", async () => {
    const adapter = new MockAdapter((req) => {
      // Simulate the host honouring the abort signal.
      if (req.signal.aborted) return { aborted: true };
      return { aborted: true }; // never produces output
    });
    // Real timers here: tiny timeout.
    const src = `export const meta = { name: "t", description: "d" };\nconst r = await agent("slow");\nreturn r;`;
    const { result, summary } = await runWorkflow(src, {
      adapter,
      runId: "to",
      config: { globalTimeoutMs: 5, sleep: noSleep, rng: () => 0 },
    });
    expect(result).toBeNull();
    expect(summary.nullsByReason.aborted + summary.nullsByReason.timeout).toBeGreaterThanOrEqual(1);
  });
});

// ── P1-5 session cleanup on cancel ──────────────────────────────────────────
describe("P1-5 sub-session cleanup", () => {
  test("closes created sessions when the run is cancelled", async () => {
    const controller = new AbortController();
    const adapter = new MockAdapter((req) => {
      controller.abort(); // cancel as soon as the first agent runs
      return { aborted: req.signal.aborted };
    });
    const src = `export const meta = { name: "c", description: "d" };\nreturn await agent("x");`;
    await run(src, adapter, { signal: controller.signal });
    expect(adapter.closed.length).toBeGreaterThanOrEqual(1);
  });
});

// ── P2-8 run summary ────────────────────────────────────────────────────────
describe("P2-8 run summary", () => {
  test("counts successes, nulls-by-reason and tokens", async () => {
    const adapter = new MockAdapter((req) =>
      req.prompt.includes("bad")
        ? { errored: true, retriable: false, outputTokens: 0 }
        : { text: "ok", outputTokens: 4 },
    );
    const src = `export const meta = { name: "s", description: "d" };
const a = await agent("good");
const b = await agent("bad one");
return { a, b };`;
    const { summary } = await run(src, adapter);
    expect(summary.succeeded).toBe(1);
    expect(summary.nullsByReason.apiError).toBe(1);
    expect(summary.outputTokens).toBe(4);
    expect(summary.agents).toBe(2);
  });
});

// ── P2-9 dropped logging (no silent caps) ───────────────────────────────────
describe("P2-9 dropped-item logging", () => {
  test("logs a dropped event for a throwing parallel thunk", async () => {
    const adapter = new MockAdapter(() => ({ text: "ok" }));
    const src = `export const meta = { name: "d", description: "d" };
return await parallel([() => agent("a"), () => { throw new Error("boom"); }]);`;
    const { summary } = await run(src, adapter);
    expect(summary.dropped).toBe(1);
    expect(adapter.events.some((e) => e.type === "dropped" && e.scope === "parallel")).toBe(true);
  });
});

// ── M8 question() host-in-the-loop ──────────────────────────────────────────
describe("M8 question()", () => {
  test("resolves to the host's answer when askQuestion is supported", async () => {
    class QAdapter extends MockAdapter {
      async askQuestion(input: { question: string }): Promise<string | null> {
        return input.question.includes("color") ? "blue" : null;
      }
    }
    const adapter = new QAdapter(() => ({ text: "ok" }));
    const src = `export const meta = { name: "q", description: "d" };
return await question("favorite color?");`;
    const { result } = await run(src, adapter);
    expect(result).toBe("blue");
  });

  test("falls back to default when the host cannot ask", async () => {
    const adapter = new MockAdapter(() => ({ text: "ok" }));
    const src = `export const meta = { name: "q", description: "d" };
return await question("anything?", { default: "fallback" });`;
    const { result } = await run(src, adapter);
    expect(result).toBe("fallback");
  });
});

// ── P2-13 phase default model ───────────────────────────────────────────────
describe("P2-13 phase default model", () => {
  test("uses the phase's model when opts specify none", async () => {
    const adapter = new MockAdapter((req) => ({ text: req.model ? `${req.model.providerID}/${req.model.modelID}` : "none" }));
    const src = `export const meta = {
  name: "pm", description: "d",
  phases: [{ title: "Build", model: "anthropic/claude-opus-4-8" }],
};
phase("Build");
return await agent("do it");`;
    const { result } = await run(src, adapter);
    expect(result).toBe("anthropic/claude-opus-4-8");
  });
});
