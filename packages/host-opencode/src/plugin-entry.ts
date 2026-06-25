import { cpus } from "node:os";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { runWorkflow } from "@workflow/core";
import { AUTHORING_GUIDE } from "./authoring-guide.js";
import { DashboardServer } from "./dashboard/server.js";
import type { OpencodeEventLike } from "./dashboard/transcript.js";
import { FileJournalSink, fileJournalSource, journalPath } from "./file-journal.js";
import { OpencodeAdapter } from "./opencode-adapter.js";
import { readConfig } from "./read-config.js";
import { resolveSource } from "./resolve-source.js";

/** Default concurrency mirrors Claude Code: min(16, cores - 2), floor 1. */
export function autoConcurrency(): number {
  const cores = cpus().length || 4;
  return Math.min(16, Math.max(1, cores - 2));
}

/**
 * opencode plugin that brings Claude Code's dynamic-workflow capability to
 * opencode. Registers a `workflow` tool (LLM-callable), a `/workflow` command,
 * and a localhost web dashboard for live workflow + agent-conversation viewing.
 * Scripts run through the host-agnostic core, so the same script also runs on
 * Claude Code's native engine. The dashboard is opencode-only.
 */
export const WorkflowPlugin: Plugin = async ({ client, directory, worktree }, options) => {
  const cfg = readConfig(options ?? {});
  const dashboardEnabled = (options as { dashboard?: boolean } | undefined)?.dashboard !== false;
  const dashboardPort = (options as { dashboardPort?: number } | undefined)?.dashboardPort;
  const dashboard = dashboardEnabled ? new DashboardServer() : undefined;

  return {
    // Feed opencode message events into the dashboard transcripts (gated to
    // sessions that belong to an active workflow run).
    ...(dashboard
      ? {
          event: async ({ event }: { event: unknown }) => {
            dashboard.registry.applyOpencodeEvent(event as OpencodeEventLike);
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

          // Start the web dashboard (once) and surface its URL.
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
            onEvent: dashboard
              ? (ev) => {
                  if (ev.type === "run-start") {
                    dashboard.registry.startRun(ev.runId, ev.meta.name, ctx.sessionID);
                  }
                  dashboard.registry.applyProgress(runId, ev);
                }
              : undefined,
          });
          const sink = new FileJournalSink(journalPath(dir, runId));

          const res = await runWorkflow(source, {
            adapter,
            runId,
            journalSink: sink,
            config: {
              ...cfg,
              concurrency: cfg.concurrency ?? autoConcurrency(),
              args: args.input,
              parentSessionId: ctx.sessionID,
              signal: ctx.abort,
              resumeFromRunId: args.resume,
              journalSource: fileJournalSource(dir),
              resolveWorkflowSource: (ref) =>
                resolveSource(
                  typeof ref === "string" ? { name: ref } : { scriptPath: ref.scriptPath },
                  dir,
                ),
            },
          });

          const output =
            typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
          return {
            output,
            metadata: {
              workflow: res.meta.name,
              agents: res.agents,
              spentOutputTokens: res.spent,
              summary: res.summary,
              ...(dashboardUrl ? { dashboard: dashboardUrl } : {}),
            },
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
