import { type Plugin, tool } from "@opencode-ai/plugin";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { runWorkflow } from "@workflow/core";
import {
  autoConcurrency,
  DashboardServer,
  FileJournalSink,
  fileJournalSource,
  indexPath,
  journalPath,
  persistScript,
  RunManager,
} from "@workflow/host-support";
import { AUTHORING_GUIDE } from "./authoring-guide.js";
import { OpencodeAdapter } from "./opencode-adapter.js";
import { OpencodeTranscriptTranslator, type OpencodeEventLike } from "./opencode-transcript.js";
import { readConfig, readToolConfig } from "./read-config.js";
import { resolveSource } from "./resolve-source.js";

export { autoConcurrency };

const translator = new OpencodeTranscriptTranslator();

/**
 * Swallows the adapter's textual progress in the plugin/TUI path. opencode
 * captures a tool's stderr while it runs and renders it as a live block, so the
 * default `process.stderr` stream would duplicate the progress tree the toasts
 * and dashboard already show. The headless CLI keeps the default stderr stream
 * (there it is the primary way to watch a run).
 */
const SILENT_LOG_STREAM = { write(_s: string): void {} };

/**
 * Best-effort: read the model the host used for the assistant message that
 * invoked the workflow tool, so sub-agents inherit it by default — mirroring
 * Claude Code, where agents run on the main-loop model unless overridden.
 * Returns a `"providerID/modelID"` string the mapper resolves directly, or
 * undefined (fall back to the host's own default) if the lookup fails or the
 * message carries no model. Wired in as `defaultModel`, the mapper's lowest
 * priority, so per-agent `model`, `modelMap`, and an explicit plugin
 * `defaultModel` all still take precedence.
 *
 * NOTE: module-private on purpose. opencode loads every *exported* function in a
 * plugin file as a plugin; an exported helper that resolves to a non-object
 * (here, undefined) crashes the host's hook dispatch. Keep new helpers unexported.
 */
async function resolveSessionModel(
  client: OpencodeClient,
  sessionID: string,
  messageID: string,
  directory: string,
): Promise<string | undefined> {
  try {
    const res = await client.session.message({
      path: { id: sessionID, messageID },
      query: { directory },
    });
    const info = res.data?.info as { providerID?: string; modelID?: string } | undefined;
    if (info?.providerID && info.modelID) return `${info.providerID}/${info.modelID}`;
  } catch {
    // best-effort; never block a run on model inheritance
  }
  return undefined;
}

/**
 * opencode plugin that brings Claude Code's dynamic-workflow capability to
 * opencode. Registers the `workflow` tool (run/author), `workflow_cancel` and
 * `workflow_status` (lifecycle), a `/workflow` command, and a localhost web
 * dashboard for live workflow + agent-conversation viewing. Scripts run through
 * the host-agnostic core, so the same script also runs on Claude Code. The
 * dashboard is opencode-only.
 */
export const WorkflowPlugin: Plugin = async ({ client, directory, worktree }, options) => {
  const cfg = readConfig(options ?? {});
  const toolCfg = readToolConfig(options ?? {});
  const dashboardEnabled = (options as { dashboard?: boolean } | undefined)?.dashboard !== false;
  const dashboardPort = (options as { dashboardPort?: number } | undefined)?.dashboardPort;

  // Process-level run lifecycle: live registry + per-run cancel + persistent
  // index (history + crash recovery). Created regardless of the dashboard.
  const manager = new RunManager({ indexPath: indexPath(directory) });
  await manager.recover().catch(() => undefined);

  const dashboard = dashboardEnabled
    ? new DashboardServer(manager.registry, { cancel: manager.cancel, answer: manager.answer })
    : undefined;

  return {
    // Feed opencode message events into the dashboard transcripts (gated to
    // sessions that belong to an active run by the registry).
    ...(dashboard
      ? {
          event: async ({ event }: { event: unknown }) => {
            for (const d of translator.translate(event as OpencodeEventLike)) {
              manager.registry.applyTranscript(d);
            }
          },
        }
      : {}),

    tool: {
      workflow: tool({
        description: AUTHORING_GUIDE,
        args: {
          script: tool.schema.string().optional().describe("Inline workflow source code"),
          scriptPath: tool.schema
            .string()
            .optional()
            .describe("Path to a .js workflow file (relative to the project)"),
          name: tool.schema
            .string()
            .optional()
            .describe("Name of a workflow registered under .opencode/workflows/"),
          input: tool.schema
            .any()
            .optional()
            .describe("Value exposed to the script as the ambient `args`"),
          resume: tool.schema
            .string()
            .optional()
            .describe("Resume from a prior run id: cached unchanged agent() results are reused"),
          replay: tool.schema
            .enum(["keyed", "prefix"])
            .optional()
            .describe(
              "Resume strategy: 'keyed' (default, position-independent, concurrency-safe) or " +
                "'prefix' (Claude-Code-style: reuse the longest unchanged prefix, rerun the first " +
                "changed call and everything after; best-effort under concurrency)",
            ),
          background: tool.schema
            .boolean()
            .optional()
            .describe(
              "Run detached: return a run id immediately and notify on completion (toast). " +
                "Fetch the result later with workflow_status. Default false (blocking).",
            ),
        },
        async execute(args, ctx) {
          const dir = ctx.directory ?? directory;
          const source = await resolveSource(args, dir);
          const runId = `wf-${ctx.messageID}`;
          // Persist model-generated inline scripts so they can be inspected, fixed,
          // and re-run via scriptPath + resume. Scripts from scriptPath/name are
          // already on disk; written before execution so a failed run still keeps it.
          const isInline = args.script != null && args.script.trim() !== "";
          const savedScriptPath = isInline ? await persistScript(dir, runId, source) : undefined;
          // Register the run; the returned signal aborts on cancel() or ctx.abort.
          const signal = manager.begin(runId, args.name ?? "workflow", ctx.sessionID, ctx.abort);

          let dashboardUrl: string | undefined;
          if (dashboard) {
            try {
              dashboardUrl = await dashboard.ensureStarted(dashboardPort);
              void client.tui
                .showToast({ body: { message: `Workflow dashboard → ${dashboardUrl}`, variant: "info" } })
                .catch(() => undefined);
            } catch {
              // dashboard is best-effort; never block a run on it
            }
          }

          const adapter = new OpencodeAdapter(client, {
            rootDirectory: worktree ?? dir,
            directory: dir,
            toast: true,
            // Progress reaches the user via toasts + dashboard; keep it off the
            // tool's stderr so opencode doesn't render a duplicate live block.
            logStream: SILENT_LOG_STREAM,
            onEvent: (ev) => manager.registry.applyProgress(runId, ev),
            onQuestion: (q) => manager.ask(runId, q.question, q.options, q.timeoutMs),
            defaultTools: toolCfg.defaultTools,
            agentTools: toolCfg.agentTools,
          });
          const sink = new FileJournalSink(journalPath(dir, runId));

          // Default sub-agents to the model that invoked this tool, so the run
          // inherits the session's model (Claude Code semantics). An explicit
          // plugin `defaultModel` wins; the lookup is skipped when one is set.
          const defaultModel =
            cfg.defaultModel ?? (await resolveSessionModel(client, ctx.sessionID, ctx.messageID, dir));

          // One run, finalized identically whether awaited (foreground) or
          // detached (background): persist result + status, then return the
          // tool result. Failures finish the run (cancelled/failed) and rethrow.
          const executeRun = async () => {
            let res: Awaited<ReturnType<typeof runWorkflow>>;
            try {
              res = await runWorkflow(source, {
                adapter,
                runId,
                journalSink: sink,
                config: {
                  ...cfg,
                  concurrency: cfg.concurrency ?? autoConcurrency(),
                  ...(defaultModel ? { defaultModel } : {}),
                  args: args.input,
                  parentSessionId: ctx.sessionID,
                  signal,
                  resumeFromRunId: args.resume,
                  // Per-call replay overrides any configured default; absent → engine default (keyed).
                  replay:
                    args.replay === "prefix" || args.replay === "keyed" ? args.replay : cfg.replay,
                  journalSource: fileJournalSource(dir),
                  resolveWorkflowSource: (ref) =>
                    resolveSource(
                      typeof ref === "string" ? { name: ref } : { scriptPath: ref.scriptPath },
                      dir,
                    ),
                },
              });
            } catch (err) {
              manager.finish(runId, signal.aborted ? "cancelled" : "failed");
              throw err;
            }
            const base =
              typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
            // Persist a bounded copy so workflow_status can return it later.
            const persisted = base.length > 8192 ? `${base.slice(0, 8192)}…(truncated)` : base;
            manager.finish(runId, "completed", res.summary, persisted);

            const output = savedScriptPath
              ? `${base}\n\nScript saved to ${savedScriptPath}. To iterate, edit it and re-run with scriptPath + resume (run id ${runId}).`
              : base;
            return {
              output,
              metadata: {
                workflow: res.meta.name,
                runId,
                agents: res.agents,
                spentOutputTokens: res.spent,
                summary: res.summary,
                ...(savedScriptPath ? { scriptPath: savedScriptPath } : {}),
                ...(dashboardUrl ? { dashboard: dashboardUrl } : {}),
              },
            };
          };

          if (args.background === true) {
            // Detached: never await, never let a rejection escape the host. The
            // adapter already toasts run start/end; finalize state on completion
            // and flush the index so workflow_status can read the result.
            void executeRun()
              .catch((err) => {
                void client.tui
                  .showToast({
                    body: {
                      message: `workflow "${args.name ?? runId}" failed: ${(err as Error).message}`,
                      variant: "error",
                    },
                  })
                  .catch(() => undefined);
              })
              .finally(() => {
                void manager.flush();
              });
            const lines = [
              `Workflow started in background. Run id: ${runId}`,
              `Fetch progress/result with workflow_status (runId: ${runId}).`,
              ...(dashboardUrl ? [`Dashboard: ${dashboardUrl}`] : []),
            ];
            return {
              output: lines.join("\n"),
              metadata: {
                runId,
                background: true,
                ...(savedScriptPath ? { scriptPath: savedScriptPath } : {}),
                ...(dashboardUrl ? { dashboard: dashboardUrl } : {}),
              },
            };
          }

          return await executeRun();
        },
      }),

      workflow_cancel: tool({
        description: "Cancel an in-flight workflow run by its run id (from a prior workflow result).",
        args: { runId: tool.schema.string().describe("The run id, e.g. wf-<messageID>") },
        async execute(args) {
          const ok = manager.cancel(args.runId);
          return {
            output: ok ? `cancelled ${args.runId}` : `run ${args.runId} is not active`,
            metadata: { cancelled: ok },
          };
        },
      }),

      workflow_answer: tool({
        description: "Answer a workflow run that is paused on a question() call.",
        args: {
          runId: tool.schema.string().describe("The paused run id"),
          answer: tool.schema.string().describe("The answer to provide"),
        },
        async execute(args) {
          const ok = manager.answer(args.runId, args.answer);
          return {
            output: ok ? `answered ${args.runId}` : `run ${args.runId} has no pending question`,
            metadata: { answered: ok },
          };
        },
      }),

      workflow_status: tool({
        description: "List workflow runs (live in this process + persisted history) with status.",
        args: { runId: tool.schema.string().optional().describe("Optional: report only this run") },
        async execute(args) {
          // Flush pending index writes first so a just-finished (e.g. background)
          // run's status/result is readable, not racing the fire-and-forget queue.
          await manager.flush();
          if (args.runId) {
            // Merge the live view (in-flight progress) with the persisted entry
            // (final status, summary, and result for completed/background runs).
            const live = manager.registry.get(args.runId);
            const persisted = (await manager.history()).find((h) => h.runId === args.runId);
            if (!live && !persisted) {
              return { output: JSON.stringify({ error: "not found" }, null, 2), metadata: {} };
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
        },
      }),
    },

    config: async (config) => {
      // Best-effort: inject a /workflow command that nudges the model to call
      // the tool. Skip if the user already defined one.
      const c = config as { command?: Record<string, unknown> };
      c.command ??= {};
      if (!c.command["workflow"]) {
        c.command["workflow"] = {
          description: "Run a portable dynamic workflow script",
          template:
            "Use the `workflow` tool to run the workflow referenced by: $ARGUMENTS\n" +
            "Treat $ARGUMENTS as a scriptPath if it looks like a file path, otherwise as a name. " +
            "If it is empty, ask which workflow to run.",
        };
      }
    },
  };
};

export default WorkflowPlugin;
