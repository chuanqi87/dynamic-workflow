import { describe, expect, test } from "bun:test";
import { validateScript } from "../src/portability-validator.js";

const VALID = `export const meta = {
  name: "demo",
  description: "a valid workflow",
  phases: [{ title: "Find" }, { title: "Verify" }],
};
const a = await agent("hello");
const results = await parallel([() => agent("x"), () => agent("y")]);
log("done");
return { a, results };
`;

function rules(src: string): string[] {
  return validateScript(src).issues.filter((i) => i.severity === "error").map((i) => i.rule);
}

describe("validateScript", () => {
  test("accepts a conforming script", () => {
    const v = validateScript(VALID);
    expect(v.ok).toBe(true);
    expect(v.meta?.name).toBe("demo");
  });

  test("rejects a missing meta", () => {
    expect(rules(`const x = 1; return x;`)).toContain("meta-literal");
  });

  test("rejects non-literal meta", () => {
    const src = `export const meta = { name: "x", description: foo() };\nreturn 1;`;
    expect(rules(src)).toContain("meta-literal");
  });

  test("rejects unknown meta keys", () => {
    const src = `export const meta = { name: "x", description: "y", bogus: 1 };\nreturn 1;`;
    expect(rules(src)).toContain("meta-keys");
  });

  test("rejects Math.random()", () => {
    const src = `export const meta = { name: "x", description: "y" };\nconst r = Math.random();\nreturn r;`;
    expect(rules(src)).toContain("no-random");
  });

  test("rejects Date.now() and argless new Date()", () => {
    const a = `export const meta = { name: "x", description: "y" };\nreturn Date.now();`;
    const b = `export const meta = { name: "x", description: "y" };\nreturn new Date();`;
    expect(rules(a)).toContain("no-now");
    expect(rules(b)).toContain("no-now");
  });

  test("rejects escape identifiers", () => {
    const src = `export const meta = { name: "x", description: "y" };\nreturn process.env;`;
    expect(rules(src)).toContain("escape");
  });

  test("rejects TypeScript syntax", () => {
    const src = `export const meta = { name: "x", description: "y" };\nconst n: number = 1;\nreturn n;`;
    expect(rules(src)).toContain("syntax");
  });

  test("flags literal batch over the limit", () => {
    const big = Array.from({ length: 4097 }, () => "0").join(", ");
    const src = `export const meta = { name: "x", description: "y" };\nreturn await parallel([${big}]);`;
    expect(rules(src)).toContain("batch-limit");
  });

  test("allows new Date(fixed) and does not warn on locally declared names", () => {
    const src = `export const meta = { name: "x", description: "y" };\nconst t = new Date(0);\nconst helper = (z) => z + 1;\nreturn helper(t.getFullYear());`;
    const v = validateScript(src);
    expect(v.ok).toBe(true);
  });
});
