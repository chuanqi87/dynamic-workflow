import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/cli-runner.js";

describe("parseArgv", () => {
  test("parses the script path and flags", () => {
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
  });

  test("defaults --args to null when omitted value", () => {
    const p = parseArgv(["w.js", "--args"]);
    expect(p.args).toBeNull();
  });
});
