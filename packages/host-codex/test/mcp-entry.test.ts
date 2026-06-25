import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflowHandlers } from "../src/mcp-entry.js";
import { RunManager } from "@workflow/host-support";
import type { CodexLike, ThreadLike, CodexEvent } from "../src/codex-sdk.js";

// ── Fake helpers ──────────────────────────────────────────────────────────────

/**
 * Creates a fake thread that yields the given events sequence on each
 * `runStreamed` call. Returns `Promise<{ events }>` to match the real SDK shape.
 * Usage fixture uses all four required fields per CodexUsage.
 */
function fakeThread(reply: string): ThreadLike {
  return {
    id: "thr-fake",
    runStreamed(_input: string): Promise<{ events: AsyncGenerator<CodexEvent> }> {
      async function* gen(): AsyncGenerator<CodexEvent> {
        yield {
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: reply },
        };
        yield {
          type: "turn.completed",
          usage: {
            input_tokens: 5,
            cached_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        };
      }
      return Promise.resolve({ events: gen() });
    },
  };
}

/**
 * A minimal CodexLike that returns the same fake thread for every call.
 * Matches the interface used by CodexAdapter.
 */
function fakeCodex(reply: string): CodexLike {
  const thread = fakeThread(reply);
  return {
    startThread: () => thread,
    resumeThread: () => thread,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildWorkflowHandlers", () => {
  test("run executes an inline script end-to-end and returns output + runId in metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-mcp-"));
    const manager = new RunManager();
    const h = buildWorkflowHandlers({
      directory: dir,
      codex: fakeCodex("OK"),
      manager,
    });

    // A minimal valid workflow: export meta, then call agent() once.
    const script = `
      export const meta = { name: "test-mcp", description: "unit test" };
      return await agent("say OK");
    `;
    const res = await h.run({ script });

    expect(res.output).toContain("OK");
    expect(typeof res.metadata["runId"]).toBe("string");
    expect(res.metadata["workflow"]).toBe("test-mcp");
  });

  test("cancel returns {cancelled: false} for an unknown runId", async () => {
    const manager = new RunManager();
    const h = buildWorkflowHandlers({
      directory: ".",
      codex: fakeCodex("x"),
      manager,
    });
    const res = await h.cancel({ runId: "nope" });
    expect(res.metadata["cancelled"]).toBe(false);
    expect(res.output).toContain("not active");
  });

  test("status returns empty live/history for a fresh manager", async () => {
    const manager = new RunManager();
    const h = buildWorkflowHandlers({
      directory: ".",
      codex: fakeCodex("x"),
      manager,
    });
    const res = await h.status({});
    expect(res.metadata["live"]).toBe(0);
    expect(res.metadata["history"]).toBe(0);
  });

  test("status for a known runId returns not-found when not registered", async () => {
    const manager = new RunManager();
    const h = buildWorkflowHandlers({
      directory: ".",
      codex: fakeCodex("x"),
      manager,
    });
    const res = await h.status({ runId: "missing-run" });
    const parsed = JSON.parse(res.output) as { error?: string };
    expect(parsed.error).toBe("not found");
  });

  test("answer returns {answered: false} for a run with no pending question", async () => {
    const manager = new RunManager();
    const h = buildWorkflowHandlers({
      directory: ".",
      codex: fakeCodex("x"),
      manager,
    });
    const res = await h.answer({ runId: "no-run", answer: "yes" });
    expect(res.metadata["answered"]).toBe(false);
    expect(res.output).toContain("no pending question");
  });

  test("run assigns unique runIds for consecutive calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-mcp-seq-"));
    const manager = new RunManager();
    const h = buildWorkflowHandlers({
      directory: dir,
      codex: fakeCodex("A"),
      manager,
    });
    const script = `
      export const meta = { name: "seq", description: "sequential" };
      return await agent("go");
    `;
    const r1 = await h.run({ script });
    const r2 = await h.run({ script });
    expect(r1.metadata["runId"]).not.toBe(r2.metadata["runId"]);
  });
});
