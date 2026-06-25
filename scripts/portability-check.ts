/**
 * CI guard for cross-host portability. Two offline checks per example workflow:
 *
 *  1. STATIC — `validateScript` proves the script obeys the portable contract
 *     (pure-literal meta, no TS, no forbidden APIs, within limits). A passing
 *     script is loadable on BOTH Claude Code and opencode.
 *  2. DRY-RUN — execute the script on the host-agnostic `@workflow/core` engine
 *     (the exact engine opencode uses, and a faithful model of CC's contract)
 *     with a deterministic mock host. This proves the script actually RUNS to
 *     completion and yields a stable result shape — not just that it parses.
 *
 * Note: a fully automated CC-vs-opencode behavioural diff is NOT possible —
 * Claude Code's Workflow runtime is closed and cannot be invoked programmatically.
 * Portability here means contract-conformance (check 1) plus identical core
 * semantics (check 2). For a true two-host comparison, run the same example with
 * the CC Workflow tool and eyeball the result shape printed below.
 *
 * Run: bun run scripts/portability-check.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatIssues,
  runWorkflow,
  validateScript,
  type AgentRequest,
  type AgentResult,
  type HostAdapter,
} from "../packages/core/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "packages", "spec", "examples");

/** Deterministic mock host: echoes prompts, never calls a model. */
class DryRunHost implements HostAdapter {
  readonly rootDirectory = examplesDir;
  private seq = 0;
  async runAgent(req: AgentRequest): Promise<AgentResult> {
    return {
      text: `dry-run:${req.prompt.slice(0, 24)}`,
      tokens: { input: 0, output: 1, reasoning: 0 },
      cost: 0,
      aborted: false,
      errored: false,
    };
  }
  async createSubSession(): Promise<string> {
    return `dry-${++this.seq}`;
  }
  async listAgents(): Promise<[]> {
    return [];
  }
  report(): void {}
}

/** A compact, stable description of a value's shape for cross-host comparison. */
function shape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length}×${value.length ? shape(value[0]) : "any"}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${shape((value as Record<string, unknown>)[k])}`).join(", ")}}`;
  }
  return typeof value;
}

const entries = await readdir(examplesDir);
const files = entries.filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort();

let failed = 0;
for (const file of files) {
  const source = await readFile(join(examplesDir, file), "utf8");

  // 1. static contract check
  const result = validateScript(source);
  const warnings = result.issues.filter((i) => i.severity === "warning");
  if (!result.ok) {
    failed++;
    process.stdout.write(`✗ ${file} (static)\n${formatIssues(result.issues)}\n`);
    continue;
  }

  // 2. offline dry-run on the shared core engine
  try {
    const out = await runWorkflow(source, {
      adapter: new DryRunHost(),
      runId: `portability-${file}`,
      config: { sleep: async () => {}, now: () => 0, schemaRetries: 0, args: {} },
    });
    const warn = warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})` : "";
    process.stdout.write(`✓ ${file}${warn} → shape ${shape(out.result)} · ${out.agents} agents\n`);
    if (warnings.length) process.stdout.write(`${formatIssues(warnings)}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`✗ ${file} (dry-run threw): ${(err as Error).message}\n`);
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} example workflows are portable (static + dry-run).\n`);
process.exit(failed ? 1 : 0);
