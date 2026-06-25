import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./read-config.js";
import { resolveSource } from "./resolve-source.js";

describe("resolveSource", () => {
  test("returns inline script verbatim", async () => {
    expect(await resolveSource({ script: "return 1;" }, "/tmp")).toBe("return 1;");
  });

  test("reads a script by path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-"));
    await writeFile(join(dir, "w.js"), "// hi\nreturn 2;");
    expect(await resolveSource({ scriptPath: "w.js" }, dir)).toContain("return 2;");
  });

  test("throws a helpful error for an unknown name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-"));
    await expect(resolveSource({ name: "nope" }, dir)).rejects.toThrow(/not found/);
  });

  test("requires one of script/scriptPath/name", async () => {
    await expect(resolveSource({}, "/tmp")).rejects.toThrow(/provide one of/);
  });
});

describe("readConfig", () => {
  test("parses known fields and drops unknowns", () => {
    const cfg = readConfig({
      concurrency: 4,
      budgetTotal: 100000,
      modelMap: { opus: { providerID: "anthropic", modelID: "claude-opus-4-8" } },
      agentTypeMap: { Explore: "explore" },
      junk: "ignored",
    });
    expect(cfg.concurrency).toBe(4);
    expect(cfg.budgetTotal).toBe(100000);
    expect(cfg.modelMap?.opus).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-8" });
    expect(cfg.agentTypeMap?.Explore).toBe("explore");
    expect("junk" in cfg).toBe(false);
  });

  test("accepts an explicit null budget", () => {
    expect(readConfig({ budgetTotal: null }).budgetTotal).toBeNull();
  });

  test("ignores non-numeric concurrency", () => {
    expect("concurrency" in readConfig({ concurrency: "lots" })).toBe(false);
  });
});
