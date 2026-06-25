import { describe, expect, test } from "bun:test";
import { extractJson, runStructured } from "../src/structured-output.js";

describe("extractJson", () => {
  test("extracts from a fenced json block", () => {
    const text = 'Here you go:\n```json\n{"a": 1, "b": [2,3]}\n```\nDone.';
    expect(extractJson(text)).toEqual({ a: 1, b: [2, 3] });
  });

  test("extracts a bare balanced object amid prose", () => {
    const text = 'The answer is {"ok": true, "n": 42} as requested.';
    expect(extractJson(text)).toEqual({ ok: true, n: 42 });
  });

  test("respects braces inside strings", () => {
    const text = '{"s": "a } b", "n": 1}';
    expect(extractJson(text)).toEqual({ s: "a } b", n: 1 });
  });

  test("tolerates trailing commas", () => {
    const text = '```json\n{"a": 1, "b": 2,}\n```';
    expect(extractJson(text)).toEqual({ a: 1, b: 2 });
  });

  test("returns undefined when no JSON is present", () => {
    expect(extractJson("no json here")).toBeUndefined();
  });
});

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, score: { type: "number" } },
  required: ["title", "score"],
  additionalProperties: false,
};

describe("runStructured", () => {
  test("returns the validated value on first valid response", async () => {
    const res = await runStructured({
      basePrompt: "rate it",
      schema: SCHEMA,
      retries: 2,
      run: async () => '```json\n{"title": "ok", "score": 9}\n```',
    });
    expect(res.value).toEqual({ title: "ok", score: 9 });
    expect(res.attempts).toBe(1);
  });

  test("retries with feedback then succeeds", async () => {
    const replies = [
      '{"title": "missing score"}', // invalid: missing required score
      '```json\n{"title": "fixed", "score": 5}\n```',
    ];
    let i = 0;
    const retries: number[] = [];
    const res = await runStructured({
      basePrompt: "rate it",
      schema: SCHEMA,
      retries: 2,
      run: async () => replies[i++]!,
      onRetry: (attempt) => retries.push(attempt),
    });
    expect(res.value).toEqual({ title: "fixed", score: 5 });
    expect(res.attempts).toBe(2);
    expect(retries).toEqual([1]);
  });

  test("returns null after exhausting retries", async () => {
    const res = await runStructured({
      basePrompt: "rate it",
      schema: SCHEMA,
      retries: 1,
      run: async () => "never valid",
    });
    expect(res.value).toBeNull();
    expect(res.attempts).toBe(2);
  });

  test("returns null when a turn dies", async () => {
    const res = await runStructured({
      basePrompt: "x",
      schema: SCHEMA,
      retries: 2,
      run: async () => null,
    });
    expect(res.value).toBeNull();
    expect(res.attempts).toBe(1);
  });
});
