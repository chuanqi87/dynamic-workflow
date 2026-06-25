import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { Plugin } from "@opencode-ai/plugin";
import { WorkflowPlugin } from "../src/plugin-entry.js";

function fakeInput(directory: string): Parameters<Plugin>[0] {
  const client = {
    session: {
      create: async () => ({ data: { id: "child-1" } }),
      prompt: async (opts: { body: { parts: Array<{ text: string }> } }) => ({
        data: {
          info: { tokens: { input: 1, output: 3, reasoning: 0 }, cost: 0, error: null },
          parts: [{ type: "text", text: `echo:${opts.body.parts[0]!.text}` }],
        },
      }),
      abort: async () => ({ data: true }),
    },
    app: { agents: async () => ({ data: [] }) },
    tui: { showToast: async () => ({ data: true }) },
  } as unknown as OpencodeClient;

  return {
    client,
    directory,
    worktree: directory,
    project: {} as never,
    serverUrl: new URL("http://localhost:0"),
    $: (() => {}) as never,
    experimental_workspace: { register() {} } as never,
  };
}

function fakeCtx(directory: string) {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "build",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask() {},
  } as never;
}

describe("WorkflowPlugin", () => {
  test("registers a workflow tool and a /workflow command", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const hooks = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    expect(typeof hooks.tool?.workflow?.execute).toBe("function");
    expect(hooks.tool?.workflow?.description).toContain("portable");

    const config: { command?: Record<string, unknown> } = {};
    await hooks.config?.(config as never);
    expect(config.command?.workflow).toBeDefined();
  });

  test("runs an inline script end-to-end through the opencode adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const hooks = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    const script = `export const meta = { name: "t", description: "d" };
const a = await agent("hi");
const b = await parallel([() => agent("x"), () => agent("y")]);
return { a, b };`;
    const result = await hooks.tool!.workflow!.execute({ script }, fakeCtx(dir));
    const out = typeof result === "string" ? result : result.output;
    const parsed = JSON.parse(out.split("\n\nScript saved to ")[0]!);
    expect(parsed.a).toBe("echo:hi");
    expect(parsed.b).toEqual(["echo:x", "echo:y"]);
  });

  test("persists a generated inline script to .workflow/scripts and reports its path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const hooks = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    const script = `export const meta = { name: "t", description: "d" };\nreturn await agent("hi");`;
    const result = await hooks.tool!.workflow!.execute({ script }, fakeCtx(dir));

    const meta = typeof result === "string" ? undefined : (result.metadata as { scriptPath?: string });
    const saved = meta?.scriptPath;
    // runId derives from ctx.messageID ("m1") → wf-m1
    expect(saved).toBe(join(dir, ".workflow", "scripts", "wf-m1.js"));
    expect(await readFile(saved!, "utf8")).toBe(script);
    const out = typeof result === "string" ? result : result.output;
    expect(out).toContain("Script saved to");
  });

  test("does not persist a script sourced from scriptPath (already on disk)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    await writeFile(
      join(dir, "wf.js"),
      `export const meta = { name: "t", description: "d" };\nreturn await agent("hi");`,
    );
    const hooks = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    const result = await hooks.tool!.workflow!.execute({ scriptPath: "wf.js" }, fakeCtx(dir));

    const meta = typeof result === "string" ? undefined : (result.metadata as { scriptPath?: string });
    expect(meta?.scriptPath).toBeUndefined();
    await expect(access(join(dir, ".workflow", "scripts", "wf-m1.js"))).rejects.toThrow();
  });

  test("rejects an invalid script via the validator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const hooks = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    await expect(
      hooks.tool!.workflow!.execute(
        { script: `export const meta = { name: "t", description: "d" };\nreturn Math.random();` },
        fakeCtx(dir),
      ),
    ).rejects.toThrow(/validation/i);
  });

  test("background mode returns immediately, then persists the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const input = fakeInput(dir);
    // Gate the prompt so the run is provably still in-flight when execute returns.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (input.client as unknown as { session: { prompt: unknown } }).session.prompt = async (opts: {
      body: { parts: Array<{ text: string }> };
    }) => {
      await gate;
      return {
        data: {
          info: { tokens: { input: 1, output: 3, reasoning: 0 }, cost: 0, error: null },
          parts: [{ type: "text", text: `echo:${opts.body.parts[0]!.text}` }],
        },
      };
    };
    const hooks = await WorkflowPlugin(input, { dashboard: false });
    const script = `export const meta = { name: "bg", description: "d" };\nreturn await agent("hi");`;

    const started = await hooks.tool!.workflow!.execute({ script, background: true }, fakeCtx(dir));
    const meta = typeof started === "string" ? undefined : (started.metadata as { background?: boolean; runId?: string });
    expect(meta?.background).toBe(true);
    expect(meta?.runId).toBe("wf-m1");
    const startedOut = typeof started === "string" ? started : started.output;
    expect(startedOut).toContain("background");

    // Let the detached run finish, then poll the persisted status/result.
    release();
    let persisted: { status?: string; result?: string } | undefined;
    for (let i = 0; i < 200; i++) {
      const s = await hooks.tool!.workflow_status!.execute({ runId: "wf-m1" }, fakeCtx(dir));
      const out = typeof s === "string" ? s : s.output;
      persisted = (JSON.parse(out) as { persisted?: typeof persisted }).persisted;
      if (persisted?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(persisted?.status).toBe("completed");
    expect(persisted?.result).toContain("echo:hi");
  });

  test("sub-agents inherit the session model that invoked the tool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const input = fakeInput(dir);
    const seen: unknown[] = [];
    const session = (input.client as unknown as { session: Record<string, unknown> }).session;
    // The assistant message that invoked the workflow tool carries the model.
    session.message = async () => ({
      data: { info: { role: "assistant", providerID: "deepseek", modelID: "deepseek-chat" } },
    });
    session.prompt = async (opts: { body: { model?: unknown; parts: Array<{ text: string }> } }) => {
      seen.push(opts.body.model);
      return {
        data: {
          info: { tokens: { input: 1, output: 3, reasoning: 0 }, cost: 0, error: null },
          parts: [{ type: "text", text: `echo:${opts.body.parts[0]!.text}` }],
        },
      };
    };
    const hooks = await WorkflowPlugin(input, { dashboard: false });
    const script = `export const meta = { name: "t", description: "d" };\nreturn await agent("hi");`;
    await hooks.tool!.workflow!.execute({ script }, fakeCtx(dir));
    expect(seen).toEqual([{ providerID: "deepseek", modelID: "deepseek-chat" }]);
  });

  test("an explicit plugin defaultModel wins over the session model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const input = fakeInput(dir);
    const seen: unknown[] = [];
    const session = (input.client as unknown as { session: Record<string, unknown> }).session;
    session.message = async () => {
      throw new Error("should not be consulted when defaultModel is set");
    };
    session.prompt = async (opts: { body: { model?: unknown; parts: Array<{ text: string }> } }) => {
      seen.push(opts.body.model);
      return {
        data: {
          info: { tokens: { input: 1, output: 3, reasoning: 0 }, cost: 0, error: null },
          parts: [{ type: "text", text: `echo:${opts.body.parts[0]!.text}` }],
        },
      };
    };
    const hooks = await WorkflowPlugin(input, {
      dashboard: false,
      defaultModel: "anthropic/claude-opus-4-8",
    });
    const script = `export const meta = { name: "t", description: "d" };\nreturn await agent("hi");`;
    await hooks.tool!.workflow!.execute({ script }, fakeCtx(dir));
    expect(seen).toEqual([{ providerID: "anthropic", modelID: "claude-opus-4-8" }]);
  });

  test("falls back to the host default when the session model lookup fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const input = fakeInput(dir);
    const seen: unknown[] = [];
    const session = (input.client as unknown as { session: Record<string, unknown> }).session;
    session.message = async () => {
      throw new Error("message endpoint unavailable");
    };
    session.prompt = async (opts: { body: { model?: unknown; parts: Array<{ text: string }> } }) => {
      seen.push(opts.body.model);
      return {
        data: {
          info: { tokens: { input: 1, output: 3, reasoning: 0 }, cost: 0, error: null },
          parts: [{ type: "text", text: `echo:${opts.body.parts[0]!.text}` }],
        },
      };
    };
    const hooks = await WorkflowPlugin(input, { dashboard: false });
    const script = `export const meta = { name: "t", description: "d" };\nreturn await agent("hi");`;
    await hooks.tool!.workflow!.execute({ script }, fakeCtx(dir));
    // No model sent → the host (opencode) picks its own default.
    expect(seen).toEqual([undefined]);
  });

  test("does not write the progress tree to stderr in the plugin/TUI path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    const hooks = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    const original = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const script = `export const meta = { name: "t", description: "d", phases: [{ title: "P" }] };
phase("P");
return await agent("hi");`;
      await hooks.tool!.workflow!.execute({ script }, fakeCtx(dir));
    } finally {
      process.stderr.write = original;
    }
    const all = captured.join("");
    // The toasts + dashboard carry progress; the tool's stderr stays quiet so
    // opencode does not render a duplicate live block in the TUI.
    expect(all).not.toContain("▶ workflow");
    expect(all).not.toContain("── phase");
    expect(all).not.toContain("✓ ");
  });

  test("registers an event hook only when the dashboard is enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wf-plugin-"));
    // Constructing the plugin does NOT start a server (that is lazy, on run).
    const withDash = await WorkflowPlugin(fakeInput(dir), {});
    const noDash = await WorkflowPlugin(fakeInput(dir), { dashboard: false });
    expect(typeof withDash.event).toBe("function");
    expect(noDash.event).toBeUndefined();
  });
});
