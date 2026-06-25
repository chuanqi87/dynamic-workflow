# 工作流脚本规范(v1）

这是**可移植工作流脚本契约**的唯一可信来源。符合本规范的脚本可以**原封不动**地
运行在:

- **Claude Code**——通过其原生的 `Workflow` 工具运行时,以及
- **opencode**——通过本仓库中的 `@workflow/host-opencode` 插件。

可移植性是通过遵守一份契约实现的,而非通过转换脚本。两个宿主都不会修改脚本;
两者都注入同一套环境全局变量,并施加同样的沙箱规则。

---

## 1. 文件形态

一个工作流脚本是**普通 JavaScript**(不是模块,也不是 TypeScript)。它恰好由
两部分组成:

```js
export const meta = { /* 纯字面量 —— 见 §2 */ };
// ── 异步函数体 ── (meta 字面量之后的所有内容)
phase("Find");
const x = await agent("…");
return { x };          // 顶层 return 产出工作流的结果
```

- 文件**必须以** `export const meta = { … }` 开头。
- meta 字面量之后的所有内容都被当作**异步函数体**:它可以使用顶层 `await` 与
  顶层 `return`,并直接引用 §3 中的环境全局变量(**不要** `import` 它们)。

> 为什么它既不是真正的 ES 模块也不是普通脚本:它把 `export`(仅模块可用)与
> 顶层 `return`(仅脚本可用)结合在了一起。宿主会单独解析 meta 字面量,并把
> 其余部分作为异步函数体运行。

---

## 2. `meta` 块

`meta` **必须是一个纯对象字面量**——不允许变量、函数调用、模板插值、展开或
计算键。允许的字段:

| 字段 | 类型 | 含义 |
|---|---|---|
| `name` | string(必填) | 在进度 UI 中显示的简短标识符 |
| `description` | string(必填) | 一行摘要 |
| `phases` | `{ title: string, detail?: string, model?: string }[]` | 为进度显示声明的各阶段 |
| `whenToUse` | string | 可选的使用提示 |
| `model` | string | 本次运行的默认逻辑模型 |

任何其他字段,或任何非字面量的值,都属于**校验错误**。

---

## 3. 环境全局变量

它们被注入到函数体中,构成全部可移植表面。

### `agent(prompt, opts?) => Promise<string | object | null>`
将单个子代理运行至完成。
- 不带 `opts.schema`:解析为子代理的**最终文本**(string)。
- 带 `opts.schema`(一个 JSON Schema 对象):解析为一个**经过校验的对象**。
- 当子代理被中止、出错,或在多次重试后仍未通过 schema 校验时,解析为 **`null`**。
  (预算耗尽默认会**抛出**;仅在宿主配置 `budgetMode: "degrade"` 时才降级为 `null`——见下文 `budget`。)

`opts` 字段:

| 字段 | 类型 | 含义 |
|---|---|---|
| `label` | string | 显示标签(**不**影响缓存) |
| `phase` | string | 把本次调用归入的阶段 |
| `schema` | JSON Schema | 约束并校验输出 |
| `model` | string | 逻辑模型(`"opus"`)或 `"provider/model-id"` |
| `effort` | `"low"\|"medium"\|"high"\|"xhigh"\|"max"` | 推理强度档位 |
| `agentType` | string | 要使用的具名宿主子代理 |
| `isolation` | `"worktree"` | 在隔离的 git worktree 中运行 |

### `parallel(thunks) => Promise<any[]>`
并发运行 `() => Promise` 形式的 thunk 并等待它们全部完成(一道**屏障**)。
抛出异常的 thunk(或其 `agent()` 失败的 thunk)在结果数组中解析为 `null`——
`parallel` 本身绝不 reject。用 `.filter(Boolean)` 过滤。

### `pipeline(items, stage1, stage2, …) => Promise<any[]>`
让每个条目独立地流经所有阶段,**阶段之间没有屏障**——条目 A 可能正处于阶段 3,
而条目 B 仍在阶段 1。每个阶段回调接收 `(prevResult, originalItem, index)`。
抛出异常的阶段会把该条目降级为 `null` 并跳过其余阶段。

### `phase(title)` / `log(message)`
进度上报。无返回值。

### `workflow(nameOrRef, args?) => Promise<any>`
将另一个工作流作为子步骤内联运行(仅允许一层嵌套)。`nameOrRef` 是一个已注册的
名称(string)或 `{ scriptPath }`。子工作流共享本次运行的并发上限、代理计数器与预算。

### `question(prompt, opts?)` —— 可选的宿主扩展(不可移植)
暂停以等待人类回答;解析为答案字符串,或在宿主无法发问或等待超时时解析为
`opts.default ?? null`。`opts`:`{ options?, default?, timeoutMs? }`。这**不属于**
可移植核心——Claude Code 不会注入它。可移植脚本在使用前**必须**进行特性检测:

```js
if (typeof question === "function") {
  const go = await question("Proceed with deploy?", { options: ["yes", "no"], default: "no" });
}
```

### `args`
传给本次运行的输入值,原样保留。

### `budget`
`{ total: number | null, spent(): number, remaining(): number }` —— 一个输出
token 预算。`total` 为 `null` 表示无上限。一旦预算耗尽,后续的 `agent()` 调用**默认会抛出**
`BudgetExceededError`(硬上限,与 Claude Code 一致);仅当宿主配置 `budgetMode: "degrade"` 时,
才会改为降级为 `null`。

---

## 4. 沙箱规则(在脚本运行前强制执行)

宿主**必须拒绝**违反以下任一规则的脚本:

1. `meta` 不是纯字面量(见 §2)。
2. 函数体包含 **TypeScript 语法**(类型注解、`interface`、`as`、泛型……)。
   脚本是普通 JS。
3. 函数体使用了 **`Date.now()`**、**`Math.random()`**,或**不带参数的
   `new Date()`**。工作流必须确定性,以保证恢复/缓存的可靠性;任何时间/随机性都应
   从 `args` 派生。
4. 函数体引用了逃逸标识符:`globalThis`、`process`、`require`、`eval`、`Function`、
   `import()`(动态)、`module`、`exports`……
5. 单次 `parallel()` / `pipeline()` 调用超过 **4096** 个条目。
6. 整次运行超过 **1000** 次 `agent()` 调用。

环境全局变量 + 标准安全内置之外的自由标识符会产生**警告**(它们未必存在于
每个宿主上)。

---

## 5. 确定性与缓存

- 一次运行由 `runId` 标识。在同一次运行内,两个具有相同 `(prompt, opts)`
  (忽略 `label`/`phase`)的 `agent()` 调用返回**同一个缓存结果**——子代理只运行一次。
- 由于脚本是确定性的(规则 §4.3),重放一次运行会重现同样的 `(prompt, opts)` 序列,
  这正是跨运行恢复得以可能的原因。

---

## 6. 并发

在途子代理有上限(Claude Code:`min(16, cores−2)`;opencode:可配置,默认 3)。
超出的调用排队。`parallel`/`pipeline` 可以被传入数千个条目;同一时刻只有上限内的
数量在运行。

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

---

## 7. 进度事件遥测（host 内部，非脚本可见）

### `agent-start.group`（host 内部遥测，非脚本可见）

`agent-start` 事件可携带可选的 `group`，描述该 `agent()` 在 `parallel`/`pipeline`
编排中的位置：`{ id, kind: "parallel"|"pipeline", parentId?, index, stageIndex? }`。
此字段由运行时通过 `AsyncLocalStorage` 编排上下文填充，**不影响脚本契约、journal key
或 resume**；Claude Code 的原生运行时不发送该字段。仅 opencode dashboard 消费它。

---

## 8. 最小合规示例

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
