---
name: recurring-failure-modes
description: Failure-mode patterns that recur in this repo's adversarial reviews — check these first on new changes
metadata:
  type: project
---

Patterns worth probing first when reviewing changes in opencode-dynamic-workflow.

**Why:** these classes of bug have shown up and are easy to re-introduce given the architecture (fire-and-forget I/O queues, per-session accounting offsets, narrow SDK error shapes).

**How to apply:** when a change touches persistence, token/budget accounting, or host error handling, walk these explicitly.

1. **Fire-and-forget persistence vs immediate read-back.** `RunIndex.record()` (packages/host-opencode/src/dashboard/run-index.ts) queues an `appendFile` and does NOT await; durability requires `RunIndex.flush()` / `RunManager.flush()`. Any code path that `record()`s then expects a later `readAll()`/`history()` to see it (especially across a tool-call boundary like `workflow_status`) is racy unless it flushes. Tests that poll-with-retry instead of asserting once are masking this race.

2. **Side-effecting usage accounting.** `OpencodeAdapter.turnUsage()` advances `this.counted[sessionId]` as a side effect every time it is called, even if the caller discards the returned usage. Any early-return AFTER `turnUsage()` ran (e.g. the post-200 `info.error` branch) silently drops that turn's tokens from the budget while still advancing the offset, so a subsequent call on the same session under-counts. Check ordering of `turnUsage()` vs error/short-circuit returns.

3. **Over-broad host error classification.** `isBadRequest()` (opencode-adapter.ts) treats the generic hey-api `{ success: false }` terminal shape (same shape `classifyError` uses for ALL terminal errors) as "format rejected" → permanently flips `structuredSupported=false`. Any non-format 400 (bad model, bad agent, malformed prompt) raised while a schema is in flight is misattributed to native-structured-output and silently downgrades the whole run. One-way capability flags that never recover compound this.

4. **Native-vs-fallback dual-run on the same session.** The native structured-output fallback re-runs `runStructured` on the SAME sessionId after a failed native turn, inheriting that turn's conversation history and the advanced `counted` offset. Probe conversation contamination + budget correctness whenever a retry/fallback reuses a session.

5. **Portability contract leak check (always run).** Core (`packages/core/src`) must have zero SDK imports; new `AgentRequest`/`AgentResult` fields are host-internal only if the core never threads them from script-supplied `AgentOpts`. Verify `AgentOpts` (types.ts) does NOT gain the field and `invokeWithRetry` does not copy `opts.<field>` into the request. (As of feat/cc-workflow-parity, `tools`/`schema` are correctly host-internal.)

6. **Journal cache-key integrity.** `cacheKey()` hashes `normalizeOpts(opts)` (script-level AgentOpts), NOT AgentRequest, so new request-level fields do not pollute resume keys — confirm any new field stays out of the key path.
