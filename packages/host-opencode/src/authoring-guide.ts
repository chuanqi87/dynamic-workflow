/**
 * The authoring contract injected into the `workflow` tool description so the
 * opencode model can both RUN and WRITE portable workflow scripts. This is the
 * same contract Claude Code's native Workflow tool honours — a script written
 * to it runs unchanged on both hosts.
 */
export const AUTHORING_GUIDE = `Run a portable dynamic-workflow script that orchestrates multiple sub-agents deterministically. The SAME script runs unchanged on Claude Code and opencode.

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
- Deeper authoring guidance + worked examples live in the \`workflow-authoring\` skill (opencode).

## Invoking this tool
Provide ONE of: \`script\` (inline source), \`scriptPath\` (path to a .js file), or \`name\` (a workflow registered under .opencode/workflows/). Optionally pass \`input\` as the workflow's \`args\`.`;
