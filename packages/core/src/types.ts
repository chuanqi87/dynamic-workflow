/**
 * Shared, host-agnostic types for the portable dynamic-workflow runtime.
 *
 * These types encode the Workflow Script Contract that both Claude Code and
 * opencode honour. Nothing here may depend on a concrete platform — the only
 * boundary to the outside world is {@link HostAdapter}.
 */

/** A JSON Schema object (draft-07 compatible). Kept loose on purpose. */
export type JsonSchema = Record<string, unknown>;

/** `phases` entry inside a workflow's `meta` block. */
export interface MetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

/** The `export const meta = {...}` literal that opens every workflow script. */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: MetaPhase[];
  whenToUse?: string;
  model?: string;
}

/** Reasoning-effort tiers, mirroring Claude Code's `agent()` opts. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Options accepted by the ambient `agent()` global. */
export interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  effort?: Effort;
  isolation?: "worktree";
  agentType?: string;
  /** Optional system prompt override (non-contract escape hatch, ignored by CC). */
  system?: string;
}

/** Read-only token budget exposed to scripts as the ambient `budget` global. */
export interface Budget {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

/** Options for the ambient `question()` global (host-in-the-loop). */
export interface QuestionOpts {
  /** Suggested answers for the UI. */
  options?: string[];
  /** Returned if no answer arrives (timeout) or the host can't ask. */
  default?: string;
  /** Max wait before falling back to `default`. */
  timeoutMs?: number;
}

/** The full set of ambient globals injected into a workflow script body. */
export interface WorkflowGlobals {
  agent(prompt: string, opts?: AgentOpts): Promise<unknown>;
  parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;
  pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<unknown[]>;
  phase(title: string): void;
  log(message: string): void;
  workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;
  /**
   * Pause for a human answer (OPTIONAL host extension — not part of the portable
   * core contract). Resolves to the answer, or `opts.default ?? null` when the
   * host cannot ask or the wait times out. Portable scripts must feature-detect:
   * `typeof question === "function"`.
   */
  question(prompt: string, opts?: QuestionOpts): Promise<string | null>;
  args: unknown;
  budget: Budget;
}

// ---------------------------------------------------------------------------
// Host adapter boundary
// ---------------------------------------------------------------------------

/** A single sub-agent prompt turn, platform-neutral. */
export interface AgentRequest {
  /** Session (created via {@link HostAdapter.createSubSession}) to prompt on. */
  sessionId: string;
  prompt: string;
  system?: string;
  model?: { providerID: string; modelID: string };
  /** Named subagent on the host (opencode agent name / CC agent type). */
  agent?: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Working directory override, used for worktree isolation. */
  directory?: string;
  /** Display label for progress UIs. */
  label?: string;
  /**
   * When set, request host-native schema-constrained output for this turn
   * (only honoured by adapters that advertise {@link HostAdapter.capabilities}
   * `.structuredOutput`). The core still validates the result with ajv.
   */
  schema?: JsonSchema;
  /** Native server-side retry budget for schema-constrained output. */
  schemaRetries?: number;
}

/** Token usage for one assistant turn. */
export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
}

/** The platform-neutral result of one sub-agent invocation. */
export interface AgentResult {
  text: string;
  tokens: TokenUsage;
  cost: number;
  aborted: boolean;
  /** True when the host reported an error (api error, output too long, ...). */
  errored: boolean;
  /**
   * Only meaningful when `errored`. True for transient failures the runtime
   * should retry (429, 5xx, network); false for terminal ones (auth, invalid
   * request, output-too-long). Honours the contract: `agent()` returns null
   * only on a terminal error *after retries*.
   */
  retriable?: boolean;
  /** Optional human-readable error detail for logs. */
  errorDetail?: string;
  /**
   * Parsed object from host-native structured output, when produced. The core
   * prefers this over parsing {@link AgentResult.text}, then re-validates it.
   */
  structured?: unknown;
  /**
   * Set by an adapter that advertised native structured output but found the
   * host rejected the request's `schema`/`format` (e.g. an older server). Tells
   * the core to fall back to the prompt-envelope + parse path for this call.
   */
  formatUnsupported?: boolean;
}

/**
 * Where an agent() sits in the parallel/pipeline orchestration that spawned
 * it. Optional, host-internal telemetry: not visible to scripts, never part
 * of the journal key, and absent under Claude Code's native runtime.
 */
export interface AgentGroup {
  id: string;
  kind: "parallel" | "pipeline";
  parentId?: string;
  index: number;
  stageIndex?: number;
}

/** Why an `agent()` call degraded to null — used for the run summary. */
export type NullReason = "budget" | "aborted" | "timeout" | "apiError" | "schema";

/** Aggregate outcome of a workflow run, for observability. */
export interface RunSummary {
  /** Total agent() calls dispatched (cache hits excluded). */
  agents: number;
  /** Calls that returned a usable value. */
  succeeded: number;
  /** Calls that degraded to null, grouped by reason. */
  nullsByReason: Record<NullReason, number>;
  /** Total retry attempts across all calls. */
  retries: number;
  /** parallel()/pipeline() items dropped to null. */
  dropped: number;
  /** Output tokens spent (matches budget accounting). */
  outputTokens: number;
  /** USD cost summed across sub-agents. */
  costUsd: number;
  /** Wall-clock duration in ms (host clock). */
  durationMs: number;
}

/** Summary of an available host subagent. */
export interface HostAgentInfo {
  name: string;
  mode?: string;
  model?: { providerID: string; modelID: string };
}

/** Progress events emitted by the runtime, routed by the host's sink. */
export type ProgressEvent =
  | { type: "run-start"; meta: WorkflowMeta; runId: string }
  | { type: "phase"; title: string }
  | { type: "log"; message: string }
  | { type: "agent-start"; label: string; phase?: string; sessionId?: string; group?: AgentGroup }
  | { type: "agent-done"; label: string; tokens: number; cost: number; sessionId?: string }
  | { type: "agent-null"; label: string; reason: string; category: NullReason; sessionId?: string }
  | { type: "agent-retry"; label: string; attempt: number; reason: string; sessionId?: string }
  | { type: "dropped"; scope: "parallel" | "pipeline"; index: number; reason: string }
  | { type: "run-end"; ok: boolean; spent: number; agents: number; summary?: RunSummary }
  | { type: "warning"; message: string };

/**
 * The single boundary between the host-agnostic core and a concrete platform.
 * Claude Code and opencode each provide one implementation.
 */
export interface HostAdapter {
  /** Root working directory for the workflow run. */
  readonly rootDirectory: string;
  /**
   * Optional, possibly-dynamic capability flags. Absent ⇒ all false. When
   * `structuredOutput` is true the core asks the host to enforce a schema
   * natively (and still re-validates); otherwise it uses the portable
   * prompt-envelope + ajv path. Claude Code's adapter leaves this unset.
   */
  readonly capabilities?: { structuredOutput?: boolean };
  /** Run one sub-agent to completion and return its normalized result. */
  runAgent(req: AgentRequest): Promise<AgentResult>;
  /** Create a sub-session under `parentId`; returns the new session id. */
  createSubSession(parentId: string | undefined, title: string): Promise<string>;
  /** List subagents available on this host (for agentType resolution). */
  listAgents(): Promise<HostAgentInfo[]>;
  /** Route a progress event to the host's UI / logs. */
  report(ev: ProgressEvent): void | Promise<void>;
  /** Create an isolated git worktree; optional capability. */
  createWorktree?(
    baseDir: string,
    id: string,
  ): Promise<{ dir: string; cleanup(): Promise<void> }>;
  /** Close/abort a sub-session created via {@link createSubSession}; optional. */
  closeSession?(sessionId: string): Promise<void> | void;
  /** Ask a human and await the answer; optional host-in-the-loop capability. */
  askQuestion?(input: {
    question: string;
    options?: string[];
    timeoutMs?: number;
  }): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Runtime configuration
// ---------------------------------------------------------------------------

/** Maps a logical model name (e.g. "opus") to a concrete host model. */
export type ModelMap = Record<string, { providerID: string; modelID: string }>;

/** Maps a logical effort tier to a logical model name in {@link ModelMap}. */
export type EffortMap = Record<Effort, string>;

/** Maps a Claude-Code agent type name to a host subagent name. */
export type AgentTypeMap = Record<string, string>;

/** Transient-error retry policy for `agent()` (DFX P0-1). */
export interface RetryConfig {
  /** Max retry attempts after the first try. Default 3. */
  retries?: number;
  /** Base backoff in ms. Default 500. */
  baseMs?: number;
  /** Backoff multiplier per attempt. Default 2. */
  factor?: number;
  /** Backoff ceiling in ms. Default 8000. */
  maxMs?: number;
  /** Jitter fraction [0,1] added to each delay. Default 0.2. */
  jitter?: number;
}

export interface RuntimeConfig {
  /** Max concurrent in-flight sub-agents. Defaults to 3 (opencode-safe). */
  concurrency?: number;
  /** Token budget target (output tokens); null/undefined = unbounded. */
  budgetTotal?: number | null;
  /**
   * Budget-exhaustion behaviour. "throw" (default, Claude-Code-compatible)
   * makes further `agent()` calls throw a BudgetExceededError; "degrade"
   * returns null instead.
   */
  budgetMode?: "throw" | "degrade";
  /** Per-agent timeout in ms; 0/undefined = no timeout. */
  agentTimeoutMs?: number;
  /** Whole-run wall-clock timeout in ms; 0/undefined = none. */
  globalTimeoutMs?: number;
  /** Transient-error retry policy. */
  retry?: RetryConfig;
  /** Retries for schema-constrained output. Defaults to 2. */
  schemaRetries?: number;
  /** Cap on cached agent results held in memory; undefined = unbounded. */
  maxJournalEntries?: number;
  /** Resume: replay cached results from a prior run's journal. */
  resumeFromRunId?: string;
  /** Resume: returns the raw jsonl text of a prior run's journal. */
  journalSource?: (runId: string) => Promise<string> | string;
  /**
   * Resume strategy. "keyed" (default) reuses any unchanged (prompt,opts) and is
   * concurrency-safe. "prefix" replays in order and runs everything live after
   * the first changed call (stricter drift detection; best-effort under
   * concurrency).
   */
  replay?: "keyed" | "prefix";
  /** Injectable clock for summary duration (default Date.now). */
  now?: () => number;
  /** Injectable delay for retry backoff (default setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source [0,1) (default Math.random). */
  rng?: () => number;
  /** Logical → concrete model mapping. */
  modelMap?: ModelMap;
  /** Effort tier → logical model mapping. */
  effortMap?: Partial<EffortMap>;
  /** CC agent type → host subagent mapping. */
  agentTypeMap?: AgentTypeMap;
  /** Default logical model when a script/opts specify none. */
  defaultModel?: string;
  /** Arbitrary args value exposed to the script as the ambient `args`. */
  args?: unknown;
  /** Directory for journal output; relative to rootDirectory when not absolute. */
  journalDir?: string;
  /** Host session under which top-level sub-agents are created. */
  parentSessionId?: string;
  /** External cancellation signal; aborting it cancels the whole run. */
  signal?: AbortSignal;
  /**
   * Resolve a nested `workflow(ref)` call to its script source. The host owns
   * file/registry access; the core stays platform-neutral. When absent, nested
   * `workflow()` throws.
   */
  resolveWorkflowSource?: (
    ref: string | { scriptPath: string },
  ) => Promise<string> | string;
}

/** Hard ceilings from the contract. */
export const LIMITS = {
  /** Max items per single parallel()/pipeline() call. */
  MAX_BATCH: 4096,
  /** Max total agent() calls across a whole workflow run. */
  MAX_AGENTS: 1000,
} as const;
