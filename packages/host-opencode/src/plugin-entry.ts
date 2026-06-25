import { cpus } from "node:os";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { runWorkflow } from "@workflow/core";
import { AUTHORING_GUIDE } from "./authoring-guide.js";
import { DashboardServer } from "./dashboard/server.js";
import { indexPath } from "./dashboard/run-index.js";
import type { OpencodeEventLike } from "./dashboard/transcript.js";
import { FileJournalSink, fileJournalSource, journalPath } from "./file-journal.js";
import { OpencodeAdapter } from "./opencode-adapter.js";
import { readConfig } from "./read-config.js";
import { resolveSource } from "./resolve-source.js";
import { RunManager } from "./run-manager.js";
import { persistScript } from "./script-store.js";

/** Default concurrency mirrors Claude Code: min(16, cores - 2), floor 1. */
export function autoConcurrency(): number {
  const cores = cpus().length || 4;
  return Math.min(16, Math.max(1, cores - 2));
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
            manager.registry.applyOpencodeEvent(event as OpencodeEventLike);
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
            onEvent: (ev) => manager.registry.applyProgress(runId, ev),
            onQuestion: (q) => manager.ask(runId, q.question, q.options, q.timeoutMs),
          });
          const sink = new FileJournalSink(journalPath(dir, runId));

          let res: Awaited<ReturnType<typeof runWorkflow>>;
          try {
            res = await runWorkflow(source, {
              adapter,
              runId,
              journalSink: sink,
              config: {
                ...cfg,
                concurrency: cfg.concurrency ?? autoConcurrency(),
                args: args.input,
                parentSessionId: ctx.sessionID,
                signal,
                resumeFromRunId: args.resume,
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
          manager.finish(runId, "completed", res.summary);

          const base =
            typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
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
          if (args.runId) {
            const run = manager.registry.get(args.runId);
            return { output: JSON.stringify(run ?? { error: "not found" }, null, 2), metadata: {} };
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
