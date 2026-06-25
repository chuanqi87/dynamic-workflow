/**
 * Minimal local typing of the `@openai/codex-sdk` surface this adapter uses.
 * The adapter depends on these interfaces (not the concrete module), so it is
 * unit-testable with a fake and tolerant of SDK shape drift.
 */

export interface ThreadOptions {
  model?: string;
  workingDirectory?: string;
  sandboxMode?: string;
  skipGitRepoCheck?: boolean;
  outputSchema?: unknown;
}

export interface TurnOptions extends ThreadOptions {
  effort?: string;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export type CodexItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text?: string }
  | { id: string; type: string; [k: string]: unknown };

export type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.updated"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem }
  | { type: "turn.completed"; usage?: CodexUsage }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string };

export interface ThreadLike {
  /** Assigned after the first run's `thread.started`; may be undefined before. */
  id?: string;
  runStreamed(input: string, opts?: TurnOptions): AsyncIterable<CodexEvent>;
}

export interface CodexLike {
  startThread(opts?: ThreadOptions): ThreadLike;
  resumeThread(threadId: string): ThreadLike;
}
