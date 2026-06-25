# Codex Host Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third host (`@workflow/host-codex`) that runs portable workflow scripts on OpenAI Codex via `@openai/codex-sdk`, while extracting all host-agnostic infrastructure (dashboard, run lifecycle, worktree, journal) into a shared `@workflow/host-support` package reused by both opencode and codex.

**Architecture:** `@workflow/core` is unchanged — `HostAdapter` is the seam. Phase 1 lifts host-agnostic code out of `host-opencode` into a new `host-support` package and generalizes the one opencode-coupled dashboard seam (transcript ingestion) behind a normalized `TranscriptDelta`. Phases 2-4 add the Codex adapter, its event→transcript translator, a headless CLI, and an optional MCP server. Phase 5 updates docs/contract.

**Tech Stack:** TypeScript (strict, ESM, NodeNext/bundler resolution, `.js` import extensions on `.ts`), Bun (test runner + package manager), `@openai/codex-sdk`, `@opencode-ai/sdk` (existing), Vite + React (dashboard, unchanged).

## Global Constraints

- **Do not modify `@workflow/core`.** If a task appears to require a core change, stop and escalate. (Spec: non-goal.)
- Bun is the package manager and test runner (`bun@1.3.14`); ESM-only (`"type": "module"`).
- TypeScript strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; cross-package imports use the `.js` extension on `.ts` source.
- `bun run build` (`tsc -b`) **is** the typecheck and must be clean before tests are meaningful (packages reference each other's `dist`).
- The dashboard is **not** part of the portability contract and must never leak into `core`. It is allowed in `host-support`.
- All new tests are **offline** — mock `@openai/codex-sdk`; no live model calls in the suite.
- Package dependency direction: `core` ← `host-support` ← {`host-opencode`, `host-codex`}. `host-support` must not depend on any host SDK (`@opencode-ai/*`, `@openai/codex-sdk`).

---

## File Structure

New package `@workflow/host-support` (`packages/host-support/`):
- `src/index.ts` — barrel export of the shared surface.
- `src/dashboard/server.ts` — `DashboardServer` (moved verbatim; `ASSET_ROOT` now resolves within host-support).
- `src/dashboard/run-registry.ts` — `RunRegistry` (moved; `applyOpencodeEvent` → `applyTranscript`).
- `src/dashboard/transcript-store.ts` — generalized `TranscriptStore` consuming `TranscriptDelta` (replaces opencode-coupled `transcript.ts`).
- `src/dashboard/run-index.ts`, `src/dashboard/buildGraph.ts` — moved verbatim.
- `src/run-manager.ts` — moved verbatim.
- `src/worktree.ts` — `createWorktree` free function extracted from `opencode-adapter.ts`.
- `src/concurrency.ts` — `autoConcurrency` extracted from `plugin-entry.ts`.
- `src/file-journal.ts`, `src/script-store.ts` — moved verbatim.
- `src/resolve-source.ts` — generalized `resolveSourceFrom(input, directory, registryDirs)`.
- `web/` — dashboard frontend (moved verbatim; builds to `packages/host-support/dashboard-dist/`).
- `tsconfig.json`, `package.json`, `web/tsconfig.json`, `web/vite.config.ts`.

`@workflow/host-opencode` (rewired):
- `src/opencode-adapter.ts` — drops the worktree helper (imports from host-support).
- `src/opencode-transcript.ts` — new: opencode event → `TranscriptDelta[]` (from old `transcript.ts` logic).
- `src/plugin-entry.ts`, `src/cli-runner.ts`, `src/read-config.ts`, `src/resolve-source.ts` — import shared pieces from host-support.
- Removes: `src/dashboard/`, `src/run-manager.ts`, `src/file-journal.ts`, `src/script-store.ts` (now in host-support).

New package `@workflow/host-codex` (`packages/host-codex/`):
- `src/codex-adapter.ts` — `CodexAdapter implements HostAdapter`.
- `src/codex-transcript.ts` — Codex stream event → `TranscriptDelta`.
- `src/codex-sdk.ts` — minimal local typing of the `@openai/codex-sdk` surface used (so the adapter is testable with a fake).
- `src/cli-runner.ts` — `workflow-run-codex` headless bin.
- `src/mcp-entry.ts` — `workflow-codex-mcp` MCP server.
- `src/resolve-source.ts` — wraps shared resolver with `.codex/workflows/` dirs.
- `tsconfig.json`, `package.json`.

---

## Phase 1 — Extract `@workflow/host-support`

### Task 1: Scaffold the `host-support` package (compiles empty)

**Files:**
- Create: `packages/host-support/package.json`
- Create: `packages/host-support/tsconfig.json`
- Create: `packages/host-support/src/index.ts`
- Modify: `tsconfig.json` (root references)
- Modify: `package.json` (root build/test scripts)

**Interfaces:**
- Produces: package `@workflow/host-support` resolvable by other workspace packages.

- [ ] **Step 1: Write `packages/host-support/package.json`**

```json
{
  "name": "@workflow/host-support",
  "version": "0.1.0",
  "description": "Host-agnostic infrastructure for workflow hosts: dashboard, run lifecycle, worktree, journal.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist", "src", "dashboard-dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json && bun run build:dashboard",
    "build:dashboard": "vite build --config web/vite.config.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@workflow/core": "workspace:*"
  },
  "devDependencies": {
    "@types/dagre": "^0.7.54",
    "@types/react": "^19.2.17",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^6.0.3",
    "@xyflow/react": "^12.11.1",
    "dagre": "^0.8.5",
    "react": "^19.2.7",
    "react-dom": "^19.2.7",
    "vite": "^8.1.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `packages/host-support/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "composite": true
  },
  "references": [{ "path": "../core" }],
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write a placeholder `packages/host-support/src/index.ts`**

```ts
// Barrel export for the shared host-support surface. Populated as modules move in.
export {};
```

- [ ] **Step 4: Add the package to the root `tsconfig.json` references**

Replace the `references` array in `tsconfig.json` with:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/host-support" },
    { "path": "./packages/host-opencode" }
  ]
}
```

- [ ] **Step 5: Update root `package.json` scripts**

In `package.json`, set:

```json
    "build": "tsc -b && bun run --filter='@workflow/host-support' build:dashboard",
    "test": "bun test packages/core/test packages/host-support/test packages/host-opencode/test",
```

- [ ] **Step 6: Install and verify the build**

Run: `bun install && bun run build`
Expected: clean `tsc -b` (host-support compiles with an empty barrel; dashboard build is a no-op until web/ is moved — if `build:dashboard` errors because `web/` is absent, that's expected this step; proceed and it is fixed in Task 3).

If the dashboard sub-build fails on the missing `web/`, temporarily run `tsc -b` alone to confirm the type graph: `bun run typecheck` → Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/host-support/package.json packages/host-support/tsconfig.json packages/host-support/src/index.ts tsconfig.json package.json bun.lock
git commit -m "build: scaffold @workflow/host-support package"
```

---

### Task 2: Move host-agnostic infra (run-index, run-manager, journal, script-store, concurrency) into host-support

**Files:**
- Move: `packages/host-opencode/src/dashboard/run-index.ts` → `packages/host-support/src/dashboard/run-index.ts`
- Move: `packages/host-opencode/src/run-manager.ts` → `packages/host-support/src/run-manager.ts`
- Move: `packages/host-opencode/src/file-journal.ts` → `packages/host-support/src/file-journal.ts`
- Move: `packages/host-opencode/src/script-store.ts` → `packages/host-support/src/script-store.ts`
- Create: `packages/host-support/src/concurrency.ts`
- Move tests: `run-manager.test.ts`, `script-store.test.ts`, `dashboard/*` index-related tests → `packages/host-support/test/`
- Modify: `packages/host-support/src/index.ts`

**Interfaces:**
- Produces: `RunManager`, `RunIndex`, `RunIndexEntry`, `IndexStatus`, `indexPath`, `FileJournalSink`, `journalPath`, `fileJournalSource`, `scriptPath`, `persistScript`, `autoConcurrency` — all exported from `@workflow/host-support`.
- Note: `run-manager.ts` imports `./dashboard/run-registry.js` and `./dashboard/run-index.js`; `run-registry.js` is moved in Task 3. Until then `run-manager.ts` will not type-check in isolation, so move it together with run-registry — **defer run-manager to Task 3** and do only run-index/journal/script-store/concurrency here.

- [ ] **Step 1: Move the leaf modules (no intra-dashboard deps)**

```bash
mkdir -p packages/host-support/src/dashboard packages/host-support/test/dashboard
git mv packages/host-opencode/src/dashboard/run-index.ts packages/host-support/src/dashboard/run-index.ts
git mv packages/host-opencode/src/file-journal.ts packages/host-support/src/file-journal.ts
git mv packages/host-opencode/src/script-store.ts packages/host-support/src/script-store.ts
```

These files import only from `@workflow/core` and `node:*` — no edits needed.

- [ ] **Step 2: Create `packages/host-support/src/concurrency.ts`**

```ts
import { cpus } from "node:os";

/** Default concurrency mirrors Claude Code: min(16, cores - 2), floor 1. */
export function autoConcurrency(): number {
  const cores = cpus().length || 4;
  return Math.min(16, Math.max(1, cores - 2));
}
```

- [ ] **Step 3: Export the moved pieces from the host-support barrel**

In `packages/host-support/src/index.ts`:

```ts
export { RunIndex, indexPath } from "./dashboard/run-index.js";
export type { RunIndexEntry, IndexStatus } from "./dashboard/run-index.js";
export { FileJournalSink, journalPath, fileJournalSource } from "./file-journal.js";
export { scriptPath, persistScript } from "./script-store.js";
export { autoConcurrency } from "./concurrency.js";
```

- [ ] **Step 4: Move the matching tests**

```bash
git mv packages/host-opencode/test/script-store.test.ts packages/host-support/test/script-store.test.ts
```

Open `packages/host-support/test/script-store.test.ts` and change any import of the source from `../src/script-store.js` — it is already relative to `test/`, so the path stays `../src/script-store.js`. Verify the import line resolves to the new location (it does, since both moved). No edit needed if the test imported `../src/script-store.js`.

- [ ] **Step 5: Verify build + moved test**

Run: `bun run typecheck`
Expected: PASS (host-opencode no longer references these paths is checked in Task 5; if host-opencode still imports them it will fail here — that is expected and fixed in Task 5. To isolate, build only host-support: `bunx tsc -b packages/host-support`).
Run: `bun test packages/host-support/test/script-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move run-index, journal, script-store, concurrency to host-support"
```

---

### Task 3: Move the dashboard (server, buildGraph) + generalize the transcript seam

This is the only behavior-changing task in Phase 1: the opencode-coupled `transcript.ts` + `RunRegistry.applyOpencodeEvent` become a normalized `TranscriptDelta` seam.

**Files:**
- Move: `packages/host-opencode/src/dashboard/server.ts` → `packages/host-support/src/dashboard/server.ts`
- Move: `packages/host-opencode/src/dashboard/buildGraph.ts` → `packages/host-support/src/dashboard/buildGraph.ts`
- Move: `packages/host-opencode/src/run-manager.ts` → `packages/host-support/src/run-manager.ts`
- Create: `packages/host-support/src/dashboard/transcript-store.ts` (generalized)
- Move + rewrite: `packages/host-opencode/src/dashboard/run-registry.ts` → `packages/host-support/src/dashboard/run-registry.ts`
- Move: `packages/host-opencode/web/` → `packages/host-support/web/`
- Move tests: `dashboard/server.test.ts`, `dashboard/buildGraph.test.ts`, `dashboard/run-registry.test.ts`, `dashboard/dashboard.test.ts`, `run-manager.test.ts` → `packages/host-support/test/`
- Modify: `packages/host-support/src/index.ts`

**Interfaces:**
- Produces:
  - `interface TranscriptDelta { sessionId: string; messageId: string; role: string; text: string; tokens?: number; cost?: number }`
  - `class TranscriptStore { apply(delta: TranscriptDelta): void; get(sessionId: string): TranscriptMessage[] }`
  - `interface TranscriptMessage { messageId: string; role: string; text: string; tokens?: number; cost?: number }`
  - `RunRegistry` with new method `applyTranscript(delta: TranscriptDelta): void` (replaces `applyOpencodeEvent`/`seedTranscript`/`applyEvent`); existing `applyProgress`, `startRun`, `importHistory`, `setPendingQuestion`, `clearPendingQuestion`, `get`, `list`, `transcript` unchanged.
  - `DashboardServer`, `DashboardServerOptions`, `RunManager`, `RunManagerOptions`, `buildGraph` exported from `@workflow/host-support`.
- Consumes: `ProgressEvent`, `RunSummary`, `AgentGroup`, `NullReason` from `@workflow/core`.

- [ ] **Step 1: Write the failing test for the generalized transcript store**

Create `packages/host-support/test/dashboard/transcript-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { TranscriptStore } from "../../src/dashboard/transcript-store.js";

describe("TranscriptStore", () => {
  test("accumulates messages per session in arrival order", () => {
    const store = new TranscriptStore();
    store.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "Hello" });
    store.apply({ sessionId: "s1", messageId: "m2", role: "user", text: "Hi" });
    store.apply({ sessionId: "s1", messageId: "m1", role: "assistant", text: "Hello world", tokens: 12 });

    expect(store.get("s1")).toEqual([
      { messageId: "m1", role: "assistant", text: "Hello world", tokens: 12, cost: undefined },
      { messageId: "m2", role: "user", text: "Hi", tokens: undefined, cost: undefined },
    ]);
  });

  test("isolates sessions and returns [] for unknown", () => {
    const store = new TranscriptStore();
    store.apply({ sessionId: "a", messageId: "m1", role: "assistant", text: "x" });
    expect(store.get("b")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/host-support/test/dashboard/transcript-store.test.ts`
Expected: FAIL ("Cannot find module .../transcript-store.js").

- [ ] **Step 3: Implement `packages/host-support/src/dashboard/transcript-store.ts`**

```ts
/**
 * Reduces normalized {@link TranscriptDelta}s into a per-session conversation
 * transcript. Host-independent: each host translates its native message events
 * into TranscriptDeltas, so this store knows nothing about opencode or codex.
 */

/** One normalized message update from any host. `text` is the full current
 *  text of the message (last-write-wins), not an incremental fragment. */
export interface TranscriptDelta {
  sessionId: string;
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
  cost?: number;
}

export interface TranscriptMessage {
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
  cost?: number;
}

interface MsgState {
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
  cost?: number;
  order: number;
}

export class TranscriptStore {
  private readonly bySession = new Map<string, Map<string, MsgState>>();
  private readonly order = new Map<string, number>();

  /** Apply a normalized delta; returns the session id it touched. */
  apply(delta: TranscriptDelta): string {
    const msg = this.ensure(delta.sessionId, delta.messageId);
    msg.role = delta.role;
    msg.text = delta.text;
    if (delta.tokens !== undefined) msg.tokens = delta.tokens;
    if (delta.cost !== undefined) msg.cost = delta.cost;
    return delta.sessionId;
  }

  /** Ordered transcript for a session. */
  get(sessionId: string): TranscriptMessage[] {
    const msgs = this.bySession.get(sessionId);
    if (!msgs) return [];
    return [...msgs.values()]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        messageId: m.messageId,
        role: m.role,
        text: m.text,
        tokens: m.tokens,
        cost: m.cost,
      }));
  }

  private ensure(sessionId: string, messageId: string): MsgState {
    let msgs = this.bySession.get(sessionId);
    if (!msgs) {
      msgs = new Map();
      this.bySession.set(sessionId, msgs);
    }
    let msg = msgs.get(messageId);
    if (!msg) {
      const n = (this.order.get(sessionId) ?? 0) + 1;
      this.order.set(sessionId, n);
      msg = { messageId, role: "assistant", text: "", order: n };
      msgs.set(messageId, msg);
    }
    return msg;
  }
}
```

- [ ] **Step 4: Run the transcript-store test to verify it passes**

Run: `bun test packages/host-support/test/dashboard/transcript-store.test.ts`
Expected: PASS

- [ ] **Step 5: Move server + buildGraph + run-manager + web (verbatim)**

```bash
git mv packages/host-opencode/src/dashboard/server.ts packages/host-support/src/dashboard/server.ts
git mv packages/host-opencode/src/dashboard/buildGraph.ts packages/host-support/src/dashboard/buildGraph.ts
git mv packages/host-opencode/src/run-manager.ts packages/host-support/src/run-manager.ts
git mv packages/host-opencode/web packages/host-support/web
```

`server.ts`'s `ASSET_ROOT` is `resolve(dirname(import.meta.url), "..", "..", "dashboard-dist")` → now resolves to `packages/host-support/dashboard-dist`. No edit needed. `run-manager.ts` imports `./dashboard/run-registry.js` and `./dashboard/run-index.js` — both will exist in host-support after Step 6. No edit needed.

- [ ] **Step 6: Move + rewrite `run-registry.ts` to use TranscriptStore + TranscriptDelta**

```bash
git mv packages/host-opencode/src/dashboard/run-registry.ts packages/host-support/src/dashboard/run-registry.ts
git rm packages/host-opencode/src/dashboard/transcript.ts
```

Edit `packages/host-support/src/dashboard/run-registry.ts`:

Replace the import block at the top:

```ts
import type { AgentGroup, NullReason, ProgressEvent, RunSummary } from "@workflow/core";
import { TranscriptStore, type TranscriptDelta, type TranscriptMessage } from "./transcript-store.js";
```

Delete the `applyOpencodeEvent`, `seedTranscript` methods and the `import { eventSessionId, ... OpencodeEventLike }`. Replace them with a single normalized ingest:

```ts
  /**
   * Feed a normalized transcript delta into the conversation store. Only
   * sessions belonging to a known run (main or an agent) are stored, so
   * unrelated activity never accumulates in memory.
   */
  applyTranscript(delta: TranscriptDelta): void {
    if (!this.sessionToRun.has(delta.sessionId)) return;
    this.transcripts.apply(delta);
    this.notify({ kind: "session", sessionId: delta.sessionId });
  }
```

Keep the rest of the class (constructor, `startRun`, `importHistory`, pending-question methods, `applyProgress`, `get`/`list`/`transcript`, `findAgent`) exactly as-is. The `transcripts` field type becomes `TranscriptStore` (already the name); `transcript(sessionId)` returns `TranscriptMessage[]`.

- [ ] **Step 7: Export the dashboard surface from the barrel**

Append to `packages/host-support/src/index.ts`:

```ts
export { DashboardServer } from "./dashboard/server.js";
export type { DashboardServerOptions } from "./dashboard/server.js";
export { RunRegistry } from "./dashboard/run-registry.js";
export type {
  RunView,
  AgentView,
  RunStatus,
  AgentStatus,
  HistoryEntry,
  RegistryChange,
} from "./dashboard/run-registry.js";
export { TranscriptStore } from "./dashboard/transcript-store.js";
export type { TranscriptDelta, TranscriptMessage } from "./dashboard/transcript-store.js";
export { buildGraph } from "./dashboard/buildGraph.js";
export { RunManager } from "./run-manager.js";
export type { RunManagerOptions } from "./run-manager.js";
```

(Confirm `buildGraph.ts`'s exported symbol name by reading its `export` line; adjust if it also exports types used by tests.)

- [ ] **Step 8: Move the dashboard tests; delete the opencode-specific transcript test**

```bash
git mv packages/host-opencode/test/dashboard/server.test.ts packages/host-support/test/dashboard/server.test.ts
git mv packages/host-opencode/test/dashboard/buildGraph.test.ts packages/host-support/test/dashboard/buildGraph.test.ts
git mv packages/host-opencode/test/dashboard/run-registry.test.ts packages/host-support/test/dashboard/run-registry.test.ts
git mv packages/host-opencode/test/dashboard/dashboard.test.ts packages/host-support/test/dashboard/dashboard.test.ts
git mv packages/host-opencode/test/run-manager.test.ts packages/host-support/test/run-manager.test.ts
git rm packages/host-opencode/test/dashboard/transcript.test.ts
```

Edit `run-registry.test.ts`: any call to `registry.applyOpencodeEvent(<opencode event>)` must become `registry.applyTranscript(<TranscriptDelta>)`. For each prior opencode-event assertion, replace with the equivalent normalized delta, e.g.:

```ts
// before: registry.applyOpencodeEvent({ type: "message.part.updated", properties: { part: { sessionID: sid, messageID: "m1", type: "text", text: "hi" } } });
registry.applyTranscript({ sessionId: sid, messageId: "m1", role: "assistant", text: "hi" });
```

Preserve the test's intent (transcript only stored for sessions tied to a run). Fix import paths to `../../src/...` / `../src/...` as appropriate for the new location.

- [ ] **Step 9: Build and run the host-support suite**

Run: `bunx tsc -b packages/host-support`
Expected: PASS
Run: `bun test packages/host-support/test`
Expected: PASS (host-opencode is still broken until Task 5 — do not run the full root build yet).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: move dashboard into host-support; normalize transcript seam to TranscriptDelta"
```

---

### Task 4: Extract `worktree` and generalize `resolve-source` into host-support

**Files:**
- Create: `packages/host-support/src/worktree.ts`
- Create: `packages/host-support/src/resolve-source.ts`
- Move test: `packages/host-opencode/test/worktree.test.ts` → `packages/host-support/test/worktree.test.ts`
- Modify: `packages/host-support/src/index.ts`

**Interfaces:**
- Produces:
  - `function createWorktree(baseDir: string, id: string, log?: (s: string) => void): Promise<{ dir: string; cleanup(): Promise<void> }>`
  - `interface SourceInput { script?: string; scriptPath?: string; name?: string }`
  - `function resolveSourceFrom(input: SourceInput, directory: string, registryDirs: string[]): Promise<string>`

- [ ] **Step 1: Create `packages/host-support/src/worktree.ts`**

Lift the `createWorktree` method body + `git` + `sanitize` helpers from `opencode-adapter.ts` into free functions. Replace `this.logStream.write(...)` with `log(...)`:

```ts
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

interface GitResult { code: number; stdout: string; stderr: string }

/** Run a git command, resolving (never rejecting) with its exit code + output. */
function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err
        ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1)
        : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}

function sanitize(s: string): string {
  return s.replace(/[^\w.-]/g, "").slice(0, 64) || "wt";
}

/**
 * Create an isolated git worktree for an agent. On cleanup, an unchanged
 * worktree is removed; a dirty one is preserved (marked) for inspection. If
 * `baseDir` is not a git repo (or git is unavailable), degrades to running in
 * `baseDir` (no isolation) rather than failing the agent.
 */
export async function createWorktree(
  baseDir: string,
  id: string,
  log: (s: string) => void = () => {},
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  const noIsolation = { dir: baseDir, cleanup: async () => {} };
  const isRepo = await git(["rev-parse", "--is-inside-work-tree"], baseDir)
    .then((r) => r.code === 0)
    .catch(() => false);
  if (!isRepo) {
    log("⚠ worktree isolation requested but the directory is not a git repo; running shared\n");
    return noIsolation;
  }
  const dir = join(baseDir, ".workflow", "worktrees", `wf-${sanitize(id)}`);
  const add = await git(["worktree", "add", "--detach", dir], baseDir);
  if (add.code !== 0) {
    log(`⚠ git worktree add failed (${add.stderr.trim()}); running shared\n`);
    return noIsolation;
  }
  return {
    dir,
    cleanup: async () => {
      const status = await git(["status", "--porcelain"], dir).catch(() => null);
      const dirty = !status || status.code !== 0 || status.stdout.trim() !== "";
      if (dirty) {
        await writeFile(join(dir, ".wf-preserved"), `${id}\n`).catch(() => undefined);
        log(`⚠ worktree ${dir} has changes — preserved for inspection\n`);
        return;
      }
      await git(["worktree", "remove", "--force", dir], baseDir).catch(() => undefined);
    },
  };
}
```

Note: the worktree dir prefix changed from `oc-wf-` to `wf-` and the marker from `.oc-wf-preserved` to `.wf-preserved` (host-neutral). Update the moved test's expectations accordingly in Step 4.

- [ ] **Step 2: Create `packages/host-support/src/resolve-source.ts`**

```ts
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
```

- [ ] **Step 3: Export from the barrel**

Append to `packages/host-support/src/index.ts`:

```ts
export { createWorktree } from "./worktree.js";
export { resolveSourceFrom } from "./resolve-source.js";
export type { SourceInput } from "./resolve-source.js";
```

- [ ] **Step 4: Move + adapt the worktree test**

```bash
git mv packages/host-opencode/test/worktree.test.ts packages/host-support/test/worktree.test.ts
```

Edit the test: import `{ createWorktree }` from `../src/worktree.js` and call it as a free function `createWorktree(dir, id, log)` instead of via an adapter instance. Update any path assertion from `oc-wf-`/`.oc-wf-preserved` to `wf-`/`.wf-preserved`.

- [ ] **Step 5: Build + test**

Run: `bunx tsc -b packages/host-support`
Expected: PASS
Run: `bun test packages/host-support/test/worktree.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: extract host-neutral worktree + resolve-source into host-support"
```

---

### Task 5: Rewire `host-opencode` onto host-support

**Files:**
- Modify: `packages/host-opencode/package.json` (add dep, drop dashboard build/devdeps)
- Modify: `packages/host-opencode/tsconfig.json` (add host-support reference)
- Modify: `packages/host-opencode/src/opencode-adapter.ts` (drop worktree helper, import it)
- Create: `packages/host-opencode/src/opencode-transcript.ts`
- Modify: `packages/host-opencode/src/resolve-source.ts` (delegate to shared resolver)
- Modify: `packages/host-opencode/src/plugin-entry.ts` (import shared infra; feed transcript via translator)
- Modify: `packages/host-opencode/src/cli-runner.ts` (import shared infra)
- Modify: `packages/host-opencode/test/*` import paths as needed

**Interfaces:**
- Consumes from host-support: `RunManager`, `DashboardServer`, `RunRegistry`, `FileJournalSink`, `journalPath`, `fileJournalSource`, `scriptPath`, `persistScript`, `indexPath`, `autoConcurrency`, `createWorktree`, `resolveSourceFrom`, `TranscriptDelta`.
- Produces: `function opencodeEventToDeltas(event: OpencodeEventLike): TranscriptDelta[]` (and `OpencodeEventLike` type).

- [ ] **Step 1: Add the host-support dependency and reference**

In `packages/host-opencode/package.json`, add to `dependencies`:

```json
    "@workflow/host-support": "workspace:*"
```

Remove the dashboard build from its `scripts` (now host-support owns the dashboard build):

```json
    "build": "tsc -p tsconfig.json",
```

Remove the dashboard-only devDependencies (`@types/dagre`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `@xyflow/react`, `dagre`, `react`, `react-dom`, `vite`) and the `dashboard-dist` entry from `files` and the `build:dashboard` script. Keep `@opencode-ai/*`.

In `packages/host-opencode/tsconfig.json`, add `{ "path": "../host-support" }` to `references`.

- [ ] **Step 2: Create `packages/host-opencode/src/opencode-transcript.ts`**

Port the old `transcript.ts` reduce logic into a pure translator producing `TranscriptDelta[]`. Because `TranscriptDelta.text` is the full current message text, accumulate part text per (session,message) inside this translator:

```ts
import type { TranscriptDelta } from "@workflow/host-support";

/** A loose view of the opencode event envelope we care about. */
export interface OpencodeEventLike {
  type: string;
  properties?: Record<string, unknown>;
}

/** Per-(session,message) accumulated text + last-known role/usage, so each
 *  emitted delta carries the FULL current message text. */
interface Acc {
  role: string;
  parts: Map<string, string>;
  tokens?: number;
  cost?: number;
}

/**
 * Stateful translator: opencode message/part events → normalized TranscriptDeltas.
 * One instance per plugin process (shared across runs); keyed by message id.
 */
export class OpencodeTranscriptTranslator {
  private readonly acc = new Map<string, Acc>();

  translate(event: OpencodeEventLike): TranscriptDelta[] {
    if (event.type === "message.updated") {
      const info = event.properties?.info as
        | { id?: string; sessionID?: string; role?: string; cost?: number; tokens?: { output?: number } }
        | undefined;
      if (!info?.sessionID || !info.id) return [];
      const a = this.ensure(info.id);
      if (info.role) a.role = info.role;
      if (typeof info.cost === "number") a.cost = info.cost;
      if (typeof info.tokens?.output === "number") a.tokens = info.tokens.output;
      return [this.delta(info.sessionID, info.id, a)];
    }
    if (event.type === "message.part.updated") {
      const part = event.properties?.part as
        | { sessionID?: string; messageID?: string; id?: string; type?: string; text?: string }
        | undefined;
      if (!part?.sessionID || !part.messageID) return [];
      if (part.type !== "text" && part.type !== "reasoning") return [];
      const a = this.ensure(part.messageID);
      a.parts.set(part.id ?? "0", part.text ?? "");
      return [this.delta(part.sessionID, part.messageID, a)];
    }
    if (event.type === "message.part.removed") {
      const p = event.properties as
        | { sessionID?: string; messageID?: string; partID?: string }
        | undefined;
      if (!p?.sessionID || !p.messageID) return [];
      const a = this.acc.get(p.messageID);
      if (a && p.partID) a.parts.delete(p.partID);
      return a ? [this.delta(p.sessionID, p.messageID, a)] : [];
    }
    return [];
  }

  private ensure(messageId: string): Acc {
    let a = this.acc.get(messageId);
    if (!a) {
      a = { role: "assistant", parts: new Map() };
      this.acc.set(messageId, a);
    }
    return a;
  }

  private delta(sessionId: string, messageId: string, a: Acc): TranscriptDelta {
    return {
      sessionId,
      messageId,
      role: a.role,
      text: [...a.parts.values()].join(""),
      tokens: a.tokens,
      cost: a.cost,
    };
  }
}
```

- [ ] **Step 3: Wire the translator into the plugin's `event` hook**

In `packages/host-opencode/src/plugin-entry.ts`:
- Replace `import type { OpencodeEventLike } from "./dashboard/transcript.js";` with `import { OpencodeTranscriptTranslator, type OpencodeEventLike } from "./opencode-transcript.js";`.
- Replace the `autoConcurrency` local function + its import usages with `import { autoConcurrency, RunManager, DashboardServer, indexPath, FileJournalSink, journalPath, fileJournalSource, persistScript } from "@workflow/host-support";` and delete the local `autoConcurrency` definition + `cpus` import.
- Construct a translator once: `const translator = new OpencodeTranscriptTranslator();`
- Change the `event` hook body to:

```ts
          event: async ({ event }: { event: unknown }) => {
            for (const d of translator.translate(event as OpencodeEventLike)) {
              manager.registry.applyTranscript(d);
            }
          },
```

- Update remaining imports that pointed at moved modules: `./run-manager.js` → `@workflow/host-support`, `./dashboard/server.js` → `@workflow/host-support`, `./dashboard/run-index.js` → `@workflow/host-support`, `./file-journal.js` → `@workflow/host-support`, `./script-store.js` → `@workflow/host-support`. Keep `./read-config.js`, `./resolve-source.js`, `./opencode-adapter.js`, `./authoring-guide.js` local.

- [ ] **Step 4: Update `opencode-adapter.ts` to import the shared worktree**

- Delete the `createWorktree` method and the `git`/`sanitize`/`GitResult` helpers from `opencode-adapter.ts`.
- Add `import { createWorktree as createWorktreeShared } from "@workflow/host-support";` and re-expose it so the adapter still satisfies `HostAdapter.createWorktree`:

```ts
  async createWorktree(baseDir: string, id: string) {
    return createWorktreeShared(baseDir, id, (s) => this.logStream.write(s));
  }
```

- Remove the now-unused `execFile`/`writeFile`/`join` imports if nothing else uses them (check: `writeFile` is still imported for `format`? No — only worktree used it; `join` only worktree used it. Remove both. `execFile` only worktree used it. Remove.).

- [ ] **Step 5: Update `cli-runner.ts` imports**

- `import { autoConcurrency } from "./plugin-entry.js";` → `import { autoConcurrency, FileJournalSink, journalPath, fileJournalSource } from "@workflow/host-support";`
- Remove the old `./file-journal.js` import.

- [ ] **Step 6: Update `resolve-source.ts` to delegate to the shared resolver**

Replace the body of `packages/host-opencode/src/resolve-source.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSourceFrom, type SourceInput } from "@workflow/host-support";

export type { SourceInput };

const registryDirs = (directory: string): string[] => [
  join(directory, ".opencode", "workflows"),
  join(homedir(), ".config", "opencode", "workflows"),
];

export function resolveSource(input: SourceInput, directory: string): Promise<string> {
  return resolveSourceFrom(input, directory, registryDirs(directory));
}
```

- [ ] **Step 7: Fix any remaining test import paths**

Run a search for stale imports in host-opencode tests and fix to host-support:

Run: `grep -rn "dashboard/transcript\|dashboard/run-index\|\./run-manager\|\./file-journal\|\./script-store\|dashboard/server\|dashboard/run-registry\|dashboard/buildGraph" packages/host-opencode/test`
For each hit, repoint the import to `@workflow/host-support`. The `opencode-adapter.test.ts` worktree assertions (if any) move with Task 4; confirm `opencode-adapter.test.ts` no longer asserts worktree internals (it delegates now) — if it does, keep a thin test that the adapter delegates (calls through and returns `{dir, cleanup}`), or rely on host-support's worktree test.

- [ ] **Step 8: Full build + full opencode + host-support suites**

Run: `bun run build`
Expected: clean `tsc -b` across core, host-support, host-opencode; dashboard builds from host-support to `packages/host-support/dashboard-dist`.
Run: `bun test packages/core/test packages/host-support/test packages/host-opencode/test`
Expected: PASS (all prior opencode behavior preserved).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: rewire host-opencode onto host-support (shared dashboard/worktree/journal)"
```

---

## Phase 2 — Codex adapter + transcript translator

### Task 6: Scaffold `host-codex` and the codex-sdk facade

**Files:**
- Create: `packages/host-codex/package.json`
- Create: `packages/host-codex/tsconfig.json`
- Create: `packages/host-codex/src/codex-sdk.ts`
- Create: `packages/host-codex/src/index.ts`
- Modify: `tsconfig.json` (root references), `package.json` (root test glob)

**Interfaces:**
- Produces local typings matching the subset of `@openai/codex-sdk` the adapter uses, so the adapter depends on an interface (testable with a fake), not the concrete import:
  - `interface CodexLike { startThread(opts?: ThreadOptions): ThreadLike; resumeThread(id: string): ThreadLike }`
  - `interface ThreadLike { id?: string; runStreamed(input: string, opts?: TurnOptions): AsyncIterable<CodexEvent> }`
  - `interface ThreadOptions { model?: string; workingDirectory?: string; sandboxMode?: string; skipGitRepoCheck?: boolean; outputSchema?: unknown }`
  - `interface TurnOptions extends ThreadOptions { effort?: string }`
  - `type CodexEvent` (thread.started | turn.started | item.started | item.completed | turn.completed | error) with the documented JSONL shapes.

- [ ] **Step 1: Write `packages/host-codex/package.json`**

```json
{
  "name": "@workflow/host-codex",
  "version": "0.1.0",
  "description": "OpenAI Codex host adapter + headless CLI + MCP server for portable dynamic workflows.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./cli": { "types": "./dist/cli-runner.d.ts", "default": "./dist/cli-runner.js" },
    "./mcp": { "types": "./dist/mcp-entry.d.ts", "default": "./dist/mcp-entry.js" }
  },
  "bin": {
    "workflow-run-codex": "./dist/cli-runner.js",
    "workflow-codex-mcp": "./dist/mcp-entry.js"
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "bun test"
  },
  "dependencies": {
    "@workflow/core": "workspace:*",
    "@workflow/host-support": "workspace:*"
  },
  "peerDependencies": {
    "@openai/codex-sdk": ">=0.1.0",
    "@modelcontextprotocol/sdk": ">=1.0.0"
  },
  "devDependencies": {
    "@openai/codex-sdk": "^0.1.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "license": "MIT"
}
```

(Pin actual installed versions of `@openai/codex-sdk` and `@modelcontextprotocol/sdk` after `bun add`. If the MCP SDK is not adopted until Task 9, move those two to that task and omit here.)

- [ ] **Step 2: Write `packages/host-codex/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "composite": true
  },
  "references": [{ "path": "../core" }, { "path": "../host-support" }],
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write `packages/host-codex/src/codex-sdk.ts`**

```ts
/**
 * Minimal local typing of the `@openai/codex-sdk` surface this adapter uses.
 * The adapter depends on these interfaces (not the concrete module), so it is
 * unit-testable with a fake and tolerant of SDK shape drift.
 */

export interface ThreadOptions {
  model?: string;
  workingDirectory?: string;
  sandboxMode?: string;
  skipGitRepoCheck?: boolean;
  outputSchema?: unknown;
}

export interface TurnOptions extends ThreadOptions {
  effort?: string;
}

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export type CodexItem =
  | { id: string; type: "agent_message"; text: string }
  | { id: string; type: "reasoning"; text?: string }
  | { id: string; type: string; [k: string]: unknown };

export type CodexEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "item.started"; item: CodexItem }
  | { type: "item.updated"; item: CodexItem }
  | { type: "item.completed"; item: CodexItem }
  | { type: "turn.completed"; usage?: CodexUsage }
  | { type: "turn.failed"; error?: { message?: string } }
  | { type: "error"; message?: string };

export interface ThreadLike {
  /** Assigned after the first run's `thread.started`; may be undefined before. */
  id?: string;
  runStreamed(input: string, opts?: TurnOptions): AsyncIterable<CodexEvent>;
}

export interface CodexLike {
  startThread(opts?: ThreadOptions): ThreadLike;
  resumeThread(threadId: string): ThreadLike;
}
```

- [ ] **Step 4: Placeholder `packages/host-codex/src/index.ts`**

```ts
export {};
```

- [ ] **Step 5: Register the package in the root config**

Add `{ "path": "./packages/host-codex" }` to `tsconfig.json` `references`. Extend the root `package.json` test script:

```json
    "test": "bun test packages/core/test packages/host-support/test packages/host-opencode/test packages/host-codex/test",
```

- [ ] **Step 6: Install + build**

Run: `bun add -D @openai/codex-sdk --cwd packages/host-codex` (pin the real version into package.json), then `bun install && bunx tsc -b packages/host-codex`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "build: scaffold @workflow/host-codex package + codex-sdk facade"
```

---

### Task 7: `codex-transcript` translator

**Files:**
- Create: `packages/host-codex/src/codex-transcript.ts`
- Create: `packages/host-codex/test/codex-transcript.test.ts`

**Interfaces:**
- Consumes: `CodexEvent` (Task 6), `TranscriptDelta` (host-support).
- Produces: `class CodexTranscriptTranslator { translate(sessionId: string, event: CodexEvent): TranscriptDelta[] }` — one instance per thread/session; maps `agent_message`/`reasoning` items to deltas and stamps `turn.completed` usage onto the latest assistant message.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { CodexTranscriptTranslator } from "../src/codex-transcript.js";

describe("CodexTranscriptTranslator", () => {
  test("emits a delta per completed agent_message item", () => {
    const t = new CodexTranscriptTranslator();
    const d = t.translate("sess1", {
      type: "item.completed",
      item: { id: "item_3", type: "agent_message", text: "Repo has docs and sdk." },
    });
    expect(d).toEqual([
      { sessionId: "sess1", messageId: "item_3", role: "assistant", text: "Repo has docs and sdk." },
    ]);
  });

  test("ignores command_execution items", () => {
    const t = new CodexTranscriptTranslator();
    expect(
      t.translate("s", { type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls" } }),
    ).toEqual([]);
  });

  test("turn.completed stamps output tokens onto the last assistant message", () => {
    const t = new CodexTranscriptTranslator();
    t.translate("s", { type: "item.completed", item: { id: "m1", type: "agent_message", text: "hi" } });
    const d = t.translate("s", {
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 42, reasoning_output_tokens: 3 },
    });
    expect(d).toEqual([{ sessionId: "s", messageId: "m1", role: "assistant", text: "hi", tokens: 42 }]);
  });

  test("turn.completed with no prior message emits nothing", () => {
    const t = new CodexTranscriptTranslator();
    expect(t.translate("s", { type: "turn.completed", usage: { output_tokens: 5 } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/host-codex/test/codex-transcript.test.ts`
Expected: FAIL ("Cannot find module .../codex-transcript.js").

- [ ] **Step 3: Implement `packages/host-codex/src/codex-transcript.ts`**

```ts
import type { TranscriptDelta } from "@workflow/host-support";
import type { CodexEvent } from "./codex-sdk.js";

/**
 * Translates a Codex thread's streamed events into normalized TranscriptDeltas
 * for the shared dashboard. One instance per (session/thread). Only
 * `agent_message` and `reasoning` items become visible messages; tool/command
 * items are skipped. `turn.completed` usage is stamped onto the most recent
 * assistant message so the conversation view shows per-message output tokens.
 */
export class CodexTranscriptTranslator {
  private lastMessageId?: string;
  private lastText = "";
  private lastRole = "assistant";

  translate(sessionId: string, event: CodexEvent): TranscriptDelta[] {
    if (event.type === "item.completed" || event.type === "item.updated") {
      const item = event.item;
      if (item.type === "agent_message") {
        this.lastMessageId = item.id;
        this.lastText = (item as { text?: string }).text ?? "";
        this.lastRole = "assistant";
        return [{ sessionId, messageId: item.id, role: "assistant", text: this.lastText }];
      }
      if (item.type === "reasoning") {
        const text = (item as { text?: string }).text ?? "";
        return [{ sessionId, messageId: item.id, role: "reasoning", text }];
      }
      return [];
    }
    if (event.type === "turn.completed") {
      if (!this.lastMessageId) return [];
      const tokens = event.usage?.output_tokens;
      return [
        {
          sessionId,
          messageId: this.lastMessageId,
          role: this.lastRole,
          text: this.lastText,
          ...(tokens !== undefined ? { tokens } : {}),
        },
      ];
    }
    return [];
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/host-codex/test/codex-transcript.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(host-codex): codex stream-event to TranscriptDelta translator"
```

---

### Task 8: `CodexAdapter implements HostAdapter`

**Files:**
- Create: `packages/host-codex/src/codex-adapter.ts`
- Create: `packages/host-codex/test/codex-adapter.test.ts`
- Modify: `packages/host-codex/src/index.ts`

**Interfaces:**
- Consumes: `HostAdapter`, `AgentRequest`, `AgentResult`, `HostAgentInfo`, `ProgressEvent` from `@workflow/core`; `CodexLike`/`ThreadLike`/`CodexEvent`/`TurnOptions` from `./codex-sdk.js`; `TranscriptDelta` from `@workflow/host-support`; `createWorktree` from `@workflow/host-support`; `CodexTranscriptTranslator` from `./codex-transcript.js`.
- Produces:
  - `interface CodexAdapterOptions { rootDirectory: string; directory?: string; logStream?: { write(s: string): void }; onEvent?: (ev: ProgressEvent) => void; onQuestion?: (input: { question: string; options?: string[]; timeoutMs?: number }) => Promise<string | null>; onTranscript?: (d: TranscriptDelta) => void; sandboxMode?: string }`
  - `class CodexAdapter implements HostAdapter` with `capabilities = { structuredOutput: true }`.

- [ ] **Step 1: Write the failing test (with a fake Codex)**

```ts
import { describe, expect, test } from "bun:test";
import { CodexAdapter } from "../src/codex-adapter.js";
import type { CodexEvent, CodexLike, ThreadLike, TurnOptions } from "../src/codex-sdk.js";

/** A scriptable fake thread: yields a fixed event sequence per run. */
function fakeThread(events: CodexEvent[][], record?: (input: string, opts?: TurnOptions) => void): ThreadLike {
  let turn = 0;
  return {
    id: "thr_fake",
    async *runStreamed(input: string, opts?: TurnOptions) {
      record?.(input, opts);
      const seq = events[turn++] ?? [];
      for (const e of seq) yield e;
    },
  };
}

function fakeCodex(thread: ThreadLike): CodexLike {
  return { startThread: () => thread, resumeThread: () => thread };
}

const signal = new AbortController().signal;

describe("CodexAdapter", () => {
  test("runAgent returns final agent_message text and turn usage", async () => {
    const thread = fakeThread([
      [
        { type: "thread.started", thread_id: "thr_1" },
        { type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } },
        { type: "turn.completed", usage: { input_tokens: 50, output_tokens: 12, reasoning_output_tokens: 2 } },
      ],
    ]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    expect(res.text).toBe("Done.");
    expect(res.tokens).toEqual({ input: 50, output: 12, reasoning: 2 });
    expect(res.errored).toBe(false);
    expect(res.cost).toBe(0);
  });

  test("passes schema as outputSchema and surfaces structured output", async () => {
    let seenOpts: TurnOptions | undefined;
    const thread = fakeThread(
      [[{ type: "item.completed", item: { id: "m1", type: "agent_message", text: '{"answer":"x"}' } }, { type: "turn.completed", usage: { output_tokens: 4 } }]],
      (_i, opts) => { seenOpts = opts; },
    );
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const schema = { type: "object", properties: { answer: { type: "string" } } };
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal, schema });

    expect(seenOpts?.outputSchema).toEqual(schema);
    expect(res.structured).toEqual({ answer: "x" });
  });

  test("turn.failed marks errored and classifies retriable", async () => {
    const thread = fakeThread([[{ type: "turn.failed", error: { message: "rate limit 429" } }]]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal });

    expect(res.errored).toBe(true);
    expect(res.retriable).toBe(true);
  });

  test("aborted signal yields aborted result without running", async () => {
    const ac = new AbortController();
    ac.abort();
    const thread = fakeThread([[]]);
    const adapter = new CodexAdapter(fakeCodex(thread), { rootDirectory: "/repo" });
    const sid = await adapter.createSubSession(undefined, "t");
    const res = await adapter.runAgent({ sessionId: sid, prompt: "go", signal: ac.signal });

    expect(res.aborted).toBe(true);
  });

  test("listAgents is empty (codex has no named subagents)", async () => {
    const adapter = new CodexAdapter(fakeCodex(fakeThread([])), { rootDirectory: "/repo" });
    expect(await adapter.listAgents()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/host-codex/test/codex-adapter.test.ts`
Expected: FAIL ("Cannot find module .../codex-adapter.js").

- [ ] **Step 3: Implement `packages/host-codex/src/codex-adapter.ts`**

```ts
import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  HostAgentInfo,
  ProgressEvent,
} from "@workflow/core";
import { createWorktree, type TranscriptDelta } from "@workflow/host-support";
import { CodexTranscriptTranslator } from "./codex-transcript.js";
import type { CodexEvent, CodexLike, ThreadLike, TurnOptions } from "./codex-sdk.js";

export interface CodexAdapterOptions {
  rootDirectory: string;
  directory?: string;
  logStream?: { write(s: string): void };
  onEvent?: (ev: ProgressEvent) => void;
  onTranscript?: (d: TranscriptDelta) => void;
  onQuestion?: (input: { question: string; options?: string[]; timeoutMs?: number }) => Promise<string | null>;
  /** Codex sandbox policy for sub-agent threads (default "workspace-write"). */
  sandboxMode?: string;
}

interface Session {
  thread: ThreadLike;
  translator: CodexTranscriptTranslator;
}

/**
 * Implements the host-agnostic {@link HostAdapter} on top of `@openai/codex-sdk`.
 * Each sub-session is a Codex thread; each runAgent is one streamed turn. Token
 * usage comes from `turn.completed`; cost is reported 0 (Codex exposes no
 * per-turn USD). Structured output uses the turn's `outputSchema`; the core
 * still re-validates with ajv.
 */
export class CodexAdapter implements HostAdapter {
  readonly rootDirectory: string;
  readonly capabilities = { structuredOutput: true };
  private readonly directory: string;
  private readonly logStream: { write(s: string): void };
  private readonly onEvent?: CodexAdapterOptions["onEvent"];
  private readonly onTranscript?: CodexAdapterOptions["onTranscript"];
  private readonly onQuestion?: CodexAdapterOptions["onQuestion"];
  private readonly sandboxMode: string;
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  constructor(private readonly codex: CodexLike, opts: CodexAdapterOptions) {
    this.rootDirectory = opts.rootDirectory;
    this.directory = opts.directory ?? opts.rootDirectory;
    this.logStream = opts.logStream ?? process.stderr;
    this.onEvent = opts.onEvent;
    this.onTranscript = opts.onTranscript;
    this.onQuestion = opts.onQuestion;
    this.sandboxMode = opts.sandboxMode ?? "workspace-write";
  }

  async createSubSession(_parentId: string | undefined, _title: string): Promise<string> {
    const id = `codex-sub-${++this.counter}`;
    const thread = this.codex.startThread({
      workingDirectory: this.directory,
      sandboxMode: this.sandboxMode,
      skipGitRepoCheck: true,
    });
    this.sessions.set(id, { thread, translator: new CodexTranscriptTranslator() });
    return id;
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    if (req.signal.aborted) return abortedResult();
    const session = this.sessions.get(req.sessionId);
    if (!session) {
      return errored(`unknown codex session ${req.sessionId}`, false);
    }

    const opts: TurnOptions = {
      workingDirectory: req.directory ?? this.directory,
      sandboxMode: this.sandboxMode,
      skipGitRepoCheck: true,
      ...(req.model ? { model: req.model.modelID } : {}),
      ...(req.schema ? { outputSchema: req.schema } : {}),
    };

    let text = "";
    const usage = { input: 0, output: 0, reasoning: 0 };
    let failure: { message: string } | undefined;

    try {
      const stream = session.thread.runStreamed(req.prompt, opts);
      for await (const event of this.withAbort(stream, req.signal)) {
        for (const d of session.translator.translate(req.sessionId, event)) {
          this.onTranscript?.(d);
        }
        switch (event.type) {
          case "item.completed":
            if (event.item.type === "agent_message") text = (event.item as { text?: string }).text ?? text;
            break;
          case "turn.completed":
            if (event.usage) {
              usage.input = event.usage.input_tokens ?? 0;
              usage.output = event.usage.output_tokens ?? 0;
              usage.reasoning = event.usage.reasoning_output_tokens ?? 0;
            }
            break;
          case "turn.failed":
            failure = { message: event.error?.message ?? "turn failed" };
            break;
          case "error":
            failure = { message: event.message ?? "codex error" };
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (req.signal.aborted) return abortedResult();
      const cls = classifyCodexError(err);
      return { text, tokens: usage, cost: 0, aborted: false, errored: true, retriable: cls.retriable, errorDetail: describe(err) };
    }

    if (req.signal.aborted) return abortedResult();
    if (failure) {
      const cls = classifyCodexError(failure.message);
      return { text, tokens: usage, cost: 0, aborted: false, errored: true, retriable: cls.retriable, errorDetail: failure.message };
    }

    const structured = req.schema ? tryParse(text) : undefined;
    return {
      text,
      tokens: usage,
      cost: 0,
      aborted: false,
      errored: false,
      ...(structured !== undefined ? { structured } : {}),
    };
  }

  async listAgents(): Promise<HostAgentInfo[]> {
    return [];
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async createWorktree(baseDir: string, id: string) {
    return createWorktree(baseDir, id, (s) => this.logStream.write(s));
  }

  async askQuestion(input: { question: string; options?: string[]; timeoutMs?: number }): Promise<string | null> {
    if (!this.onQuestion) return null;
    return this.onQuestion(input);
  }

  report(ev: ProgressEvent): void {
    try {
      this.onEvent?.(ev);
    } catch {
      // a dashboard tap must never break a run
    }
  }

  /** Stop iterating the stream promptly when the run is aborted. */
  private async *withAbort(stream: AsyncIterable<CodexEvent>, signal: AbortSignal): AsyncIterable<CodexEvent> {
    for await (const ev of stream) {
      if (signal.aborted) return;
      yield ev;
    }
  }
}

function abortedResult(): AgentResult {
  return { text: "", tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0, aborted: true, errored: false };
}

function errored(detail: string, retriable: boolean): AgentResult {
  return { text: "", tokens: { input: 0, output: 0, reasoning: 0 }, cost: 0, aborted: false, errored: true, retriable, errorDetail: detail };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 429/5xx/network → retriable; auth/400/invalid → terminal. */
function classifyCodexError(error: unknown): { retriable: boolean } {
  const text = (typeof error === "string" ? error : describe(error)).toLowerCase();
  if (/\b(401|403|invalid|unauthor|permission|bad request|400|not found|404)\b/.test(text)) {
    return { retriable: false };
  }
  if (/\b(429|rate limit|5\d\d|timeout|timed out|econn|network|socket|overloaded)\b/.test(text)) {
    return { retriable: true };
  }
  return { retriable: true }; // unknown → transient until proven otherwise
}

function describe(error: unknown): string {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
```

Note on `req.model`: `AgentRequest.model` is `{ providerID; modelID }`. Codex takes a single model string, so pass `req.model.modelID`. The host's `modelMap` should map logical names to `{ providerID: "openai", modelID: "gpt-5.x" }`.

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `bun test packages/host-codex/test/codex-adapter.test.ts`
Expected: PASS

- [ ] **Step 5: Export from the barrel**

`packages/host-codex/src/index.ts`:

```ts
export { CodexAdapter } from "./codex-adapter.js";
export type { CodexAdapterOptions } from "./codex-adapter.js";
export { CodexTranscriptTranslator } from "./codex-transcript.js";
export type { CodexLike, ThreadLike, CodexEvent, ThreadOptions, TurnOptions } from "./codex-sdk.js";
```

- [ ] **Step 6: Build + test + commit**

Run: `bunx tsc -b packages/host-codex && bun test packages/host-codex/test`
Expected: PASS

```bash
git add -A
git commit -m "feat(host-codex): CodexAdapter (HostAdapter over @openai/codex-sdk)"
```

---

## Phase 3 — Headless CLI

### Task 9: `workflow-run-codex` headless runner

**Files:**
- Create: `packages/host-codex/src/codex-factory.ts` (wraps the real `@openai/codex-sdk` `Codex` as a `CodexLike`)
- Create: `packages/host-codex/src/resolve-source.ts`
- Create: `packages/host-codex/src/cli-runner.ts`
- Create: `packages/host-codex/test/cli-runner.test.ts`

**Interfaces:**
- Consumes: `CodexAdapter` (Task 8), `runWorkflow`/`RuntimeConfig` from `@workflow/core`, `autoConcurrency`/`FileJournalSink`/`journalPath`/`fileJournalSource`/`resolveSourceFrom` from `@workflow/host-support`.
- Produces:
  - `function createCodex(): CodexLike` (real SDK adapter; lazy import of `@openai/codex-sdk`).
  - `interface HeadlessCodexOptions { source: string; directory: string; codex: CodexLike; args?: unknown; config?: RuntimeConfig; runId?: string; resumeFromRunId?: string; noJournal?: boolean }`
  - `function runHeadlessCodex(opts: HeadlessCodexOptions): Promise<unknown>`
  - `function parseArgv(argv: string[]): { scriptPath?: string; args?: unknown; resume?: string; config: RuntimeConfig }`

- [ ] **Step 1: Write `packages/host-codex/src/codex-factory.ts`**

```ts
import type { CodexLike, ThreadLike, ThreadOptions, TurnOptions, CodexEvent } from "./codex-sdk.js";

/**
 * Wrap the real `@openai/codex-sdk` `Codex` as a {@link CodexLike}. Lazily
 * imported so the package builds and unit-tests run without the SDK installed.
 * The SDK's thread exposes `runStreamed(input, opts)`; we normalize its event
 * objects (already shaped like {@link CodexEvent}) straight through.
 */
export async function createCodex(): Promise<CodexLike> {
  const mod = (await import("@openai/codex-sdk")) as { Codex: new () => RawCodex };
  const raw = new mod.Codex();
  return {
    startThread: (opts?: ThreadOptions) => wrap(raw.startThread(opts as RawThreadOpts)),
    resumeThread: (id: string) => wrap(raw.resumeThread(id)),
  };
}

interface RawThreadOpts { [k: string]: unknown }
interface RawThread {
  id?: string;
  runStreamed(input: string, opts?: RawThreadOpts): AsyncIterable<CodexEvent> | { events: AsyncIterable<CodexEvent> };
}
interface RawCodex {
  startThread(opts?: RawThreadOpts): RawThread;
  resumeThread(id: string): RawThread;
}

function wrap(raw: RawThread): ThreadLike {
  return {
    get id() {
      return raw.id;
    },
    runStreamed(input: string, opts?: TurnOptions): AsyncIterable<CodexEvent> {
      const out = raw.runStreamed(input, opts as RawThreadOpts);
      // Some SDK builds return { events }; others return the iterable directly.
      return (out as { events?: AsyncIterable<CodexEvent> }).events ?? (out as AsyncIterable<CodexEvent>);
    },
  };
}
```

(Verify the real SDK's `runStreamed` return shape against the installed version during this task; adjust `wrap` accordingly. If only `run()` is available without streaming, fall back to a single synthetic `item.completed` + `turn.completed` from `run()`'s result — note this in a code comment and add a `codex-factory` integration smoke to INSTALL.md.)

- [ ] **Step 2: Write `packages/host-codex/src/resolve-source.ts`**

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSourceFrom, type SourceInput } from "@workflow/host-support";

export type { SourceInput };

const registryDirs = (directory: string): string[] => [
  join(directory, ".codex", "workflows"),
  join(homedir(), ".codex", "workflows"),
];

export function resolveSource(input: SourceInput, directory: string): Promise<string> {
  return resolveSourceFrom(input, directory, registryDirs(directory));
}
```

- [ ] **Step 3: Write the failing CLI test (with a fake Codex)**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadlessCodex, parseArgv } from "../src/cli-runner.js";
import type { CodexLike } from "../src/codex-sdk.js";

function fakeCodex(reply: string): CodexLike {
  const thread = {
    id: "thr",
    async *runStreamed() {
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: reply } } as const;
      yield { type: "turn.completed", usage: { output_tokens: 3 } } as const;
    },
  };
  return { startThread: () => thread, resumeThread: () => thread };
}

describe("runHeadlessCodex", () => {
  test("runs a one-agent workflow and returns its result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-codex-"));
    const script = `
      export const meta = { name: 'echo', description: 'echo' };
      const out = await agent('say hi');
      return out;
    `;
    const result = await runHeadlessCodex({ source: script, directory: dir, codex: fakeCodex("HI"), noJournal: true });
    expect(result).toBe("HI");
  });

  test("parseArgv reads scriptPath + flags", () => {
    const p = parseArgv(["wf.js", "--budget", "1000", "--concurrency", "2", "--args", '{"x":1}']);
    expect(p.scriptPath).toBe("wf.js");
    expect(p.config.budgetTotal).toBe(1000);
    expect(p.config.concurrency).toBe(2);
    expect(p.args).toEqual({ x: 1 });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test packages/host-codex/test/cli-runner.test.ts`
Expected: FAIL ("Cannot find module .../cli-runner.js").

- [ ] **Step 5: Implement `packages/host-codex/src/cli-runner.ts`**

```ts
#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflow, type RuntimeConfig } from "@workflow/core";
import { autoConcurrency, FileJournalSink, fileJournalSource, journalPath } from "@workflow/host-support";
import { CodexAdapter } from "./codex-adapter.js";
import type { CodexLike } from "./codex-sdk.js";
import { createCodex } from "./codex-factory.js";
import { resolveSource } from "./resolve-source.js";

export interface HeadlessCodexOptions {
  source: string;
  directory: string;
  codex: CodexLike;
  args?: unknown;
  config?: RuntimeConfig;
  runId?: string;
  resumeFromRunId?: string;
  noJournal?: boolean;
}

/** Small stable hash for deterministic run ids (FNV-1a, hex). */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Run a workflow headless on Codex; returns its result. */
export async function runHeadlessCodex(opts: HeadlessCodexOptions): Promise<unknown> {
  const adapter = new CodexAdapter(opts.codex, {
    rootDirectory: opts.directory,
    directory: opts.directory,
  });
  const runId = opts.runId ?? `codex-${shortHash(opts.source + JSON.stringify(opts.args ?? null))}`;
  const sink = opts.noJournal ? undefined : new FileJournalSink(journalPath(opts.directory, runId));

  const res = await runWorkflow(opts.source, {
    adapter,
    runId,
    journalSink: sink,
    config: {
      concurrency: autoConcurrency(),
      ...opts.config,
      args: opts.args,
      resumeFromRunId: opts.resumeFromRunId,
      journalSource: fileJournalSource(opts.directory),
      resolveWorkflowSource: (ref) =>
        resolveSource(typeof ref === "string" ? { name: ref } : { scriptPath: ref.scriptPath }, opts.directory),
    },
  });
  return res.result;
}

export interface ParsedArgs {
  scriptPath?: string;
  args?: unknown;
  resume?: string;
  config: RuntimeConfig;
}

export function parseArgv(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { config: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--args") out.args = JSON.parse(argv[++i] ?? "null");
    else if (a === "--concurrency") out.config.concurrency = Number(argv[++i]);
    else if (a === "--budget") out.config.budgetTotal = Number(argv[++i]);
    else if (a === "--timeout") out.config.agentTimeoutMs = Number(argv[++i]);
    else if (a === "--global-timeout") out.config.globalTimeoutMs = Number(argv[++i]);
    else if (a === "--resume") out.resume = argv[++i];
    else if (!a.startsWith("--")) out.scriptPath = a;
  }
  return out;
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.scriptPath) {
    process.stderr.write(
      "usage: workflow-run-codex <script.js> [--args '<json>'] [--concurrency N] [--budget N] [--timeout MS] [--resume RUNID]\n",
    );
    process.exit(2);
  }
  const directory = process.cwd();
  const p = isAbsolute(parsed.scriptPath) ? parsed.scriptPath : resolve(directory, parsed.scriptPath);
  const source = await readFile(p, "utf8");
  const result = await runHeadlessCodex({
    source,
    directory,
    codex: await createCodex(),
    args: parsed.args,
    config: parsed.config,
    runId: `codex-${basename(p)}`,
    resumeFromRunId: parsed.resume,
  });
  process.stdout.write(`${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`);
}

function isCliEntry(): boolean {
  if ((import.meta as { main?: boolean }).main) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((err) => {
    process.stderr.write(`workflow-run-codex failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Run the CLI test to verify it passes**

Run: `bun test packages/host-codex/test/cli-runner.test.ts`
Expected: PASS

- [ ] **Step 7: Build + commit**

Run: `bunx tsc -b packages/host-codex`
Expected: PASS

```bash
git add -A
git commit -m "feat(host-codex): workflow-run-codex headless CLI runner"
```

---

## Phase 4 — MCP server

### Task 10: `workflow-codex-mcp` MCP server exposing the workflow tools

**Files:**
- Create: `packages/host-codex/src/mcp-entry.ts`
- Create: `packages/host-codex/test/mcp-entry.test.ts`

**Interfaces:**
- Consumes: `runHeadlessCodex`/`createCodex`/`resolveSource` (Task 9), `RunManager`/`DashboardServer`/`indexPath`/`persistScript`/`scriptPath` from `@workflow/host-support`, the MCP server SDK (`@modelcontextprotocol/sdk`).
- Produces:
  - `function buildWorkflowHandlers(deps: { directory: string; codex: CodexLike; manager: RunManager }): { run(args): Promise<{ output: string; metadata: object }>; status(args): Promise<...>; cancel(args): ...; answer(args): ... }` — the tool logic, MCP-transport-independent so it is unit-testable.
  - `function startMcpServer(opts?: { directory?: string }): Promise<void>` — wires handlers to an MCP stdio server.

- [ ] **Step 1: Write the failing test for the transport-independent handlers**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflowHandlers } from "../src/mcp-entry.js";
import { RunManager } from "@workflow/host-support";
import type { CodexLike } from "../src/codex-sdk.js";

function fakeCodex(reply: string): CodexLike {
  const thread = {
    id: "thr",
    async *runStreamed() {
      yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: reply } } as const;
      yield { type: "turn.completed", usage: { output_tokens: 1 } } as const;
    },
  };
  return { startThread: () => thread, resumeThread: () => thread };
}

describe("buildWorkflowHandlers", () => {
  test("run executes an inline script and returns its output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-mcp-"));
    const h = buildWorkflowHandlers({ directory: dir, codex: fakeCodex("OK"), manager: new RunManager() });
    const res = await h.run({ script: "export const meta={name:'m',description:'d'}; return await agent('x');" });
    expect(res.output).toContain("OK");
    expect(res.metadata.runId).toBeString();
  });

  test("cancel reports false for an unknown run", async () => {
    const h = buildWorkflowHandlers({ directory: ".", codex: fakeCodex("x"), manager: new RunManager() });
    const res = await h.cancel({ runId: "nope" });
    expect(res.metadata.cancelled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/host-codex/test/mcp-entry.test.ts`
Expected: FAIL ("Cannot find module .../mcp-entry.js").

- [ ] **Step 3: Implement `packages/host-codex/src/mcp-entry.ts`**

Implement `buildWorkflowHandlers` reusing `runHeadlessCodex` (passing `manager`-derived signal + `onEvent`/`onTranscript` into a `CodexAdapter`; for the first cut, call a thin variant of `runHeadlessCodex` that accepts an injected adapter, OR inline the adapter wiring here so progress feeds `manager.registry`). Mirror `plugin-entry.ts`'s tool semantics: `run` (script/scriptPath/name/input/resume/background), `status`, `cancel`, `answer`. Then `startMcpServer` registers these four as MCP tools over stdio.

Key code (handlers; full adapter wiring shown so progress + lifecycle match opencode):

```ts
#!/usr/bin/env node
import { runWorkflow } from "@workflow/core";
import {
  autoConcurrency,
  DashboardServer,
  FileJournalSink,
  fileJournalSource,
  indexPath,
  journalPath,
  persistScript,
  RunManager,
} from "@workflow/host-support";
import { CodexAdapter } from "./codex-adapter.js";
import type { CodexLike } from "./codex-sdk.js";
import { createCodex } from "./codex-factory.js";
import { resolveSource } from "./resolve-source.js";

export interface WorkflowHandlerDeps {
  directory: string;
  codex: CodexLike;
  manager: RunManager;
  dashboard?: DashboardServer;
}

interface RunArgs {
  script?: string;
  scriptPath?: string;
  name?: string;
  input?: unknown;
  resume?: string;
  replay?: "keyed" | "prefix";
}

export function buildWorkflowHandlers(deps: WorkflowHandlerDeps) {
  const { directory, codex, manager } = deps;
  let runSeq = 0;

  async function run(args: RunArgs) {
    const source = await resolveSource(args, directory);
    const runId = `codex-mcp-${++runSeq}`;
    const isInline = args.script != null && args.script.trim() !== "";
    const savedScriptPath = isInline ? await persistScript(directory, runId, source) : undefined;
    const signal = manager.begin(runId, args.name ?? "workflow");

    const adapter = new CodexAdapter(codex, {
      rootDirectory: directory,
      directory,
      onEvent: (ev) => manager.registry.applyProgress(runId, ev),
      onTranscript: (d) => manager.registry.applyTranscript(d),
      onQuestion: (q) => manager.ask(runId, q.question, q.options, q.timeoutMs),
    });
    const sink = new FileJournalSink(journalPath(directory, runId));

    try {
      const res = await runWorkflow(source, {
        adapter,
        runId,
        journalSink: sink,
        config: {
          concurrency: autoConcurrency(),
          args: args.input,
          signal,
          resumeFromRunId: args.resume,
          replay: args.replay,
          journalSource: fileJournalSource(directory),
          resolveWorkflowSource: (ref) =>
            resolveSource(typeof ref === "string" ? { name: ref } : { scriptPath: ref.scriptPath }, directory),
        },
      });
      const base = typeof res.result === "string" ? res.result : JSON.stringify(res.result, null, 2);
      manager.finish(runId, "completed", res.summary, base.slice(0, 8192));
      return {
        output: savedScriptPath ? `${base}\n\nScript saved to ${savedScriptPath} (run id ${runId}).` : base,
        metadata: { runId, workflow: res.meta.name, agents: res.agents, spentOutputTokens: res.spent, summary: res.summary },
      };
    } catch (err) {
      manager.finish(runId, signal.aborted ? "cancelled" : "failed");
      throw err;
    }
  }

  async function status(args: { runId?: string }) {
    await manager.flush();
    if (args.runId) {
      const live = manager.registry.get(args.runId);
      const persisted = (await manager.history()).find((h) => h.runId === args.runId);
      return { output: JSON.stringify({ live, persisted }, null, 2), metadata: { status: persisted?.status ?? live?.status ?? "running" } };
    }
    const live = manager.list().map((r) => ({ runId: r.runId, name: r.name, status: r.status, agents: r.agents.length }));
    const history = await manager.history();
    return { output: JSON.stringify({ live, history }, null, 2), metadata: { live: live.length, history: history.length } };
  }

  async function cancel(args: { runId: string }) {
    const ok = manager.cancel(args.runId);
    return { output: ok ? `cancelled ${args.runId}` : `run ${args.runId} is not active`, metadata: { cancelled: ok } };
  }

  async function answer(args: { runId: string; answer: string }) {
    const ok = manager.answer(args.runId, args.answer);
    return { output: ok ? `answered ${args.runId}` : `run ${args.runId} has no pending question`, metadata: { answered: ok } };
  }

  return { run, status, cancel, answer };
}

export async function startMcpServer(opts: { directory?: string } = {}): Promise<void> {
  const directory = opts.directory ?? process.cwd();
  const manager = new RunManager({ indexPath: indexPath(directory) });
  await manager.recover().catch(() => undefined);
  const codex = await createCodex();
  const handlers = buildWorkflowHandlers({ directory, codex, manager });

  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");

  const server = new Server({ name: "workflow-codex", version: "0.1.0" }, { capabilities: { tools: {} } });
  const tools = [
    { name: "workflow", description: "Run a portable dynamic workflow script on Codex.", inputSchema: { type: "object", properties: { script: { type: "string" }, scriptPath: { type: "string" }, name: { type: "string" }, input: {}, resume: { type: "string" }, replay: { type: "string", enum: ["keyed", "prefix"] } } } },
    { name: "workflow_status", description: "List workflow runs with status.", inputSchema: { type: "object", properties: { runId: { type: "string" } } } },
    { name: "workflow_cancel", description: "Cancel an in-flight workflow run.", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } },
    { name: "workflow_answer", description: "Answer a paused workflow question().", inputSchema: { type: "object", properties: { runId: { type: "string" }, answer: { type: "string" } }, required: ["runId", "answer"] } },
  ];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const a = req.params.arguments ?? {};
    const dispatch: Record<string, () => Promise<{ output: string }>> = {
      workflow: () => handlers.run(a),
      workflow_status: () => handlers.status(a as { runId?: string }),
      workflow_cancel: () => handlers.cancel(a as { runId: string }),
      workflow_answer: () => handlers.answer(a as { runId: string; answer: string }),
    };
    const fn = dispatch[req.params.name];
    if (!fn) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
    const res = await fn();
    return { content: [{ type: "text", text: res.output }] };
  });

  await server.connect(new StdioServerTransport());
}

function isCliEntry(): boolean {
  return (import.meta as { main?: boolean }).main === true;
}
if (isCliEntry()) {
  startMcpServer().catch((err) => {
    process.stderr.write(`workflow-codex-mcp failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
```

(Confirm `@modelcontextprotocol/sdk` import paths + request-schema names against the installed version; adjust the dynamic imports if the SDK exposes a higher-level `McpServer`/`registerTool` API — prefer that if available and keep `buildWorkflowHandlers` unchanged.)

- [ ] **Step 4: Run the handlers test to verify it passes**

Run: `bun test packages/host-codex/test/mcp-entry.test.ts`
Expected: PASS

- [ ] **Step 5: Build + commit**

Run: `bunx tsc -b packages/host-codex`
Expected: PASS

```bash
git add -A
git commit -m "feat(host-codex): workflow-codex-mcp MCP server + transport-independent handlers"
```

---

## Phase 5 — Docs & contract

### Task 11: Update spec, test matrix, CLAUDE.md, INSTALL.md

**Files:**
- Modify: `docs/spec/WORKFLOW_SCRIPT_SPEC.md`
- Modify: `docs/spec/SPEC_TEST_MATRIX.md`
- Modify: `CLAUDE.md`
- Modify: `INSTALL.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a "Codex host capability differences" subsection to `WORKFLOW_SCRIPT_SPEC.md`**

Add, near where host capability differences (Claude Code vs opencode) are discussed:

```markdown
### Codex host

The `@workflow/host-codex` adapter maps `agent()` onto Codex threads. Capability notes:

- **`agentType` is ignored.** Codex has no named subagents; `listAgents()` returns `[]`.
- **`cost` is reported as 0.** Codex exposes no per-turn USD cost; only token usage
  (which feeds `budget`). `RunSummary.costUsd` will be 0 under Codex.
- **Structured output** uses the turn's `outputSchema`; the core still re-validates
  with ajv. `capabilities.structuredOutput` is `true`.
- **`question()`** is answerable only when a dashboard/MCP host is present to resolve it;
  otherwise it resolves to `opts.default ?? null`, exactly as the contract requires.
- **Worktree isolation** uses the same git-worktree mechanism as opencode; the Codex
  thread runs with `workingDirectory` set to the worktree.
```

- [ ] **Step 2: Add rows to `SPEC_TEST_MATRIX.md`**

For each capability note above, add a row mapping it to the covering test:
- `agentType ignored / listAgents empty` → `packages/host-codex/test/codex-adapter.test.ts`
- `token usage from turn.completed` → `codex-adapter.test.ts`
- `structured output via outputSchema` → `codex-adapter.test.ts`
- `error classification retriable` → `codex-adapter.test.ts`
- `transcript translation` → `codex-transcript.test.ts`
- `headless run end-to-end` → `cli-runner.test.ts`

- [ ] **Step 3: Update `CLAUDE.md` architecture section**

- Change the package list to three packages plus `host-codex`, and note `@workflow/host-support` holds the dashboard + run lifecycle + worktree + journal, reused by both hosts; it is **not** part of the portability contract but is allowed to depend on the dashboard (only `core` must stay pure).
- Update the `bun test` command to include all four test dirs.
- Update the root `build` description (dashboard now builds from `host-support`).
- Note the new bins: `workflow-run-codex`, `workflow-codex-mcp`, and `.codex/workflows/` as the Codex name registry.

- [ ] **Step 4: Update `INSTALL.md` with Codex smoke steps**

Add a section: installing `@openai/codex-sdk`, exporting auth, running `workflow-run-codex examples/<x>.js`, and registering `workflow-codex-mcp` as an MCP server in Codex config. Mark these as paid/live and excluded from the offline suite.

- [ ] **Step 5: Run the full suite + build as the final gate**

Run: `bun run build && bun test packages/core/test packages/host-support/test packages/host-opencode/test packages/host-codex/test`
Expected: clean build; all tests PASS.
Run: `bun run scripts/portability-check.ts`
Expected: example scripts still validate (no contract regressions).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: document Codex host + host-support restructure (spec, matrix, CLAUDE.md, INSTALL.md)"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §1 package structure → Tasks 1-5 (host-support), 6 (host-codex scaffold).
- §2 CodexAdapter mapping → Task 8 (+ 6 facade, 7 transcript).
- §3 dashboard/transcript generalization → Task 3 (+ opencode translator in Task 5).
- §4 trigger surfaces → Task 9 (CLI), Task 10 (MCP).
- §5 testing & contract → tests embedded per task; Task 11 (docs/matrix).
- Risks (core untouched, SDK version drift, sandbox) → Global Constraints + notes in Tasks 8/9/10.

**2. Placeholder scan** — no "TBD/implement later"; the few "confirm against installed SDK version" notes are explicit verification steps tied to concrete fallbacks, not deferred design. Acceptable: pinning exact `@openai/codex-sdk` / `@modelcontextprotocol/sdk` versions happens at install time (Tasks 6/9/10) since they are environment-dependent.

**3. Type consistency** — `TranscriptDelta` shape is identical across host-support (Task 3), opencode translator (Task 5), and codex translator (Task 7). `CodexLike`/`ThreadLike`/`CodexEvent`/`TurnOptions` defined once in Task 6's `codex-sdk.ts` and consumed unchanged in Tasks 7-10. `AgentResult`/`AgentRequest` come from core unchanged. `createWorktree(baseDir, id, log?)` signature is consistent across host-support (Task 4), opencode adapter (Task 5), codex adapter (Task 8). `RunRegistry.applyTranscript(delta)` defined in Task 3 and called in Tasks 5/10.
