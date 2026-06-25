#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { runWorkflow, type RuntimeConfig } from "@workflow/core";
import {
  autoConcurrency,
  FileJournalSink,
  fileJournalSource,
  journalPath,
  shortHash,
  isCliEntry,
  parseArgv,
} from "@workflow/host-support";
import { CodexAdapter } from "./codex-adapter.js";
import type { CodexLike } from "./codex-sdk.js";
import { createCodex } from "./codex-factory.js";
import { resolveSource } from "./resolve-source.js";

// ── Public types ───────────────────────────────────────────────────────────────

export interface HeadlessCodexOptions {
  /** Workflow source (JS text). */
  source: string;
  /** Working directory for the run. */
  directory: string;
  /** Pre-constructed Codex client (injected for testability). */
  codex: CodexLike;
  /** Workflow args forwarded to the script. */
  args?: unknown;
  /** Runtime config overrides (concurrency, budget, etc.). */
  config?: RuntimeConfig;
  /** Explicit run id; auto-derived from source hash if omitted. */
  runId?: string;
  /** Resume from a prior run id. */
  resumeFromRunId?: string;
  /** Suppress the file journal (e.g. in tests). */
  noJournal?: boolean;
}

// ── Core runner ────────────────────────────────────────────────────────────────

/** Run a workflow headless on Codex; returns its result. */
export async function runHeadlessCodex(opts: HeadlessCodexOptions): Promise<unknown> {
  const adapter = new CodexAdapter(opts.codex, {
    rootDirectory: opts.directory,
    directory: opts.directory,
  });
  const runId = opts.runId ?? `codex-${shortHash(opts.source + JSON.stringify(opts.args ?? null))}`;
  const sink = opts.noJournal ? undefined : new FileJournalSink(journalPath(opts.directory, runId));

  const res = await runWorkflow(opts.source, {
    adapter,
    runId,
    journalSink: sink,
    config: {
      concurrency: autoConcurrency(),
      ...opts.config,
      args: opts.args,
      resumeFromRunId: opts.resumeFromRunId,
      journalSource: fileJournalSource(opts.directory),
      resolveWorkflowSource: (ref) =>
        resolveSource(
          typeof ref === "string" ? { name: ref } : { scriptPath: ref.scriptPath },
          opts.directory,
        ),
    },
  });
  return res.result;
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.scriptPath) {
    process.stderr.write(
      "usage: workflow-run-codex <script.js> [--args '<json>'] [--concurrency N] [--budget N] [--timeout MS] [--resume RUNID]\n",
    );
    process.exit(2);
  }
  const directory = process.cwd();
  const p = isAbsolute(parsed.scriptPath) ? parsed.scriptPath : resolve(directory, parsed.scriptPath);
  const source = await readFile(p, "utf8");
  const result = await runHeadlessCodex({
    source,
    directory,
    codex: await createCodex(),
    args: parsed.args,
    config: parsed.config,
    runId: `codex-${basename(p)}`,
    resumeFromRunId: parsed.resume,
  });
  process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
}

if (isCliEntry(import.meta.url, (import.meta as { main?: boolean }).main)) {
  main().catch((err) => {
    process.stderr.write(`workflow-run-codex failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
