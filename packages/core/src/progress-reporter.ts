import type { HostAdapter, NullReason, ProgressEvent, RunSummary } from "./types.js";

/**
 * Façade over {@link HostAdapter.report} that also accumulates a run summary.
 * Centralizes progress emission so the runtime never touches the adapter's
 * reporting directly, and so observability counters have one origin.
 */
export class ProgressReporter {
  private agents = 0;
  private succeeded = 0;
  private retries = 0;
  private dropped = 0;
  private readonly nullsByReason: Record<NullReason, number> = {
    budget: 0,
    aborted: 0,
    timeout: 0,
    apiError: 0,
    schema: 0,
  };

  constructor(private readonly adapter: HostAdapter) {}

  private emit(ev: ProgressEvent): void {
    try {
      void this.adapter.report(ev);
    } catch {
      // Reporting must never break a run.
    }
  }

  runStart(ev: Extract<ProgressEvent, { type: "run-start" }>): void {
    this.emit(ev);
  }
  phase(title: string): void {
    this.emit({ type: "phase", title });
  }
  log(message: string): void {
    this.emit({ type: "log", message });
  }
  agentStart(label: string, phase?: string, sessionId?: string): void {
    this.agents++;
    this.emit({ type: "agent-start", label, phase, sessionId });
  }
  agentDone(label: string, tokens: number, cost: number, sessionId?: string): void {
    this.succeeded++;
    this.emit({ type: "agent-done", label, tokens, cost, sessionId });
  }
  agentNull(label: string, reason: string, category: NullReason, sessionId?: string): void {
    this.nullsByReason[category]++;
    this.emit({ type: "agent-null", label, reason, category, sessionId });
  }
  agentRetry(label: string, attempt: number, reason: string, sessionId?: string): void {
    this.retries++;
    this.emit({ type: "agent-retry", label, attempt, reason, sessionId });
  }
  dropFromBatch(scope: "parallel" | "pipeline", index: number, reason: string): void {
    this.dropped++;
    this.emit({ type: "dropped", scope, index, reason });
  }
  warning(message: string): void {
    this.emit({ type: "warning", message });
  }
  runEnd(ok: boolean, spent: number, summary: RunSummary): void {
    this.emit({ type: "run-end", ok, spent, agents: summary.agents, summary });
  }

  /** Build the run summary. Tokens/cost come from the authoritative budget. */
  summary(durationMs: number, outputTokens: number, costUsd: number): RunSummary {
    return {
      agents: this.agents,
      succeeded: this.succeeded,
      nullsByReason: { ...this.nullsByReason },
      retries: this.retries,
      dropped: this.dropped,
      outputTokens,
      costUsd,
      durationMs,
    };
  }
}
