import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "../src/codex-adapter.js";
import type { CodexEvent, CodexLike, ThreadLike, TurnOptions } from "../src/codex-sdk.js";

// ── Fake helpers ──────────────────────────────────────────────────────────────

/**
 * A scriptable fake thread. Each `runStreamed` call consumes the next sequence
 * from `eventSets`. Returns `Promise<{ events }>` to match the real SDK shape.
 */
function fakeThread(
  eventSets: CodexEvent[][],
  record?: (input: string, opts?: TurnOptions) => void,
): ThreadLike {
  let turn = 0;
  return {
    id: "thr_fake",
    runStreamed(input: string, opts?: TurnOptions): Promise<{ events: AsyncGenerator<CodexEvent> }> {
      record?.(input, opts);
      const seq = eventSets[turn++] ?? [];
      async function* gen(): AsyncGenerator<CodexEvent> {
        for (const e of seq) yield e;
      }
      return Promise.resolve({ events: gen() });
    },
  };
}

/** A fake codex client that returns a fixed thread for both start and resume. */
function fakeCodex(thread: ThreadLike, onStart?: () => void): CodexLike {
  return {
    startThread: () => {
      onStart?.();
      return thread;
    },
    resumeThread: () => thread,
  };
}

const signal = new AbortController().signal;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CodexAdapter", () => {
  test("runAgent returns final agent_message text and turn usage", async () => {
    const thread = fakeThread([
      [
        { type: "thread.started", thread_id: "thr_1" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } },
        {
          type: "turn.completed",
          usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 12, reasoning_output_tokens: 2 },
        },
      ],
    ]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    expect(res.text).toBe("Done.");
    expect(res.tokens).toEqual({ input: 50, output: 12, reasoning: 2 });
    expect(res.errored).toBe(false);
    expect(res.cost).toBe(0);
  });

  test("passes schema as outputSchema in TurnOptions and surfaces structured output", async () => {
    let seenOpts: TurnOptions | undefined;
    const thread = fakeThread(
      [
        [
          {
            type: "item.completed",
            item: { id: "m1", type: "agent_message", text: '{"answer":"x"}' },
          },
          {
            type: "turn.completed",
            usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 },
          },
        ],
      ],
      (_i, opts) => {
        seenOpts = opts;
      },
    );
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal, schema });

    expect(seenOpts?.outputSchema).toEqual(schema);
    expect(res.structured).toEqual({ answer: "x" });
  });

  test("turn.failed marks errored and classifies 429 as retriable", async () => {
    const thread = fakeThread([
      [{ type: "turn.failed", error: { message: "rate limit 429" } }],
    ]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(true);
  });

  test("turn.failed with auth error is classified as terminal (non-retriable)", async () => {
    const thread = fakeThread([
      [{ type: "turn.failed", error: { message: "401 unauthorized" } }],
    ]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(false);
  });

  test("aborted signal yields aborted result without calling runStreamed", async () => {
    const ac = new AbortController();
    ac.abort();
    let runStreamedCalled = false;
    const thread = fakeThread([[]], () => {
      runStreamedCalled = true;
    });
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal: ac.signal });

    expect(res.aborted).toBe(true);
    expect(res.errored).toBe(false);
    expect(runStreamedCalled).toBe(false);
  });

  test("listAgents returns empty array (codex has no named subagents)", async () => {
    const adapter = new CodexAdapter(fakeCodex(fakeThread([])), { rootDirectory: "/repo" });
    expect(await adapter.listAgents()).toEqual([]);
  });

  test("lazy thread start: createSubSession does NOT call startThread; first runAgent does", async () => {
    let startCount = 0;
    const thread = fakeThread([
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      ],
    ]);
    const codex = fakeCodex(thread, () => {
      startCount++;
    });
    const adapter = new CodexAdapter(codex, { rootDirectory: "/repo" });

    // createSubSession must not start a thread
    const sid = await adapter.createSubSession(undefined, "lazy-test");
    expect(startCount).toBe(0);

    // first runAgent starts the thread
    await adapter.runAgent({ sessionId: sid, prompt: "hello", signal });
    expect(startCount).toBe(1);

    // second runAgent on same session reuses — no new startThread
    const thread2 = fakeThread([
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      ],
    ]);
    // We need the second call to reuse the existing thread, so we must use the existing fake
    // The fake thread above has 2 event sets; this checks startCount doesn't grow
    await adapter.runAgent({ sessionId: sid, prompt: "world", signal });
    expect(startCount).toBe(1);
  });

  test("closeSession removes the session from the map", async () => {
    const thread = fakeThread([]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    await adapter.closeSession(sid);
    // After close, runAgent should return an error about unknown session
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });
    expect(res.errored).toBe(true);
  });

  test("error event during stream marks errored as retriable (unknown error)", async () => {
    const thread = fakeThread([
      [{ type: "error", message: "connection reset" }],
    ]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(true);
  });

  test("onTranscript callback is called with translated deltas", async () => {
    const thread = fakeThread([
      [
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Hello!" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 },
        },
      ],
    ]);
    const transcripts: unknown[] = [];
    const adapter = new CodexAdapter(fakeCodex(thread), {
      rootDirectory: "/repo",
      onTranscript: (d) => transcripts.push(d),
    });
    const sid = await adapter.createSubSession(undefined, "t");
    await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    // At least one transcript delta should be emitted for the agent_message
    expect(transcripts.length).toBeGreaterThan(0);
    expect((transcripts[0] as { role: string }).role).toBe("assistant");
  });

  test("model.modelID is passed as ThreadOptions.model at thread start", async () => {
    let capturedModel: string | undefined;
    const thread = fakeThread([
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
        },
      ],
    ]);
    const codex: CodexLike = {
      startThread: (opts) => {
        capturedModel = opts?.model;
        return thread;
      },
      resumeThread: () => thread,
    };
    const adapter = new CodexAdapter(codex, { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    await adapter.runAgent({
      sessionId: sid,
      prompt: "go",
      signal,
      model: { providerID: "openai", modelID: "codex-mini-latest" },
    });
    expect(capturedModel).toBe("codex-mini-latest");
  });

  test("capabilities declares structuredOutput true", () => {
    const adapter = new CodexAdapter(fakeCodex(fakeThread([])), { rootDirectory: "/repo" });
    expect(adapter.capabilities).toEqual({ structuredOutput: true });
  });

  test("report calls onEvent without throwing", () => {
    const events: unknown[] = [];
    const adapter = new CodexAdapter(fakeCodex(fakeThread([])), {
      rootDirectory: "/repo",
      onEvent: (ev) => events.push(ev),
    });
    adapter.report({ type: "log", message: "test log" });
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe("log");
  });

  test("report swallows onEvent exceptions", () => {
    const adapter = new CodexAdapter(fakeCodex(fakeThread([])), {
      rootDirectory: "/repo",
      onEvent: () => {
        throw new Error("tap crash");
      },
    });
    // Must not throw
    expect(() => adapter.report({ type: "log", message: "x" })).not.toThrow();
  });
});
