/**
 * Minimal local typing of the `@openai/codex-sdk` surface this adapter uses.
 * The adapter depends on these interfaces (not the concrete module), so it is
 * unit-testable with a fake and tolerant of SDK shape drift.
 *
 * Field names and method signatures are grounded in @openai/codex-sdk@0.142.2
 * (packages/host-codex/node_modules/@openai/codex-sdk/dist/index.d.ts).
 */

// ── Thread creation options ───────────────────────────────────────────────────

export interface ThreadOptions {
  model?: string;
  workingDirectory?: string;
  sandboxMode?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: string;
  networkAccessEnabled?: boolean;
  webSearchMode?: string;
  webSearchEnabled?: boolean;
  approvalPolicy?: string;
  additionalDirectories?: string[];
}

/**
 * Per-turn options. NOTE: in the real SDK, TurnOptions does NOT extend
 * ThreadOptions — it is a separate flat type with only these two fields.
 */
export interface TurnOptions {
  /** JSON schema describing the expected agent output. */
  outputSchema?: unknown;
  /** AbortSignal to cancel the turn. */
  signal?: AbortSignal;
}

// ── Usage ─────────────────────────────────────────────────────────────────────

/**
 * All four fields are REQUIRED in the real SDK (not optional).
 */
export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

// ── Thread items ──────────────────────────────────────────────────────────────

/**
 * Discriminated union of thread items the adapter cares about.
 * The catch-all variant intentionally has NO index signature so that
 * TypeScript can narrow `agent_message` and `reasoning` correctly under
 * `noUncheckedIndexedAccess` without requiring unsafe casts.
 *
 * Compile-only assertion (fix verification):
 *   const item: CodexItem = { id: "x", type: "agent_message", text: "hi" };
 *   if (item.type === "agent_message") { const t: string = item.text; }  // OK
 */
export type CodexItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: string };

// ── Stream events ─────────────────────────────────────────────────────────────

/**
 * Top-level JSONL events emitted by the SDK stream.
 * Field names match @openai/codex-sdk@0.142.2:
 *   - thread.started  → thread_id: string   (NOT threadId)
 *   - turn.completed  → usage: CodexUsage   (required)
 *   - turn.failed     → error: { message: string }  (required)
 *   - error           → message: string     (required)
 */
export type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.updated"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem }
  | { type: "turn.completed"; usage: CodexUsage }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "error"; message: string };

// ── Thread interface ──────────────────────────────────────────────────────────

/**
 * The real SDK's `Thread.id` getter returns `string | null` (not undefined)
 * before the first turn starts.
 *
 * `runStreamed` returns `Promise<StreamedTurn>` where `StreamedTurn = { events:
 * AsyncGenerator<ThreadEvent> }`.  The adapter must await the promise first,
 * then iterate `result.events`.
 */
export interface StreamedTurn {
  events: AsyncGenerator<CodexEvent>;
}

export interface ThreadLike {
  /** Returns null before the first turn's thread.started event. */
  id: string | null;
  runStreamed(input: string, opts?: TurnOptions): Promise<StreamedTurn>;
}

// ── Codex client interface ────────────────────────────────────────────────────

/**
 * `resumeThread` takes an optional second `ThreadOptions` argument
 * (confirmed in 0.142.2: `resumeThread(id: string, options?: ThreadOptions)`).
 */
export interface CodexLike {
  startThread(opts?: ThreadOptions): ThreadLike;
  resumeThread(threadId: string, opts?: ThreadOptions): ThreadLike;
}
