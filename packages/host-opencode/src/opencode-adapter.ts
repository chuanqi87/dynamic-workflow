import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  HostAgentInfo,
  ProgressEvent,
} from "@workflow/core";

const ABORTED = Symbol("aborted");

export interface OpencodeAdapterOptions {
  /** Root working directory (PluginInput.directory). */
  rootDirectory: string;
  /** Directory scope passed to session create/prompt. Defaults to rootDirectory. */
  directory?: string;
  /** Emit opencode TUI toasts for milestones (default true; false for headless). */
  toast?: boolean;
  /** Write a one-line progress log to this stream (default process.stderr). */
  logStream?: { write(s: string): void };
  /** Tap every progress event (e.g. to feed the web dashboard). */
  onEvent?: (ev: ProgressEvent) => void;
}

/**
 * Implements the host-agnostic {@link HostAdapter} on top of the opencode SDK.
 *
 * All the platform specifics — sub-sessions, prompt turns, token accounting,
 * abort, agent discovery, toasts — live here. The core never sees the SDK.
 */
export class OpencodeAdapter implements HostAdapter {
  readonly rootDirectory: string;
  private readonly directory: string;
  private readonly toast: boolean;
  private readonly logStream: { write(s: string): void };
  private readonly onEvent?: (ev: ProgressEvent) => void;
  /** Per-session count of assistant messages already accounted for. */
  private readonly counted = new Map<string, number>();

  constructor(
    private readonly client: OpencodeClient,
    opts: OpencodeAdapterOptions,
  ) {
    this.rootDirectory = opts.rootDirectory;
    this.directory = opts.directory ?? opts.rootDirectory;
    this.toast = opts.toast ?? true;
    this.logStream = opts.logStream ?? process.stderr;
    this.onEvent = opts.onEvent;
  }

  async createSubSession(parentId: string | undefined, title: string): Promise<string> {
    const res = await this.client.session.create({
      body: { parentID: parentId, title },
      query: { directory: this.directory },
    });
    if (!res.data) {
      throw new Error(`failed to create session: ${describe(res.error)}`);
    }
    return res.data.id;
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    if (req.signal.aborted) return abortedResult();

    const promptCall = this.client.session.prompt({
      path: { id: req.sessionId },
      query: { directory: req.directory ?? this.directory },
      body: {
        ...(req.model ? { model: req.model } : {}),
        ...(req.agent ? { agent: req.agent } : {}),
        ...(req.system ? { system: req.system } : {}),
        parts: [{ type: "text", text: req.prompt }],
      },
    });

    const outcome = await this.race(promptCall, req);
    if (outcome === ABORTED) {
      void this.client.session.abort({ path: { id: req.sessionId } }).catch(() => undefined);
      return abortedResult();
    }

    const data = outcome.data;
    if (!data) {
      // No 200 payload — a transport/HTTP/validation error.
      const cls = classifyError(outcome.error);
      return {
        text: "",
        tokens: { input: 0, output: 0, reasoning: 0 },
        cost: 0,
        aborted: cls.aborted,
        errored: !cls.aborted,
        retriable: cls.retriable,
        errorDetail: describe(outcome.error),
      };
    }

    const info = data.info;
    const text = data.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");

    // Account the FULL cost/tokens of this turn (incl. tool-loop assistant
    // messages), not just the final message. Per-session offset prevents
    // double-counting across schema retries on the same session.
    const usage = await this.turnUsage(req.sessionId, info);

    if (info.error != null) {
      const cls = classifyError(info.error);
      return {
        text,
        tokens: usage.tokens,
        cost: usage.cost,
        aborted: cls.aborted,
        errored: !cls.aborted,
        retriable: cls.retriable,
        errorDetail: describe(info.error),
      };
    }

    return {
      text,
      tokens: usage.tokens,
      cost: usage.cost,
      aborted: false,
      errored: false,
    };
  }

  /** Close (abort) a sub-session — used by the engine on cancellation. */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    this.counted.delete(sessionId);
  }

  /** Sum tokens/cost of assistant messages produced since the last turn. */
  private async turnUsage(
    sessionId: string,
    info: { tokens: { input: number; output: number; reasoning: number }; cost: number },
  ): Promise<{ tokens: { input: number; output: number; reasoning: number }; cost: number }> {
    try {
      const res = await this.client.session.messages({ path: { id: sessionId } });
      const items = (res.data ?? []) as Array<{ info?: AnyMessage } | AnyMessage>;
      const assistants = items
        .map((it) => ("info" in it && it.info ? it.info : (it as AnyMessage)))
        .filter((m) => m && m.role === "assistant");
      const already = this.counted.get(sessionId) ?? 0;
      const fresh = assistants.slice(already);
      this.counted.set(sessionId, assistants.length);
      if (fresh.length === 0) {
        return { tokens: pickTokens(info), cost: info.cost };
      }
      return {
        tokens: {
          input: sum(fresh, (m) => m.tokens?.input ?? 0),
          output: sum(fresh, (m) => m.tokens?.output ?? 0),
          reasoning: sum(fresh, (m) => m.tokens?.reasoning ?? 0),
        },
        cost: sum(fresh, (m) => m.cost ?? 0),
      };
    } catch {
      // Fall back to the single returned message on any error.
      return { tokens: pickTokens(info), cost: info.cost };
    }
  }

  async listAgents(): Promise<HostAgentInfo[]> {
    const res = await this.client.app.agents();
    return (res.data ?? []).map((a) => ({ name: a.name, mode: a.mode, model: a.model }));
  }

  report(ev: ProgressEvent): void {
    try {
      this.onEvent?.(ev);
    } catch {
      // a dashboard tap must never break a run
    }
    this.logStream.write(`${formatEvent(ev)}\n`);
    if (!this.toast) return;
    const toast = toastFor(ev);
    if (toast) {
      void this.client.tui
        .showToast({ body: { message: toast.message, variant: toast.variant } })
        .catch(() => undefined);
    }
  }

  /** Race a prompt against the master signal and an optional timeout. */
  private async race<T>(
    call: Promise<T>,
    req: AgentRequest,
  ): Promise<T | typeof ABORTED> {
    const cancel = new Promise<typeof ABORTED>((resolve) => {
      const onAbort = (): void => resolve(ABORTED);
      if (req.signal.aborted) return resolve(ABORTED);
      req.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const timeout =
      req.timeoutMs && req.timeoutMs > 0
        ? new Promise<typeof ABORTED>((resolve) => {
            timers.push(setTimeout(() => resolve(ABORTED), req.timeoutMs));
          })
        : null;
    try {
      return await Promise.race(timeout ? [call, cancel, timeout] : [call, cancel]);
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  }
}

function abortedResult(): AgentResult {
  return {
    text: "",
    tokens: { input: 0, output: 0, reasoning: 0 },
    cost: 0,
    aborted: true,
    errored: false,
  };
}

interface AnyMessage {
  role?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number };
}

function pickTokens(info: {
  tokens: { input: number; output: number; reasoning: number };
}): { input: number; output: number; reasoning: number } {
  return {
    input: info.tokens.input,
    output: info.tokens.output,
    reasoning: info.tokens.reasoning,
  };
}

function sum<T>(items: T[], get: (item: T) => number): number {
  return items.reduce((acc, it) => acc + get(it), 0);
}

/**
 * Classify a host error into {aborted, retriable}. opencode's APIError carries
 * an authoritative `data.isRetryable`; other shapes map by name/status.
 */
function classifyError(error: unknown): { aborted: boolean; retriable: boolean } {
  const e = error as { name?: string; data?: { isRetryable?: boolean; statusCode?: number } } | null;
  const name = e?.name;
  if (name === "MessageAbortedError") return { aborted: true, retriable: false };
  if (name === "APIError") {
    if (typeof e?.data?.isRetryable === "boolean") {
      return { aborted: false, retriable: e.data.isRetryable };
    }
    const code = e?.data?.statusCode ?? 0;
    return { aborted: false, retriable: code === 429 || code >= 500 };
  }
  // Terminal: auth, output-too-long, bad request, not found.
  if (
    name === "ProviderAuthError" ||
    name === "MessageOutputLengthError" ||
    name === "NotFoundError"
  ) {
    return { aborted: false, retriable: false };
  }
  // BadRequestError has no `name`; treat malformed requests as terminal.
  if (e && typeof e === "object" && "success" in e && (e as { success?: boolean }).success === false) {
    return { aborted: false, retriable: false };
  }
  // Unknown / transport error → retry (transient until proven otherwise).
  return { aborted: false, retriable: true };
}

function describe(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatEvent(ev: ProgressEvent): string {
  switch (ev.type) {
    case "run-start":
      return `▶ workflow "${ev.meta.name}" (run ${ev.runId})`;
    case "phase":
      return `── phase: ${ev.title} ──`;
    case "log":
      return `· ${ev.message}`;
    case "agent-start":
      return `  → ${ev.label}${ev.phase ? ` [${ev.phase}]` : ""}`;
    case "agent-done":
      return `  ✓ ${ev.label} (spent ${ev.tokens} out-tok)`;
    case "agent-null":
      return `  ✗ ${ev.label}: ${ev.reason} (${ev.category})`;
    case "agent-retry":
      return `  ↻ ${ev.label} retry ${ev.attempt}: ${ev.reason.split("\n")[0]}`;
    case "dropped":
      return `  ⊘ ${ev.scope}[${ev.index}] dropped: ${ev.reason}`;
    case "warning":
      return `⚠ ${ev.message}`;
    case "run-end":
      return `■ workflow ${ev.ok ? "ok" : "failed"} — ${ev.agents} agents, ${ev.spent} out-tok`;
  }
}

function toastFor(
  ev: ProgressEvent,
): { message: string; variant: "info" | "success" | "warning" | "error" } | null {
  switch (ev.type) {
    case "run-start":
      return { message: `workflow "${ev.meta.name}" started`, variant: "info" };
    case "phase":
      return { message: ev.title, variant: "info" };
    case "warning":
      return { message: ev.message, variant: "warning" };
    case "run-end":
      return {
        message: `workflow ${ev.ok ? "finished" : "failed"} (${ev.agents} agents)`,
        variant: ev.ok ? "success" : "error",
      };
    default:
      return null;
  }
}
