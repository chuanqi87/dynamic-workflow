import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "@workflow/core";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedArgs {
  scriptPath?: string;
  args?: unknown;
  resume?: string;
  config: RuntimeConfig;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Small stable hash for deterministic run ids (FNV-1a, hex).
 * Deterministic across calls: same input always yields same 8-hex-char output.
 */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * True when this module is the process entry point. Handles Bun
 * (`import.meta.main`) and Node — resolving symlinks so the CLI still
 * self-runs when invoked through a renamed bin wrapper.
 *
 * Callers must pass their own `import.meta.url` (and optionally
 * `(import.meta as { main?: boolean }).main`) since a shared helper cannot
 * read the caller's `import.meta`.
 */
export function isCliEntry(importMetaUrl: string, importMetaMain?: boolean): boolean {
  if (importMetaMain) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
}

/**
 * Parse the subset of CLI flags that all workflow headless runners share.
 * `argv` should be `process.argv.slice(2)`.
 */
export function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { config: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--args") out.args = JSON.parse(argv[++i] ?? "null");
    else if (a === "--concurrency") out.config.concurrency = Number(argv[++i]);
    else if (a === "--budget") out.config.budgetTotal = Number(argv[++i]);
    else if (a === "--timeout") out.config.agentTimeoutMs = Number(argv[++i]);
    else if (a === "--global-timeout") out.config.globalTimeoutMs = Number(argv[++i]);
    else if (a === "--resume") out.resume = argv[++i];
    else if (!a.startsWith("--")) out.scriptPath = a;
  }
  return out;
}
