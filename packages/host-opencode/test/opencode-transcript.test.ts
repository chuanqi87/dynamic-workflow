import { describe, expect, test, beforeEach } from "bun:test";
import { OpencodeTranscriptTranslator } from "../src/opencode-transcript.js";

// ---------------------------------------------------------------------------
// Helpers to build realistic opencode event shapes
// ---------------------------------------------------------------------------

function messageUpdatedEvent(opts: {
  id: string;
  sessionID: string;
  role?: string;
  cost?: number;
  outputTokens?: number;
}) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: opts.id,
        sessionID: opts.sessionID,
        role: opts.role ?? "assistant",
        cost: opts.cost,
        tokens: { output: opts.outputTokens },
      },
    },
  };
}

function partUpdatedEvent(opts: {
  sessionID: string;
  messageID: string;
  id: string;
  type: string;
  text?: string;
}) {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        sessionID: opts.sessionID,
        messageID: opts.messageID,
        id: opts.id,
        type: opts.type,
        text: opts.text ?? "",
      },
    },
  };
}

function partRemovedEvent(opts: {
  sessionID: string;
  messageID: string;
  partID: string;
}) {
  return {
    type: "message.part.removed",
    properties: {
      sessionID: opts.sessionID,
      messageID: opts.messageID,
      partID: opts.partID,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpencodeTranscriptTranslator", () => {
  let translator: OpencodeTranscriptTranslator;

  beforeEach(() => {
    translator = new OpencodeTranscriptTranslator();
  });

  // 1. Multi-part text assembly + metadata
  describe("multi-part text assembly and metadata", () => {
    test("message.updated emits a delta with role and usage metadata", () => {
      const deltas = translator.translate(
        messageUpdatedEvent({
          id: "msg-1",
          sessionID: "sess-1",
          role: "assistant",
          cost: 0.005,
          outputTokens: 42,
        }),
      );

      expect(deltas).toHaveLength(1);
      const d = deltas[0]!;
      expect(d.sessionId).toBe("sess-1");
      expect(d.messageId).toBe("msg-1");
      expect(d.role).toBe("assistant");
      expect(d.tokens).toBe(42);
      expect(d.cost).toBe(0.005);
    });

    test("message.part.updated text parts accumulate and delta carries full joined text", () => {
      // Seed the message metadata first
      translator.translate(
        messageUpdatedEvent({ id: "msg-1", sessionID: "sess-1", role: "assistant", cost: 0.001, outputTokens: 10 }),
      );

      const d1 = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "part-a", type: "text", text: "Hello" }),
      );
      expect(d1).toHaveLength(1);
      expect(d1[0]!.text).toBe("Hello");

      const d2 = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "part-b", type: "text", text: " World" }),
      );
      expect(d2).toHaveLength(1);
      // Full accumulated text is the join of all parts
      expect(d2[0]!.text).toBe("Hello World");
    });

    test("part delta carries the role and usage from the preceding message.updated", () => {
      translator.translate(
        messageUpdatedEvent({ id: "msg-2", sessionID: "sess-2", role: "user", cost: 0.002, outputTokens: 7 }),
      );

      const deltas = translator.translate(
        partUpdatedEvent({ sessionID: "sess-2", messageID: "msg-2", id: "p1", type: "text", text: "Hi" }),
      );

      expect(deltas).toHaveLength(1);
      const d = deltas[0]!;
      expect(d.role).toBe("user");
      expect(d.tokens).toBe(7);
      expect(d.cost).toBe(0.002);
      expect(d.text).toBe("Hi");
    });
  });

  // 2. Non-text parts are ignored
  describe("ignores non-text/reasoning parts", () => {
    test("tool part emits no delta", () => {
      const deltas = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "p1", type: "tool" }),
      );
      expect(deltas).toEqual([]);
    });

    test("file part emits no delta", () => {
      const deltas = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "p1", type: "file" }),
      );
      expect(deltas).toEqual([]);
    });

    test("tool part does not contribute to accumulated text", () => {
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "p1", type: "text", text: "Visible" }),
      );
      // This should be ignored
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "p2", type: "tool", text: "Should not appear" }),
      );
      // Next text part sees only the accumulated text parts
      const deltas = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-1", id: "p3", type: "text", text: " Text" }),
      );
      expect(deltas[0]!.text).toBe("Visible Text");
    });
  });

  // 3. Reasoning parts ARE included
  describe("reasoning parts are included", () => {
    test("reasoning part emits a delta with its text", () => {
      const deltas = translator.translate(
        partUpdatedEvent({
          sessionID: "sess-1",
          messageID: "msg-r",
          id: "reasoning-1",
          type: "reasoning",
          text: "<think>step 1</think>",
        }),
      );
      expect(deltas).toHaveLength(1);
      expect(deltas[0]!.text).toBe("<think>step 1</think>");
    });

    test("reasoning part text is joined with subsequent text parts", () => {
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-r2", id: "r", type: "reasoning", text: "Thought. " }),
      );
      const deltas = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-r2", id: "t", type: "text", text: "Answer." }),
      );
      expect(deltas[0]!.text).toBe("Thought. Answer.");
    });
  });

  // 4. Part removal
  describe("part removal", () => {
    test("removing a part decreases accumulated text", () => {
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-rm", id: "p1", type: "text", text: "First " }),
      );
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-rm", id: "p2", type: "text", text: "Second" }),
      );

      const deltas = translator.translate(
        partRemovedEvent({ sessionID: "sess-1", messageID: "msg-rm", partID: "p1" }),
      );

      expect(deltas).toHaveLength(1);
      expect(deltas[0]!.text).toBe("Second");
    });

    test("removing the only part yields empty text", () => {
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-only", id: "p1", type: "text", text: "Only" }),
      );

      const deltas = translator.translate(
        partRemovedEvent({ sessionID: "sess-1", messageID: "msg-only", partID: "p1" }),
      );

      expect(deltas).toHaveLength(1);
      expect(deltas[0]!.text).toBe("");
    });

    test("removing unknown part from unknown message emits no delta", () => {
      const deltas = translator.translate(
        partRemovedEvent({ sessionID: "sess-1", messageID: "unknown-msg", partID: "p1" }),
      );
      expect(deltas).toEqual([]);
    });
  });

  // 5. Events lacking required IDs emit []
  describe("events lacking required ids emit []", () => {
    test("message.updated without sessionID emits []", () => {
      const event = {
        type: "message.updated",
        properties: { info: { id: "msg-1" /* no sessionID */ } },
      };
      expect(translator.translate(event)).toEqual([]);
    });

    test("message.updated without info.id emits []", () => {
      const event = {
        type: "message.updated",
        properties: { info: { sessionID: "sess-1" /* no id */ } },
      };
      expect(translator.translate(event)).toEqual([]);
    });

    test("message.updated with no properties emits []", () => {
      const event = { type: "message.updated" };
      expect(translator.translate(event)).toEqual([]);
    });

    test("message.part.updated without sessionID emits []", () => {
      const event = {
        type: "message.part.updated",
        properties: { part: { messageID: "msg-1", id: "p1", type: "text", text: "hi" } },
      };
      expect(translator.translate(event)).toEqual([]);
    });

    test("message.part.updated without messageID emits []", () => {
      const event = {
        type: "message.part.updated",
        properties: { part: { sessionID: "sess-1", id: "p1", type: "text", text: "hi" } },
      };
      expect(translator.translate(event)).toEqual([]);
    });

    test("message.part.removed without sessionID emits []", () => {
      const event = {
        type: "message.part.removed",
        properties: { messageID: "msg-1", partID: "p1" },
      };
      expect(translator.translate(event)).toEqual([]);
    });

    test("message.part.removed without messageID emits []", () => {
      const event = {
        type: "message.part.removed",
        properties: { sessionID: "sess-1", partID: "p1" },
      };
      expect(translator.translate(event)).toEqual([]);
    });

    test("unknown event type emits []", () => {
      expect(translator.translate({ type: "session.created" })).toEqual([]);
      expect(translator.translate({ type: "run.started" })).toEqual([]);
    });
  });

  // Edge cases
  describe("edge cases", () => {
    test("multiple independent messages are tracked separately", () => {
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-A", id: "p1", type: "text", text: "Alpha" }),
      );
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-B", id: "p1", type: "text", text: "Beta" }),
      );

      const dA = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-A", id: "p2", type: "text", text: " Plus" }),
      );
      expect(dA[0]!.text).toBe("Alpha Plus");

      const dB = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-B", id: "p2", type: "text", text: " More" }),
      );
      expect(dB[0]!.text).toBe("Beta More");
    });

    test("updating an existing part id replaces its text", () => {
      translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-upd", id: "p1", type: "text", text: "Old" }),
      );
      const deltas = translator.translate(
        partUpdatedEvent({ sessionID: "sess-1", messageID: "msg-upd", id: "p1", type: "text", text: "New" }),
      );
      expect(deltas[0]!.text).toBe("New");
    });

    test("cost and token fields are optional — emits delta without them", () => {
      const deltas = translator.translate(
        messageUpdatedEvent({ id: "msg-nocost", sessionID: "sess-1" }),
      );
      expect(deltas).toHaveLength(1);
      expect(deltas[0]!.cost).toBeUndefined();
      expect(deltas[0]!.tokens).toBeUndefined();
    });
  });
});
