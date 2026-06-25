import { describe, expect, test } from "bun:test";
import { cacheKey, Journal, parseJournal } from "./journal.js";

describe("cacheKey", () => {
  test("ignores display-only label and phase", () => {
    const a = cacheKey("do x", { label: "one", phase: "Find" });
    const b = cacheKey("do x", { label: "two", phase: "Verify" });
    expect(a).toBe(b);
  });

  test("changes when prompt or schema changes", () => {
    expect(cacheKey("a", {})).not.toBe(cacheKey("b", {}));
    expect(cacheKey("a", {})).not.toBe(
      cacheKey("a", { schema: { type: "object" } }),
    );
  });
});

describe("parseJournal", () => {
  test("seeds only successful (non-null) agent results", () => {
    const lines = [
      JSON.stringify({ seq: 0, runId: "r", type: "run-start" }),
      JSON.stringify({ seq: 1, runId: "r", type: "agent", key: "K1", payload: "ok" }),
      JSON.stringify({ seq: 2, runId: "r", type: "agent", key: "K2", payload: null }),
      JSON.stringify({ seq: 3, runId: "r", type: "agent", key: "K3", payload: { v: 1 } }),
      "garbage line that is not json",
    ].join("\n");
    const seed = parseJournal(lines);
    expect(seed.get("K1")).toBe("ok");
    expect(seed.has("K2")).toBe(false); // null not seeded
    expect(seed.get("K3")).toEqual({ v: 1 });
  });
});

describe("Journal maxEntries", () => {
  test("stops caching past the cap and warns once, but keeps journaling", () => {
    let warned = 0;
    const lines: string[] = [];
    const j = new Journal("r", {
      sink: { append: (l) => lines.push(l) },
      maxEntries: 1,
      onCapExceeded: () => warned++,
    });
    j.record("agent", "A", "1");
    j.record("agent", "B", "2"); // exceeds cap → not cached
    expect(j.has("A")).toBe(true);
    expect(j.has("B")).toBe(false);
    expect(warned).toBe(1);
    expect(lines.length).toBe(2); // both still journaled to the sink
  });
});
