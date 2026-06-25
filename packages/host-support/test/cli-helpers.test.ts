import { describe, expect, test } from "bun:test";
import { shortHash, parseArgv, isCliEntry } from "../src/cli-helpers.js";

describe("shortHash", () => {
  test("returns an 8-character hex string", () => {
    const h = shortHash("hello");
    expect(h).toHaveLength(8);
    expect(/^[0-9a-f]{8}$/.test(h)).toBe(true);
  });

  test("is deterministic — same input always yields same output", () => {
    expect(shortHash("workflow-source")).toBe(shortHash("workflow-source"));
  });

  test("different inputs produce different hashes (collision unlikely)", () => {
    expect(shortHash("aaa")).not.toBe(shortHash("bbb"));
  });

  test("empty string yields a stable value", () => {
    const h = shortHash("");
    expect(h).toHaveLength(8);
    expect(shortHash("")).toBe(h);
  });

  test("known FNV-1a value for empty string is 811c9dc5", () => {
    // FNV-1a initial hash value for empty string equals the seed
    expect(shortHash("")).toBe("811c9dc5");
  });
});

describe("parseArgv", () => {
  test("parses scriptPath and all flags", () => {
    const p = parseArgv([
      "my.workflow.js",
      "--args",
      '{"files":["a.ts"]}',
      "--concurrency",
      "5",
      "--budget",
      "200000",
      "--timeout",
      "30000",
      "--global-timeout",
      "600000",
      "--resume",
      "wf-prev",
    ]);
    expect(p.scriptPath).toBe("my.workflow.js");
    expect(p.args).toEqual({ files: ["a.ts"] });
    expect(p.config.concurrency).toBe(5);
    expect(p.config.budgetTotal).toBe(200000);
    expect(p.config.agentTimeoutMs).toBe(30000);
    expect(p.config.globalTimeoutMs).toBe(600000);
    expect(p.resume).toBe("wf-prev");
  });

  test("works with only a script path", () => {
    const p = parseArgv(["w.js"]);
    expect(p.scriptPath).toBe("w.js");
    expect(p.config).toEqual({});
    expect(p.resume).toBeUndefined();
    expect(p.args).toBeUndefined();
  });

  test("defaults --args to null when value is missing", () => {
    const p = parseArgv(["w.js", "--args"]);
    expect(p.args).toBeNull();
  });

  test("empty argv yields empty result", () => {
    const p = parseArgv([]);
    expect(p.scriptPath).toBeUndefined();
    expect(p.config).toEqual({});
  });

  test("skips unknown flags gracefully", () => {
    // Unknown flags starting with '--' are silently ignored
    const p = parseArgv(["w.js", "--unknown-flag"]);
    expect(p.scriptPath).toBe("w.js");
  });
});

describe("isCliEntry", () => {
  test("returns true when importMetaMain is true", () => {
    // Simulates Bun's import.meta.main === true
    expect(isCliEntry("file:///some/path/cli.js", true)).toBe(true);
  });

  test("returns false when process.argv[1] is undefined", () => {
    // Edge case: no argv[1]
    const origArgv = process.argv;
    try {
      process.argv = ["node"];
      expect(isCliEntry("file:///some/path/cli.js", false)).toBe(false);
    } finally {
      process.argv = origArgv;
    }
  });
});
