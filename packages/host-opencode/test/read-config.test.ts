import { describe, expect, test } from "bun:test";
import { readConfig, readToolConfig } from "../src/read-config.js";

describe("readConfig", () => {
  test("parses replay only for the two valid values", () => {
    expect(readConfig({ replay: "prefix" }).replay).toBe("prefix");
    expect(readConfig({ replay: "keyed" }).replay).toBe("keyed");
    expect(readConfig({ replay: "bogus" }).replay).toBeUndefined();
    expect(readConfig({}).replay).toBeUndefined();
  });

  test("drops undefined keys so engine defaults apply", () => {
    expect(Object.keys(readConfig({}))).toEqual([]);
  });
});

describe("readToolConfig", () => {
  test("parses defaultTools, dropping non-boolean entries", () => {
    const cfg = readToolConfig({ defaultTools: { write: false, read: true, junk: "x" } });
    expect(cfg.defaultTools).toEqual({ write: false, read: true });
  });

  test("parses per-agent tool maps", () => {
    const cfg = readToolConfig({
      agentTools: { Explore: { write: false, edit: false }, bad: { x: 1 } },
    });
    expect(cfg.agentTools).toEqual({ Explore: { write: false, edit: false } });
  });

  test("returns an empty object when nothing is configured", () => {
    expect(readToolConfig({})).toEqual({});
    expect(readToolConfig({ defaultTools: {}, agentTools: {} })).toEqual({});
  });
});
