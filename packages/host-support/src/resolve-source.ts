import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface SourceInput {
  script?: string;
  scriptPath?: string;
  name?: string;
}

/** Candidate files for a workflow registered by bare name, across registry dirs. */
function nameCandidates(registryDirs: string[], name: string): string[] {
  const safe = name.replace(/[^\w.-]/g, "");
  const files: string[] = [];
  for (const d of registryDirs) {
    files.push(join(d, `${safe}.workflow.js`), join(d, `${safe}.js`), join(d, `${safe}.workflow.mjs`));
  }
  return files;
}

/**
 * Resolve a {script | scriptPath | name} input to workflow source text. The
 * host supplies the registry directories searched for a bare `name`.
 */
export async function resolveSourceFrom(
  input: SourceInput,
  directory: string,
  registryDirs: string[],
): Promise<string> {
  if (input.script != null && input.script.trim() !== "") return input.script;
  if (input.scriptPath) {
    const p = isAbsolute(input.scriptPath) ? input.scriptPath : resolve(directory, input.scriptPath);
    return readFile(p, "utf8");
  }
  if (input.name) {
    for (const candidate of nameCandidates(registryDirs, input.name)) {
      try {
        return await readFile(candidate, "utf8");
      } catch {
        // try next candidate
      }
    }
    throw new Error(`workflow "${input.name}" not found under: ${registryDirs.join(", ")}`);
  }
  throw new Error("provide one of: script, scriptPath, or name");
}
