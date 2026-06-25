# 规范 → 测试映射表

[WORKFLOW_SCRIPT_SPEC.md](./WORKFLOW_SCRIPT_SPEC.md) 中的每一条契约条款,以及每一项
DFX 加固行为,都至少映射到一个自动化测试。测试使用 `MockAdapter`(core)或伪造的
`OpencodeClient`(host)——没有真实模型,没有真实睡眠(注入 `sleep`/`now`/`rng`)。
本表是回归基线。

| # | 契约 / DFX 条款 | 测试 |
|---|---|---|
| meta 是纯字面量 | §2 | `portability-validator.test.ts` → "rejects non-literal meta" |
| meta 字段白名单 | §2 | "rejects unknown meta keys" |
| 仅限普通 JS(无 TS) | §4.2 | "rejects TypeScript syntax" |
| 禁用 `Math.random()` | §4.3 | "rejects Math.random()" |
| 禁用 `Date.now()` / 无参 `new Date()` | §4.3 | "rejects Date.now() and argless new Date()" |
| 禁用逃逸标识符 | §4.4 | "rejects escape identifiers" |
| 禁用 `.constructor`/`.__proto__` | §4.4 (DFX P2-11) | "rejects proto access" |
| 单批 ≤ 4096 | §4.5 | "flags literal batch over the limit" + `runtime` MAX_BATCH 守卫 |
| 代理总数 ≤ 1000 | §4.6 | `AgentLimitError`(agent-runner 计数器) |
| `agent()` 返回文本 | §3 | `engine.test.ts` → "returns a basic agent result" |
| `agent({schema})` 返回经校验的对象 | §3 | "schema-constrained agent returns a validated object" |
| 带反馈的 schema 重试 | §3 | `structured-output.test.ts` → "retries with feedback then succeeds" |
| `parallel` 屏障 + null 降级 | §3 | "parallel degrades a throwing thunk to null" |
| `pipeline` 无屏障 + 逐条目 null | §3 | "pipeline threads stages and isolates failures" |
| 相同 `(prompt,opts)` 在运行内被缓存 | §5 | "identical (prompt, opts) is cached within a run" |
| label/phase 不计入缓存键 | §5 | `journal.test.ts` → "ignores display-only label and phase" |
| 并发上限(排队) | §6 | `semaphore.test.ts`(全部) |
| 并发自动 = min(16,cores-2) | §6 (DFX P2-10) | host `autoConcurrency()`(plugin-entry) |
| **终端错误 → 重试后为 null** | §3 (DFX P0-1) | `dfx.test.ts` → "retries a transient error then succeeds" / "does NOT retry a terminal error" / "exhausting retries" |
| 退避调度 | DFX P0-1 | "backoff follows the exponential schedule" |
| 瞬时错误分类(host) | DFX P0-1 | `opencode-adapter.test.ts` → "error classification" 区块 |
| **预算硬上限 → 抛出** | budget §3 (DFX P0-2) | `engine.test.ts` → "budget exhaustion throws by default" |
| 预算降级模式 | DFX P0-2 | "budget exhaustion degrades to null when budgetMode is 'degrade'" |
| **跨运行恢复(按键)** | resume §5 (DFX P0-3) | `resume.test.ts` → "reuses all cached results" / "only changed agent() calls run live" |
| 失败结果不写入种子 | DFX P0-3 | "failed (null) results are NOT seeded" |
| 损坏的日志 → 全新运行 | DFX P0-3 | "a corrupted/missing journal degrades to a fresh run" |
| 日志只为成功项写入种子 | DFX P0-3 | `journal.test.ts` → "seeds only successful agent results" |
| 全局挂钟超时 | DFX P1-4 | `dfx.test.ts` → "aborts in-flight agents when the global timeout elapses" |
| 取消时清理子会话 | DFX P1-5 | "closes created sessions when the run is cancelled" + adapter "closeSession" |
| 结束时刷写日志 | DFX P1-6 | `FileJournalSink.flush`(引擎清理);经由 plugin-entry 集成覆盖 |
| 成本/token 汇总 | DFX P1-7 | `opencode-adapter.test.ts` → "sums tokens and cost across all assistant messages" |
| 运行汇总计数器 | DFX P2-8 | `dfx.test.ts` → "counts successes, nulls-by-reason and tokens" |
| 丢弃条目日志(无静默截断) | §4 (DFX P2-9) | "logs a dropped event for a throwing parallel thunk" |
| 日志内存上限 | DFX P2-12 | `journal.test.ts` → "stops caching past the cap and warns once" |
| 阶段默认模型 | DFX P2-13 | `dfx.test.ts` → "uses the phase's model when opts specify none" |
| 中止立即返回 / 运行中中止 | §3 | `opencode-adapter.test.ts` → "already aborted" / "aborts an in-flight prompt" |
| 单代理超时 | §3 | `opencode-adapter.test.ts` → "respects per-call timeout" |
| 端到端 opencode 路径 | — | `plugin-entry.test.ts` → "runs an inline script end-to-end" |
| CLI 参数解析 | M5 | `cli-runner.test.ts` → "parseArgv" |
| 共享引擎上的离线 dry-run | M5 | `scripts/portability-check.ts`(静态 + dry-run) |
| 运行生命周期:按 id 取消 | M6 | `run-manager.test.ts` → "begin returns a cancellable signal" / "finish clears the controller" |
| 持久化运行索引(历史) | M6 | `run-manager.test.ts` → "RunIndex last-write-wins" |
| 崩溃恢复(被中断) | M6 | `run-manager.test.ts` → "recover flags orphaned 'running' runs" |
| 仪表盘取消路由 | M6 | server cancel route + RunManager.cancel |
| worktree 隔离(创建/保留/降级) | M7 | `worktree.test.ts`(全部) |
| 前缀恢复模式 | M7 | `resume.test.ts` → "prefix mode: changed early call invalidates" / "unchanged prefix reused" |
| 原生结构化输出(opencode `format: json_schema`)+ ajv 兜底 | §3 | `engine.test.ts` → "native structured output: returns the host's structured object" / "ajv safety net rejects an invalid structured payload" / "formatUnsupported falls back to the prompt-envelope path";`opencode-adapter.test.ts` → "OpencodeAdapter native structured output" 区块 |
| 旧服务端拒绝 `format` → 一次性降级 + 回退 ajv | §3 (DFX) | `opencode-adapter.test.ts` → "downgrades only on a format-specific 400, then stops sending format" |
| 仅 format 相关 400 才降级(通用 400 不误判) | §3 (DFX) | `opencode-adapter.test.ts` → "a generic 400 (not about format) does NOT downgrade native (B1)" |
| native 校验失败 → 回退 envelope 反馈式重试 | §3 | `engine.test.ts` → "an invalid native payload falls through to envelope retries" |
| effort→reasoning_effort | M7 | 未实现 —— opencode SDK 的 prompt body 无逐 prompt 的 `reasoning_effort` 字段;effort 仅用于本地模型选择,已记录在案 |
| 工具层暴露 replay(keyed/prefix) | resume §5 | `read-config.test.ts` → "parses replay only for the two valid values"(引擎双模式见 `resume.test.ts`) |
| 背景执行(background)+ 结果持久化 | host | `plugin-entry.test.ts` → "background mode returns immediately, then persists the result";`run-manager.test.ts` → "finish persists the final result for later retrieval" |
| 逐代理工具控制(host 配置 `defaultTools`/`agentTools`) | host | `read-config.test.ts` → "readToolConfig" 区块;`opencode-adapter.test.ts` → "forwards a per-prompt tools map" |
| question() 人在回路 | M8 | `dfx.test.ts` → "M8 question()";`run-manager.test.ts` → "ask()/answer()/cancel unblocks" |
| `agent-start.group` 编排遥测 | §7 遥测 | `orchestration-metadata.test.ts` → "parallel children share a groupId" / "pipeline stages carry stageIndex" / "parallel nested in a pipeline stage links parentId" / "group ids are stable across a re-run" |
| **Codex: agentType ignored / listAgents returns `[]`** | §6 Codex host | `packages/host-codex/test/codex-adapter.test.ts` → "listAgents returns empty array (codex has no named subagents)" |
| **Codex: token usage from `turn.completed`** | §6 Codex host | `packages/host-codex/test/codex-adapter.test.ts` → "runAgent returns final agent_message text and turn usage" |
| **Codex: structured output via `outputSchema`** | §6 Codex host | `packages/host-codex/test/codex-adapter.test.ts` → "passes schema as outputSchema in TurnOptions and surfaces structured output" / "capabilities declares structuredOutput true" |
| **Codex: error classification retriable** | §6 Codex host | `packages/host-codex/test/codex-adapter.test.ts` → "turn.failed marks errored and classifies 429 as retriable" / "turn.failed with auth error is classified as terminal (non-retriable)" |
| **Codex: transcript translation** | §6 Codex host | `packages/host-codex/test/codex-transcript.test.ts` → "emits a delta per completed agent_message item" / "turn.completed stamps output tokens onto the last assistant message" |
| **Codex: headless run end-to-end** | §6 Codex host | `packages/host-codex/test/cli-runner.test.ts` → "runs a one-agent workflow and returns its result" |
| **Codex: MCP server handlers** | §6 Codex host | `packages/host-codex/test/mcp-entry.test.ts` → "run executes an inline script end-to-end and returns output + runId in metadata" |
