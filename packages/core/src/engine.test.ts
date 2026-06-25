import { describe, expect, test } from "bun:test";
import { runWorkflow } from "./engine.js";
import type { AgentRequest, AgentResult, HostAdapter } from "./types.js";

interface MockReply {
  text?: string;
  outputTokens?: number;
  errored?: boolean;
  aborted?: boolean;
}

class MockAdapter implements HostAdapter {
  readonly rootDirectory = "/tmp/wf-test";
  readonly calls: AgentRequest[] = [];
  private sessionSeq = 0;

  constructor(private readonly responder: (req: AgentRequest) => MockReply) {}

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    this.calls.push(req);
    const r = this.responder(req);
    return {
      text: r.text ?? "",
      tokens: { input: 0, output: r.outputTokens ?? 10, reasoning: 0 },
      cost: 0,
      aborted: r.aborted ?? false,
      errored: r.errored ?? false,
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
