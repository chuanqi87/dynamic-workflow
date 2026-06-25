# Workflow Script Spec (v1)

This is the single source of truth for the **portable workflow script contract**.
A script that conforms to this spec runs **unchanged** on:

- **Claude Code** — via its native `Workflow` tool runtime, and
- **opencode** — via the `@workflow/host-opencode` plugin in this repo.

Portability is achieved by honouring one contract, not by transforming scripts.
Neither host modifies the script; both inject the same ambient globals and apply
the same sandbox rules.

---

## 1. File shape

A workflow script is **plain JavaScript** (not a module, not TypeScript). It has
exactly two parts:

```js
export const meta = { /* pure literal — see §2 */ };
// ── async function body ── (everything after the meta literal)
phase("Find");
const x = await agent("…");
return { x };          // top-level return yields the workflow result
```

- The file **must begin** with `export const meta = { … }`.
- Everything after the meta literal is treated as an **async function body**:
  it may use top-level `await` and top-level `return`, and it references the
  ambient globals in §3 directly (do **not** `import` them).

> Why this is neither a real ES module nor a plain script: it combines `export`
> (module-only) with top-level `return` (script-only). Hosts parse the meta
> literal in isolation and run the remainder as an async function body.

---

## 2. The `meta` block

`meta` **must be a pure object literal** — no variables, function calls, template
interpolation, spreads, or computed keys. Allowed fields:

| field | type | meaning |
|---|---|---|
| `name` | string (required) | short identifier shown in progress UIs |
| `description` | string (required) | one-line summary |
| `phases` | `{ title: string, detail?: string, model?: string }[]` | declared phases for the progress display |
| `whenToUse` | string | optional usage hint |
| `model` | string | default logical model for the run |

Any other field, or any non-literal value, is a **validation error**.

---

## 3. Ambient globals

These are injected into the body. They are the entire portable surface.

### `agent(prompt, opts?) => Promise<string | object | null>`
Runs one sub-agent to completion.
- Without `opts.schema`: resolves to the sub-agent's **final text** (string).
- With `opts.schema` (a JSON Schema object): resolves to a **validated object**.
- Resolves to **`null`** when the sub-agent is skipped (budget exhausted),
  aborted, errors out, or fails schema validation after retries.

`opts` fields:

| field | type | meaning |
|---|---|---|
| `label` | string | display label (does **not** affect caching) |
| `phase` | string | phase to group this call under |
| `schema` | JSON Schema | constrain & validate the output |
| `model` | string | logical model (`"opus"`) or `"provider/model-id"` |
| `effort` | `"low"\|"medium"\|"high"\|"xhigh"\|"max"` | reasoning-effort tier |
| `agentType` | string | named host subagent to use |
| `isolation` | `"worktree"` | run in an isolated git worktree |

### `parallel(thunks) => Promise<any[]>`
Runs `() => Promise` thunks concurrently and awaits them all (a **barrier**). A
thunk that throws (or whose `agent()` dies) resolves to `null` in the result
array — `parallel` itself never rejects. Filter with `.filter(Boolean)`.

### `pipeline(items, stage1, stage2, …) => Promise<any[]>`
Runs each item through all stages independently with **no barrier between
stages** — item A may be in stage 3 while item B is still in stage 1. Each stage
callback receives `(prevResult, originalItem, index)`. A stage that throws drops
that item to `null` and skips its remaining stages.

### `phase(title)` / `log(message)`
Progress reporting. No return value.

### `workflow(nameOrRef, args?) => Promise<any>`
Runs another workflow inline as a sub-step (one level of nesting only). `nameOrRef`
is a registered name (string) or `{ scriptPath }`. The child shares the run's
concurrency cap, agent counter, and budget.

### `args`
The input value passed to this run, verbatim.

### `budget`
`{ total: number | null, spent(): number, remaining(): number }` — an
output-token budget. `total` is `null` when unbounded. Once exhausted, further
`agent()` calls degrade to `null`.

---

## 4. Sandbox rules (enforced before the script runs)

A host **must reject** a script that violates any of these:

1. `meta` is not a pure literal (see §2).
2. The body contains **TypeScript syntax** (type annotations, `interface`, `as`,
   generics, …). Scripts are plain JS.
3. The body uses **`Date.now()`**, **`Math.random()`**, or **argument-less
   `new Date()`**. Workflows must be deterministic so resume/caching is sound;
   derive any time/randomness from `args`.
4. The body references escape identifiers: `globalThis`, `process`, `require`,
   `eval`, `Function`, `import()` (dynamic), `module`, `exports`, …
5. A single `parallel()` / `pipeline()` call exceeds **4096** items.
6. A whole run exceeds **1000** `agent()` calls.

Free identifiers outside the ambient globals + standard safe builtins produce a
**warning** (they may not exist on every host).

---

## 5. Determinism & caching

- A run is identified by a `runId`. Within a run, two `agent()` calls with an
  identical `(prompt, opts)` (ignoring `label`/`phase`) return the **same cached
  result** — the sub-agent runs once.
- Because scripts are deterministic (rule §4.3), replaying a run reproduces the
  same `(prompt, opts)` sequence, which is what makes cross-run resume possible.

---

## 6. Concurrency

In-flight sub-agents are capped (Claude Code: `min(16, cores−2)`; opencode:
configurable, default 3). Excess calls queue. `parallel`/`pipeline` may be handed
thousands of items; only the cap runs at once.

---

## 7. Minimal conforming example

```js
export const meta = {
  name: "hello",
  description: "Greet, then write blurbs in parallel.",
  phases: [{ title: "Greet" }, { title: "Blurbs" }],
};

phase("Greet");
const greeting = await agent("Reply with a one-sentence friendly greeting.");

phase("Blurbs");
const topics = ["weather", "news", "sports"];
const blurbs = await parallel(topics.map((t) => () => agent(`One sentence about ${t}.`)));

return { greeting, blurbs: blurbs.filter(Boolean) };
```
