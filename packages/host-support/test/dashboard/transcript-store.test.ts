import { describe, expect, test } from "bun:test";
import { TranscriptStore } from "../../src/dashboard/transcript-store.js";

describe("TranscriptStore", () => {
  test("accumulates messages per session in arrival order", () => {
    const store = new TranscriptStore();
    store.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "Hello" });
    store.apply({ sessionId: "s1", messageId: "m2", role: "user", text: "Hi" });
    store.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "Hello world", tokens: 12 });

    expect(store.get("s1")).toEqual([
      { messageId: "m1", role: "assistant", text: "Hello world", tokens: 12, cost: undefined },
      { messageId: "m2", role: "user", text: "Hi", tokens: undefined, cost: undefined },
    ]);
  });

  test("isolates sessions and returns [] for unknown", () => {
    const store = new TranscriptStore();
    store.apply({ sessionId: "a", messageId: "m1", role: "assistant", text: "x" });
    expect(store.get("b")).toEqual([]);
  });
});
