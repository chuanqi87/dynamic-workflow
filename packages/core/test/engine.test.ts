import { describe, expect, test } from "bun:test";
import { runWorkflow } from "../src/engine.js";
import type { AgentRequest, AgentResult, HostAdapter } from "../src/types.js";

interface MockReply {
  text?: string;
  outputTokens?: number;
  errored?: boolean;
  aborted?: boolean;
  /** Host-native structured output payload. */
  structured?: unknown;
  /** Simulate a host that rejects the native `format` field. */
  formatUnsupported?: boolean;
}

class MockAdapter implements HostAdapter {
  readonly rootDirectory = "/tmp/wf-test";
  readonly calls: AgentRequest[] = [];
  readonly capabilities?: { structuredOutput?: boolean };
  private sessionSeq = 0;

  constructor(
    private readonly responder: (req: AgentRequest) => MockReply,
    capabilities?: { structuredOutput?: boolean },
  ) {
    this.capabilities = capabilities;
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const r = this.responder(req);
    return {
      text: r.text ?? "",
      tokens: { input: 0, output: r.outputTokens ?? 10, reasoning: 0 },
      cost: 0,
      aborted: r.aborted ?? false,
      errored: r.errored ?? false,
      ...(r.structured !== undefined ? { structured: r.structured } : {}),
      ...(r.formatUnsupported ? { formatUnsupported: true } : {}),
    };
  }
  async createSubSession(): Promise<string> {
    return `sess-${++this.sessionSeq}`;
  }
  async listAgents(): Promise<[]> {
    return [];
  }
  report(): void {}
}

const run = (source: string, adapter: HostAdapter, config = {}) =>
  runWorkflow(source, { adapter, runId: "test-run", config });

describe("runWorkflow", () => {
  test("returns a basic agent result", async () => {
    const adapter = new MockAdapter(() => ({ text: "hello world" }));
    const src = `export const meta = { name: "basic", description: "d" };
const greeting = await agent("say hi");
return { greeting };`;
    const { result } = await run(src, adapter);
    expect(result).toEqual({ greeting: "hello world" });
    expect(adapter.calls.length).toBe(1);
  });

  test("parallel degrades a throwing thunk to null", async () => {
    const adapter = new MockAdapter((req) => ({ text: req.prompt }));
    const src = `export const meta = { name: "par", description: "d" };
return await parallel([
  () => agent("a"),
  () => { throw new Error("boom"); },
  () => agent("c"),
]);`;
    const { result } = await run(src, adapter);
    expect(result).toEqual(["a", null, "c"]);
  });

  test("pipeline threads stages and isolates failures", async () => {
    const adapter = new MockAdapter((req) => ({ text: req.prompt.toUpperCase() }));
    const src = `export const meta = { name: "pipe", description: "d" };
return await pipeline(
  ["x", "y"],
  (prev, item) => agent(item),
  (prev) => agent(prev + "!"),
);`;
    const { result } = await run(src, adapter);
    // stage1("x") -> "X"; stage2("X!") -> "X!" upper => "X!"
    expect(result).toEqual(["X!", "Y!"]);
  });

  test("schema-constrained agent returns a validated object", async () => {
    const adapter = new MockAdapter(() => ({
      text: '```json\n{"verdict": "real", "score": 8}\n```',
    }));
    const src = `export const meta = { name: "schema", description: "d" };
return await agent("judge", { schema: {
  type: "object",
  properties: { verdict: { type: "string" }, score: { type: "number" } },
  required: ["verdict", "score"],
} });`;
    const { result } = await run(src, adapter);
    expect(result).toEqual({ verdict: "real", score: 8 });
  });

  const schemaSrc = `export const meta = { name: "schema", description: "d" };
return await agent("judge", { schema: {
  type: "object",
  properties: { verdict: { type: "string" }, score: { type: "number" } },
  required: ["verdict", "score"],
} });`;

  test("native structured output: returns the host's structured object (no JSON in text)", async () => {
    const adapter = new MockAdapter(
      () => ({ text: "", structured: { verdict: "real", score: 9 } }),
      { structuredOutput: true },
    );
    const { result } = await run(schemaSrc, adapter);
    expect(result).toEqual({ verdict: "real", score: 9 });
    // The schema must have been forwarded to the host for native enforcement.
    expect(adapter.calls[0]!.schema).toBeDefined();
  });

  test("native structured output: ajv safety net rejects an invalid structured payload", async () => {
    // Host claims native support but returns an object missing `score`.
    const adapter = new MockAdapter(
      () => ({ text: "", structured: { verdict: "real" } }),
      { structuredOutput: true },
    );
    const { result } = await run(schemaSrc, adapter);
    expect(result).toBeNull();
  });

  test("native structured output: an invalid native payload falls through to envelope retries", async () => {
    let calls = 0;
    const adapter = new MockAdapter(
      (req) => {
        calls++;
        // Native attempt (carries schema) returns an object that fails ajv;
        // the envelope retry (no schema) returns valid JSON text.
        if (req.schema) return { text: "", structured: { verdict: "real" } };
        return { text: '```json\n{"verdict": "real", "score": 6}\n```' };
      },
      { structuredOutput: true },
    );
    const { result } = await run(schemaSrc, adapter);
    expect(result).toEqual({ verdict: "real", score: 6 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("native structured output: formatUnsupported falls back to the prompt-envelope path", async () => {
    let calls = 0;
    const adapter = new MockAdapter(
      () => {
        calls++;
        // First (native) attempt is rejected; the envelope retry returns JSON text.
        if (calls === 1) return { formatUnsupported: true };
        return { text: '```json\n{"verdict": "real", "score": 7}\n```' };
      },
      { structuredOutput: true },
    );
    const { result } = await run(schemaSrc, adapter);
    expect(result).toEqual({ verdict: "real", score: 7 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("budget exhaustion throws by default (hard ceiling)", async () => {
    const adapter = new MockAdapter(() => ({ text: "ok", outputTokens: 10 }));
    const src = `export const meta = { name: "bud", description: "d" };
const first = await agent("one");
const second = await agent("two");
return { first, second };`;
    await expect(run(src, adapter, { budgetTotal: 5 })).rejects.toThrow(/budget/i);
    expect(adapter.calls.length).toBe(1); // second never reaches the host
  });

  test("budget exhaustion degrades to null when budgetMode is 'degrade'", async () => {
    const adapter = new MockAdapter(() => ({ text: "ok", outputTokens: 10 }));
    const src = `export const meta = { name: "bud", description: "d" };
const first = await agent("one");
const second = await agent("two");
return { first, second };`;
    const { result } = await run(src, adapter, { budgetTotal: 5, budgetMode: "degrade" });
    expect(result).toEqual({ first: "ok", second: null });
    expect(adapter.calls.length).toBe(1);
  });

  test("identical (prompt, opts) is cached within a run", async () => {
    const adapter = new MockAdapter((req) => ({ text: req.prompt }));
    const src = `export const meta = { name: "cache", description: "d" };
const a = await agent("same");
const b = await agent("same");
return { a, b };`;
    const { result } = await run(src, adapter);
    expect(result).toEqual({ a: "same", b: "same" });
    expect(adapter.calls.length).toBe(1);
  });

  test("host error degrades the call to null", async () => {
    const adapter = new MockAdapter(() => ({ errored: true, text: "" }));
    const src = `export const meta = { name: "err", description: "d" };
return await agent("will fail");`;
    const { result } = await run(src, adapter);
    expect(result).toBeNull();
  });

  test("rejects an invalid script before running", async () => {
    const adapter = new MockAdapter(() => ({ text: "x" }));
    const src = `export const meta = { name: "bad", description: "d" };
return Math.random();`;
    await expect(run(src, adapter)).rejects.toThrow(/validation/i);
  });
});
