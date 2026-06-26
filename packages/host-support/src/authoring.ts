import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Host-agnostic workflow authoring assets, shared by every host.
 *
 * - `AUTHORING_GUIDE`: the terse contract embedded into a host's `workflow`
 *   tool description (always-on layer). The SAME contract Claude Code's native
 *   Workflow tool honours.
 * - The `workflow-authoring` skill: the deep, on-demand layer. opencode
 *   registers `WORKFLOW_SKILLS_DIR` via `config.skills.paths`; Codex serves
 *   `readWorkflowSkill()` over MCP (prompt + a `workflow_guide` tool).
 *
 * All three authoring surfaces (this guide, the SKILL.md, and
 * `docs/spec/authoring-guide.md`) must stay in sync — change one, update the
 * others.
 */
export const AUTHORING_GUIDE = `Run a portable dynamic-workflow script that orchestrates multiple sub-agents deterministically. The SAME script runs unchanged on Claude Code, opencode, and Codex.

## Script shape
A workflow is plain JavaScript (NOT TypeScript). It MUST begin with a pure-literal meta block, then an async function body that uses ambient globals and ends with an optional \`return\`:

    export const meta = {
      name: 'find-bugs',
      description: 'Find and verify bugs',
      phases: [{ title: 'Find' }, { title: 'Verify' }],
    }
    phase('Find')
    const found = await agent('List suspicious functions in src/.', { schema: BUGS_SCHEMA })
    const verified = await parallel(found.bugs.map(b => () =>
      agent(\`Verify this bug is real: \${b.desc}\`, { schema: VERDICT_SCHEMA })))
    return verified.filter(Boolean)

\`meta\` must be a literal — no variables, calls, or template interpolation.

## Ambient globals (do NOT import them)
- \`agent(prompt, opts?)\` → without \`schema\` returns the sub-agent's final text (string); with \`schema\` (a JSON Schema object) returns a validated object; returns null if the sub-agent is skipped or dies.
  opts: { label?, phase?, schema?, model?, effort?, agentType?, isolation?: 'worktree' }
- \`parallel(thunks)\` → run \`() => Promise\` thunks concurrently; a failed thunk becomes null. Barrier: awaits all.
- \`pipeline(items, stage1, stage2, ...)\` → each item flows through all stages with NO barrier between stages; stage signature is (prevResult, item, index); a throwing stage drops that item to null.
- \`phase(title)\` / \`log(message)\` → progress reporting.
- \`workflow(nameOrRef, args?)\` → run another workflow inline (one level only).
- \`args\` → the input value passed to this run. \`budget\` → { total, spent(), remaining() } (output-token budget).

## Hard rules (enforced by a validator before the script runs)
- Plain JS only — type annotations / interfaces / generics are rejected.
- \`Date.now()\`, \`Math.random()\`, and argument-less \`new Date()\` are forbidden (scripts must be deterministic; derive any randomness/time from \`args\`).
- A single parallel()/pipeline() call takes at most 4096 items; a whole run makes at most 1000 agent() calls.

## Good practice
- Run independent agents CONCURRENTLY via parallel()/pipeline() — never \`await\` them one-by-one. Serial awaits don't save tokens; they just multiply wall-clock by the number of agents.
- The script's \`return\` value is the ONLY thing surfaced back to the session — sub-agents' intermediate output is not. Return the gathered material, not just a lossy summary, or the expensive fan-out is paid for and discarded. Always \`return\` something.
- Right-size the fan-out to the deliverable: a tiny output (e.g. a 10-line overview) does not justify a fleet of heavy explorers feeding a lossy synthesis (you pay for the detail twice — once to produce it, once to re-read it).
- Prefer pipeline() over parallel() when stages are independent — it avoids barrier latency.
- Use schema for any result you will branch on; filter nulls (\`.filter(Boolean)\`) before using parallel/pipeline results.
- Keep agent prompts self-contained; sub-agents do not share conversation state.
- Deeper authoring guidance + worked examples live in the \`workflow-authoring\` skill.

## Invoking this tool
Provide ONE of: \`script\` (inline source), \`scriptPath\` (path to a .js file), or \`name\` (a registered workflow). Optionally pass \`input\` as the workflow's \`args\`.`;

/** The on-demand authoring skill's name (its directory + frontmatter name). */
export const WORKFLOW_SKILL_NAME = "workflow-authoring";

/**
 * Absolute path to the `skills/` directory shipped inside this package,
 * resolved from this module's REAL location.
 *
 * `realpathSync` is required because a host may load its plugin/server via a
 * symlink; Node ESM does not auto-resolve symlinks, so a naive `import.meta.url`
 * would point at the symlink and break the relative lookup. From either `dist/`
 * (built) or `src/` (tests run the TS directly), the parent of this module's dir
 * is the package root, where `skills/` lives — shipped via the package `files`
 * field.
 */
const moduleDir = dirname(realpathSync(fileURLToPath(import.meta.url)));
export const PACKAGE_ROOT = dirname(moduleDir);
export const WORKFLOW_SKILLS_DIR = join(PACKAGE_ROOT, "skills");

/** Read the `workflow-authoring` SKILL.md content (for hosts without a skill dir, e.g. Codex MCP). */
export function readWorkflowSkill(): string {
  return readFileSync(join(WORKFLOW_SKILLS_DIR, WORKFLOW_SKILL_NAME, "SKILL.md"), "utf8");
}
