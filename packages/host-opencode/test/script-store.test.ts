import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistScript, scriptPath } from "../src/script-store.js";

const tmp = () => mkdtemp(join(tmpdir(), "wf-script-"));

describe("scriptPath", () => {
  test("computes <directory>/.workflow/scripts/<runId>.js", () => {
    expect(scriptPath("/proj", "wf-abc")).toBe("/proj/.workflow/scripts/wf-abc.js");
  });
});

describe("persistScript", () => {
  test("writes the source verbatim and returns its path", async () => {
    const dir = await tmp();
    const source = "export const meta = { name: 'x', description: 'd' }\nlog('hi')\n";

    const path = await persistScript(dir, "wf-1", source);

    expect(path).toBe(scriptPath(dir, "wf-1"));
    expect(await readFile(path!, "utf8")).toBe(source);
  });

  test("creates the scripts/ subdirectory when absent", async () => {
    const dir = await tmp();
    const path = await persistScript(dir, "wf-2", "export const meta = {}\n");
    expect(await readFile(path!, "utf8")).toBe("export const meta = {}\n");
  });

  test("returns undefined and does not throw when the path is unwritable", async () => {
    const dir = await tmp();
    // Make `.workflow` a file so mkdir of `.workflow/scripts` fails.
    await writeFile(join(dir, ".workflow"), "blocker");

    const path = await persistScript(dir, "wf-3", "source");

    expect(path).toBeUndefined();
  });
});
