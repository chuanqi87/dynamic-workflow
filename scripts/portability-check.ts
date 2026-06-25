/**
 * CI guard: statically validate every example workflow against the portable
 * contract. A script that passes here is guaranteed to load on both Claude Code
 * and opencode (it touches only ambient globals and obeys the sandbox rules).
 *
 * Run: bun run scripts/portability-check.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatIssues, validateScript } from "../packages/core/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "packages", "spec", "examples");

const entries = await readdir(examplesDir);
const files = entries.filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).sort();

let failed = 0;
for (const file of files) {
  const source = await readFile(join(examplesDir, file), "utf8");
  const result = validateScript(source);
  const warnings = result.issues.filter((i) => i.severity === "warning");
  if (!result.ok) {
    failed++;
    process.stdout.write(`✗ ${file}\n${formatIssues(result.issues)}\n`);
  } else {
    const suffix = warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? "s" : ""})` : "";
    process.stdout.write(`✓ ${file}${suffix}\n`);
    if (warnings.length) process.stdout.write(`${formatIssues(warnings)}\n`);
  }
}

process.stdout.write(`\n${files.length - failed}/${files.length} example workflows are portable.\n`);
process.exit(failed ? 1 : 0);
