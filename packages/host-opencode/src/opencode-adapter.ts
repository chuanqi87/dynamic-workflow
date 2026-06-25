import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  HostAgentInfo,
  ProgressEvent,
} from "@workflow/core";

const ABORTED = Symbol("aborted");

/**
 * The v1 SDK prompt body, extended with `format` (native structured output).
 * `format` exists on the opencode server and the v2 typings but not the v1
 * client body type; this single localized cast lets the v1 client carry it.
 */
type PromptBody = NonNullable<
  NonNullable<Parameters<OpencodeClient["session"]["prompt"]>[0]>["body"]
> & {
  format?: { type: "json_schema"; schema: unknown; retryCount?: number };
};

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
  /** Resolve a human-in-the-loop question (e.g. via the dashboard / a tool). */
  onQuestion?: (input: {
    question: string;
    options?: string[];
    timeoutMs?: number;
  }) => Promise<string | null>;
  /** Tool enable/disable applied to every sub-agent prompt (host config). */
  defaultTools?: Record<string, boolean>;
  /** Per-agent-name tool enable/disable, merged over {@link defaultTools}. */
  agentTools?: Record<string, Record<string, boolean>>;
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
  private readonly onQuestion?: OpencodeAdapterOptions["onQuestion"];
  private readonly defaultTools?: Record<string, boolean>;
  private readonly agentTools?: Record<string, Record<string, boolean>>;
  /** Per-session count of assistant messages already accounted for. */
  private readonly counted = new Map<string, number>();
  /**
   * Whether native schema-constrained output (`format: json_schema`) works on
   * this server. Optimistically true; flipped off for the rest of the run if the
   * server rejects the `format` field, so later schema calls skip straight to the
   * core's portable prompt-envelope path.
   */
  private structuredSupported = true;

  /** Advertised to the core; dynamic so an older server downgrades cleanly. */
  get capabilities(): { structuredOutput: boolean } {
    return { structuredOutput: this.structuredSupported };
  }

  constructor(
    private readonly client: OpencodeClient,
    opts: OpencodeAdapterOptions,
  ) {
    this.rootDirectory = opts.rootDirectory;
    this.directory = opts.directory ?? opts.rootDirectory;
    this.toast = opts.toast ?? true;
    this.logStream = opts.logStream ?? process.stderr;
    this.onEvent = opts.onEvent;
    this.onQuestion = opts.onQuestion;
    this.defaultTools = opts.defaultTools;
    this.agentTools = opts.agentTools;
  }

  /**
   * Effective per-prompt tool map: host `defaultTools`, overlaid by the
   * resolved agent's `agentTools`. Returns undefined when nothing is configured
   * (the host then uses the agent type's own tools).
   */
  private toolsFor(req: AgentRequest): Record<string, boolean> | undefined {
    const perAgent = req.agent ? this.agentTools?.[req.agent] : undefined;
    const merged = { ...this.defaultTools, ...perAgent };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /** Host-in-the-loop: delegate to the injected resolver (dashboard / tool). */
  async askQuestion(input: {
    question: string;
    options?: string[];
    timeoutMs?: number;
  }): Promise<string | null> {
    if (!this.onQuestion) return null;
    return this.onQuestion(input);
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

    // Send native schema-constrained output only while the server is known to
    // accept it. The localized cast carries `format`/`tools`, which exist on the
    // opencode server (and the v2 SDK typings) but not on the v1 client body type.
    const sentFormat = req.schema != null && this.structuredSupported;
    const tools = this.toolsFor(req);
    const promptCall = this.client.session.prompt({
      path: { id: req.sessionId },
      query: { directory: req.directory ?? this.directory },
      body: {
        ...(req.model ? { model: req.model } : {}),
        ...(req.agent ? { agent: req.agent } : {}),
        ...(req.system ? { system: req.system } : {}),
        ...(tools ? { tools } : {}),
        ...(sentFormat
          ? { format: { type: "json_schema", schema: req.schema, retryCount: req.schemaRetries } }
          : {}),
        parts: [{ type: "text", text: req.prompt }],
      } as PromptBody,
    });

    const outcome = await this.race(promptCall, req);
    if (outcome === ABORTED) {
      void this.client.session.abort({ path: { id: req.sessionId } }).catch(() => undefined);
      return abortedResult();
    }

    const data = outcome.data;
    if (!data) {
      // No 200 payload — a transport/HTTP/validation error. A rejected `format`
      // field surfaces here (request-body validation happens before generation),
      // and only when the error specifically names format/schema do we downgrade
      // — a generic 400 (bad model, unknown agent) must stay a real error.
      if (sentFormat && isFormatRejection(outcome.error)) {
        return this.disableStructured(outcome.error);
      }
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
    // Native structured output: the server attaches the parsed object to the
    // assistant message. Read it via a narrow cast (absent on the v1 typings).
    const structured = (info as { structured?: unknown }).structured;

    // Account the FULL cost/tokens of this turn (incl. tool-loop assistant
    // messages), not just the final message. Per-session offset prevents
    // double-counting across schema retries on the same session.
    const usage = await this.turnUsage(req.sessionId, info);

    if (info.error != null) {
      // Note: a rejected `format` field is a request-validation error (the !data
      // branch above), never a mid-generation 200 error — so we do not retry the
      // format downgrade here, which also avoids dropping this turn's accounted
      // tokens and re-running the fallback on a polluted session.
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
      ...(structured !== undefined ? { structured } : {}),
    };
  }

  /**
   * The server rejected the `format` field — disable native structured output
   * for the rest of the run and tell the core to retry via its portable
   * prompt-envelope path. The turn's tokens were not produced, so report zero.
   */
  private disableStructured(error: unknown): AgentResult {
    this.structuredSupported = false;
    this.logStream.write(
      "⚠ server rejected native structured output (format); falling back to prompt-envelope\n",
    );
    return {
      text: "",
      tokens: { input: 0, output: 0, reasoning: 0 },
      cost: 0,
      aborted: false,
      errored: false,
      formatUnsupported: true,
      errorDetail: describe(error),
    };
  }

  /** Close (abort) a sub-session — used by the engine on cancellation. */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    this.counted.delete(sessionId);
  }

  /**
   * Create an isolated git worktree for an agent. On cleanup, an unchanged
   * worktree is removed; a dirty one is preserved (marked) for inspection.
   * If `baseDir` is not a git repo (or git is unavailable), gracefully degrades
   * to running in `baseDir` (no isolation) rather than failing the agent.
   */
  async createWorktree(
    baseDir: string,
    id: string,
  ): Promise<{ dir: string; cleanup(): Promise<void> }> {
    const noIsolation = { dir: baseDir, cleanup: async () => {} };
    const isRepo = await git(["rev-parse", "--is-inside-work-tree"], baseDir)
      .then((r) => r.code === 0)
      .catch(() => false);
    if (!isRepo) {
      this.logStream.write(
        "⚠ worktree isolation requested but the directory is not a git repo; running shared\n",
      );
      return noIsolation;
    }
    const dir = join(baseDir, ".workflow", "worktrees", `oc-wf-${sanitize(id)}`);
    const add = await git(["worktree", "add", "--detach", dir], baseDir);
    if (add.code !== 0) {
      this.logStream.write(`⚠ git worktree add failed (${add.stderr.trim()}); running shared\n`);
      return noIsolation;
    }
    return {
      dir,
      cleanup: async () => {
        const status = await git(["status", "--porcelain"], dir).catch(() => null);
        const dirty = !status || status.code !== 0 || status.stdout.trim() !== "";
        if (dirty) {
          await writeFile(join(dir, ".oc-wf-preserved"), `${id}\n`).catch(() => undefined);
          this.logStream.write(`⚠ worktree ${dir} has changes — preserved for inspection\n`);
          return;
        }
        await git(["worktree", "remove", "--force", dir], baseDir).catch(() => undefined);
      },
    };
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

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a git command, resolving (never rejecting) with its exit code + output. */
function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

function sanitize(s: string): string {
  return s.replace(/[^\w.-]/g, "").slice(0, 64) || "wt";
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

/** Whether an error has a 400/bad-request shape (status, name, or hey-api). */
function isBadRequest(error: unknown): boolean {
  const e = error as
    | { name?: string; statusCode?: number; data?: { statusCode?: number }; success?: boolean }
    | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "BadRequestError" || e.name === "InvalidRequestError") return true;
  const code = e.data?.statusCode ?? e.statusCode;
  if (code === 400) return true;
  // hey-api BadRequest shape: { success: false } with no name.
  if ("success" in e && e.success === false) return true;
  return false;
}

/**
 * Whether an error is specifically the opencode server rejecting the `format`
 * field (an older server without native structured output). Requires BOTH a
 * bad-request shape AND the error text naming format/schema — so a generic 400
 * (wrong model, unknown agent, malformed prompt) is NOT mistaken for it and does
 * not trigger the one-time native downgrade.
 */
function isFormatRejection(error: unknown): boolean {
  if (!isBadRequest(error)) return false;
  const text = describe(error).toLowerCase();
  return /format|json[_-]?schema|unrecognized|unknown (field|key|propert)|additional propert|unexpected (key|field|propert)/.test(
    text,
  );
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
