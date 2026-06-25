import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  HostAgentInfo,
  ProgressEvent,
} from "@workflow/core";
import { createWorktree as createWorktreeShared, type TranscriptDelta } from "@workflow/host-support";
import { CodexTranscriptTranslator } from "./codex-transcript.js";
import type { CodexEvent, CodexLike, ThreadLike, ThreadOptions, TurnOptions } from "./codex-sdk.js";

export interface CodexAdapterOptions {
  /** Absolute root directory for the workflow run (used for thread workingDirectory). */
  rootDirectory: string;
  /** Working directory override; defaults to rootDirectory. */
  directory?: string;
  /** Write a one-line progress log to this stream (default process.stderr). */
  logStream?: { write(s: string): void };
  /** Tap every progress event (e.g. to feed the dashboard). */
  onEvent?: (ev: ProgressEvent) => void;
  /** Receive normalized transcript deltas for the dashboard conversation view. */
  onTranscript?: (d: TranscriptDelta) => void;
  /** Resolve a human-in-the-loop question. */
  onQuestion?: (input: {
    question: string;
    options?: string[];
    timeoutMs?: number;
  }) => Promise<string | null>;
  /** Codex sandbox policy applied to sub-agent threads (default "workspace-write"). */
  sandboxMode?: string;
}

/**
 * Deferred thread state: allocated on `createSubSession`, started lazily on
 * the first `runAgent` for that session. This avoids calling `startThread`
 * before the model is known (model comes from `AgentRequest`, not session opts).
 */
interface DeferredSession {
  thread: ThreadLike | null;
  translator: CodexTranscriptTranslator;
  started: boolean;
}

/**
 * Implements the host-agnostic {@link HostAdapter} on top of `@openai/codex-sdk`.
 *
 * Each sub-session maps to one Codex thread (started lazily on the first turn).
 * Each `runAgent` call is one streamed turn. Token usage comes from
 * `turn.completed`. Cost is always 0 (Codex exposes no per-turn USD). Structured
 * output uses the turn's `outputSchema`; the core re-validates with ajv.
 */
export class CodexAdapter implements HostAdapter {
  readonly rootDirectory: string;
  readonly capabilities = { structuredOutput: true } as const;

  private readonly directory: string;
  private readonly logStream: { write(s: string): void };
  private readonly onEvent?: CodexAdapterOptions["onEvent"];
  private readonly onTranscript?: CodexAdapterOptions["onTranscript"];
  private readonly onQuestion?: CodexAdapterOptions["onQuestion"];
  private readonly sandboxMode: string;
  private readonly sessions = new Map<string, DeferredSession>();
  private counter = 0;

  constructor(
    private readonly codex: CodexLike,
    opts: CodexAdapterOptions,
  ) {
    this.rootDirectory = opts.rootDirectory;
    this.directory = opts.directory ?? opts.rootDirectory;
    this.logStream = opts.logStream ?? process.stderr;
    this.onEvent = opts.onEvent;
    this.onTranscript = opts.onTranscript;
    this.onQuestion = opts.onQuestion;
    this.sandboxMode = opts.sandboxMode ?? "workspace-write";
  }

  /**
   * Allocates a synthetic session id and deferred thread state. Does NOT start
   * a thread — model is unknown at this point (it comes from `AgentRequest`).
   */
  async createSubSession(_parentId: string | undefined, _title: string): Promise<string> {
    const id = `codex-sub-${++this.counter}`;
    this.sessions.set(id, {
      thread: null,
      translator: new CodexTranscriptTranslator(),
      started: false,
    });
    return id;
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    if (req.signal.aborted) return abortedResult();

    const session = this.sessions.get(req.sessionId);
    if (!session) {
      return erroredResult(`unknown codex session ${req.sessionId}`, false);
    }

    // Lazy thread start: first runAgent on this session creates the thread.
    if (!session.started) {
      const threadOpts: ThreadOptions = {
        workingDirectory: req.directory ?? this.directory,
        sandboxMode: this.sandboxMode,
        skipGitRepoCheck: true,
        ...(req.model ? { model: req.model.modelID } : {}),
      };
      session.thread = this.codex.startThread(threadOpts);
      session.started = true;
    }

    const thread = session.thread!;

    const turnOpts: TurnOptions = {
      signal: req.signal,
      ...(req.schema ? { outputSchema: req.schema } : {}),
    };

    let text = "";
    const tokens = { input: 0, output: 0, reasoning: 0 };
    let failureMessage: string | undefined;

    try {
      const turn = await thread.runStreamed(req.prompt, turnOpts);
      for await (const event of this.withAbort(turn.events, req.signal)) {
        for (const delta of session.translator.translate(req.sessionId, event)) {
          this.onTranscript?.(delta);
        }
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          text = (event.item as { id: string; type: "agent_message"; text: string }).text;
        } else if (event.type === "turn.completed") {
          tokens.input = event.usage.input_tokens;
          tokens.output = event.usage.output_tokens;
          tokens.reasoning = event.usage.reasoning_output_tokens;
        } else if (event.type === "turn.failed") {
          failureMessage = event.error.message;
        } else if (event.type === "error") {
          failureMessage = event.message;
        }
      }
    } catch (err) {
      if (req.signal.aborted) return abortedResult();
      const cls = classifyCodexError(err);
      return {
        text,
        tokens,
        cost: 0,
        aborted: false,
        errored: true,
        retriable: cls.retriable,
        errorDetail: describeError(err),
      };
    }

    if (req.signal.aborted) return abortedResult();

    if (failureMessage !== undefined) {
      const cls = classifyCodexError(failureMessage);
      return {
        text,
        tokens,
        cost: 0,
        aborted: false,
        errored: true,
        retriable: cls.retriable,
        errorDetail: failureMessage,
      };
    }

    const structured = req.schema ? tryParseJson(text) : undefined;
    return {
      text,
      tokens,
      cost: 0,
      aborted: false,
      errored: false,
      ...(structured !== undefined ? { structured } : {}),
    };
  }

  async listAgents(): Promise<HostAgentInfo[]> {
    return [];
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async createWorktree(
    baseDir: string,
    id: string,
  ): Promise<{ dir: string; cleanup(): Promise<void> }> {
    return createWorktreeShared(baseDir, id, (s) => this.logStream.write(s));
  }

  async askQuestion(input: {
    question: string;
    options?: string[];
    timeoutMs?: number;
  }): Promise<string | null> {
    if (!this.onQuestion) return null;
    return this.onQuestion(input);
  }

  report(ev: ProgressEvent): void {
    try {
      this.onEvent?.(ev);
    } catch {
      // A dashboard tap must never break a run.
    }
  }

  /** Stops yielding events as soon as the abort signal fires. */
  private async *withAbort(
    events: AsyncGenerator<CodexEvent>,
    signal: AbortSignal,
  ): AsyncGenerator<CodexEvent> {
    for await (const ev of events) {
      if (signal.aborted) return;
      yield ev;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function abortedResult(): AgentResult {
  return {
    text: "",
    tokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    aborted: true,
    errored: false,
  };
}

function erroredResult(detail: string, retriable: boolean): AgentResult {
  return {
    text: "",
    tokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    aborted: false,
    errored: true,
    retriable,
    errorDetail: detail,
  };
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Classify a Codex error into {retriable}:
 * - 429 / rate-limit / 5xx / timeout / network / overloaded → retriable
 * - 401 / 403 / 400 / invalid / auth / not-found → terminal
 * - unknown → retriable (transient until proven otherwise)
 */
function classifyCodexError(error: unknown): { retriable: boolean } {
  const text = (typeof error === "string" ? error : describeError(error)).toLowerCase();
  if (
    /\b(401|403|invalid|unauthor|permission|bad\s*request|400|not.?found|404)\b/.test(text)
  ) {
    return { retriable: false };
  }
  if (
    /\b(429|rate.?limit|5\d\d|timeout|timed.?out|econn|network|socket|overloaded)\b/.test(text)
  ) {
    return { retriable: true };
  }
  return { retriable: true };
}

function describeError(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
