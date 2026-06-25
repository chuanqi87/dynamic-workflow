import { RunRegistry } from "./dashboard/run-registry.js";
import { RunIndex, type IndexStatus, type RunIndexEntry } from "./dashboard/run-index.js";
import type { RunSummary } from "@workflow/core";

export interface RunManagerOptions {
  /** Path to the persistent run index; omit to disable persistence. */
  indexPath?: string;
  now?: () => number;
}

/**
 * Process-level owner of workflow runs: the dashboard {@link RunRegistry} (live
 * view), per-run {@link AbortController}s (cancellation across tool calls), and
 * the persistent {@link RunIndex} (history + crash recovery). Plugin-feasible
 * equivalent of the fork's DB-backed run lifecycle.
 */
const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

interface Pending {
  resolve: (answer: string | null) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class RunManager {
  readonly registry: RunRegistry;
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, Pending>();
  private readonly index?: RunIndex;
  private readonly now: () => number;

  constructor(opts: RunManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.registry = new RunRegistry(this.now);
    if (opts.indexPath) this.index = new RunIndex(opts.indexPath);
  }

  /** Register a run; returns a signal aborted by cancel() or the external one. */
  begin(runId: string, name: string, mainSessionId?: string, external?: AbortSignal): AbortSignal {
    const ac = new AbortController();
    if (external) {
      if (external.aborted) ac.abort();
      else external.addEventListener("abort", () => ac.abort(), { once: true });
    }
    this.controllers.set(runId, ac);
    this.registry.startRun(runId, name, mainSessionId);
    this.index?.record({ runId, name, status: "running", startedAt: this.now() });
    return ac.signal;
  }

  /** Mark a run terminal and persist it (optionally with its final result). */
  finish(runId: string, status: IndexStatus, summary?: RunSummary, result?: string): void {
    this.resolvePending(runId, null);
    this.controllers.delete(runId);
    const run = this.registry.get(runId);
    this.index?.record({
      runId,
      name: run?.name ?? runId,
      status,
      startedAt: run?.startedAt ?? this.now(),
      endedAt: this.now(),
      agents: run?.agents.length,
      summary,
      ...(result !== undefined ? { result } : {}),
    });
  }

  /** Abort a run by id. Returns false if it is not currently in-flight. */
  cancel = (runId: string): boolean => {
    const ac = this.controllers.get(runId);
    if (!ac) return false;
    this.resolvePending(runId, null); // unblock any awaited question()
    ac.abort();
    return true;
  };

  /**
   * Pause a run awaiting a human answer. Resolves when {@link answer} is called,
   * or to null after `timeoutMs` (default 10min). One pending question per run.
   */
  ask = (
    runId: string,
    question: string,
    options?: string[],
    timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
  ): Promise<string | null> => {
    this.resolvePending(runId, null); // supersede any prior pending question
    this.registry.setPendingQuestion(runId, { question, options });
    return new Promise<string | null>((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => this.resolvePending(runId, null), timeoutMs)
          : undefined;
      this.pending.set(runId, { resolve, timer });
    });
  };

  /** Answer a run's pending question. Returns false if none is pending. */
  answer = (runId: string, value: string | null): boolean => {
    if (!this.pending.has(runId)) return false;
    this.resolvePending(runId, value);
    return true;
  };

  private resolvePending(runId: string, value: string | null): void {
    const p = this.pending.get(runId);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(runId);
    this.registry.clearPendingQuestion(runId);
    p.resolve(value);
  }

  /** True while the run is in-flight in this process. */
  isActive(runId: string): boolean {
    return this.controllers.has(runId);
  }

  /** Live runs in this process (newest first). */
  list(): ReturnType<RunRegistry["list"]> {
    return this.registry.list();
  }

  /** Persisted history across processes. */
  history(): Promise<RunIndexEntry[]> {
    return this.index ? this.index.readAll() : Promise.resolve([]);
  }

  async flush(): Promise<void> {
    await this.index?.flush();
  }

  /**
   * On startup: load history into the registry so the dashboard shows past runs,
   * and flag any run still marked "running" (no live controller) as interrupted
   * — i.e. it was killed mid-flight by a process crash.
   */
  async recover(): Promise<RunIndexEntry[]> {
    if (!this.index) return [];
    const all = await this.index.readAll();
    const orphans = all.filter((e) => e.status === "running" && !this.controllers.has(e.runId));
    for (const o of orphans) {
      this.index.record({ ...o, status: "interrupted", endedAt: this.now() });
    }
    const recovered = all.map((e) =>
      e.status === "running" && !this.controllers.has(e.runId)
        ? { ...e, status: "interrupted" as IndexStatus }
        : e,
    );
    this.registry.importHistory(recovered);
    return orphans;
  }
}
