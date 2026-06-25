# Authoring Guide

Practical guidance for writing portable workflow scripts. For the normative
rules, see [WORKFLOW_SCRIPT_SPEC.md](./WORKFLOW_SCRIPT_SPEC.md).

## The mental model

A workflow is a deterministic *orchestrator*. You write plain JS that calls
`agent()` to delegate work to sub-agents, and `parallel()` / `pipeline()` to fan
that work out. The script itself does no model calls — it only arranges them.

## Patterns

**Pipeline by default.** When stages are independent per item, prefer
`pipeline()` over `parallel()` — items flow through stages without a barrier, so
fast items don't wait on slow ones.

```js
const results = await pipeline(
  files,
  (_, file) => agent(`Review ${file}`, { schema: FINDINGS }),
  (review) => parallel((review?.findings ?? []).map((f) => () =>
    agent(`Verify: ${f.issue}`, { schema: VERDICT }).then((v) => ({ ...f, verdict: v })))),
);
```

**Adversarial verify.** For findings you’ll act on, spawn independent verifiers
and keep only those a majority confirm. Diversity (different lenses) beats
redundancy.

**Loop until dry.** For unknown-size discovery, keep spawning finders until N
consecutive rounds surface nothing new — counters miss the tail.

**Structured output.** Pass a `schema` for anything you branch on. On opencode
the schema is enforced by prompt-instruction + validation + retry; on Claude Code
it is enforced natively. Either way your script sees a validated object or
`null`.

## Determinism

Never call `Date.now()`, `Math.random()`, or `new Date()` with no argument — the
validator rejects them. If a workflow needs a seed or timestamp, pass it in via
`args` and read it from there. This is what lets the same script cache, resume,
and behave identically on both hosts.

## Null-handling

`agent()`, `parallel()`, and `pipeline()` degrade failures to `null` instead of
throwing. Always `.filter(Boolean)` before consuming their results, and treat
schema-constrained results as possibly `null`.

## Budget-aware scaling

When a run has a token budget, scale your fan-out to it:

```js
const fleet = budget.total ? Math.floor(budget.total / 100000) : 5;
```
