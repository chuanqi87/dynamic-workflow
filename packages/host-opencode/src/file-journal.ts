import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { JournalSink } from "@workflow/core";

/** A {@link JournalSink} that appends newline-delimited JSON to a file. */
export class FileJournalSink implements JournalSink {
  private queue: Promise<void> = Promise.resolve();
  private ensured = false;

  constructor(private readonly path: string) {}

  append(line: string): void {
    // Chain writes so lines never interleave; never let a write reject the run.
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

  /** Await all buffered writes — call before run-end / abort for durability. */
  async flush(): Promise<void> {
    await this.queue;
  }
}

/** Path to the journal file for a run, under `<directory>/.workflow/`. */
export function journalPath(directory: string, runId: string): string {
  return join(directory, ".workflow", `${runId}.jsonl`);
}

/**
 * A resume source that reads a prior run's journal file. Returns empty text
 * when the file is missing so resume degrades to a fresh run.
 */
export function fileJournalSource(directory: string): (runId: string) => Promise<string> {
  return async (runId: string) => {
    const path = isAbsolute(runId) ? runId : journalPath(directory, runId);
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  };
}
