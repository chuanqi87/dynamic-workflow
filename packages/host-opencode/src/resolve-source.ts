import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface SourceInput {
  script?: string;
  scriptPath?: string;
  name?: string;
}

/** Candidate locations for a workflow registered by bare name. */
function nameCandidates(directory: string, name: string): string[] {
  const safe = name.replace(/[^\w.-]/g, "");
  const dirs = [join(directory, ".opencode", "workflows"), join(homedir(), ".config", "opencode", "workflows")];
  const files: string[] = [];
  for (const d of dirs) {
    files.push(join(d, `${safe}.workflow.js`), join(d, `${safe}.js`), join(d, `${safe}.workflow.mjs`));
  }
  return files;
}

/** Resolve a {script | scriptPath | name} input to workflow source text. */
export async function resolveSource(input: SourceInput, directory: string): Promise<string> {
  if (input.script != null && input.script.trim() !== "") {
    return input.script;
  }
  if (input.scriptPath) {
    const p = isAbsolute(input.scriptPath) ? input.scriptPath : resolve(directory, input.scriptPath);
    return readFile(p, "utf8");
  }
  if (input.name) {
    for (const candidate of nameCandidates(directory, input.name)) {
      try {
        return await readFile(candidate, "utf8");
      } catch {
        // try next candidate
      }
    }
    throw new Error(
      `workflow "${input.name}" not found under .opencode/workflows/ (project or ~/.config/opencode)`,
    );
  }
  throw new Error("provide one of: script, scriptPath, or name");
}
