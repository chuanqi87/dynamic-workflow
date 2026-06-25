import { describe, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { AgentRequest } from "@workflow/core";
import { OpencodeAdapter } from "./opencode-adapter.js";

interface FakeBehaviour {
  promptData?: unknown;
  promptError?: unknown;
  prompt?: (opts: unknown) => Promise<{ data?: unknown; error?: unknown }>;
  agents?: unknown[];
  /** Assistant messages returned by session.messages (for cost summation). */
  messages?: unknown[];
}

function fakeClient(b: FakeBehaviour): { client: OpencodeClient; aborted: string[] } {
  const aborted: string[] = [];
  const client = {
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      prompt:
        b.prompt ??
        (async () => ({ data: b.promptData, error: b.promptError })),
      messages: async () => ({ data: b.messages ?? [] }),
      abort: async (opts: { path: { id: string } }) => {
        aborted.push(opts.path.id);
        return { data: true };
      },
    },
    app: { agents: async () => ({ data: b.agents ?? [] }) },
    tui: { showToast: async () => ({ data: true }) },
  } as unknown as OpencodeClient;
  return { client, aborted };
}

const baseReq = (over: Partial<AgentRequest> = {}): AgentRequest => ({
  sessionId: "sess-1",
  prompt: "hi",
  signal: new AbortController().signal,
  ...over,
});

const okData = {
  info: { tokens: { input: 5, output: 12, reasoning: 1 }, cost: 0.01, error: null },
  parts: [
    { type: "text", text: "Hello " },
    { type: "tool", text: "ignored" },
    { type: "text", text: "world" },
  ],
};

describe("OpencodeAdapter.runAgent", () => {
  test("joins text parts and maps tokens/cost", async () => {
    const { client } = fakeClient({ promptData: okData });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const res = await adapter.runAgent(baseReq());
    expect(res.text).toBe("Hello world");
    expect(res.tokens).toEqual({ input: 5, output: 12, reasoning: 1 });
    expect(res.cost).toBe(0.01);
    expect(res.errored).toBe(false);
    expect(res.aborted).toBe(false);
  });

  test("flags errored when info.error is set", async () => {
    const { client } = fakeClient({
      promptData: { ...okData, info: { ...okData.info, error: { name: "ApiError" } } },
    });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const res = await adapter.runAgent(baseReq());
    expect(res.errored).toBe(true);
  });

  test("flags errored when the response has no data", async () => {
    const { client } = fakeClient({ promptData: undefined, promptError: { msg: "boom" } });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const res = await adapter.runAgent(baseReq());
    expect(res.errored).toBe(true);
    expect(res.text).toBe("");
  });

  test("returns immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const { client } = fakeClient({
      prompt: async () => {
        called = true;
        return { data: okData };
      },
    });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const res = await adapter.runAgent(baseReq({ signal: ac.signal }));
    expect(res.aborted).toBe(true);
    expect(called).toBe(false);
  });

  test("aborts an in-flight prompt and calls session.abort", async () => {
    const ac = new AbortController();
    const { client, aborted } = fakeClient({
      prompt: () => new Promise(() => {}), // never resolves
    });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const p = adapter.runAgent(baseReq({ signal: ac.signal }));
    ac.abort();
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(aborted).toContain("sess-1");
  });

  test("respects per-call timeout", async () => {
    const { client } = fakeClient({ prompt: () => new Promise(() => {}) });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const res = await adapter.runAgent(baseReq({ timeoutMs: 20 }));
    expect(res.aborted).toBe(true);
  });
});

describe("OpencodeAdapter.listAgents", () => {
  test("maps the agents response", async () => {
    const { client } = fakeClient({
      agents: [{ name: "explore", mode: "subagent", model: { providerID: "p", modelID: "m" } }],
    });
    const adapter = new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });
    const agents = await adapter.listAgents();
    expect(agents).toEqual([{ name: "explore", mode: "subagent", model: { providerID: "p", modelID: "m" } }]);
  });
});

const makeAdapter = (client: OpencodeClient) =>
  new OpencodeAdapter(client, { rootDirectory: "/r", toast: false, logStream: { write() {} } });

const withError = (error: unknown) => ({
  info: { tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0, error },
  parts: [],
});

describe("OpencodeAdapter error classification (P0-1)", () => {
  test("APIError isRetryable=true → retriable", async () => {
    const { client } = fakeClient({ promptData: withError({ name: "APIError", data: { message: "x", isRetryable: true } }) });
    const res = await makeAdapter(client).runAgent(baseReq());
    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(true);
  });

  test("APIError isRetryable=false → terminal", async () => {
    const { client } = fakeClient({ promptData: withError({ name: "APIError", data: { message: "x", isRetryable: false } }) });
    const res = await makeAdapter(client).runAgent(baseReq());
    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(false);
  });

  test("ProviderAuthError → terminal (not retriable)", async () => {
    const { client } = fakeClient({ promptData: withError({ name: "ProviderAuthError", data: { providerID: "p", message: "no auth" } }) });
    const res = await makeAdapter(client).runAgent(baseReq());
    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(false);
  });

  test("MessageAbortedError → aborted (not errored)", async () => {
    const { client } = fakeClient({ promptData: withError({ name: "MessageAbortedError", data: { message: "stopped" } }) });
    const res = await makeAdapter(client).runAgent(baseReq());
    expect(res.aborted).toBe(true);
    expect(res.errored).toBe(false);
  });

  test("transport error (no data) defaults to retriable", async () => {
    const { client } = fakeClient({ promptData: undefined, promptError: new Error("ECONNRESET") });
    const res = await makeAdapter(client).runAgent(baseReq());
    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(true);
  });
});

describe("OpencodeAdapter cost/token summation (P1-7)", () => {
  test("sums tokens and cost across all assistant messages of the turn", async () => {
    const { client } = fakeClient({
      promptData: okData,
      messages: [
        { info: { role: "assistant", tokens: { input: 1, output: 10, reasoning: 0 }, cost: 0.05 } },
        { info: { role: "user", tokens: { input: 2, output: 0, reasoning: 0 }, cost: 0 } },
        { info: { role: "assistant", tokens: { input: 1, output: 10, reasoning: 1 }, cost: 0.05 } },
      ],
    });
    const res = await makeAdapter(client).runAgent(baseReq());
    expect(res.tokens.output).toBe(20);
    expect(res.cost).toBeCloseTo(0.1, 5);
  });
});

describe("OpencodeAdapter.closeSession (P1-5)", () => {
  test("aborts the session", async () => {
    const { client, aborted } = fakeClient({});
    await makeAdapter(client).closeSession("sess-9");
    expect(aborted).toContain("sess-9");
  });
});
