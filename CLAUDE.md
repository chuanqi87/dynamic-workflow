# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A portable dynamic-workflow runtime. A single workflow script — plain JavaScript that
deterministically orchestrates sub-agents via injected globals (`agent`, `parallel`,
`pipeline`, `phase`, `log`, `workflow`, `args`, `budget`) — runs **unchanged** on three
hosts: Claude Code's native `Workflow` tool, opencode via `@workflow/host-opencode`, or
OpenAI Codex via `@workflow/host-codex`. The portability contract lives in one place:
[`docs/spec/WORKFLOW_SCRIPT_SPEC.md`](./docs/spec/WORKFLOW_SCRIPT_SPEC.md).

## Commands

```sh
bun install
bun run build                                   # tsc -b across all packages + Vite dashboard build (also the typecheck)
bun run typecheck                               # alias for tsc -b only (no Vite)
bun test packages/core/test packages/host-support/test packages/host-opencode/test packages/host-codex/test  # full suite (offline)
bun test packages/core/test/engine.test.ts      # run one test file
bun test packages/core/test -t "budget"         # run tests matching a name
bun run scripts/portability-check.ts            # validate example scripts against the spec
```

`bun run build` **is** the typecheck — there is no separate lint step. The build must be
clean (`tsc -b`) before tests are meaningful, since packages reference each other's `dist`.

Live smoke tests against real models (CLI / TUI) are documented in [INSTALL.md](./INSTALL.md);
they cost money and need auth, so the offline suite above covers everything else.

## Architecture

Three packages plus `host-codex`, host-agnostic core with a single boundary to each
platform; shared host infrastructure in `host-support`; the portability contract lives
in `docs/spec/` as plain documentation (not a package):

```
@workflow/core           host-agnostic runtime (sandbox, validator, orchestration)
  └── HostAdapter        the ONLY interface to a concrete platform
@workflow/host-support   shared host infrastructure: dashboard UI, run lifecycle (RunManager),
                         worktree isolation, journal helpers, CLI argv parser, resolve-source.
                         Reused by both host-opencode and host-codex. NOT part of the
                         portability contract, but allowed to depend on the dashboard
                         (only core must stay pure).
@workflow/host-opencode  opencode adapter + plugin + headless CLI (workflow-run)
@workflow/host-codex     Codex adapter + headless CLI (workflow-run-codex) + MCP server
                         (workflow-codex-mcp). Workflow name registry: .codex/workflows/
                         (project) and ~/.codex/workflows/ (global).
docs/spec/               contract, authoring guide, example scripts (docs only, no package)
```

### The portability strategy

Claude Code's workflow runtime is native and closed. This project does **not** modify it —
it *mirrors its contract*. The core injects the same environment globals and enforces the
same sandbox rules; `@workflow/host-opencode` maps those onto the opencode SDK and
`@workflow/host-codex` maps them onto the Codex SDK. Same script, three hosts. Anything
outside the contract (e.g. the dashboard) lives in `host-support` and must not leak into
core.

### Core (`packages/core/src`)

- [engine.ts](./packages/core/src/engine.ts) — `runWorkflow(source, options)`, the single
  entry point every opencode trigger funnels through. Validates, loads, builds globals,
  executes the script body, returns result + `RunSummary`. Owns `SharedState` (semaphore,
  budget, journal, reporter, abort signal).
- [types.ts](./packages/core/src/types.ts) — the contract. **`HostAdapter`** is the seam:
  `runAgent`, `createSubSession`, `listAgents`, `report`, plus optional `createWorktree`,
  `closeSession`, `askQuestion`. Also `RuntimeConfig`, `RunSummary`, `WorkflowGlobals`.
- [runtime-context.ts](./packages/core/src/runtime-context.ts) — builds the injected globals;
  `parallel`/`pipeline` orchestration primitives. **pipeline has no barrier between stages**
  (per-item streaming); `parallel` is a barrier. Failed agents degrade to `null`.
- [portability-validator.ts](./packages/core/src/portability-validator.ts) — acorn AST walk
  that rejects non-portable scripts **before** execution: no `import`/`require`, no
  `Date.now()`/argless `new Date()`/`Math.random()` (determinism for resume). Keep new
  sandbox rules here and reflected in the spec.
- [agent-runner.ts](./packages/core/src/agent-runner.ts) — per-agent execution: retry/backoff
  on transient errors, budget enforcement, timeout, schema retries, null-on-failure with reason.
- [journal.ts](./packages/core/src/journal.ts) — resume: cached `agent()` results keyed by
  `(prompt, opts)`. "keyed" mode (default, concurrency-safe) vs "prefix" mode.
- Supporting: `budget-tracker.ts`, `semaphore.ts`, `model-agent-mapper.ts`,
  `structured-output.ts` (schema-constrained output via ajv), `progress-reporter.ts`,
  `script-loader.ts`.

### Host Support (`packages/host-support/src`)

Shared infrastructure consumed by both `host-opencode` and `host-codex`. **Not part of
the portability contract**, but allowed to depend on the dashboard (only `core` stays pure).

- `run-manager.ts` — `RunManager`: in-process run lifecycle (begin/cancel/status, abort
  wiring, persistent run index, crash recovery for orphaned runs). Used by both hosts.
- `worktree.ts` — `createWorktree(baseDir, id, log?)`: git-worktree isolation, shared
  signature used by both adapters.
- `journal.ts` — file-backed journal sink helpers, shared across hosts.
- `cli-helpers.ts` / `resolve-source.ts` — CLI argv parser (`parseArgv`) and workflow
  source resolution (inline script, file path, or name registry lookup).
- `dashboard/` — localhost web UI (progress tree + per-agent conversation streaming).
  Vite-built to `packages/host-support/dashboard-dist/` by `bun run build:dashboard`.
  The web app under `web/` uses its own `web/tsconfig.json` and is **not** included in
  the root `tsc -b`. `buildGraph` (a pure function deriving the React Flow graph from a
  run snapshot) lives in `src/dashboard/` and is covered by the offline `bun test` suite.

### Host opencode (`packages/host-opencode/src`)

- [plugin-entry.ts](./packages/host-opencode/src/plugin-entry.ts) — the opencode plugin.
  Registers the `workflow` tool (run/author), `workflow_cancel`, `workflow_answer`,
  `workflow_status` lifecycle tools, and injects a `/workflow` command. All triggers call
  `runWorkflow`.
- [opencode-adapter.ts](./packages/host-opencode/src/opencode-adapter.ts) — `OpencodeAdapter
  implements HostAdapter`, mapping core calls onto the opencode SDK (sub-sessions, agent runs,
  error classification for retry).
- [cli-runner.ts](./packages/host-opencode/src/cli-runner.ts) — `workflow-run` headless bin
  using an embedded opencode server (CI, batch, cross-host verification).

### Host Codex (`packages/host-codex/src`)

- [codex-adapter.ts](./packages/host-codex/src/codex-adapter.ts) — `CodexAdapter implements
  HostAdapter`. Each sub-session is one Codex thread (started lazily on first turn). Token
  usage from `turn.completed`; cost always 0. Structured output via `TurnOptions.outputSchema`;
  `capabilities.structuredOutput = true`.
- [codex-sdk.ts](./packages/host-codex/src/codex-sdk.ts) — minimal local typings for
  `@openai/codex-sdk` (grounded at v0.142.2); keeps adapter unit-testable with a fake.
- [cli-runner.ts](./packages/host-codex/src/cli-runner.ts) — `workflow-run-codex` headless
  bin; `parseArgv` and `runHeadlessCodex` entry points.
- [mcp-entry.ts](./packages/host-codex/src/mcp-entry.ts) — `workflow-codex-mcp` MCP server;
  exposes `workflow/run`, `workflow/cancel`, `workflow/status`, `workflow/answer` tools.
- [resolve-source.ts](./packages/host-codex/src/resolve-source.ts) — delegates to
  `@workflow/host-support` with Codex-specific registry dirs (`.codex/workflows/` project +
  `~/.codex/workflows/` global).

### Spec (`docs/spec`)

[WORKFLOW_SCRIPT_SPEC.md](./docs/spec/WORKFLOW_SCRIPT_SPEC.md) is the source of truth for
the contract. [SPEC_TEST_MATRIX.md](./docs/spec/SPEC_TEST_MATRIX.md) maps contract clauses
to regression tests — update it when changing cross-host behavior. `authoring-guide.md` is
embedded into the tool description (also mirrored in `host-opencode/src/authoring-guide.ts`)
so the model can author contract-compliant scripts. `examples/` are validated by
`scripts/portability-check.ts`.

## Conventions

- **Bun** is the package manager and test runner (`bun@1.3.14`); ESM-only (`"type": "module"`),
  TypeScript strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- Cross-package imports use the `.js` extension on `.ts` source (NodeNext/bundler resolution).
- When changing anything observable across hosts, the change belongs in the contract: update
  the spec, the test matrix, and keep the validator in sync. Host-only features stay in
  `host-opencode` or `host-codex` (or `host-support` if shared) and never become
  assumptions in `core`.
