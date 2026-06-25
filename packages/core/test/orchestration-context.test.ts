import { describe, expect, test } from "bun:test";
import { currentFrames, runInFrame, type Frame } from "../src/orchestration-context.js";

const f = (groupId: string, extra: Partial<Frame> = {}): Frame => ({
  kind: "parallel",
  groupId,
  index: 0,
  ...extra,
});

describe("orchestration-context", () => {
  test("currentFrames() is empty outside any frame", () => {
    expect(currentFrames()).toEqual([]);
  });

  test("runInFrame exposes the frame to synchronous reads", () => {
    const seen = runInFrame(f("g1"), () => currentFrames());
    expect(seen).toEqual([f("g1")]);
    // store is restored after the call
    expect(currentFrames()).toEqual([]);
  });

  test("runInFrame nests: inner sees the full stack, outer is unaffected", () => {
    runInFrame(f("g1"), () => {
      const inner = runInFrame(f("g2", { parentId: "g1", index: 2 }), () => currentFrames());
      expect(inner.map((x) => x.groupId)).toEqual(["g1", "g2"]);
      expect(currentFrames().map((x) => x.groupId)).toEqual(["g1"]);
    });
  });

  test("context propagates across awaits inside the frame", async () => {
    const seen = await runInFrame(f("g1"), async () => {
      await Promise.resolve();
      return currentFrames();
    });
    expect(seen.map((x) => x.groupId)).toEqual(["g1"]);
  });
});
