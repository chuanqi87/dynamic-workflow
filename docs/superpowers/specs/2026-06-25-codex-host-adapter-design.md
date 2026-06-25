# 设计：扩展支持 Codex host（@workflow/host-codex）

- 日期：2026-06-25
- 状态：已批准方向，待实现计划
- 作者：xuchuanqi（with Claude）

## 目标

让同一份 workflow 脚本——除了现有的 Claude Code 原生 `Workflow` 工具与 opencode
插件——还能**不加修改**地运行在 OpenAI Codex 上。同时，把当前散落在
`@workflow/host-opencode` 里的、与 host 无关的"基础设施"（dashboard、run 生命周期、
git worktree、journal 等）抽成共享层，供 opencode 与 codex 两个 host 复用，避免重复实现。

非目标：
- 不修改 `@workflow/core`。`HostAdapter` 就是为新增 host 设计的接缝；若实现中发现必须改
  core 才能适配 Codex，先停下来对齐，不在本设计内默许 core 改动。
- 不改变 workflow 脚本可移植性契约的语义。Codex 作为第三个 host，其能力差异通过既有的
  capability 机制表达（如同 Claude Code 不设 `capabilities`），不引入新的脚本侧 API。

## 背景：现状与耦合分析

两包结构，core 纯净，host-opencode 同时承担三类职责：

1. **opencode 专属**：`OpencodeAdapter`（SDK 映射）、`plugin-entry`（opencode 插件钩子/工具
   注册）、opencode 事件 → transcript 的摄取。
2. **host 无关基础设施（但非 core 契约）**：`DashboardServer`（HTTP/SSE）、`RunRegistry`、
   `RunIndex`、`buildGraph`、web 前端、`RunManager`、`autoConcurrency`、git worktree 辅助、
   `FileJournalSink`/journal source、`script-store`。
3. **headless 入口**：`cli-runner`。

dashboard 与 opencode 的唯一强耦合点：
- `RunRegistry.applyOpencodeEvent(ev)` —— 接收 opencode 原生事件。
- `TranscriptStore.apply(OpencodeEventLike)` 与 `eventSessionId` —— 解析 opencode 的
  `message.updated` / `message.part.updated` / `message.part.removed`。

其余 dashboard 代码（server、buildGraph、run-index、web 前端、registry 的进度部分）消费的是
host 无关的 `ProgressEvent`，本就可直接复用。

## Codex 集成事实（来自 OpenAI 官方文档核实）

- `new Codex(opts?)` → `codex.startThread(opts?)` / `codex.resumeThread(threadId)`。
- `thread.run(prompt, opts?)` 返回 `{ finalResponse, items, usage }`；
  `thread.runStreamed(prompt, opts?)` 产出事件流：`thread.started`（含 `thread_id`）、
  `turn.started`、`item.started`、`item.completed`（`agent_message` 带 `text`；另有
  `command_execution` / `file_change` / `reasoning` 等）、`turn.completed`（含 `usage`）。
- `usage` 字段：`input_tokens` / `cached_input_tokens` / `output_tokens` /
  `reasoning_output_tokens`。turn 级用量已包含工具循环，与现有"整轮计费"语义一致。
- turn 支持 `outputSchema`（JSON Schema，结构化输出）、`model`、`effort`、`cwd`/
  `workingDirectory`、`sandbox`/`sandboxMode`、`skipGitRepoCheck` 等选项。
- Codex **没有** opencode 式的"具名 subagent"概念，**没有**逐轮 USD cost 字段，
  **没有** opencode 式的插件钩子系统——但 Codex 讲 MCP。

## 设计

### 1. 包结构

```
@workflow/core            不动
@workflow/host-support    新增：host 无关基础设施（非 core 契约）
@workflow/host-opencode   瘦身，依赖 host-support
@workflow/host-codex      新增，依赖 host-support
```

`@workflow/host-support` 内容（从 host-opencode 平移）：

- `dashboard/server.ts`：`DashboardServer`，原样平移。`ASSET_ROOT` 指向 host-support
  自身 dist，使两个 host 共享同一套 UI 资产。
- `dashboard/run-registry.ts`：`RunRegistry`，泛化 transcript 接缝（见 §3）。
- `dashboard/run-index.ts`、`dashboard/buildGraph.ts`：原样平移。
- `dashboard/transcript-store.ts`：泛化后的 `TranscriptStore`（见 §3）。
- `run-manager.ts`：原样平移。
- `worktree.ts`：从 `opencode-adapter.ts` 抽出的 git worktree 辅助（`createWorktree` +
  `git`/`sanitize` 私有函数），host 无关。
- `concurrency.ts`：`autoConcurrency`。
- `file-journal.ts`、`script-store.ts`：原样平移（纯文件操作，host 无关）。
- `web/`：dashboard 前端源码 + Vite 构建 → host-support 的 `dashboard-dist`，经
  package `files` 字段随包发布。

CLAUDE.md 中"dashboard 是 opencode-only、不得泄漏进 core"约束的精确含义不变：禁止的是泄漏进
**core**。host-support 是允许依赖 dashboard 的 host 基础设施层；core 仍保持纯净。本设计会同步
更新 CLAUDE.md 的架构段落以反映三包结构与 dashboard 的新归属。

### 2. CodexAdapter（`implements HostAdapter`）

落在 `@workflow/host-codex/src/codex-adapter.ts`，构造接收一个 `Codex` 实例与
`CodexAdapterOptions`（rootDirectory、directory、onEvent、onQuestion、logStream 等，
对齐 `OpencodeAdapterOptions` 形态）。

映射表：

| HostAdapter 成员 | Codex 映射 |
|---|---|
| `rootDirectory` | 来自 options |
| `capabilities.structuredOutput` | `true`（透传 `req.schema` 为 turn 的 `outputSchema`）。若安装的 SDK 版本拒绝 `outputSchema`，返回 `formatUnsupported: true`，由 core 回退到 prompt-envelope + ajv 路径 |
| `createSubSession(parent, title)` | `codex.startThread(threadOpts)`；返回合成 sessionId（`codex-sub-<n>`），内部 `Map<sessionId, Thread>`。真实 `thread_id` 在首个 run 的 `thread.started` 事件落定后记录，仅用于关联/调试 |
| `runAgent(req)` | 取 Thread → `thread.runStreamed(req.prompt, { model, effort, outputSchema, workingDirectory })`；消费事件流：`item.completed(agent_message)` 累加文本并喂 transcript，`turn.completed.usage` → `{ input, output: output_tokens, reasoning: reasoning_output_tokens }`，命中 `outputSchema` 时设 `structured`。返回 `AgentResult`（cost 记 0） |
| `listAgents()` | `[]`（Codex 无具名 subagent；`agentType` 解析退化为 no-op） |
| `report(ev)` | 复用 host-support 进度管线（`onEvent` → registry）；CLI 模式写 stderr，沿用现有 `formatEvent` |
| `createWorktree?` | 复用 host-support 的 `worktree.ts`；thread 以 `workingDirectory = worktree.dir` 运行 |
| `closeSession?(id)` | 从 Map 移除并尽力中止对应 thread |
| `askQuestion?` | 可选；委派 `onQuestion`（dashboard answer 端点 / MCP 工具 / `opts.default`） |

并发与中止：`runAgent` 在 `req.signal` 上挂中止（复用现有 `race` 模式），超时同理。
错误分类：新建 `classifyCodexError`，把 `429/5xx/网络` 归为 retriable，鉴权/400/无效请求归为
terminal，对齐 `AgentResult.retriable` 语义。

per-run vs per-thread 选项的版本差异：`thread.run`/`runStreamed` 是否接受逐轮
`outputSchema`/`model`/`effort` 随 SDK 版本而异。适配器按"逐轮优先"实现；若安装版本只支持在
`startThread` 设定，则改为**懒启动 thread**（首个 run 时用该 run 的 opts 调 `startThread`）。
实现阶段对照实际安装的 `@openai/codex-sdk` 版本验证并择一固化。

### 3. dashboard / transcript 泛化

唯一需要改动（而非平移）的 dashboard 部分。

引入归一化 `TranscriptDelta`（落在 host-support）：

```ts
interface TranscriptDelta {
  sessionId: string;
  messageId: string;
  role: string;        // "assistant" | "user" | ...
  text: string;        // 该 message 当前累计文本（全量覆盖语义，沿用现有 parts join 结果）
  tokens?: number;     // 该 message 的 output tokens
  cost?: number;
}
```

- host-support `TranscriptStore` 改为消费 `TranscriptDelta`（不再认识 opencode 事件）。
- `RunRegistry` 暴露 `applyTranscript(delta)`（取代 `applyOpencodeEvent`），仍按
  `sessionToRun` 门控、仍发 `{ kind: "session", sessionId }` 通知。`RunRegistry` 的
  `ProgressEvent` 处理部分原样保留。
- 各 host 自带翻译器：
  - `host-opencode/src/opencode-transcript.ts`：opencode 事件 → `TranscriptDelta[]`
    （从现有 `transcript.ts` 的 `apply` + `eventSessionId` 逻辑改造而来），plugin 的
    `event` 钩子调用它再 `registry.applyTranscript(...)`。
  - `host-codex/src/codex-transcript.ts`：Codex 流事件（`item.completed` 等）→
    `TranscriptDelta`。由 `CodexAdapter` 在消费 `runStreamed` 时直接产生并上报。

web 前端无需改动：它消费的是 registry 输出的 JSON，与 host 无关。

### 4. 触发面

Codex 无 opencode 式插件钩子，因此两条入口：

1. **headless CLI（必做）**：`@workflow/host-codex` 提供 `workflow-run-codex` bin，内嵌
   `new Codex()`，与现有 [cli-runner.ts] 同构（`runHeadless` + `parseArgv` + `isCliEntry`）。
   面向 CI / 批处理 / 跨 host 验证同一脚本。
2. **MCP server（可选，本期一并做）**：`workflow-codex-mcp` bin，暴露 `workflow` /
   `workflow_status` / `workflow_cancel` / `workflow_answer` 工具，供活跃 Codex 会话内调用
   ——opencode `plugin-entry` 在 Codex 侧的等价物。命名 workflow 注册目录为
   `.codex/workflows/`（`resolve-source` 把注册目录参数化，逻辑与 opencode 版共享）。

两条入口都复用 host-support 的 `RunManager`（生命周期/取消/question）与可选 `DashboardServer`。

### 5. 数据流（一次 Codex run）

```
CLI/MCP 触发
  → RunManager.begin(runId) 取得 signal
  → CodexAdapter（new Codex 实例）
  → runWorkflow(source, { adapter, config, signal, ... })  // core 不变
      └ agent() → adapter.runAgent → thread.runStreamed
            ├ item.completed(agent_message) → TranscriptDelta → registry.applyTranscript
            ├ turn.completed.usage → AgentResult.tokens（进 budget）
            └ outputSchema 命中 → AgentResult.structured（core ajv 复验）
      └ progress ProgressEvent → registry.applyProgress（dashboard 树/计数）
  → RunManager.finish(runId, status, summary, result)
```

## 测试策略（全离线）

- `@openai/codex-sdk` 用可编排的 fake 替身（fake `Codex`/`Thread`：可设定 run 结果、
  `runStreamed` 事件序列、usage、抛错时机），覆盖 `CodexAdapter`（token 统计、结构化输出命中
  与回退、错误分类→retriable、中止/超时、worktree workingDirectory 透传）与
  `codex-transcript`（事件 → TranscriptDelta）。
- host-support 接管并平移现有 `buildGraph` / `transcript-store`（改造后）/ `run-registry`
  测试；新增 `applyTranscript` 的归一化测试。
- host-opencode 的 `opencode-transcript` 翻译器补测，验证与改造前 transcript 行为等价。
- 根 `bun test` 扩展到 `packages/core/test packages/host-support/test
  packages/host-opencode/test packages/host-codex/test`。
- `bun run build`（`tsc -b`）仍是全量 typecheck 关卡，跨包 `dist` 引用必须先构建干净。
- 实模型 smoke（CLI / MCP）记入 INSTALL.md，付费、需鉴权，不进离线套件。

## 文档与契约

- `docs/spec/WORKFLOW_SCRIPT_SPEC.md`：增补"Codex host 能力差异"小节——`agentType` 被忽略、
  逐轮 cost 可能为 0、`question()` 仅在 dashboard/MCP 在场时可答（否则走 `default`）、
  结构化输出走 `outputSchema`。
- `docs/spec/SPEC_TEST_MATRIX.md`：为上述能力差异补对应回归测试行。
- `CLAUDE.md`：更新为三包结构，标注 dashboard 归属 host-support（仍非 core 契约）。
- `INSTALL.md`：补 Codex CLI/MCP 的 smoke 步骤。

## 分阶段实施（每步可独立 `tsc -b` + 测试通过）

1. **抽 host-support**：平移基础设施 + 泛化 transcript 接缝；改造 host-opencode 接入
   `opencode-transcript` + 从 host-support 引 worktree/dashboard/run-manager/journal。
   验收：opencode 全套测试与 dashboard 行为不变（绿）。
2. **host-codex 适配器 + transcript**：`CodexAdapter` + `codex-transcript` + fake SDK 测试。
3. **headless CLI**：`workflow-run-codex` + runHeadless 测试。
4. **MCP server**：`workflow-codex-mcp` + 生命周期工具 + `.codex/workflows/` resolve。
5. **文档与契约**：spec / 矩阵 / CLAUDE.md / INSTALL.md。

## 风险与开放点

- core 零改动是硬约束（见目标）。
- `@openai/codex-sdk` 选项的版本差异（§2 末），实现时对照实际版本固化。
- Codex sandbox/审批策略与本项目 git-worktree 隔离是两套机制；本期以 `workingDirectory`
  指向 worktree 即可，不引入 Codex sandbox 的额外审批交互（默认走 SDK 默认策略，必要时由
  `threadOpts` 配置项暴露）。
