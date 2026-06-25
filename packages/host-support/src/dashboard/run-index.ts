import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunSummary } from "@workflow/core";

export type IndexStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RunIndexEntry {
  runId: string;
  name: string;
  status: IndexStatus;
  startedAt: number;
  endedAt?: number;
  agents?: number;
  summary?: RunSummary;
  /** Final workflow output (truncated), so background runs are retrievable. */
  result?: string;
}

/** Path to the cross-run index under `<directory>/.workflow/`. */
export function indexPath(directory: string): string {
  return join(directory, ".workflow", "index.jsonl");
}

/**
 * Append-only, last-write-wins run index. Survives process restarts so the
 * dashboard can show history and crash recovery can flag interrupted runs.
 * Appending (vs rewriting) keeps concurrent writers safe and crash-tolerant.
 */
export class RunIndex {
  private queue: Promise<void> = Promise.resolve();
  private ensured = false;

  constructor(private readonly path: string) {}

  record(entry: RunIndexEntry): void {
    const line = JSON.stringify(entry);
    this.queue = this.queue
      .then(async () => {
        if (!this.ensured) {
          await mkdir(dirname(this.path), { recursive: true });
          this.ensured = true;
        }
        await appendFile(this.path, `${line}\n`);
      })
      .catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  /** Read the index, reducing to the latest entry per runId (newest first). */
  async readAll(): Promise<RunIndexEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const byId = new Map<string, RunIndexEntry>();
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as RunIndexEntry;
        if (e.runId) byId.set(e.runId, e);
      } catch {
        // tolerate a torn final line
      }
    }
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  }
}
