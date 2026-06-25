#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencode } from "@opencode-ai/sdk";
import { runWorkflow, type RuntimeConfig } from "@workflow/core";
import { autoConcurrency, FileJournalSink, fileJournalSource, journalPath } from "@workflow/host-support";
import { OpencodeAdapter } from "./opencode-adapter.js";
import { resolveSource } from "./resolve-source.js";

export interface HeadlessOptions {
  source: string;
  directory: string;
  args?: unknown;
  config?: RuntimeConfig;
  runId?: string;
  /** Resume from a prior run id. */
  resumeFromRunId?: string;
  /** Suppress the file journal (e.g. in tests). */
  noJournal?: boolean;
}

/** Small stable hash for deterministic run ids (FNV-1a, hex). */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Run a workflow headless: spin up an embedded opencode server + client, drive
 * the core, return its result. This is the cleanest place to verify that a
 * script behaves identically on opencode and Claude Code.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<unknown> {
  const { client, server } = await createOpencode();
  try {
    const adapter = new OpencodeAdapter(client, {
      rootDirectory: opts.directory,
      directory: opts.directory,
      toast: false,
    });
    // A fresh root session parents all sub-agents for this run.
    const root = await client.session.create({
      body: { title: "workflow-run" },
      query: { directory: opts.directory },
    });
    const parentSessionId = root.data?.id;
    const runId = opts.runId ?? `cli-${shortHash(opts.source + JSON.stringify(opts.args ?? null))}`;
    const sink = opts.noJournal ? undefined : new FileJournalSink(journalPath(opts.directory, runId));

    const res = await runWorkflow(opts.source, {
      adapter,
      runId,
      journalSink: sink,
      config: {
        concurrency: autoConcurrency(),
        ...opts.config,
        args: opts.args,
        parentSessionId,
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
  } finally {
    server.close();
  }
}

export interface ParsedArgs {
  scriptPath?: string;
  args?: unknown;
  resume?: string;
  config: RuntimeConfig;
}

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

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.scriptPath) {
    process.stderr.write(
      "usage: workflow-run <script.js> [--args '<json>'] [--concurrency N] [--budget N] [--timeout MS]\n",
    );
    process.exit(2);
  }
  const directory = process.cwd();
  const p = isAbsolute(parsed.scriptPath) ? parsed.scriptPath : resolve(directory, parsed.scriptPath);
  const source = await readFile(p, "utf8");
  const result = await runHeadless({
    source,
    directory,
    args: parsed.args,
    config: parsed.config,
    runId: `cli-${basename(p)}`,
    resumeFromRunId: parsed.resume,
  });
  process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
}

/**
 * True when this module is the process entry point. Handles Bun
 * (`import.meta.main`) and Node — resolving symlinks so the CLI still self-runs
 * when invoked through a renamed bin wrapper (e.g. `workflow-run`).
 */
function isCliEntry(): boolean {
  if ((import.meta as { main?: boolean }).main) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((err) => {
    process.stderr.write(`workflow-run failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
