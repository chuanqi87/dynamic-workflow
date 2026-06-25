import type { BudgetTracker } from "./budget-tracker.js";
import { cacheKey, type Journal, type PrefixReplay } from "./journal.js";
import type { ModelAgentMapper } from "./model-agent-mapper.js";
import type { ProgressReporter } from "./progress-reporter.js";
import { extractJson, runStructured, validateAgainst } from "./structured-output.js";
import type { Semaphore } from "./semaphore.js";
import { currentFrames } from "./orchestration-context.js";
import {
  LIMITS,
  type AgentGroup,
  type AgentOpts,
  type AgentRequest,
  type AgentResult,
  type HostAdapter,
  type NullReason,
  type WorkflowMeta,
} from "./types.js";

/** Raised when a workflow exceeds the hard ceiling on total agent() calls. */
export class AgentLimitError extends Error {
  constructor(limit: number) {
    super(`workflow exceeded the maximum of ${limit} agent() calls`);
    this.name = "AgentLimitError";
  }
}

/** Raised when the token budget is exhausted (hard ceiling, per the contract). */
export class BudgetExceededError extends Error {
  constructor(
    readonly total: number,
    readonly spent: number,
  ) {
    super(`token budget exhausted: spent ${spent} of ${total} output tokens`);
    this.name = "BudgetExceededError";
  }
}

/** Shared, mutable agent-call counter so nested workflows share one ceiling. */
export interface AgentCounter {
  n: number;
}

export interface ResolvedRetryConfig {
  retries: number;
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: number;
}

export interface AgentRunnerDeps {
  adapter: HostAdapter;
  semaphore: Semaphore;
  budget: BudgetTracker;
  journal: Journal;
  reporter: ProgressReporter;
  mapper: ModelAgentMapper;
  meta: WorkflowMeta;
  parentSessionId: string | undefined;
  /** Shared across nested workflows so MAX_AGENTS bounds the whole run. */
  counter: AgentCounter;
  /** Master signal; aborting it cancels all in-flight sub-agents. */
  signal: AbortSignal;
  agentTimeoutMs: number;
  schemaRetries: number;
  rootDirectory: string;
  budgetMode: "throw" | "degrade";
  retry: ResolvedRetryConfig;
  sleep: (ms: number) => Promise<void>;
  rng: () => number;
  /** Notified of every created sub-session id (for cleanup). */
  onSession: (sessionId: string) => void;
  /** Prefix-mode cross-run resume; absent for keyed/no resume. */
  prefixReplay?: PrefixReplay;
}

/** Per-call token/cost accumulator (covers retries + schema turns). */
interface Spend {
  tokens: number;
  cost: number;
}

/** Outcome of the transient-retry loop for one logical agent call. */
interface TurnOutcome {
  text: string | null;
  category: NullReason;
  /** Host-native structured payload, when the host produced one. */
  structured?: unknown;
  /** Host advertised native structured output but rejected the schema/format. */
  formatUnsupported?: boolean;
}

/**
 * Implements the ambient `agent()` semantics on top of a {@link HostAdapter}:
 * cache/resume lookup, hard budget ceiling, concurrency, model/agent
 * resolution, optional worktree isolation, schema-constrained output, and
 * transient-retry-then-null degradation.
 */
export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  get agentCount(): number {
    return this.deps.counter.n;
  }

  run = async (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    // Capture the group synchronously before the semaphore defers execution —
    // AsyncLocalStorage context can be lost once the thunk runs in a different
    // async continuation. CRITICAL: do not read currentFrames() inside execute().
    const group = topGroup(currentFrames());
    if (++this.deps.counter.n > LIMITS.MAX_AGENTS) {
      throw new AgentLimitError(LIMITS.MAX_AGENTS);
    }

    const { journal, budget, reporter } = this.deps;
    const label = opts?.label ?? this.deps.meta.name;
    const key = cacheKey(prompt, opts);

    // Resume / dedupe: an unchanged (prompt, opts) returns its cached result —
    // unless a schema is now required but the cached value cannot satisfy it
    // (e.g. a plaintext result from a prior non-schema run): then re-run live.
    if (journal.has(key)) {
      const cached = journal.get(key);
      if (!(opts?.schema && (cached === null || typeof cached !== "object"))) {
        return cached;
      }
    }

    // Prefix-mode cross-run resume: consult the ordered replay (in-run dedup
    // above already handled repeats). On a hit, record it so later identical
    // calls dedup without advancing the prefix cursor.
    if (this.deps.prefixReplay) {
      const r = this.deps.prefixReplay.lookup(key);
      if (r.hit && !(opts?.schema && (r.value === null || typeof r.value !== "object"))) {
        journal.record("agent", key, r.value);
        return r.value;
      }
    }

    // Budget gate: hard ceiling. Throw by default (contract); degrade if asked.
    if (budget.exhausted) {
      if (this.deps.budgetMode === "degrade") {
        reporter.agentNull(label, "budget exhausted", "budget");
        journal.record("agent", key, null);
        return null;
      }
      throw new BudgetExceededError(budget.total ?? 0, budget.spent());
    }

    return this.deps.semaphore.run(() => this.execute(prompt, opts, label, key, group));
  };

  private async execute(
    prompt: string,
    opts: AgentOpts | undefined,
    label: string,
    key: string,
    group: AgentGroup | undefined,
  ): Promise<unknown> {
    const { adapter, reporter, mapper, journal } = this.deps;

    const resolved = await mapper.resolve(opts);
    const sessionId = await adapter.createSubSession(this.deps.parentSessionId, label);
    this.deps.onSession(sessionId);
    // Report start AFTER the session exists so the dashboard can bind this
    // agent row to its sub-session conversation.
    reporter.agentStart(label, opts?.phase, sessionId, group);

    let directory: string | undefined;
    let cleanup: (() => Promise<void>) | undefined;
    if (opts?.isolation === "worktree") {
      if (adapter.createWorktree) {
        const wt = await adapter.createWorktree(this.deps.rootDirectory, key);
        directory = wt.dir;
        cleanup = wt.cleanup;
      } else {
        reporter.warning(
          `agent "${label}" requested worktree isolation but the host does not support it; running in the shared directory`,
        );
      }
    }

    const spend: Spend = { tokens: 0, cost: 0 };
    try {
      if (opts?.schema) {
        // Native path: ask the host to enforce the schema server-side, then
        // re-validate with ajv (never trust the host blindly). Falls back to the
        // portable prompt-envelope path if the host can't do native structured
        // output for this call.
        if (adapter.capabilities?.structuredOutput === true) {
          const native = await this.invokeWithRetry(
            sessionId,
            prompt,
            resolved,
            directory,
            label,
            spend,
            { schema: opts.schema, retries: this.deps.schemaRetries },
          );
          if (!native.formatUnsupported) {
            // A genuine terminal/abort failure (no response at all): degrade now
            // rather than waste an envelope retry that would hit the same wall.
            if (native.text === null && native.structured === undefined) {
              reporter.agentNull(label, native.category, native.category, sessionId);
              journal.record("agent", key, null);
              return null;
            }
            const candidate =
              native.structured !== undefined ? native.structured : extractJson(native.text ?? "");
            const checked =
              candidate === undefined ? null : validateAgainst(opts.schema, candidate);
            if (checked && checked.ok) {
              reporter.agentDone(label, spend.tokens, spend.cost, sessionId);
              journal.record("agent", key, checked.value);
              return checked.value;
            }
            // Got a response that didn't satisfy the schema → fall through to the
            // portable envelope path for feedback-driven retries (symmetry with
            // the non-native path; native is then never strictly less robust).
          }
          // formatUnsupported also falls through to the envelope path below.
        }

        const { value } = await runStructured({
          basePrompt: prompt,
          schema: opts.schema,
          retries: this.deps.schemaRetries,
          run: (p) =>
            this.invokeWithRetry(sessionId, p, resolved, directory, label, spend).then(
              (o) => o.text,
            ),
          onRetry: (attempt, reason) => reporter.agentRetry(label, attempt, reason, sessionId),
        });
        if (value === null) {
          reporter.agentNull(label, "schema validation failed", "schema", sessionId);
          journal.record("agent", key, null);
          return null;
        }
        reporter.agentDone(label, spend.tokens, spend.cost, sessionId);
        journal.record("agent", key, value);
        return value;
      }

      const outcome = await this.invokeWithRetry(sessionId, prompt, resolved, directory, label, spend);
      if (outcome.text === null) {
        reporter.agentNull(label, outcome.category, outcome.category, sessionId);
        journal.record("agent", key, null);
        return null;
      }
      reporter.agentDone(label, spend.tokens, spend.cost, sessionId);
      journal.record("agent", key, outcome.text);
      return outcome.text;
    } finally {
      if (cleanup) await cleanup().catch(() => undefined);
    }
  }

  /**
   * One logical turn with transient-error retries and exponential backoff.
   * Returns text on success, or null with a category on terminal failure.
   * Every attempt's usage is accounted to the budget and `spend`.
   */
  private async invokeWithRetry(
    sessionId: string,
    prompt: string,
    resolved: { model?: { providerID: string; modelID: string }; agent?: string },
    directory: string | undefined,
    label: string,
    spend: Spend,
    structured?: { schema: AgentOpts["schema"]; retries: number },
  ): Promise<TurnOutcome> {
    const req: AgentRequest = {
      sessionId,
      prompt,
      model: resolved.model,
      agent: resolved.agent,
      signal: this.deps.signal,
      timeoutMs: this.deps.agentTimeoutMs || undefined,
      directory,
      label,
      ...(structured ? { schema: structured.schema, schemaRetries: structured.retries } : {}),
    };

    let attempt = 0;
    for (;;) {
      let result: AgentResult;
      try {
        result = await this.deps.adapter.runAgent(req);
      } catch (err) {
        // An unexpected host throw is treated as a transient failure.
        result = {
          text: "",
          tokens: { input: 0, output: 0, reasoning: 0 },
          cost: 0,
          aborted: false,
          errored: true,
          retriable: true,
          errorDetail: (err as Error).message,
        };
      }

      this.deps.budget.add(result.tokens, result.cost);
      spend.tokens += result.tokens.output;
      spend.cost += result.cost;

      // Host can't enforce the schema natively — surface so execute() falls back
      // to the portable prompt-envelope path (don't retry the same way).
      if (result.formatUnsupported) {
        return { text: result.text || null, category: "apiError", formatUnsupported: true };
      }

      if (result.aborted) {
        // Master-signal abort (user cancel / global timeout) is intentional —
        // never retry. A per-attempt timeout (signal not aborted) may retry.
        if (this.deps.signal.aborted) return { text: null, category: "aborted" };
        if (attempt < this.deps.retry.retries) {
          attempt++;
          this.deps.reporter.agentRetry(label, attempt, "timeout", sessionId);
          await this.backoff(attempt);
          continue;
        }
        return { text: null, category: "timeout" };
      }

      if (!result.errored) {
        return { text: result.text, category: "apiError", structured: result.structured };
      }

      const transient = result.retriable === true;
      if (transient && attempt < this.deps.retry.retries && !this.deps.signal.aborted) {
        attempt++;
        this.deps.reporter.agentRetry(label, attempt, result.errorDetail ?? "transient error", sessionId);
        await this.backoff(attempt);
        continue;
      }
      return { text: null, category: "apiError" };
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const { baseMs, factor, maxMs, jitter } = this.deps.retry;
    const base = Math.min(maxMs, baseMs * factor ** (attempt - 1));
    const delay = base + base * jitter * this.deps.rng();
    await this.deps.sleep(delay);
  }
}

/** Map the top ALS frame to the AgentGroup shape the event carries. */
function topGroup(frames: ReturnType<typeof currentFrames>): AgentGroup | undefined {
  const top = frames.at(-1);
  if (!top) return undefined;
  return {
    id: top.groupId,
    kind: top.kind,
    parentId: top.parentId,
    index: top.index,
    stageIndex: top.stageIndex,
  };
}
