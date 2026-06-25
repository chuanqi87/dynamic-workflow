import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Path to the persisted source of a run's script, under `<directory>/.workflow/scripts/`. */
export function scriptPath(directory: string, runId: string): string {
  return join(directory, ".workflow", "scripts", `${runId}.js`);
}

/**
 * Persist a generated workflow script to disk so it can be inspected, fixed, and
 * re-run via `scriptPath` + resume. Best-effort: a write failure returns
 * `undefined` rather than throwing, so it never fails the run.
 */
export async function persistScript(
  directory: string,
  runId: string,
  source: string,
): Promise<string | undefined> {
  const path = scriptPath(directory, runId);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
    return path;
  } catch {
    return undefined;
  }
}
