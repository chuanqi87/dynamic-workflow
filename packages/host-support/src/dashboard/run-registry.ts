import type { AgentGroup, NullReason, ProgressEvent, RunSummary } from "@workflow/core";
import { TranscriptStore, type TranscriptDelta, type TranscriptMessage } from "./transcript-store.js";

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type AgentStatus = "running" | "done" | "null" | "retrying";

/** A persisted run entry imported as a read-only historical view. */
export interface HistoryEntry {
  runId: string;
  name: string;
  status: RunStatus;
  startedAt: number;
  summary?: RunSummary;
}

export interface AgentView {
  sessionId?: string;
  label: string;
  phase?: string;
  status: AgentStatus;
  tokens?: number;
  cost?: number;
  retries: number;
  nullReason?: NullReason;
  group?: AgentGroup;
}

export interface RunView {
  runId: string;
  name: string;
  status: RunStatus;
  mainSessionId?: string;
  currentPhase?: string;
  phases: string[];
  agents: AgentView[];
  summary?: RunSummary;
  startedAt: number;
  /** Set while the run is paused awaiting a human answer (question()). */
  pendingQuestion?: { question: string; options?: string[] };
}

export type RegistryChange = { kind: "run"; runId: string } | { kind: "session"; sessionId: string };

/**
 * In-memory store of live workflow runs for the dashboard. Progress (tree,
 * status, counters) comes from our own {@link ProgressEvent}s; conversations
 * come from host-translated {@link TranscriptDelta}s via {@link TranscriptStore}.
 */
export class RunRegistry {
  private readonly runs = new Map<string, RunView>();
  private readonly transcripts = new TranscriptStore();
  private readonly sessionToRun = new Map<string, string>();
  private readonly listeners = new Set<(c: RegistryChange) => void>();

  constructor(private readonly now: () => number = Date.now) {}

  on(listener: (c: RegistryChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(change: RegistryChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        // a broken listener must not break the run
      }
    }
  }

  startRun(runId: string, name: string, mainSessionId?: string): void {
    this.runs.set(runId, {
      runId,
      name,
      status: "running",
      mainSessionId,
      phases: [],
      agents: [],
      startedAt: this.now(),
    });
    if (mainSessionId) this.sessionToRun.set(mainSessionId, runId);
    this.notify({ kind: "run", runId });
  }

  /**
   * Import persisted runs as read-only historical views (e.g. after restart).
   * Live runs already present in memory take precedence and are not overwritten.
   */
  importHistory(entries: HistoryEntry[]): void {
    for (const e of entries) {
      if (this.runs.has(e.runId)) continue;
      this.runs.set(e.runId, {
        runId: e.runId,
        name: e.name,
        status: e.status,
        phases: [],
        agents: [],
        summary: e.summary,
        startedAt: e.startedAt,
      });
    }
    this.notify({ kind: "run", runId: entries[0]?.runId ?? "" });
  }

  /** Mark a run as awaiting a human answer (drives the dashboard prompt). */
  setPendingQuestion(runId: string, q: { question: string; options?: string[] }): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.pendingQuestion = q;
    this.notify({ kind: "run", runId });
  }

  clearPendingQuestion(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || !run.pendingQuestion) return;
    run.pendingQuestion = undefined;
    this.notify({ kind: "run", runId });
  }

  /** Feed one of our progress events into the run view. */
  applyProgress(runId: string, ev: ProgressEvent): void {
    const run = this.runs.get(runId);
    if (!run) return;
    switch (ev.type) {
      case "run-start":
        run.name = ev.meta.name;
        break;
      case "phase":
        run.currentPhase = ev.title;
        if (!run.phases.includes(ev.title)) run.phases.push(ev.title);
        break;
      case "agent-start": {
        const a: AgentView = {
          sessionId: ev.sessionId,
          label: ev.label,
          phase: ev.phase ?? run.currentPhase,
          status: "running",
          retries: 0,
          group: ev.group,
        };
        run.agents.push(a);
        if (ev.sessionId) this.sessionToRun.set(ev.sessionId, runId);
        break;
      }
      case "agent-retry": {
        const a = this.findAgent(run, ev.sessionId, ev.label);
        if (a) {
          a.status = "retrying";
          a.retries = ev.attempt;
        }
        break;
      }
      case "agent-done": {
        const a = this.findAgent(run, ev.sessionId, ev.label);
        if (a) {
          a.status = "done";
          a.tokens = ev.tokens;
          a.cost = ev.cost;
        }
        break;
      }
      case "agent-null": {
        const a = this.findAgent(run, ev.sessionId, ev.label);
        if (a) {
          a.status = "null";
          a.nullReason = ev.category;
        }
        break;
      }
      case "run-end":
        run.status = ev.ok ? "completed" : "failed";
        run.summary = ev.summary;
        break;
      default:
        break;
    }
    this.notify({ kind: "run", runId });
  }

  /**
   * Feed a normalized transcript delta into the conversation store. Only
   * sessions belonging to a known run (main or an agent) are stored, so
   * unrelated activity never accumulates in memory.
   */
  applyTranscript(delta: TranscriptDelta): void {
    if (!this.sessionToRun.has(delta.sessionId)) return;
    this.transcripts.apply(delta);
    this.notify({ kind: "session", sessionId: delta.sessionId });
  }

  get(runId: string): RunView | undefined {
    return this.runs.get(runId);
  }
  list(): RunView[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
  transcript(sessionId: string): TranscriptMessage[] {
    return this.transcripts.get(sessionId);
  }

  private findAgent(run: RunView, sessionId: string | undefined, label: string): AgentView | undefined {
    if (sessionId) {
      const bySession = run.agents.find((a) => a.sessionId === sessionId);
      if (bySession) return bySession;
    }
    // Fallback: most recent running agent with this label.
    for (let i = run.agents.length - 1; i >= 0; i--) {
      if (run.agents[i]!.label === label) return run.agents[i];
    }
    return undefined;
  }
}
