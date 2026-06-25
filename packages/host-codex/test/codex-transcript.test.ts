import { describe, expect, test } from "bun:test";
import { CodexTranscriptTranslator } from "../src/codex-transcript.js";

describe("CodexTranscriptTranslator", () => {
  test("emits a delta per completed agent_message item", () => {
    const t = new CodexTranscriptTranslator();
    const d = t.translate("sess1", {
      type: "item.completed",
      item: { id: "item_3", type: "agent_message", text: "Repo has docs and sdk." },
    });
    expect(d).toEqual([
      { sessionId: "sess1", messageId: "item_3", role: "assistant", text: "Repo has docs and sdk." },
    ]);
  });

  test("ignores command_execution items", () => {
    const t = new CodexTranscriptTranslator();
    expect(
      t.translate("s", { type: "item.completed", item: { id: "i1", type: "command_execution" } }),
    ).toEqual([]);
  });

  test("turn.completed stamps output tokens onto the last assistant message", () => {
    const t = new CodexTranscriptTranslator();
    t.translate("s", { type: "item.completed", item: { id: "m1", type: "agent_message", text: "hi" } });
    const d = t.translate("s", {
      type: "turn.completed",
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 42, reasoning_output_tokens: 3 },
    });
    expect(d).toEqual([{ sessionId: "s", messageId: "m1", role: "assistant", text: "hi", tokens: 42 }]);
  });

  test("turn.completed with no prior message emits nothing", () => {
    const t = new CodexTranscriptTranslator();
    expect(
      t.translate("s", {
        type: "turn.completed",
        usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
      }),
    ).toEqual([]);
  });

  test("emits a reasoning delta for reasoning items", () => {
    const t = new CodexTranscriptTranslator();
    const d = t.translate("s", {
      type: "item.completed",
      item: { id: "r1", type: "reasoning", text: "thinking..." },
    });
    expect(d).toEqual([{ sessionId: "s", messageId: "r1", role: "reasoning", text: "thinking..." }]);
  });
});
