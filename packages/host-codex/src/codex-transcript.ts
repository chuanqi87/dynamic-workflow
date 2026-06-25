import type { TranscriptDelta } from "@workflow/host-support";
import type { CodexEvent } from "./codex-sdk.js";

/**
 * Translates a Codex thread's streamed events into normalized TranscriptDeltas
 * for the shared dashboard. One instance per (session/thread). Only
 * `agent_message` and `reasoning` items become visible messages; tool/command
 * items are skipped. `turn.completed` usage is stamped onto the most recent
 * assistant message so the conversation view shows per-message output tokens.
 */
export class CodexTranscriptTranslator {
  private lastMessageId?: string;
  private lastText = "";

  translate(sessionId: string, event: CodexEvent): TranscriptDelta[] {
    if (event.type === "item.completed" || event.type === "item.updated") {
      const item = event.item;
      if (item.type === "agent_message") {
        this.lastMessageId = item.id;
        this.lastText = (item as { text: string }).text;
        return [{ sessionId, messageId: item.id, role: "assistant", text: this.lastText }];
      }
      if (item.type === "reasoning") {
        const text = (item as { text: string }).text;
        return [{ sessionId, messageId: item.id, role: "reasoning", text }];
      }
      return [];
    }
    if (event.type === "turn.completed") {
      if (!this.lastMessageId) return [];
      const tokens = event.usage.output_tokens;
      return [
        {
          sessionId,
          messageId: this.lastMessageId,
          role: "assistant",
          text: this.lastText,
          ...(tokens !== undefined ? { tokens } : {}),
        },
      ];
    }
    return [];
  }
}
