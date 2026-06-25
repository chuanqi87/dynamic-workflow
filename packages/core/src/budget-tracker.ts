import type { Budget, TokenUsage } from "./types.js";

/**
 * Tracks output-token spend against an optional ceiling.
 *
 * `total` is measured in output tokens (matching Claude Code's `budget.total`
 * semantics). The runtime treats the ceiling as a soft gate: once exhausted,
 * new `agent()` calls degrade to `null` rather than aborting in-flight work.
 */
export class BudgetTracker implements Budget {
  private spentTokens = 0;
  private spentCost = 0;

  constructor(readonly total: number | null) {}

  spent(): number {
    return this.spentTokens;
  }

  /** Total USD cost accumulated across sub-agents (for the run summary). */
  cost(): number {
    return this.spentCost;
  }

  remaining(): number {
    return this.total == null ? Infinity : Math.max(0, this.total - this.spentTokens);
  }

  /** Accumulate a finished turn's usage. Only output tokens count toward spend. */
  add(tokens: TokenUsage, cost = 0): void {
    this.spentTokens += tokens.output;
    this.spentCost += cost;
  }

  /** True when a ceiling exists and has been reached. */
  get exhausted(): boolean {
    return this.total != null && this.remaining() <= 0;
  }

  /** A read-only view safe to expose to script bodies. */
  view(): Budget {
    return {
      total: this.total,
      spent: () => this.spentTokens,
      remaining: () => this.remaining(),
    };
  }
}
