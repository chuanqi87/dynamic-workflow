import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadlessCodex } from "../src/cli-runner.js";
import type { CodexLike } from "../src/codex-sdk.js";

// ── Fake helpers ───────────────────────────────────────────────────────────────

/**
 * A minimal fake CodexLike that yields a fixed agent reply.
 * `runStreamed` returns `Promise<{ events }>` matching the real SDK shape
 * (ThreadLike in codex-sdk.ts declares exactly this return type).
 */
function fakeCodex(reply: string): CodexLike {
  const thread = {
    id: "thr" as string | null,
    runStreamed(_input: string) {
      async function* gen() {
        yield {
          type: "item.completed" as const,
          item: { id: "m1", type: "agent_message" as const, text: reply },
        };
        yield {
          type: "turn.completed" as const,
          usage: {
            input_tokens: 5,
            cached_input_tokens: 0,
            output_tokens: 3,
            reasoning_output_tokens: 0,
          },
        };
      }
      return Promise.resolve({ events: gen() });
    },
  };
  return {
    startThread: () => thread,
    resumeThread: () => thread,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runHeadlessCodex", () => {
  test("runs a one-agent workflow and returns its result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-codex-"));
    const script = `
      export const meta = { name: 'echo', description: 'echo' };
      const out = await agent('say hi');
      return out;
    `;
    const result = await runHeadlessCodex({
      source: script,
      directory: dir,
      codex: fakeCodex("HI"),
      noJournal: true,
    });
    expect(result).toBe("HI");
  });

});

