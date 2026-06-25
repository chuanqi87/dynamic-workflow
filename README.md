# opencode-dynamic-workflow

Bring Claude Code's **dynamic workflow** capability to opencode — and make every
workflow script **portable across both hosts**. Write one workflow script; run it
unchanged on Claude Code's native `Workflow` tool *or* on opencode via this
plugin.

A workflow is plain JavaScript that orchestrates sub-agents deterministically:

```js
export const meta = {
  name: "review-files",
  description: "Review files for bugs, then verify each finding.",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

const reviewed = await pipeline(
  args.files,
  (_, file) => agent(`Review ${file} for bugs.`, { schema: FINDINGS }),
  (review) => parallel((review?.findings ?? []).map((f) => () =>
    agent(`Verify: ${f.issue}`, { schema: VERDICT }).then((v) => ({ ...f, verdict: v })))),
);
return { confirmed: reviewed.flat().filter(Boolean).filter((f) => f.verdict?.real) };
```

The portability contract is defined once in
[`packages/spec/WORKFLOW_SCRIPT_SPEC.md`](./packages/spec/WORKFLOW_SCRIPT_SPEC.md).

## How portability works

Claude Code's workflow runtime is native and closed. We don't change it — we
mirror its contract. The host-agnostic `@workflow/core` engine injects the same
ambient globals (`agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`,
`args`, `budget`) and enforces the same sandbox rules. `@workflow/host-opencode`
maps those onto the opencode SDK. Result: the same bytes run on both hosts.

```
@workflow/core           host-agnostic runtime (sandbox, validator, orchestration)
  └── HostAdapter        the only boundary to a platform
@workflow/host-opencode  opencode adapter + plugin + headless CLI
@workflow/spec           the contract, the authoring guide, and example scripts
```

## Install & build

```sh
bun install
bun run build      # tsc -b across packages
bun test packages/core/src packages/host-opencode/src
bun run scripts/portability-check.ts   # validate examples against the contract
```

## Use it in opencode

There are three entry points; all share the same engine.

### 1. The `workflow` tool (LLM-callable)

Register the plugin globally or per-project.

- **Global**: symlink/copy the built plugin into `~/.config/opencode/plugins/`,
  or add it to `~/.config/opencode/opencode.json`:

  ```json
  {
    "plugin": [
      ["@workflow/host-opencode", {
        "concurrency": 3,
        "budgetTotal": 500000,
        "modelMap": { "opus": { "providerID": "anthropic", "modelID": "claude-opus-4-8" } },
        "agentTypeMap": { "Explore": "explore", "general-purpose": "general" }
      }]
    ]
  }
  ```

The model can then call the `workflow` tool with one of `script` (inline),
`scriptPath`, or `name` (a file under `.opencode/workflows/`), plus optional
`input` (exposed to the script as `args`). The tool description embeds the full
authoring guide, so the model can also **write** conforming workflows.

### 2. The `/workflow` command (user-triggered)

The plugin injects a `/workflow <scriptPath-or-name>` command that drives the
same tool.

### 3. Headless CLI

```sh
workflow-run path/to/my.workflow.js --args '{"files":["src/a.ts"]}' --concurrency 3 --budget 200000
```

Runs the script outside a chat using an embedded opencode server — ideal for CI,
batch runs, and verifying cross-host parity.

## Configuration (plugin options)

| option | type | default | meaning |
|---|---|---|---|
| `concurrency` | number | `min(16, cores-2)` | max in-flight sub-agents |
| `budgetTotal` | number \| null | `null` | output-token ceiling (hard) |
| `budgetMode` | `"throw"` \| `"degrade"` | `"throw"` | on exhaustion: throw (Claude-Code-compatible) or return `null` |
| `agentTimeoutMs` | number | none | per-agent timeout |
| `globalTimeoutMs` | number | none | whole-run wall-clock timeout (aborts the run) |
| `retry` | object | `{retries:3,baseMs:500,factor:2,maxMs:8000,jitter:0.2}` | transient-error retry/backoff |
| `schemaRetries` | number | `2` | retries for schema-constrained output |
| `maxJournalEntries` | number | unbounded | cap on in-memory cached results |
| `modelMap` | record | `{}` | logical model name → `{ providerID, modelID }` |
| `effortMap` | record | sensible | effort tier → logical model name |
| `agentTypeMap` | record | `{}` | Claude-Code agent type → opencode subagent |
| `defaultModel` | string | inherit | logical model when none is specified |
| `dashboard` | boolean | `true` | enable the live web dashboard (opencode-only) |
| `dashboardPort` | number | `4178` | preferred dashboard port (auto-increments if busy) |

### Live web dashboard (opencode-only)

When a workflow runs under opencode, the plugin starts a small **localhost web
dashboard** (printed as a toast, e.g. `http://127.0.0.1:4178`) where you can
watch, in real time:

- the **workflow progress tree** — phases → agents with live status
  (running / done / null+reason / retrying), tokens and retries, plus the run
  summary;
- **each agent's conversation** — click an agent to stream its sub-session
  messages live;
- the **main agent's conversation** — the parent session that launched the run.

Progress comes from the workflow's own events; conversations come from opencode's
message stream (captured via the plugin `event` hook, scoped to the run's
sessions only — your ordinary chat is never captured). It needs no opencode
source changes and is disabled with `{ "dashboard": false }`. This feature is
**not** part of the portable contract — it only exists on the opencode host.

### DFX / reliability

Built for long-running multi-agent runs: transient errors (429/5xx/network) are
retried with exponential backoff; the token budget is a hard ceiling (throws,
matching the contract); failed sub-agents degrade to `null` and are surfaced in
a **run summary** (`succeeded`, `nullsByReason`, `retries`, `dropped`,
`outputTokens`, `costUsd`, `durationMs`); `parallel`/`pipeline` log every dropped
item (no silent caps); sub-sessions are aborted on cancel; and runs are
**resumable** — pass `resume: <priorRunId>` (tool) or `--resume <runId>` (CLI) and
unchanged `agent()` calls replay from the journal while changed/failed ones run
live. The cross-host contract and its regression tests are tracked in
[`packages/spec/SPEC_TEST_MATRIX.md`](./packages/spec/SPEC_TEST_MATRIX.md).

By default models are **inherited from the host session** — configure `modelMap`
only if you want logical names like `"opus"` to resolve to specific providers.

## Status

Implemented and tested (`tsc -b` clean, 89 tests): core orchestration
(`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`), schema-constrained
output, model/agent mapping, all three entry points, a portability validator, the
DFX hardening (retry/backoff, hard budget, cross-run resume, global timeout,
session cleanup, run summary, dropped-item logging), and the opencode-only live
web dashboard. Worktree isolation is scaffolded (`isolation: "worktree"` is
accepted and degrades gracefully) for a later milestone. Contract and regression
coverage: [`packages/spec/SPEC_TEST_MATRIX.md`](./packages/spec/SPEC_TEST_MATRIX.md).

## License

MIT
