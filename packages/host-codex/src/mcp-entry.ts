#!/usr/bin/env node
/**
 * workflow-codex-mcp — MCP stdio server exposing workflow tools for Codex.
 *
 * Two public surfaces:
 *   buildWorkflowHandlers(deps) — transport-independent tool logic (unit-testable).
 *   startMcpServer(opts?)       — wires handlers onto an MCP stdio server.
 *
 * The four tools mirror the opencode plugin semantics:
 *   workflow         run/author workflow scripts
 *   workflow_status  list/inspect runs
 *   workflow_cancel  abort an in-flight run
 *   workflow_answer  reply to a paused question()
 */
import { runWorkflow } from "@workflow/core";
import {
  autoConcurrency,
  FileJournalSink,
  fileJournalSource,
  indexPath,
  journalPath,
  persistScript,
  RunManager,
} from "@workflow/host-support";
import { CodexAdapter } from "./codex-adapter.js";
import type { CodexLike } from "./codex-sdk.js";
import { createCodex } from "./codex-factory.js";
import { resolveSource } from "./resolve-source.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface WorkflowHandlerDeps {
  directory: string;
  codex: CodexLike;
  manager: RunManager;
}

interface RunArgs {
  script?: string;
  scriptPath?: string;
  name?: string;
  input?: unknown;
  resume?: string;
  replay?: "keyed" | "prefix";
  background?: boolean;
}

// ── Handlers (transport-independent) ─────────────────────────────────────────

/**
 * Build the four workflow tool handlers backed by `deps`. The returned object
 * is MCP-transport-free — it can be called directly from unit tests without
 * spinning up any network or stdio server.
 */
export function buildWorkflowHandlers(deps: WorkflowHandlerDeps): {
  run(args: RunArgs): Promise<{ output: string; metadata: Record<string, unknown> }>;
  status(args: { runId?: string }): Promise<{ output: string; metadata: Record<string, unknown> }>;
  cancel(args: { runId: string }): Promise<{ output: string; metadata: Record<string, unknown> }>;
  answer(args: { runId: string; answer: string }): Promise<{
    output: string;
    metadata: Record<string, unknown>;
  }>;
} {
  const { directory, codex, manager } = deps;
  let runSeq = 0;

  // ── run ───────────────────────────────────────────────────────────────────

  async function run(
    args: RunArgs,
  ): Promise<{ output: string; metadata: Record<string, unknown> }> {
    const source = await resolveSource(args, directory);
    const runId = `codex-mcp-${++runSeq}`;

    const isInline = args.script != null && args.script.trim() !== "";
    const savedScriptPath = isInline
      ? await persistScript(directory, runId, source)
      : undefined;

    const signal = manager.begin(runId, args.name ?? "workflow");

    const adapter = new CodexAdapter(codex, {
      rootDirectory: directory,
      directory,
      onEvent: (ev) => manager.registry.applyProgress(runId, ev),
      onTranscript: (d) => manager.registry.applyTranscript(d),
      onQuestion: (q) =>
        manager.ask(runId, q.question, q.options, q.timeoutMs),
    });

    const sink = new FileJournalSink(journalPath(directory, runId));

    const executeRun = async (): Promise<{
      output: string;
      metadata: Record<string, unknown>;
    }> => {
      let res: Awaited<ReturnType<typeof runWorkflow>>;
      try {
        res = await runWorkflow(source, {
          adapter,
          runId,
          journalSink: sink,
          config: {
            concurrency: autoConcurrency(),
            args: args.input,
            signal,
            resumeFromRunId: args.resume,
            replay:
              args.replay === "prefix" || args.replay === "keyed"
                ? args.replay
                : undefined,
            journalSource: fileJournalSource(directory),
            resolveWorkflowSource: (ref) =>
              resolveSource(
                typeof ref === "string"
                  ? { name: ref }
                  : { scriptPath: ref.scriptPath },
                directory,
              ),
          },
        });
      } catch (err) {
        manager.finish(runId, signal.aborted ? "cancelled" : "failed");
        throw err;
      }

      const base =
        typeof res.result === "string"
          ? res.result
          : JSON.stringify(res.result, null, 2);
      const persisted =
        base.length > 8192 ? `${base.slice(0, 8192)}…(truncated)` : base;
      manager.finish(runId, "completed", res.summary, persisted);

      const output = savedScriptPath
        ? `${base}\n\nScript saved to ${savedScriptPath}. To iterate, edit it and re-run with scriptPath + resume (run id ${runId}).`
        : base;

      return {
        output,
        metadata: {
          runId,
          workflow: res.meta.name,
          agents: res.agents,
          spentOutputTokens: res.spent,
          summary: res.summary,
          ...(savedScriptPath ? { scriptPath: savedScriptPath } : {}),
        },
      };
    };

    if (args.background === true) {
      void executeRun()
        .catch(() => undefined)
        .finally(() => {
          void manager.flush();
        });
      return {
        output: [
          `Workflow started in background. Run id: ${runId}`,
          `Fetch progress/result with workflow_status (runId: ${runId}).`,
        ].join("\n"),
        metadata: {
          runId,
          background: true,
          ...(savedScriptPath ? { scriptPath: savedScriptPath } : {}),
        },
      };
    }

    return executeRun();
  }

  // ── status ────────────────────────────────────────────────────────────────

  async function status(args: { runId?: string }): Promise<{
    output: string;
    metadata: Record<string, unknown>;
  }> {
    await manager.flush();
    if (args.runId) {
      const live = manager.registry.get(args.runId);
      const persisted = (await manager.history()).find(
        (h) => h.runId === args.runId,
      );
      if (!live && !persisted) {
        return {
          output: JSON.stringify({ error: "not found" }, null, 2),
          metadata: {},
        };
      }
      return {
        output: JSON.stringify({ live, persisted }, null, 2),
        metadata: {
          status: persisted?.status ?? live?.status ?? "running",
          hasResult: persisted?.result != null,
        },
      };
    }
    const live = manager.list().map((r) => ({
      runId: r.runId,
      name: r.name,
      status: r.status,
      agents: r.agents.length,
    }));
    const history = await manager.history();
    return {
      output: JSON.stringify({ live, history }, null, 2),
      metadata: { live: live.length, history: history.length },
    };
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  async function cancel(args: { runId: string }): Promise<{
    output: string;
    metadata: Record<string, unknown>;
  }> {
    const ok = manager.cancel(args.runId);
    return {
      output: ok
        ? `cancelled ${args.runId}`
        : `run ${args.runId} is not active`,
      metadata: { cancelled: ok },
    };
  }

  // ── answer ────────────────────────────────────────────────────────────────

  async function answer(args: { runId: string; answer: string }): Promise<{
    output: string;
    metadata: Record<string, unknown>;
  }> {
    const ok = manager.answer(args.runId, args.answer);
    return {
      output: ok
        ? `answered ${args.runId}`
        : `run ${args.runId} has no pending question`,
      metadata: { answered: ok },
    };
  }

  return { run, status, cancel, answer };
}

// ── MCP stdio server ──────────────────────────────────────────────────────────

/**
 * Start an MCP stdio server exposing the four workflow tools.
 *
 * Uses the low-level `Server` + `setRequestHandler` API from
 * `@modelcontextprotocol/sdk@1.29.0` with plain JSON schemas (no Zod
 * dependency). Transport is `StdioServerTransport`.
 */
export async function startMcpServer(
  opts: { directory?: string } = {},
): Promise<void> {
  const directory = opts.directory ?? process.cwd();

  const manager = new RunManager({ indexPath: indexPath(directory) });
  await manager.recover().catch(() => undefined);

  const codex = await createCodex();
  const handlers = buildWorkflowHandlers({ directory, codex, manager });

  // Dynamic imports so the file compiles and tests run without a live server.
  const { Server } = (await import(
    "@modelcontextprotocol/sdk/server/index.js"
  )) as typeof import("@modelcontextprotocol/sdk/server/index.js");

  const { StdioServerTransport } = (await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  )) as typeof import("@modelcontextprotocol/sdk/server/stdio.js");

  const { ListToolsRequestSchema, CallToolRequestSchema } = (await import(
    "@modelcontextprotocol/sdk/types.js"
  )) as typeof import("@modelcontextprotocol/sdk/types.js");

  const server = new Server(
    { name: "workflow-codex", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const TOOLS = [
    {
      name: "workflow",
      description:
        "Run a portable dynamic workflow script on Codex. Supply `script` (inline source), `scriptPath` (path to a .js file), or `name` (registry workflow).",
      inputSchema: {
        type: "object" as const,
        properties: {
          script: { type: "string", description: "Inline workflow source code" },
          scriptPath: {
            type: "string",
            description: "Path to a .js workflow file",
          },
          name: {
            type: "string",
            description: "Name of a registered workflow",
          },
          input: { description: "Value exposed as the ambient `args`" },
          resume: {
            type: "string",
            description: "Resume from a prior run id",
          },
          replay: {
            type: "string",
            enum: ["keyed", "prefix"],
            description: "Resume strategy",
          },
          background: {
            type: "boolean",
            description: "Run detached; return run id immediately",
          },
        },
      },
    },
    {
      name: "workflow_status",
      description:
        "List workflow runs (live in this process + persisted history) with status.",
      inputSchema: {
        type: "object" as const,
        properties: {
          runId: {
            type: "string",
            description: "Optional: report only this run",
          },
        },
      },
    },
    {
      name: "workflow_cancel",
      description: "Cancel an in-flight workflow run by its run id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          runId: { type: "string", description: "The run id to cancel" },
        },
        required: ["runId"],
      },
    },
    {
      name: "workflow_answer",
      description: "Answer a workflow run that is paused on a question() call.",
      inputSchema: {
        type: "object" as const,
        properties: {
          runId: { type: "string", description: "The paused run id" },
          answer: { type: "string", description: "The answer to provide" },
        },
        required: ["runId", "answer"],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const a = req.params.arguments ?? {};
      try {
        type Dispatch = (a: Record<string, unknown>) => Promise<{ output: string }>;
        const dispatch: Record<string, Dispatch> = {
          workflow: (x) => handlers.run(x as RunArgs),
          workflow_status: (x) =>
            handlers.status(x as { runId?: string }),
          workflow_cancel: (x) =>
            handlers.cancel(x as { runId: string }),
          workflow_answer: (x) =>
            handlers.answer(x as { runId: string; answer: string }),
        };
        const fn = dispatch[req.params.name];
        if (!fn) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown tool: ${req.params.name}`,
              },
            ],
            isError: true,
          };
        }
        const res = await fn(a);
        return { content: [{ type: "text" as const, text: res.output }] };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

// ── CLI entry-point ───────────────────────────────────────────────────────────

if ((import.meta as { main?: boolean }).main === true) {
  startMcpServer().catch((err) => {
    process.stderr.write(
      `workflow-codex-mcp failed: ${(err as Error).message}\n`,
    );
    process.exit(1);
  });
}
