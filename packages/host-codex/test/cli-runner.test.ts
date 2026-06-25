import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadlessCodex, parseArgv } from "../src/cli-runner.js";
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

  test("writeFileSync is importable (sanity)", () => {
    // Ensure the import does not break at module load time
    expect(typeof writeFileSync).toBe("function");
  });
});

describe("parseArgv (via cli-runner re-export)", () => {
  test("reads scriptPath + flags", () => {
    const p = parseArgv([
      "wf.js",
      "--budget",
      "1000",
      "--concurrency",
      "2",
      "--args",
      '{"x":1}',
    ]);
    expect(p.scriptPath).toBe("wf.js");
    expect(p.config.budgetTotal).toBe(1000);
    expect(p.config.concurrency).toBe(2);
    expect(p.args).toEqual({ x: 1 });
  });

  test("parses all flags", () => {
    const p = parseArgv([
      "my.js",
      "--args",
      '{"files":["a.ts"]}',
      "--concurrency",
      "5",
      "--budget",
      "200000",
      "--timeout",
      "30000",
      "--global-timeout",
      "600000",
      "--resume",
      "codex-prev",
    ]);
    expect(p.scriptPath).toBe("my.js");
    expect(p.args).toEqual({ files: ["a.ts"] });
    expect(p.config.concurrency).toBe(5);
    expect(p.config.budgetTotal).toBe(200000);
    expect(p.config.agentTimeoutMs).toBe(30000);
    expect(p.config.globalTimeoutMs).toBe(600000);
    expect(p.resume).toBe("codex-prev");
  });

  test("works with only a script path", () => {
    const p = parseArgv(["w.js"]);
    expect(p.scriptPath).toBe("w.js");
    expect(p.config).toEqual({});
    expect(p.resume).toBeUndefined();
  });

  test("defaults --args to null when value is missing", () => {
    const p = parseArgv(["w.js", "--args"]);
    expect(p.args).toBeNull();
  });
});
