import { AgentRunner, type AgentCounter, type ResolvedRetryConfig } from "./agent-runner.js";
import { BudgetTracker } from "./budget-tracker.js";
import { Journal, parseJournal, parseJournalOrdered, PrefixReplay, type JournalSink } from "./journal.js";
import { ModelAgentMapper } from "./model-agent-mapper.js";
import { ProgressReporter } from "./progress-reporter.js";
import { buildGlobals } from "./runtime-context.js";
import { executeBody, loadScript } from "./script-loader.js";
import { Semaphore } from "./semaphore.js";
import { formatIssues, validateScript } from "./portability-validator.js";
import type { HostAdapter, RunSummary, RuntimeConfig, WorkflowMeta } from "./types.js";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_SCHEMA_RETRIES = 2;
const MAX_NESTING_DEPTH = 1;

const DEFAULT_RETRY: ResolvedRetryConfig = {
  retries: 3,
  baseMs: 500,
  factor: 2,
  maxMs: 8000,
  jitter: 0.2,
};

/** Thrown when a script fails portability validation before execution. */
export class WorkflowValidationError extends Error {
  constructor(public readonly report: string) {
    super(`workflow failed validation:\n${report}`);
    this.name = "WorkflowValidationError";
  }
}

export interface RunWorkflowOptions {
  adapter: HostAdapter;
  config?: RuntimeConfig;
  /** Run the portability validator first (default true). */
  validate?: boolean;
  /** Run id for journaling / resume. Caller supplies a stable id. */
  runId: string;
  /** Optional journal sink for persistence. */
  journalSink?: JournalSink;
}

export interface RunWorkflowResult {
  result: unknown;
  meta: WorkflowMeta;
  spent: number;
  agents: number;
  summary: RunSummary;
}

interface SharedState {
  adapter: HostAdapter;
  config: RuntimeConfig;
  semaphore: Semaphore;
  budget: BudgetTracker;
  journal: Journal;
  reporter: ProgressReporter;
  counter: AgentCounter;
  /** Shared, deterministic group-id counter (parallel/pipeline). */
  groups: { n: number };
  signal: AbortSignal;
  agentTimeoutMs: number;
  schemaRetries: number;
  budgetMode: "throw" | "degrade";
  retry: ResolvedRetryConfig;
  sleep: (ms: number) => Promise<void>;
  rng: () => number;
  sessions: Set<string>;
  journalSink?: JournalSink;
  prefixReplay?: PrefixReplay;
}

/**
 * Execute a workflow script against a host adapter — the single entry point
 * shared by every opencode trigger (tool, command, CLI). The same `source`
 * runs unchanged on Claude Code's native engine.
 */
export async function runWorkflow(
  source: string,
  options: RunWorkflowOptions,
): Promise<RunWorkflowResult> {
  const config = options.config ?? {};
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rng = config.rng ?? Math.random;
  const startedAt = now();

  if (options.validate !== false) {
    const v = validateScript(source);
    if (!v.ok) throw new WorkflowValidationError(formatIssues(v.issues));
  }

  const controller = new AbortController();
  if (config.signal) {
    if (config.signal.aborted) controller.abort();
    else config.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  const budget = new BudgetTracker(config.budgetTotal ?? null);
  const reporter = new ProgressReporter(options.adapter);
  const journal = new Journal(options.runId, {
    sink: options.journalSink,
    maxEntries: config.maxJournalEntries,
    onCapExceeded: () =>
      reporter.warning(
        `journal in-memory cache reached ${config.maxJournalEntries} entries; further results are journaled to disk but not cached`,
      ),
  });

  // Resume: replay cached results from a prior run's journal.
  let prefixReplay: PrefixReplay | undefined;
  if (config.resumeFromRunId && config.journalSource) {
    try {
      const text = await config.journalSource(config.resumeFromRunId);
      if (config.replay === "prefix") {
        prefixReplay = new PrefixReplay(parseJournalOrdered(text));
      } else {
        journal.seed(parseJournal(text));
      }
    } catch (err) {
      reporter.warning(`resume failed to load journal ${config.resumeFromRunId}: ${(err as Error).message}; running fresh`);
    }
  }

  const shared: SharedState = {
    adapter: options.adapter,
    config,
    semaphore: new Semaphore(config.concurrency ?? DEFAULT_CONCURRENCY),
    budget,
    journal,
    reporter,
    counter: { n: 0 },
    groups: { n: 0 },
    signal: controller.signal,
    agentTimeoutMs: config.agentTimeoutMs ?? 0,
    schemaRetries: config.schemaRetries ?? DEFAULT_SCHEMA_RETRIES,
    budgetMode: config.budgetMode ?? "throw",
    retry: { ...DEFAULT_RETRY, ...config.retry },
    sleep,
    rng,
    sessions: new Set<string>(),
    journalSink: options.journalSink,
    prefixReplay,
  };

  // Global wall-clock timeout aborts the whole run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (config.globalTimeoutMs && config.globalTimeoutMs > 0) {
    timer = setTimeout(() => {
      reporter.warning(`global timeout of ${config.globalTimeoutMs}ms reached; aborting run`);
      controller.abort();
    }, config.globalTimeoutMs);
  }

  const loaded = loadScript(source);
  reporter.runStart({ type: "run-start", meta: loaded.meta, runId: options.runId });

  let ok = false;
  try {
    const result = await runOne(shared, source, config.args, 0);
    ok = true;
    return finalize(shared, loaded.meta, result, now() - startedAt, true);
  } finally {
    if (timer) clearTimeout(timer);
    await cleanup(shared, ok);
    if (!ok) reporter.runEnd(false, budget.spent(), reporter.summary(now() - startedAt, budget.spent(), budget.cost()));
  }
}

function finalize(
  shared: SharedState,
  meta: WorkflowMeta,
  result: unknown,
  durationMs: number,
  ok: boolean,
): RunWorkflowResult {
  const summary = shared.reporter.summary(durationMs, shared.budget.spent(), shared.budget.cost());
  shared.reporter.runEnd(ok, shared.budget.spent(), summary);
  return { result, meta, spent: shared.budget.spent(), agents: shared.counter.n, summary };
}

/** Flush the journal, and close sub-sessions if the run was cancelled. */
async function cleanup(shared: SharedState, ok: boolean): Promise<void> {
  const sink = shared.journalSink;
  if (sink?.flush) await sink.flush().catch(() => undefined);
  // Tear down sessions when the run was cancelled (signal aborted), regardless
  // of whether the script swallowed the resulting nulls and "completed". On a
  // clean, un-cancelled run we keep sessions for inspection/audit.
  void ok;
  if (shared.signal.aborted && shared.adapter.closeSession) {
    for (const id of shared.sessions) {
      try {
        await shared.adapter.closeSession(id);
      } catch {
        // best-effort
      }
    }
  }
}

async function runOne(
  shared: SharedState,
  source: string,
  args: unknown,
  depth: number,
): Promise<unknown> {
  const { meta, body } = loadScript(source);
  const phaseRef: { current?: string } = {};

  const mapper = new ModelAgentMapper(
    {
      modelMap: shared.config.modelMap,
      effortMap: shared.config.effortMap,
      agentTypeMap: shared.config.agentTypeMap,
      defaultModel: shared.config.defaultModel,
      metaModel: meta.model,
      phaseModelResolver: () => meta.phases?.find((p) => p.title === phaseRef.current)?.model,
    },
    () => shared.adapter.listAgents(),
  );

  const runner = new AgentRunner({
    adapter: shared.adapter,
    semaphore: shared.semaphore,
    budget: shared.budget,
    journal: shared.journal,
    reporter: shared.reporter,
    mapper,
    meta,
    parentSessionId: shared.config.parentSessionId,
    counter: shared.counter,
    signal: shared.signal,
    agentTimeoutMs: shared.agentTimeoutMs,
    schemaRetries: shared.schemaRetries,
    rootDirectory: shared.adapter.rootDirectory,
    budgetMode: shared.budgetMode,
    retry: shared.retry,
    sleep: shared.sleep,
    rng: shared.rng,
    onSession: (id) => shared.sessions.add(id),
    prefixReplay: shared.prefixReplay,
  });

  const workflowFn = async (
    ref: string | { scriptPath: string },
    nestedArgs?: unknown,
  ): Promise<unknown> => {
    if (depth >= MAX_NESTING_DEPTH) {
      throw new Error("nested workflow() is limited to one level");
    }
    if (!shared.config.resolveWorkflowSource) {
      throw new Error("workflow() is not supported: no resolveWorkflowSource configured");
    }
    const childSource = await shared.config.resolveWorkflowSource(ref);
    const v = validateScript(childSource);
    if (!v.ok) throw new WorkflowValidationError(formatIssues(v.issues));
    return runOne(shared, childSource, nestedArgs, depth + 1);
  };

  const question = async (
    prompt: string,
    opts?: { options?: string[]; default?: string; timeoutMs?: number },
  ): Promise<string | null> => {
    if (!shared.adapter.askQuestion) {
      shared.reporter.warning("question() is not supported by this host; using default");
      return opts?.default ?? null;
    }
    shared.reporter.log(`question: ${prompt}`);
    try {
      const answer = await shared.adapter.askQuestion({
        question: prompt,
        options: opts?.options,
        timeoutMs: opts?.timeoutMs,
      });
      return answer ?? opts?.default ?? null;
    } catch {
      return opts?.default ?? null;
    }
  };

  const globals = buildGlobals({
    runner,
    reporter: shared.reporter,
    budget: shared.budget.view(),
    args,
    meta,
    phaseRef,
    workflow: workflowFn,
    question,
    allocGroupId: () => `g${++shared.groups.n}`,
  });

  return executeBody(body, globals);
}
