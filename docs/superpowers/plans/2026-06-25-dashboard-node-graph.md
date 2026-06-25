# 节点图式现代 Dashboard 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 opencode 的 dashboard 从等宽 TUI 风格三栏页面,改造成清爽浅色、以真实依赖节点图为中心、点击节点看详情的现代前端应用。

**Architecture:** 给 `@workflow/core` 增加一个基于 `AsyncLocalStorage` 的编排上下文,让 `agent-start` 进度事件携带可选的 `group`(parallel/pipeline 分组与阶段)元数据;host 侧把该元数据存进 `RunView`,用纯函数 `buildGraph` 把运行快照转成节点/边,前端用 React + React Flow + dagre 渲染。dashboard 静态产物由现有 HTTP server 提供,所有 SSE/JSON 接口不变。

**Tech Stack:** TypeScript(strict, NodeNext)、Bun(包管理 + 测试)、`node:async_hooks`、Vite、React、`@xyflow/react`、`dagre`。

## Global Constraints

- **包管理与测试**:Bun `bun@1.3.14`;ESM-only(`"type": "module"`);TS strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。
- **跨包导入**:`.ts` 源码里对内部模块用 `.js` 扩展名(NodeNext/bundler 解析)。
- **`bun run build` 即 typecheck**:`tsc -b` 必须先干净通过,再跑 dashboard 构建;不存在独立 lint。
- **可移植性契约不破**:脚本面向的 globals/sandbox/确定性规则零改动;新增的 `agent-start.group` 字段**全部可选**、是 host 内部遥测、不进 journal key、不影响 resume。**禁止**在用户脚本可见路径使用 `Date.now()`/`Math.random()`/argless `new Date()`;group id 用确定性计数器。
- **dashboard 是 opencode-only**:不得泄漏进 `@workflow/core` 的跨 host 假设;`{ "dashboard": false }` 仍可关闭。
- **离线测试**:全套测试不联网。前端交互测试不在范围;可测逻辑下沉到纯函数。
- **提交**:每个 Task 末尾一次提交;提交信息结尾加
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- **当前分支**:`feat/dashboard-node-graph`(已存在;在此分支上实现)。

---

### Task 1: 编排上下文模块 `orchestration-context.ts`

**Files:**
- Create: `packages/core/src/orchestration-context.ts`
- Test: `packages/core/src/orchestration-context.test.ts`

**Interfaces:**
- Produces:
  - `interface Frame { kind: "parallel" | "pipeline"; groupId: string; parentId?: string; index: number; stageIndex?: number }`
  - `function currentFrames(): Frame[]`
  - `function runInFrame<T>(frame: Frame, fn: () => T): T`

- [ ] **Step 1: 写失败测试**

`packages/core/src/orchestration-context.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { currentFrames, runInFrame, type Frame } from "./orchestration-context.js";

const f = (groupId: string, extra: Partial<Frame> = {}): Frame => ({
  kind: "parallel",
  groupId,
  index: 0,
  ...extra,
});

describe("orchestration-context", () => {
  test("currentFrames() is empty outside any frame", () => {
    expect(currentFrames()).toEqual([]);
  });

  test("runInFrame exposes the frame to synchronous reads", () => {
    const seen = runInFrame(f("g1"), () => currentFrames());
    expect(seen).toEqual([f("g1")]);
    // store is restored after the call
    expect(currentFrames()).toEqual([]);
  });

  test("runInFrame nests: inner sees the full stack, outer is unaffected", () => {
    runInFrame(f("g1"), () => {
      const inner = runInFrame(f("g2", { parentId: "g1", index: 2 }), () => currentFrames());
      expect(inner.map((x) => x.groupId)).toEqual(["g1", "g2"]);
      expect(currentFrames().map((x) => x.groupId)).toEqual(["g1"]);
    });
  });

  test("context propagates across awaits inside the frame", async () => {
    const seen = await runInFrame(f("g1"), async () => {
      await Promise.resolve();
      return currentFrames();
    });
    expect(seen.map((x) => x.groupId)).toEqual(["g1"]);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `bun test packages/core/src/orchestration-context.test.ts`
Expected: FAIL —「Cannot find module './orchestration-context.js'」。

- [ ] **Step 3: 实现模块**

`packages/core/src/orchestration-context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One orchestration frame: where an agent() call sits relative to the
 * parallel/pipeline that spawned it. Pure telemetry — never affects results,
 * the journal key, or resume. Only the opencode dashboard consumes it.
 */
export interface Frame {
  kind: "parallel" | "pipeline";
  /** Stable id of the nearest parallel/pipeline call (deterministic counter). */
  groupId: string;
  /** groupId of the enclosing group, when nested. */
  parentId?: string;
  /** parallel: thunk index; pipeline: item index. */
  index: number;
  /** pipeline only: which stage produced this agent. */
  stageIndex?: number;
}

const store = new AsyncLocalStorage<Frame[]>();

/** The frame stack for the current async context (outermost first). */
export function currentFrames(): Frame[] {
  return store.getStore() ?? [];
}

/** Run `fn` with `frame` pushed onto the current stack. */
export function runInFrame<T>(frame: Frame, fn: () => T): T {
  return store.run([...currentFrames(), frame], fn);
}
```

- [ ] **Step 4: 运行,确认通过**

Run: `bun test packages/core/src/orchestration-context.test.ts`
Expected: PASS(4 tests)。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/orchestration-context.ts packages/core/src/orchestration-context.test.ts
git commit -m "feat(core): AsyncLocalStorage orchestration context for agent grouping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 让 `agent-start` 携带 group 元数据(core 全链路)

把 group 元数据从 parallel/pipeline 埋帧 → agent-runner 读取 → 进度事件,贯通起来。

**Files:**
- Modify: `packages/core/src/types.ts`(给 `agent-start` 加可选 `group`;新增 `AgentGroup` 类型)
- Modify: `packages/core/src/progress-reporter.ts`(`agentStart` 接收并转发 `group`)
- Modify: `packages/core/src/runtime-context.ts`(parallel/pipeline 埋帧;`GlobalsDeps.allocGroupId`)
- Modify: `packages/core/src/engine.ts`(`SharedState.groups` 共享计数器;`buildGlobals` 传 `allocGroupId`)
- Modify: `packages/core/src/agent-runner.ts`(`run` 顶部同步读帧,下传 `execute`,发 `group`)
- Modify: `packages/spec/WORKFLOW_SCRIPT_SPEC.md`、`packages/spec/SPEC_TEST_MATRIX.md`(登记新遥测字段)
- Test: `packages/core/src/orchestration-metadata.test.ts`(新建,端到端)

**Interfaces:**
- Consumes: `Frame`、`currentFrames`、`runInFrame`(Task 1)。
- Produces:
  - `interface AgentGroup { id: string; kind: "parallel" | "pipeline"; parentId?: string; index: number; stageIndex?: number }`
  - `agent-start` 事件新增 `group?: AgentGroup`。
  - `ProgressReporter.agentStart(label: string, phase?: string, sessionId?: string, group?: AgentGroup): void`
  - `GlobalsDeps.allocGroupId: () => string`
  - parallel/pipeline 新签名(向后兼容,新增可选末参):
    - `parallel(thunks, onDrop?, allocGroupId?): Promise<unknown[]>`
    - `pipeline(items, ...stages)`(globals 版本不变;内部 `pipelineWith(items, onDrop, stages, allocGroupId?)`)

- [ ] **Step 1: 写失败测试**

`packages/core/src/orchestration-metadata.test.ts` —— 用一个最小的 fake adapter 捕获 `agent-start` 事件,断言 group 元数据正确。脚本直接调用 `buildGlobals` 产出的 `agent/parallel/pipeline`。

```ts
import { describe, expect, test } from "bun:test";
import { runWorkflow } from "./engine.js";
import type {
  AgentRequest,
  AgentResult,
  HostAdapter,
  HostAgentInfo,
  ProgressEvent,
} from "./types.js";

function fakeAdapter(events: ProgressEvent[]): HostAdapter {
  let n = 0;
  return {
    rootDirectory: "/tmp/wf",
    async runAgent(_req: AgentRequest): Promise<AgentResult> {
      return { text: "ok", tokens: { input: 1, output: 1, reasoning: 0 }, cost: 0, aborted: false, errored: false };
    },
    async createSubSession(): Promise<string> {
      return `s${++n}`;
    },
    async listAgents(): Promise<HostAgentInfo[]> {
      return [];
    },
    report(ev: ProgressEvent): void {
      events.push(ev);
    },
  };
}

const starts = (events: ProgressEvent[]) =>
  events.filter((e): e is Extract<ProgressEvent, { type: "agent-start" }> => e.type === "agent-start");

describe("agent-start group metadata", () => {
  test("top-level agent() carries no group", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await agent("hi", { label: "solo" });`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r1" });
    const s = starts(events).find((e) => e.label === "solo");
    expect(s?.group).toBeUndefined();
  });

  test("parallel children share a groupId, index by position", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await parallel([
        () => agent("a", { label: "p0" }),
        () => agent("b", { label: "p1" }),
      ]);`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r2" });
    const p0 = starts(events).find((e) => e.label === "p0")!;
    const p1 = starts(events).find((e) => e.label === "p1")!;
    expect(p0.group?.kind).toBe("parallel");
    expect(p0.group?.id).toBe(p1.group?.id);
    expect([p0.group?.index, p1.group?.index].sort()).toEqual([0, 1]);
    expect(p0.group?.stageIndex).toBeUndefined();
  });

  test("pipeline stages carry stageIndex and itemIndex within one groupId", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await pipeline([{}],
        (_p, _item, i) => agent("s0", { label: "stage0-" + i }),
        (_p, _item, i) => agent("s1", { label: "stage1-" + i }),
      );`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r3" });
    const s0 = starts(events).find((e) => e.label === "stage0-0")!;
    const s1 = starts(events).find((e) => e.label === "stage1-0")!;
    expect(s0.group?.kind).toBe("pipeline");
    expect(s0.group?.id).toBe(s1.group?.id);
    expect(s0.group?.index).toBe(0);
    expect(s0.group?.stageIndex).toBe(0);
    expect(s1.group?.stageIndex).toBe(1);
  });

  test("parallel nested in a pipeline stage links parentId", async () => {
    const events: ProgressEvent[] = [];
    const source = `export const meta = { name: "t", description: "d" };
      await pipeline([{}],
        (_p, _item, i) => agent("lead", { label: "lead-" + i }),
        () => parallel([ () => agent("x", { label: "child" }) ]),
      );`;
    await runWorkflow(source, { adapter: fakeAdapter(events), runId: "r4" });
    const lead = starts(events).find((e) => e.label === "lead-0")!;
    const child = starts(events).find((e) => e.label === "child")!;
    expect(lead.group?.kind).toBe("pipeline");
    expect(child.group?.kind).toBe("parallel");
    expect(child.group?.parentId).toBe(lead.group?.id);
  });

  test("group ids are stable across a re-run (determinism)", async () => {
    const source = `export const meta = { name: "t", description: "d" };
      await parallel([ () => agent("a", { label: "p0" }) ]);`;
    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    await runWorkflow(source, { adapter: fakeAdapter(a), runId: "rA" });
    await runWorkflow(source, { adapter: fakeAdapter(b), runId: "rB" });
    expect(starts(a).find((e) => e.label === "p0")!.group?.id)
      .toBe(starts(b).find((e) => e.label === "p0")!.group?.id);
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `bun test packages/core/src/orchestration-metadata.test.ts`
Expected: FAIL —— `group` 全为 `undefined`(字段尚未实现)。

- [ ] **Step 3: 给 `types.ts` 加 `AgentGroup` 与事件字段**

在 `packages/core/src/types.ts` 中,`ProgressEvent` 联合定义前(或附近)新增类型,并扩展 `agent-start`:

```ts
/**
 * Where an agent() sits in the parallel/pipeline orchestration that spawned
 * it. Optional, host-internal telemetry: not visible to scripts, never part
 * of the journal key, and absent under Claude Code's native runtime.
 */
export interface AgentGroup {
  id: string;
  kind: "parallel" | "pipeline";
  parentId?: string;
  index: number;
  stageIndex?: number;
}
```

把这一行:

```ts
  | { type: "agent-start"; label: string; phase?: string; sessionId?: string }
```

改成:

```ts
  | { type: "agent-start"; label: string; phase?: string; sessionId?: string; group?: AgentGroup }
```

- [ ] **Step 4: `progress-reporter.ts` 转发 group**

把 `agentStart` 改为:

```ts
  agentStart(label: string, phase?: string, sessionId?: string, group?: AgentGroup): void {
    this.agents++;
    this.emit({ type: "agent-start", label, phase, sessionId, group });
  }
```

并在文件顶部 import 里加入 `AgentGroup`:

```ts
import type { AgentGroup, HostAdapter, NullReason, ProgressEvent, RunSummary } from "./types.js";
```

- [ ] **Step 5: `runtime-context.ts` 埋帧 + allocGroupId**

文件顶部新增 import:

```ts
import { currentFrames, runInFrame } from "./orchestration-context.js";
```

把 `parallel` 改为(新增可选 `allocGroupId`,不传则行为完全不变):

```ts
export async function parallel(
  thunks: Array<() => Promise<unknown>>,
  onDrop?: (index: number, reason: string) => void,
  allocGroupId?: () => string,
): Promise<unknown[]> {
  assertBatch("parallel", thunks.length);
  const groupId = allocGroupId?.();
  const parentId = currentFrames().at(-1)?.groupId;
  return Promise.all(
    thunks.map((t, i) =>
      Promise.resolve()
        .then(() =>
          groupId
            ? runInFrame({ kind: "parallel", groupId, parentId, index: i }, () => t())
            : t(),
        )
        .catch((err) => {
          onDrop?.(i, reason(err));
          return null;
        }),
    ),
  );
}
```

把 `pipelineWith` 改为(新增可选 `allocGroupId`):

```ts
async function pipelineWith(
  items: unknown[],
  onDrop: ((index: number, reason: string) => void) | undefined,
  stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>,
  allocGroupId?: () => string,
): Promise<unknown[]> {
  assertBatch("pipeline", items.length);
  const groupId = allocGroupId?.();
  const parentId = currentFrames().at(-1)?.groupId;
  return Promise.all(
    items.map(async (item, index) => {
      let prev: unknown = item;
      try {
        for (let k = 0; k < stages.length; k++) {
          const stage = stages[k]!;
          prev = groupId
            ? await runInFrame(
                { kind: "pipeline", groupId, parentId, index, stageIndex: k },
                () => stage(prev, item, index),
              )
            : await stage(prev, item, index);
        }
        return prev;
      } catch (err) {
        onDrop?.(index, reason(err));
        return null;
      }
    }),
  );
}
```

在 `GlobalsDeps` 接口里新增:

```ts
  /** Allocate a deterministic group id for the next parallel/pipeline call. */
  allocGroupId: () => string;
```

把 `buildGlobals` 里 parallel/pipeline 两行改为传入 allocator:

```ts
    parallel: (thunks) =>
      parallel(
        thunks,
        (index, r) => deps.reporter.dropFromBatch("parallel", index, r),
        deps.allocGroupId,
      ),
    pipeline: (items, ...stages) =>
      pipelineWith(
        items,
        (index, r) => deps.reporter.dropFromBatch("pipeline", index, r),
        stages,
        deps.allocGroupId,
      ),
```

- [ ] **Step 6: `engine.ts` 加共享计数器并接线**

在 `SharedState` 接口里,`counter: AgentCounter;` 之后新增:

```ts
  /** Shared, deterministic group-id counter (parallel/pipeline). */
  groups: { n: number };
```

在 `shared` 对象字面量里,`counter: { n: 0 },` 之后新增:

```ts
    groups: { n: 0 },
```

在 `runOne` 的 `buildGlobals({ ... })` 调用里,新增一行:

```ts
    allocGroupId: () => `g${++shared.groups.n}`,
```

(共享 `shared.groups` → 同一个 run 内 parallel/pipeline 全局唯一,嵌套 workflow 也共享。)

- [ ] **Step 7: `agent-runner.ts` 顶部读帧并下传**

文件顶部新增 import:

```ts
import { currentFrames } from "./orchestration-context.js";
import type { AgentGroup } from "./types.js";
```

把 `run` 改为在**同步入口**捕获帧并下传(关键:不可在 `execute` 里读,semaphore 排队后上下文可能已变):

```ts
  run = async (prompt: string, opts?: AgentOpts): Promise<unknown> => {
    const group = topGroup(currentFrames());
    if (++this.deps.counter.n > LIMITS.MAX_AGENTS) {
      throw new AgentLimitError(LIMITS.MAX_AGENTS);
    }

    const { journal, budget, reporter } = this.deps;
    const label = opts?.label ?? this.deps.meta.name;
    const key = cacheKey(prompt, opts);

    if (journal.has(key)) {
      const cached = journal.get(key);
      if (!(opts?.schema && (cached === null || typeof cached !== "object"))) {
        return cached;
      }
    }

    if (this.deps.prefixReplay) {
      const r = this.deps.prefixReplay.lookup(key);
      if (r.hit && !(opts?.schema && (r.value === null || typeof r.value !== "object"))) {
        journal.record("agent", key, r.value);
        return r.value;
      }
    }

    if (budget.exhausted) {
      if (this.deps.budgetMode === "degrade") {
        reporter.agentNull(label, "budget exhausted", "budget");
        journal.record("agent", key, null);
        return null;
      }
      throw new BudgetExceededError(budget.total ?? 0, budget.spent());
    }

    return this.deps.semaphore.run(() => this.execute(prompt, opts, label, key, group));
  };
```

在类内新增一个私有纯 helper(放在 `run` 与 `execute` 之间):

```ts
  // top frame → the agent's immediate group (or undefined when not in one)
```

并在文件内(类外底部或类内 private)实现 `topGroup`。这里用模块级函数最简洁,放文件底部:

```ts
function topGroup(frames: ReturnType<typeof currentFrames>): AgentGroup | undefined {
  const top = frames.at(-1);
  if (!top) return undefined;
  return {
    id: top.groupId,
    kind: top.kind,
    parentId: top.parentId,
    index: top.index,
    stageIndex: top.stageIndex,
  };
}
```

把 `execute` 的签名与 `agentStart` 调用改为带 `group`:

```ts
  private async execute(
    prompt: string,
    opts: AgentOpts | undefined,
    label: string,
    key: string,
    group: AgentGroup | undefined,
  ): Promise<unknown> {
    const { adapter, reporter, mapper, journal } = this.deps;

    const resolved = await mapper.resolve(opts);
    const sessionId = await adapter.createSubSession(this.deps.parentSessionId, label);
    this.deps.onSession(sessionId);
    reporter.agentStart(label, opts?.phase, sessionId, group);
    // ...(其余函数体不变)
```

- [ ] **Step 8: 运行新测试,确认通过**

Run: `bun test packages/core/src/orchestration-metadata.test.ts`
Expected: PASS(5 tests)。

- [ ] **Step 9: 回归 —— typecheck + 全核心套件**

Run: `bun run build`
Expected: `tsc -b` 干净通过(dashboard 构建步骤尚未加入,本步只验证 tsc;若 build 已串 vite 而 web 未就绪会失败,此时改跑 `bun run typecheck`)。
Run: `bun test packages/core/src`
Expected: 全绿(含既有 `engine.test.ts`、`dfx.test.ts` 等;parallel/pipeline 行为未变)。

- [ ] **Step 10: 同步 spec**

在 `packages/spec/WORKFLOW_SCRIPT_SPEC.md` 进度事件相关章节追加一段:

```markdown
### `agent-start.group`（host 内部遥测，非脚本可见）

`agent-start` 事件可携带可选的 `group`，描述该 `agent()` 在 `parallel`/`pipeline`
编排中的位置：`{ id, kind: "parallel"|"pipeline", parentId?, index, stageIndex? }`。
此字段由运行时通过 `AsyncLocalStorage` 编排上下文填充，**不影响脚本契约、journal key
或 resume**；Claude Code 的原生运行时不发送该字段。仅 opencode dashboard 消费它。
```

在 `packages/spec/SPEC_TEST_MATRIX.md` 登记一行,映射到 `orchestration-metadata.test.ts`(沿用该文件现有表格列格式)。

- [ ] **Step 11: 提交**

```bash
git add packages/core/src/types.ts packages/core/src/progress-reporter.ts \
        packages/core/src/runtime-context.ts packages/core/src/engine.ts \
        packages/core/src/agent-runner.ts packages/core/src/orchestration-metadata.test.ts \
        packages/spec/WORKFLOW_SCRIPT_SPEC.md packages/spec/SPEC_TEST_MATRIX.md
git commit -m "feat(core): emit agent-start.group telemetry for parallel/pipeline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `RunView` 捕获 group,供 dashboard 消费

**Files:**
- Modify: `packages/host-opencode/src/dashboard/run-registry.ts`(`AgentView.group` + agent-start 分支存储)
- Test: `packages/host-opencode/src/dashboard/dashboard.test.ts`(扩展既有 RunRegistry 测试)

**Interfaces:**
- Consumes: `AgentGroup`(`@workflow/core`)、`agent-start.group` 事件字段(Task 2)。
- Produces: `AgentView.group?: AgentGroup`(`RunView.agents[i].group`)。

- [ ] **Step 1: 扩展失败测试**

在 `dashboard.test.ts` 的 `describe("RunRegistry")` 内,新增一个测试:

```ts
  test("captures agent group metadata from agent-start", () => {
    const r = new RunRegistry(() => 0);
    r.startRun("run-1", "demo", "main-1");
    r.applyProgress(
      "run-1",
      ev({
        type: "agent-start",
        label: "p0",
        sessionId: "s1",
        group: { id: "g1", kind: "parallel", index: 0 },
      }),
    );
    expect(r.get("run-1")!.agents[0]!.group).toEqual({ id: "g1", kind: "parallel", index: 0 });
  });
```

- [ ] **Step 2: 运行,确认失败**

Run: `bun test packages/host-opencode/src/dashboard/dashboard.test.ts -t "group metadata"`
Expected: FAIL —— `agents[0].group` 为 `undefined`。

- [ ] **Step 3: 实现**

在 `run-registry.ts` 顶部 import 加入 `AgentGroup`:

```ts
import type { AgentGroup, NullReason, ProgressEvent, RunSummary } from "@workflow/core";
```

在 `AgentView` 接口里新增:

```ts
  group?: AgentGroup;
```

在 `applyProgress` 的 `case "agent-start":` 里,把构造的 `AgentView` 补上 `group`:

```ts
      case "agent-start": {
        const a: AgentView = {
          sessionId: ev.sessionId,
          label: ev.label,
          phase: ev.phase ?? run.currentPhase,
          status: "running",
          retries: 0,
          group: ev.group,
        };
        run.agents.push(a);
        if (ev.sessionId) this.sessionToRun.set(ev.sessionId, runId);
        break;
      }
```

- [ ] **Step 4: 运行,确认通过**

Run: `bun test packages/host-opencode/src/dashboard/dashboard.test.ts`
Expected: 全绿(含新测试)。

- [ ] **Step 5: 提交**

```bash
git add packages/host-opencode/src/dashboard/run-registry.ts \
        packages/host-opencode/src/dashboard/dashboard.test.ts
git commit -m "feat(dashboard): store agent group metadata in RunView

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 纯函数 `buildGraph`(运行快照 → 节点/边)

放在 host 的 `src/dashboard/` 下,由现有离线 `bun test` 覆盖;web 端后续 import 它。

**Files:**
- Create: `packages/host-opencode/src/dashboard/buildGraph.ts`
- Test: `packages/host-opencode/src/dashboard/buildGraph.test.ts`

**Interfaces:**
- Consumes: 一个结构化的运行快照(前端从 `/api/runs/:id` 与 SSE 拿到的 JSON 的子集)。为解耦,**自带输入类型**,不直接依赖 `RunView`:
  - `interface GraphAgent { sessionId?: string; label: string; phase?: string; status: "running" | "done" | "null" | "retrying"; tokens?: number; retries: number; nullReason?: string; group?: { id: string; kind: "parallel" | "pipeline"; parentId?: string; index: number; stageIndex?: number } }`
  - `interface GraphRun { phases: string[]; agents: GraphAgent[] }`
- Produces:
  - `interface GraphNode { id: string; type: "agent" | "group" | "phase"; label: string; parentId?: string; status?: GraphAgent["status"]; sessionId?: string; data: Record<string, unknown> }`
  - `interface GraphEdge { id: string; source: string; target: string }`
  - `function buildGraph(run: GraphRun): { nodes: GraphNode[]; edges: GraphEdge[] }`

**派生规则(写进实现与测试):**
- 每个 `phase`(按 `run.phases` 顺序)→ 一个 `type:"phase"` 节点,id 为 `phase:<title>`。
- 每个不同的 `group.id`(以及被引用的 `parentId`)→ 一个 `type:"group"` 节点,id 为 `group:<gid>`;`parentId` 指向其 `group:<parentId>`,否则指向其 phase 节点。
- 每个 agent → 一个 `type:"agent"` 节点,id 为 `agent:<sessionId 或 phase+label+seq>`;`parentId` 指向其 group(若有)否则其 phase。
- 边:
  - pipeline:同 `group.id` 同 `group.index`(itemIndex),`stageIndex k → k+1` 的 agent 之间连边。
  - 相邻 phase 节点之间连边(`phase:<a> → phase:<b>`),体现主轴顺序。
- 纯函数、确定性(同输入同输出),无 `Date.now`/`Math.random`。

- [ ] **Step 1: 写失败测试**

`packages/host-opencode/src/dashboard/buildGraph.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildGraph, type GraphRun } from "./buildGraph.js";

const agent = (over: Partial<GraphRun["agents"][number]>): GraphRun["agents"][number] => ({
  label: "a",
  status: "done",
  retries: 0,
  ...over,
});

describe("buildGraph", () => {
  test("phases become ordered phase nodes connected in sequence", () => {
    const run: GraphRun = { phases: ["Find", "Verify"], agents: [] };
    const { nodes, edges } = buildGraph(run);
    const phaseIds = nodes.filter((n) => n.type === "phase").map((n) => n.id);
    expect(phaseIds).toEqual(["phase:Find", "phase:Verify"]);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "phase:Find", target: "phase:Verify" }),
    );
  });

  test("a parallel group yields one group node parenting its agents", () => {
    const run: GraphRun = {
      phases: ["Find"],
      agents: [
        agent({ label: "p0", phase: "Find", sessionId: "s0", group: { id: "g1", kind: "parallel", index: 0 } }),
        agent({ label: "p1", phase: "Find", sessionId: "s1", group: { id: "g1", kind: "parallel", index: 1 } }),
      ],
    };
    const { nodes } = buildGraph(run);
    const group = nodes.find((n) => n.type === "group" && n.id === "group:g1");
    expect(group).toBeDefined();
    expect(group!.parentId).toBe("phase:Find");
    const agents = nodes.filter((n) => n.type === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.parentId === "group:g1")).toBe(true);
  });

  test("pipeline stage chain connects stageIndex k -> k+1 for the same item", () => {
    const run: GraphRun = {
      phases: ["Run"],
      agents: [
        agent({ label: "s0", phase: "Run", sessionId: "a", group: { id: "p", kind: "pipeline", index: 0, stageIndex: 0 } }),
        agent({ label: "s1", phase: "Run", sessionId: "b", group: { id: "p", kind: "pipeline", index: 0, stageIndex: 1 } }),
      ],
    };
    const { nodes, edges } = buildGraph(run);
    const s0 = nodes.find((n) => n.type === "agent" && n.label === "s0")!;
    const s1 = nodes.find((n) => n.type === "agent" && n.label === "s1")!;
    expect(edges).toContainEqual(expect.objectContaining({ source: s0.id, target: s1.id }));
  });

  test("nested group links to its parent group", () => {
    const run: GraphRun = {
      phases: ["Run"],
      agents: [
        agent({ label: "child", sessionId: "c", group: { id: "g2", kind: "parallel", parentId: "g1", index: 0 } }),
      ],
    };
    const { nodes } = buildGraph(run);
    expect(nodes.find((n) => n.id === "group:g2")!.parentId).toBe("group:g1");
  });

  test("top-level agent (no group) parents directly to its phase", () => {
    const run: GraphRun = {
      phases: ["Run"],
      agents: [agent({ label: "solo", phase: "Run", sessionId: "x" })],
    };
    const { nodes } = buildGraph(run);
    expect(nodes.find((n) => n.type === "agent")!.parentId).toBe("phase:Run");
  });

  test("is deterministic for the same input", () => {
    const run: GraphRun = {
      phases: ["A"],
      agents: [agent({ label: "x", phase: "A", sessionId: "s" })],
    };
    expect(buildGraph(run)).toEqual(buildGraph(run));
  });
});
```

- [ ] **Step 2: 运行,确认失败**

Run: `bun test packages/host-opencode/src/dashboard/buildGraph.test.ts`
Expected: FAIL —「Cannot find module './buildGraph.js'」。

- [ ] **Step 3: 实现 `buildGraph.ts`**

```ts
/**
 * Pure projection of a run snapshot into a node/edge graph for the dashboard.
 * Decoupled from React Flow and from RunView: it takes only the structural
 * subset it needs, so it stays in the offline test suite. Deterministic.
 */

export interface GraphAgent {
  sessionId?: string;
  label: string;
  phase?: string;
  status: "running" | "done" | "null" | "retrying";
  tokens?: number;
  retries: number;
  nullReason?: string;
  group?: { id: string; kind: "parallel" | "pipeline"; parentId?: string; index: number; stageIndex?: number };
}

export interface GraphRun {
  phases: string[];
  agents: GraphAgent[];
}

export interface GraphNode {
  id: string;
  type: "agent" | "group" | "phase";
  label: string;
  parentId?: string;
  status?: GraphAgent["status"];
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

const phaseId = (title: string): string => `phase:${title}`;
const groupId = (gid: string): string => `group:${gid}`;

export function buildGraph(run: GraphRun): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 1) Phase nodes, in order, chained along the spine.
  const phases = run.phases.length > 0 ? run.phases : agentPhases(run.agents);
  phases.forEach((title, i) => {
    nodes.push({ id: phaseId(title), type: "phase", label: title, data: { order: i } });
    const prev = phases[i - 1];
    if (prev !== undefined) {
      edges.push({ id: `e:${phaseId(prev)}->${phaseId(title)}`, source: phaseId(prev), target: phaseId(title) });
    }
  });
  const phaseSet = new Set(phases);
  const fallbackPhase = phases[0];

  const parentOfAgent = (a: GraphAgent): string | undefined => {
    if (a.group) return groupId(a.group.id);
    if (a.phase && phaseSet.has(a.phase)) return phaseId(a.phase);
    return fallbackPhase !== undefined ? phaseId(fallbackPhase) : undefined;
  };

  // 2) Group nodes — one per distinct group id, including referenced parents.
  const groupMeta = new Map<string, { kind?: "parallel" | "pipeline"; parentId?: string; phase?: string }>();
  for (const a of run.agents) {
    const g = a.group;
    if (!g) continue;
    if (!groupMeta.has(g.id)) groupMeta.set(g.id, {});
    const m = groupMeta.get(g.id)!;
    m.kind ??= g.kind;
    m.parentId ??= g.parentId;
    m.phase ??= a.phase;
    if (g.parentId && !groupMeta.has(g.parentId)) groupMeta.set(g.parentId, {});
  }
  for (const [gid, m] of groupMeta) {
    const parent =
      m.parentId !== undefined
        ? groupId(m.parentId)
        : m.phase && phaseSet.has(m.phase)
          ? phaseId(m.phase)
          : fallbackPhase !== undefined
            ? phaseId(fallbackPhase)
            : undefined;
    nodes.push({
      id: groupId(gid),
      type: "group",
      label: m.kind ?? "group",
      parentId: parent,
      data: { kind: m.kind },
    });
  }

  // 3) Agent nodes.
  const agentNodeId = (a: GraphAgent, seq: number): string =>
    a.sessionId ? `agent:${a.sessionId}` : `agent:${a.phase ?? ""}:${a.label}:${seq}`;
  const ids: string[] = [];
  run.agents.forEach((a, seq) => {
    const id = agentNodeId(a, seq);
    ids.push(id);
    nodes.push({
      id,
      type: "agent",
      label: a.label,
      parentId: parentOfAgent(a),
      status: a.status,
      sessionId: a.sessionId,
      data: { tokens: a.tokens, retries: a.retries, nullReason: a.nullReason, group: a.group },
    });
  });

  // 4) Pipeline stage edges: same group id + same item index, stageIndex k -> k+1.
  const byItem = new Map<string, GraphAgent[]>();
  run.agents.forEach((a, seq) => {
    const g = a.group;
    if (!g || g.kind !== "pipeline" || g.stageIndex === undefined) return;
    const key = `${g.id}#${g.index}`;
    (byItem.get(key) ?? byItem.set(key, []).get(key)!).push(a);
    // keep id alongside for edge wiring
    (a as GraphAgent & { _nodeId?: string })._nodeId = ids[seq];
  });
  for (const group of byItem.values()) {
    const sorted = [...group].sort((x, y) => (x.group!.stageIndex! - y.group!.stageIndex!));
    for (let i = 1; i < sorted.length; i++) {
      const from = (sorted[i - 1] as GraphAgent & { _nodeId?: string })._nodeId!;
      const to = (sorted[i] as GraphAgent & { _nodeId?: string })._nodeId!;
      edges.push({ id: `e:${from}->${to}`, source: from, target: to });
    }
  }

  return { nodes, edges };
}

/** Fallback phase list when the run never called phase() but has agents. */
function agentPhases(agents: GraphAgent[]): string[] {
  const seen: string[] = [];
  for (const a of agents) {
    const p = a.phase ?? "—";
    if (!seen.includes(p)) seen.push(p);
  }
  return seen.length ? seen : ["—"];
}
```

> 注:`_nodeId` 临时挂载仅用于边连线;若偏好不可变,可改用 `Map<GraphAgent, string>`。测试只断言行为,实现可任选其一。

- [ ] **Step 4: 运行,确认通过**

Run: `bun test packages/host-opencode/src/dashboard/buildGraph.test.ts`
Expected: PASS(6 tests)。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 干净通过(`tsc -b`)。

- [ ] **Step 6: 提交**

```bash
git add packages/host-opencode/src/dashboard/buildGraph.ts \
        packages/host-opencode/src/dashboard/buildGraph.test.ts
git commit -m "feat(dashboard): pure buildGraph projection (run snapshot -> nodes/edges)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Server 改为静态文件服务 + 未构建降级

**Files:**
- Modify: `packages/host-opencode/src/dashboard/server.ts`(`/` 与未命中路径走静态文件;缺产物时降级)
- Modify: `packages/host-opencode/src/dashboard/ui.ts`(大 HTML → 改为 `FALLBACK_HTML` 占位页)
- Modify: `packages/host-opencode/src/dashboard/server.test.ts`(更新页面断言)
- Modify: `packages/host-opencode/src/dashboard/dashboard.test.ts`(更新「serves the UI」断言)

**Interfaces:**
- Consumes: 构建产物目录 `dashboard-dist/`(Task 6 产出;本任务先实现"缺失即降级")。
- Produces: server 在产物存在时服务 `index.html` + 资源;否则返回 `FALLBACK_HTML`(含字符串 `Workflow Dashboard`,使既有断言仍可用,并提示运行构建)。

- [ ] **Step 1: 改 `ui.ts` 为占位页**

把 `ui.ts` 内容整体替换为:

```ts
/** Fallback page shown when the built dashboard assets are absent. */
export const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Workflow Dashboard</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#f6f8fa; color:#1f2328; }
  .card { max-width:520px; padding:28px 32px; background:#fff; border:1px solid #d0d7de;
    border-radius:12px; box-shadow:0 1px 3px rgba(27,31,36,.08); }
  code { background:#eef1f4; padding:2px 6px; border-radius:6px; font-family:ui-monospace,monospace; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { margin:8px 0; color:#57606a; }
</style></head>
<body><div class="card">
  <h1>Workflow Dashboard</h1>
  <p>The dashboard UI has not been built yet.</p>
  <p>Run <code>bun run build:dashboard</code> (or <code>bun run build</code>) and reload.</p>
</div></body></html>`;
```

- [ ] **Step 2: 改 `server.ts` 静态服务 + 降级**

文件顶部 import 调整:

```ts
import { readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RunRegistry } from "./run-registry.js";
import { FALLBACK_HTML } from "./ui.js";
```

在文件内(类外)新增常量与辅助:

```ts
// dist layout: <pkg>/dist/dashboard/server.js → <pkg>/dashboard-dist
const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard-dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}
```

在 `DashboardServer` 类里新增一个静态文件服务方法:

```ts
  /** Serve a built asset; fall back to index.html (SPA); fall back to the
   *  placeholder page when nothing is built. */
  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "/index.html" : pathname;
    // Prevent path traversal: resolved file must stay under ASSET_ROOT.
    const filePath = normalize(join(ASSET_ROOT, rel));
    if (!filePath.startsWith(ASSET_ROOT)) return this.serveFallback(res);
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(body);
      return;
    } catch {
      // SPA fallback: serve index.html for unknown non-asset routes.
      if (!rel.includes(".")) {
        try {
          const index = await readFile(join(ASSET_ROOT, "index.html"));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(index);
          return;
        } catch {
          /* fall through to placeholder */
        }
      }
      return this.serveFallback(res);
    }
  }

  private serveFallback(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FALLBACK_HTML);
  }
```

把 `handle` 改成 async,并把根路由 + 末尾兜底改为静态服务。具体改动:

1. 方法签名:`private handle(req, res): void` → `private async handle(req: IncomingMessage, res: ServerResponse): Promise<void>`,且 `createServer` 回调改为 `(req, res) => void this.handle(req, res)`。
2. 删除原来的:

```ts
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(DASHBOARD_HTML);
      return;
    }
```

3. 把 `handle` 末尾的 `notFound(res);` 改为:

```ts
    // Non-API: serve the built dashboard (or the placeholder).
    if (!path.startsWith("/api/")) return this.serveStatic(path, res);
    notFound(res);
```

(所有 `/api/*` 与 SSE 分支保持不变;`stat` 可不用则不 import —— 仅保留实际使用的导入,避免 `noUnusedLocals`。)

> 注:`import.meta.url` 在 ESM 下可用。`stat` 若未用请从 import 删除。

- [ ] **Step 3: 更新测试断言**

`server.test.ts` 中:

```ts
    expect(await page.text()).toContain("Workflow Dashboard");
```

保持不变(占位页含该字符串)。无需其他改动。

`dashboard.test.ts` 中 `DashboardServer` 块:

```ts
      const html = await (await fetch(`${url}/`)).text();
      expect(html).toContain("Workflow Dashboard");
```

保持不变。

- [ ] **Step 4: 运行,确认通过**

Run: `bun test packages/host-opencode/src/dashboard`
Expected: 全绿(占位页路径)。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: 干净通过。

- [ ] **Step 6: 提交**

```bash
git add packages/host-opencode/src/dashboard/server.ts \
        packages/host-opencode/src/dashboard/ui.ts \
        packages/host-opencode/src/dashboard/server.test.ts \
        packages/host-opencode/src/dashboard/dashboard.test.ts
git commit -m "feat(dashboard): serve built static assets with a build-me fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Web 工程脚手架 + 构建接线

让 `bun run build:dashboard` 产出 `dashboard-dist/`,并被 server 服务;`bun run build` 一条命令出全部。

**Files:**
- Create: `packages/host-opencode/web/index.html`
- Create: `packages/host-opencode/web/vite.config.ts`
- Create: `packages/host-opencode/web/tsconfig.json`
- Create: `packages/host-opencode/web/src/main.tsx`(最小可渲染骨架)
- Modify: `packages/host-opencode/package.json`(devDeps + scripts + files)
- Modify: 根 `package.json`(`build` 串联 dashboard 构建)
- Modify: `.gitignore`(忽略 `dashboard-dist/`,若仓库有 .gitignore)

**Interfaces:**
- Produces: `dashboard-dist/index.html` + `assets/*`;`bun run build:dashboard` 脚本;web 端可 import `../src/dashboard/buildGraph.js`(经 Vite bundler 解析,源码用 `.js` 后缀指向 `.ts`)。

- [ ] **Step 1: 安装依赖**

```bash
cd packages/host-opencode
bun add -d vite @vitejs/plugin-react react react-dom @xyflow/react dagre @types/react @types/react-dom @types/dagre
cd ../..
```

Expected: `package.json` 的 devDependencies 出现上述包;根 `bun.lock` 更新。

- [ ] **Step 2: 写 `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true
  },
  "include": ["src", "vite.config.ts"]
}
```

> 该 tsconfig **不**被根 `tsc -b` 引用,Vite 自行使用,避免污染 core 的 NodeNext 构建。

- [ ] **Step 3: 写 `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dashboard-dist",
    emptyOutDir: true,
  },
});
```

- [ ] **Step 4: 写 `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workflow Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 写最小 `web/src/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";

function App(): React.ReactElement {
  return <div data-testid="app-root">Workflow Dashboard</div>;
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
```

- [ ] **Step 6: 接线 host `package.json` scripts 与 files**

把 host `package.json` 的 `scripts` 改为:

```json
  "scripts": {
    "build": "tsc -p tsconfig.json && bun run build:dashboard",
    "build:dashboard": "vite build --config web/vite.config.ts",
    "test": "bun test"
  },
```

把 `files` 改为:

```json
  "files": ["dist", "src", "dashboard-dist"],
```

- [ ] **Step 7: 接线根 `package.json`**

把根 `build` 改为(先全量 typecheck,再产出 dashboard):

```json
    "build": "tsc -b && bun run --filter='@workflow/host-opencode' build:dashboard",
```

> 若 `bun run --filter` 语法在本机 bun 版本下不可用,退路为:
> `"build": "tsc -b && bun --cwd packages/host-opencode run build:dashboard"`。
> Step 9 会实测。

- [ ] **Step 8: 忽略产物**

若存在根 `.gitignore`,追加一行:

```
dashboard-dist/
```

(产物随发布走 `files` 字段;源码仓库不跟踪构建产物。)

- [ ] **Step 9: 构建并验证产物 + 服务**

```bash
bun install
bun run build
test -f packages/host-opencode/dashboard-dist/index.html && echo "DIST OK"
```

Expected: `tsc -b` 干净;`vite build` 成功;打印 `DIST OK`。

启动一次 server 冒烟(确认服务的是构建产物而非占位页):

```bash
bun -e '
import { DashboardServer } from "./packages/host-opencode/src/dashboard/server.ts";
const s = new DashboardServer();
const url = await s.ensureStarted(0);
const html = await (await fetch(url + "/")).text();
console.log(html.includes("/assets/") || html.includes("main") ? "SERVED BUILT INDEX" : "SERVED FALLBACK");
await s.close();
'
```

Expected: 打印 `SERVED BUILT INDEX`(产物存在时不再是占位页)。

- [ ] **Step 10: 全套回归**

Run: `bun test packages/core/src packages/host-opencode/src`
Expected: 全绿。

- [ ] **Step 11: 提交**

```bash
git add packages/host-opencode/web packages/host-opencode/package.json package.json .gitignore bun.lock
git commit -m "build(dashboard): scaffold Vite + React web app and wire the build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 浅色主题 + 应用外壳 + 数据层 `api.ts`

**Files:**
- Create: `packages/host-opencode/web/src/theme.css`(浅色设计令牌)
- Create: `packages/host-opencode/web/src/api.ts`(SSE/fetch 封装 + 运行快照类型)
- Create: `packages/host-opencode/web/src/AppShell.tsx`(布局外壳:左 RunsRail 占位 + 主区 + 右抽屉占位)
- Modify: `packages/host-opencode/web/src/main.tsx`(渲染 `AppShell`,引入 theme.css)

**Interfaces:**
- Produces:
  - `api.ts`:`interface RunListItem { runId: string; name: string; status: string; agents: number; currentPhase?: string }`;`interface RunSnapshot extends GraphRun { runId: string; name: string; status: string; mainSessionId?: string; summary?: unknown; pendingQuestion?: { question: string; options?: string[] } }`(`GraphRun` 来自 `../src/dashboard/buildGraph.js`)。
  - `fetchRuns(): Promise<RunListItem[]>`、`streamRun(id, cb): () => void`、`streamSession(id, cb): () => void`、`cancelRun(id)`、`answerRun(id, value)`。
  - `AppShell`:接收选中 run 状态,放置三块区域。

- [ ] **Step 1: 写 `theme.css`**

```css
:root {
  --bg: #f6f8fa;
  --surface: #ffffff;
  --border: #d0d7de;
  --text: #1f2328;
  --muted: #57606a;
  --accent: #2563eb;
  --running: #2563eb;
  --done: #1a7f37;
  --null: #cf222e;
  --retrying: #bf8700;
  --pending: #6e7781;
  --shadow: 0 1px 3px rgba(27, 31, 36, 0.08), 0 1px 2px rgba(27, 31, 36, 0.06);
  --radius: 10px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Inter, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.shell { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
.rail { border-right: 1px solid var(--border); background: var(--surface); overflow-y: auto; }
.main { position: relative; overflow: hidden; }
.badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
.badge.running { background: #ddeafe; color: var(--running); }
.badge.completed, .badge.done { background: #d3f3dd; color: var(--done); }
.badge.failed, .badge.null { background: #ffd8d3; color: var(--null); }
.badge.retrying { background: #fbf0d0; color: var(--retrying); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
.badge.running { animation: pulse 1.6s ease-in-out infinite; }
```

- [ ] **Step 2: 写 `api.ts`**

```ts
import type { GraphRun } from "../../src/dashboard/buildGraph.js";

export interface RunListItem {
  runId: string;
  name: string;
  status: string;
  agents: number;
  currentPhase?: string;
}

export interface RunSnapshot extends GraphRun {
  runId: string;
  name: string;
  status: string;
  mainSessionId?: string;
  summary?: Record<string, unknown>;
  pendingQuestion?: { question: string; options?: string[] };
}

export interface ConvoMessage {
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
}

export async function fetchRuns(): Promise<RunListItem[]> {
  const res = await fetch("/api/runs");
  return res.ok ? ((await res.json()) as RunListItem[]) : [];
}

/** Subscribe to a run snapshot stream. Returns an unsubscribe fn. */
export function streamRun(id: string, cb: (run: RunSnapshot | null) => void): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
  es.onmessage = (e) => cb(JSON.parse(e.data) as RunSnapshot | null);
  return () => es.close();
}

export function streamSession(id: string, cb: (msgs: ConvoMessage[]) => void): () => void {
  const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`);
  es.onmessage = (e) => cb((JSON.parse(e.data) as ConvoMessage[]) ?? []);
  return () => es.close();
}

export function cancelRun(id: string): void {
  void fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => {});
}

export function answerRun(id: string, value: string): void {
  void fetch(`/api/runs/${encodeURIComponent(id)}/answer?value=${encodeURIComponent(value)}`, {
    method: "POST",
  }).catch(() => {});
}
```

> 注:server 的 `/api/runs/:id` 返回完整 `RunView`(含 `phases`、`agents`),其结构是 `GraphRun` 的超集 + `RunSnapshot` 的其余字段,可直接喂 `buildGraph`。

- [ ] **Step 3: 写 `AppShell.tsx`(此步先用占位主区,Task 8/9 填充)**

```tsx
import React, { useEffect, useState } from "react";
import { fetchRuns, type RunListItem } from "./api.js";

export function AppShell(): React.ReactElement {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => void fetchRuns().then(setRuns);
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="shell">
      <aside className="rail">
        <h2 style={{ font: "600 11px system-ui", textTransform: "uppercase", color: "var(--muted)", padding: "12px" }}>
          Runs
        </h2>
        {runs.map((r) => (
          <button
            key={r.runId}
            onClick={() => setSelected(r.runId)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none",
              background: r.runId === selected ? "#eef2ff" : "transparent",
              padding: "8px 12px", cursor: "pointer", font: "13px system-ui",
            }}
          >
            {r.name} <span className={`badge ${r.status}`}>{r.status}</span>
            <div style={{ color: "var(--muted)", fontSize: 11 }}>{r.agents} agents</div>
          </button>
        ))}
        {runs.length === 0 && <div style={{ color: "var(--muted)", padding: 12 }}>No runs yet.</div>}
      </aside>
      <main className="main">
        {selected ? (
          <div data-testid="graph-slot" data-run={selected} style={{ padding: 16 }}>
            Graph for {selected} (filled in Task 8).
          </div>
        ) : (
          <div style={{ padding: 24, color: "var(--muted)" }}>Select a run.</div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 更新 `main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./AppShell.js";
import "./theme.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<AppShell />);
```

- [ ] **Step 5: 构建验证**

Run: `bun run build:dashboard`(在 `packages/host-opencode/` 下)
Expected: 构建成功;`dashboard-dist/index.html` 引用打包后的 assets。

- [ ] **Step 6: typecheck(web)**

Run: `cd packages/host-opencode && bunx tsc -p web/tsconfig.json --noEmit && cd ../..`
Expected: 无类型错误。

- [ ] **Step 7: 提交**

```bash
git add packages/host-opencode/web/src/theme.css packages/host-opencode/web/src/api.ts \
        packages/host-opencode/web/src/AppShell.tsx packages/host-opencode/web/src/main.tsx
git commit -m "feat(dashboard): light theme, app shell, and SSE/fetch data layer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 节点图画布(React Flow + dagre)+ 顶栏

**Files:**
- Create: `packages/host-opencode/web/src/layout.ts`(`GraphNode`/`GraphEdge` → React Flow nodes/edges,dagre 布局)
- Create: `packages/host-opencode/web/src/nodes/AgentNode.tsx`(按状态着色的自定义节点)
- Create: `packages/host-opencode/web/src/GraphCanvas.tsx`(React Flow 容器 + run 快照流)
- Create: `packages/host-opencode/web/src/TopBar.tsx`(run 名 + 状态 + cancel + pendingQuestion)
- Modify: `packages/host-opencode/web/src/AppShell.tsx`(主区接入 `TopBar` + `GraphCanvas`,管理选中节点)

**Interfaces:**
- Consumes: `buildGraph`、`RunSnapshot`、`streamRun`、`cancelRun`、`answerRun`(前序任务)。
- Produces:
  - `layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): { rfNodes: RFNode[]; rfEdges: RFEdge[] }`(用 dagre 计算坐标)。
  - `GraphCanvas` props:`{ runId: string; onSelectNode: (sessionId: string | null) => void }`。
  - `TopBar` props:`{ run: RunSnapshot }`。

- [ ] **Step 1: 写 `layout.ts`**

```ts
import dagre from "dagre";
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "../../src/dashboard/buildGraph.js";

const NODE_W = 180;
const NODE_H = 52;

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { rfNodes: RFNode[]; rfEdges: RFEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const rfNodes: RFNode[] = nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: n.type === "agent" ? "agentNode" : "default",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { label: n.label, status: n.status, sessionId: n.sessionId, ...n.data },
      ...(n.type !== "agent" ? { style: groupStyle(n.type) } : {}),
    };
  });
  const rfEdges: RFEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
  }));
  return { rfNodes, rfEdges };
}

function groupStyle(type: GraphNode["type"]): React.CSSProperties {
  return type === "phase"
    ? { background: "#eef2ff", border: "1px dashed #c7d2fe", borderRadius: 10, fontWeight: 600 }
    : { background: "#f6f8fa", border: "1px solid #d0d7de", borderRadius: 10 };
}
```

> 注:`React` 命名空间用于 `CSSProperties`,文件顶部加 `import type React from "react";`。本步用扁平 dagre 布局(group/phase 也作为普通节点参与排布,不用 React Flow 父子嵌套),先把"真实依赖边 + 状态"立起来;嵌套容器视觉可作为后续增强。

- [ ] **Step 2: 写 `nodes/AgentNode.tsx`**

```tsx
import React from "react";
import { Handle, Position } from "@xyflow/react";

type Status = "running" | "done" | "null" | "retrying";

export function AgentNode({
  data,
}: {
  data: { label: string; status?: Status; tokens?: number; retries?: number };
}): React.ReactElement {
  return (
    <div
      style={{
        width: 180, padding: "8px 12px", background: "var(--surface)",
        border: "1px solid var(--border)", borderLeft: `4px solid ${color(data.status)}`,
        borderRadius: 10, boxShadow: "var(--shadow)", font: "13px system-ui",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {data.label}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        <span className={`badge ${data.status ?? ""}`}>{data.status}</span>
        {data.tokens != null ? ` · ${data.tokens} tok` : ""}
        {data.retries ? ` · ${data.retries} retries` : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function color(status?: Status): string {
  return status === "done"
    ? "var(--done)"
    : status === "null"
      ? "var(--null)"
      : status === "retrying"
        ? "var(--retrying)"
        : "var(--running)";
}
```

- [ ] **Step 3: 写 `GraphCanvas.tsx`**

```tsx
import React, { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Node as RFNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildGraph } from "../../src/dashboard/buildGraph.js";
import { layoutGraph } from "./layout.js";
import { AgentNode } from "./nodes/AgentNode.js";
import { streamRun, type RunSnapshot } from "./api.js";
import { TopBar } from "./TopBar.js";

const nodeTypes = { agentNode: AgentNode };

export function GraphCanvas({
  runId,
  onSelectNode,
}: {
  runId: string;
  onSelectNode: (sessionId: string | null) => void;
}): React.ReactElement {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  useEffect(() => streamRun(runId, setRun), [runId]);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!run) return { rfNodes: [], rfEdges: [] };
    const { nodes, edges } = buildGraph(run);
    return layoutGraph(nodes, edges);
  }, [run]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {run && <TopBar run={run} />}
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          onNodeClick={(_e, node: RFNode) => onSelectNode((node.data as { sessionId?: string }).sessionId ?? null)}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 写 `TopBar.tsx`**

```tsx
import React, { useState } from "react";
import { answerRun, cancelRun, type RunSnapshot } from "./api.js";

export function TopBar({ run }: { run: RunSnapshot }): React.ReactElement {
  const [answer, setAnswer] = useState("");
  return (
    <header
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
        borderBottom: "1px solid var(--border)", background: "var(--surface)",
      }}
    >
      <strong>{run.name}</strong>
      <span className={`badge ${run.status}`}>{run.status}</span>
      <div style={{ flex: 1 }} />
      {run.status === "running" && (
        <button onClick={() => cancelRun(run.runId)} style={btn()}>Cancel</button>
      )}
      {run.pendingQuestion && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>❓ {run.pendingQuestion.question}</span>
          {(run.pendingQuestion.options ?? []).map((o) => (
            <button key={o} onClick={() => answerRun(run.runId, o)} style={btn()}>{o}</button>
          ))}
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="answer…" />
          <button onClick={() => answerRun(run.runId, answer)} style={btn()}>Send</button>
        </div>
      )}
    </header>
  );
}

function btn(): React.CSSProperties {
  return {
    border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 8,
    padding: "4px 10px", cursor: "pointer", font: "12px system-ui",
  };
}
```

- [ ] **Step 5: 接入 `AppShell.tsx` 主区**

把 `AppShell` 的 `<main>` 内容替换为(并新增 `selectedNode` 状态,供 Task 9 的抽屉使用):

```tsx
import { GraphCanvas } from "./GraphCanvas.js";
// ... 在组件内:
const [selectedNode, setSelectedNode] = useState<string | null>(null);
// ... <main className="main">:
{selected ? (
  <GraphCanvas runId={selected} onSelectNode={setSelectedNode} />
) : (
  <div style={{ padding: 24, color: "var(--muted)" }}>Select a run.</div>
)}
```

(`selectedNode` 暂未渲染抽屉,Task 9 接入;为避免 `noUnusedLocals`,本步可临时 `void selectedNode;` 或直接在 Task 9 一并加入。建议本步把 Step 5 的 `selectedNode` 与 Task 9 合并提交以保持可编译。)

- [ ] **Step 6: 构建 + web typecheck**

Run: `cd packages/host-opencode && bun run build:dashboard && bunx tsc -p web/tsconfig.json --noEmit && cd ../..`
Expected: 构建成功、无类型错误。

- [ ] **Step 7: 提交**

```bash
git add packages/host-opencode/web/src/layout.ts packages/host-opencode/web/src/nodes \
        packages/host-opencode/web/src/GraphCanvas.tsx packages/host-opencode/web/src/TopBar.tsx \
        packages/host-opencode/web/src/AppShell.tsx
git commit -m "feat(dashboard): React Flow graph canvas with dagre layout and top bar

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 节点详情抽屉(点击节点看状态 + 实时对话)

**Files:**
- Create: `packages/host-opencode/web/src/NodeDrawer.tsx`
- Modify: `packages/host-opencode/web/src/AppShell.tsx`(渲染抽屉,串起 `selectedNode`)

**Interfaces:**
- Consumes: `streamSession`、`ConvoMessage`、`RunSnapshot`(用于查节点的状态/tokens)。
- Produces: `NodeDrawer` props:`{ sessionId: string; onClose: () => void }`。

- [ ] **Step 1: 写 `NodeDrawer.tsx`**

```tsx
import React, { useEffect, useState } from "react";
import { streamSession, type ConvoMessage } from "./api.js";

export function NodeDrawer({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}): React.ReactElement {
  const [msgs, setMsgs] = useState<ConvoMessage[]>([]);
  useEffect(() => streamSession(sessionId, setMsgs), [sessionId]);

  return (
    <aside
      style={{
        position: "absolute", top: 0, right: 0, height: "100%", width: 420,
        background: "var(--surface)", borderLeft: "1px solid var(--border)",
        boxShadow: "-4px 0 16px rgba(27,31,36,.08)", display: "flex", flexDirection: "column",
        zIndex: 10,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ flex: 1 }}>Agent detail</strong>
        <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18 }}>×</button>
      </header>
      <div style={{ overflowY: "auto", padding: 12 }}>
        {msgs.length === 0 && <div style={{ color: "var(--muted)" }}>No messages yet.</div>}
        {msgs.map((m) => (
          <div key={m.messageId} style={{ borderLeft: "2px solid var(--border)", padding: "4px 0 4px 10px", margin: "8px 0", whiteSpace: "pre-wrap" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", color: m.role === "assistant" ? "var(--accent)" : "var(--done)" }}>
              {m.role}{m.tokens != null ? ` · ${m.tokens} tok` : ""}
            </div>
            {m.text}
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: 在 `AppShell.tsx` 渲染抽屉**

在 `<main>` 内、`GraphCanvas` 之后加入:

```tsx
{selectedNode && (
  <NodeDrawer sessionId={selectedNode} onClose={() => setSelectedNode(null)} />
)}
```

并在顶部 import:

```tsx
import { NodeDrawer } from "./NodeDrawer.js";
```

- [ ] **Step 3: 构建 + web typecheck**

Run: `cd packages/host-opencode && bun run build:dashboard && bunx tsc -p web/tsconfig.json --noEmit && cd ../..`
Expected: 成功、无类型错误。

- [ ] **Step 4: 全套离线回归**

Run: `bun run build && bun test packages/core/src packages/host-opencode/src`
Expected: `tsc -b` 干净、dashboard 构建成功、测试全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/host-opencode/web/src/NodeDrawer.tsx packages/host-opencode/web/src/AppShell.tsx
git commit -m "feat(dashboard): node detail drawer with live conversation streaming

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: 端到端人工冒烟 + 文档

**Files:**
- Modify: `INSTALL.md`(新增 dashboard 构建与冒烟说明)
- Modify: `CLAUDE.md`(在 dashboard 段落补一句:产物需 `bun run build:dashboard`;web 工程独立 tsconfig)

**Interfaces:** 无新代码接口;验证全链路。

- [ ] **Step 1: 真实冒烟(需 auth,按 INSTALL.md 现有流程)**

参考 [INSTALL.md](../../INSTALL.md) 跑一个最小 workflow(含一个 `parallel` 与一个 `pipeline`),打开 dashboard URL,确认:
- 节点图按 phase 从左到右排布;
- parallel 子节点同组、pipeline 阶段链有边;
- 节点按状态着色,running 有脉冲;
- 点击节点右侧抽屉滑出并流式显示该 agent 对话;
- `question()` 触发时顶栏出现提问区,作答后运行继续。

记录结果(通过/问题)。

- [ ] **Step 2: 更新 `INSTALL.md`**

新增小节,说明:`bun run build`(或 `bun run build:dashboard`)会产出 `dashboard-dist/`;dashboard 启动后访问打印的 URL;未构建时显示占位页提示。

- [ ] **Step 3: 更新 `CLAUDE.md`**

在 `dashboard/` 说明处补充:产物由 Vite 构建到 `dashboard-dist/`(随包发布);web 工程使用独立 tsconfig,不进 `tsc -b`;`buildGraph` 纯函数在 `src/dashboard/` 受离线测试覆盖。

- [ ] **Step 4: 提交**

```bash
git add INSTALL.md CLAUDE.md
git commit -m "docs: dashboard build + smoke instructions for the node-graph UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- §2 Core 增强(AsyncLocalStorage + agent-start.group + 确定性 id + 不破契约/resume)→ Task 1、Task 2。✓
- §3 图模型(phase 泳道、group 容器、真实依赖边、纯函数)→ Task 4(`buildGraph`)+ Task 8(`layout` 用 dagre)。✓ 注:spec §3 提"嵌套父节点",Task 8 Step 1 显式降级为扁平 dagre 布局并标注为后续增强 —— 已在计划中点明取舍。
- §4 前端栈与组件(浅色、TopBar、RunsRail、GraphCanvas、NodeDrawer、状态色)→ Task 7/8/9。✓
- §5 Server(静态服务、SPA 回退、降级、ui.ts 退化)→ Task 5。✓
- §6 构建接线(devDeps、build:dashboard、files、根 build 串联、web 独立 tsconfig)→ Task 6。✓
- §7 测试(buildGraph 单测、core 编排单测、server/dashboard 测试更新、测试矩阵)→ Task 2/3/4/5。✓
- §9 RunView 携带 group → Task 3。✓
- §10 已知限制(历史运行图空)→ 不需新代码,沿用现状;计划不引入回归。✓
- §11 阶段划分 → Task 1–10 对应。✓

**2. Placeholder scan:** 无 TBD/TODO;每个代码步给出完整代码;命令含期望输出。Task 8 Step 5 的 `selectedNode` 临时未用问题已显式提示与 Task 9 合并以保持可编译。✓

**3. Type consistency:**
- `AgentGroup`(core)字段 `{ id, kind, parentId?, index, stageIndex? }` 在 types.ts、reporter、agent-runner `topGroup`、run-registry、buildGraph 输入、api.ts 一致。✓
- `agentStart(label, phase?, sessionId?, group?)` 新签名在 reporter 定义、agent-runner 调用一致。✓
- `buildGraph(run: GraphRun)` 与 GraphCanvas 调用一致;`layoutGraph(nodes, edges)` 与 GraphCanvas 调用一致。✓
- `GraphRun`/`GraphAgent` 在 buildGraph 定义,api.ts `RunSnapshot extends GraphRun` 复用,字段(phases、agents[].group/status/...)对齐 RunView。✓
- parallel/pipeline 新增可选 `allocGroupId` 末参,既有直接调用(engine.test 等)不传 → 行为不变。✓

发现并修正的点:`buildGraph` 输入特意自带类型而非依赖 `RunView`,避免跨包/构建期耦合(已在 Task 4 Interfaces 标注)。无悬空类型引用。
