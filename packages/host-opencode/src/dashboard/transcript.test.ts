import { describe, expect, test } from "bun:test";
import { eventSessionId, TranscriptStore } from "./transcript.js";

const partUpdated = (sessionID: string, messageID: string, id: string, text: string, type = "text") => ({
  type: "message.part.updated",
  properties: { part: { sessionID, messageID, id, type, text } },
});
const messageUpdated = (sessionID: string, id: string, role: string, output: number, cost: number) => ({
  type: "message.updated",
  properties: { info: { sessionID, id, role, tokens: { output }, cost } },
});

describe("TranscriptStore", () => {
  test("assembles a message from its text parts and metadata", () => {
    const s = new TranscriptStore();
    s.apply(partUpdated("S1", "M1", "p0", "Hello "));
    s.apply(partUpdated("S1", "M1", "p1", "world"));
    s.apply(messageUpdated("S1", "M1", "assistant", 12, 0.02));
    const msgs = s.get("S1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: "assistant", text: "Hello world", tokens: 12, cost: 0.02 });
  });

  test("orders messages by first appearance", () => {
    const s = new TranscriptStore();
    s.apply(messageUpdated("S1", "M1", "user", 0, 0));
    s.apply(partUpdated("S1", "M1", "p", "hi"));
    s.apply(messageUpdated("S1", "M2", "assistant", 3, 0));
    s.apply(partUpdated("S1", "M2", "p", "yo"));
    expect(s.get("S1").map((m) => m.text)).toEqual(["hi", "yo"]);
  });

  test("ignores non-text/reasoning parts and unrelated sessions", () => {
    const s = new TranscriptStore();
    s.apply(partUpdated("S1", "M1", "t", "{}", "tool"));
    expect(s.get("S1")).toEqual([]);
    expect(s.get("S2")).toEqual([]);
  });

  test("eventSessionId extracts the session id", () => {
    expect(eventSessionId(partUpdated("S9", "M", "p", "x"))).toBe("S9");
    expect(eventSessionId(messageUpdated("S8", "M", "assistant", 1, 0))).toBe("S8");
    expect(eventSessionId({ type: "something.else" })).toBeUndefined();
  });
});
