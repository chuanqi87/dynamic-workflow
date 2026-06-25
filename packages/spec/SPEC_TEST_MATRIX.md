# Spec → Test Matrix

Every contract clause in [WORKFLOW_SCRIPT_SPEC.md](./WORKFLOW_SCRIPT_SPEC.md) and
every DFX hardening behaviour maps to at least one automated test. Tests use a
`MockAdapter` (core) or a fake `OpencodeClient` (host) — no real models, no real
sleeps (injected `sleep`/`now`/`rng`). This table is the regression baseline.

| # | Contract / DFX clause | Test(s) |
|---|---|---|
| meta is a pure literal | §2 | `portability-validator.test.ts` → "rejects non-literal meta" |
| meta field whitelist | §2 | "rejects unknown meta keys" |
| plain JS only (no TS) | §4.2 | "rejects TypeScript syntax" |
| no `Math.random()` | §4.3 | "rejects Math.random()" |
| no `Date.now()` / argless `new Date()` | §4.3 | "rejects Date.now() and argless new Date()" |
| escape identifiers banned | §4.4 | "rejects escape identifiers" |
| `.constructor`/`.__proto__` banned | §4.4 (DFX P2-11) | "rejects proto access" |
| single batch ≤ 4096 | §4.5 | "flags literal batch over the limit" + `runtime` MAX_BATCH guard |
| total agents ≤ 1000 | §4.6 | `AgentLimitError` (agent-runner counter) |
| `agent()` returns text | §3 | `engine.test.ts` → "returns a basic agent result" |
| `agent({schema})` returns validated object | §3 | "schema-constrained agent returns a validated object" |
| schema retry-with-feedback | §3 | `structured-output.test.ts` → "retries with feedback then succeeds" |
| `parallel` barrier + null degrade | §3 | "parallel degrades a throwing thunk to null" |
| `pipeline` no-barrier + per-item null | §3 | "pipeline threads stages and isolates failures" |
| identical `(prompt,opts)` cached in-run | §5 | "identical (prompt, opts) is cached within a run" |
| label/phase excluded from cache key | §5 | `journal.test.ts` → "ignores display-only label and phase" |
| concurrency cap (queueing) | §6 | `semaphore.test.ts` (all) |
| concurrency auto = min(16,cores-2) | §6 (DFX P2-10) | host `autoConcurrency()` (plugin-entry) |
| **terminal error → null after retries** | §3 (DFX P0-1) | `dfx.test.ts` → "retries a transient error then succeeds" / "does NOT retry a terminal error" / "exhausting retries" |
| backoff schedule | DFX P0-1 | "backoff follows the exponential schedule" |
| transient classification (host) | DFX P0-1 | `opencode-adapter.test.ts` → "error classification" block |
| **budget hard ceiling → throw** | budget §3 (DFX P0-2) | `engine.test.ts` → "budget exhaustion throws by default" |
| budget degrade mode | DFX P0-2 | "budget exhaustion degrades to null when budgetMode is 'degrade'" |
| **cross-run resume (keyed)** | resume §5 (DFX P0-3) | `resume.test.ts` → "reuses all cached results" / "only changed agent() calls run live" |
| failed results not seeded | DFX P0-3 | "failed (null) results are NOT seeded" |
| corrupted journal → fresh | DFX P0-3 | "a corrupted/missing journal degrades to a fresh run" |
| journal seeds only successes | DFX P0-3 | `journal.test.ts` → "seeds only successful agent results" |
| global wall-clock timeout | DFX P1-4 | `dfx.test.ts` → "aborts in-flight agents when the global timeout elapses" |
| sub-session cleanup on cancel | DFX P1-5 | "closes created sessions when the run is cancelled" + adapter "closeSession" |
| journal flush on end | DFX P1-6 | `FileJournalSink.flush` (engine cleanup); covered via plugin-entry integration |
| cost/token summation | DFX P1-7 | `opencode-adapter.test.ts` → "sums tokens and cost across all assistant messages" |
| run summary counters | DFX P2-8 | `dfx.test.ts` → "counts successes, nulls-by-reason and tokens" |
| dropped-item logging (no silent caps) | §4 (DFX P2-9) | "logs a dropped event for a throwing parallel thunk" |
| journal memory bound | DFX P2-12 | `journal.test.ts` → "stops caching past the cap and warns once" |
| phase default model | DFX P2-13 | `dfx.test.ts` → "uses the phase's model when opts specify none" |
| abort returns immediately / mid-flight | §3 | `opencode-adapter.test.ts` → "already aborted" / "aborts an in-flight prompt" |
| per-agent timeout | §3 | `opencode-adapter.test.ts` → "respects per-call timeout" |
| end-to-end opencode path | — | `plugin-entry.test.ts` → "runs an inline script end-to-end" |
