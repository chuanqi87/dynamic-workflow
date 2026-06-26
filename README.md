# opencode-dynamic-workflow

把 Claude Code 的**动态工作流（dynamic workflow）**能力带到 opencode——并让每一个
工作流脚本都能**在两个宿主之间可移植**。只需编写一份工作流脚本,即可原封不动地
运行在 Claude Code 原生的 `Workflow` 工具上,*或*通过本插件运行在 opencode 上。

工作流就是一段确定性地编排子代理的普通 JavaScript:

```js
export const meta = {
  name: "review-files",
  description: "Review files for bugs, then verify each finding.",
  phases: [{ title: "Review" }, { title: "Verify" }],
};

const reviewed = await pipeline(
  args.files,
  (_, file) => agent(`Review ${file} for bugs.`, { schema: FINDINGS }),
  (review) => parallel((review?.findings ?? []).map((f) => () =>
    agent(`Verify: ${f.issue}`, { schema: VERDICT }).then((v) => ({ ...f, verdict: v })))),
);
return { confirmed: reviewed.flat().filter(Boolean).filter((f) => f.verdict?.real) };
```

可移植性契约只在一处定义:
[`docs/spec/WORKFLOW_SCRIPT_SPEC.md`](./docs/spec/WORKFLOW_SCRIPT_SPEC.md)。

## 可移植性的工作原理

Claude Code 的工作流运行时是原生且封闭的。我们不去改动它——而是**镜像它的契约**。
与宿主无关的 `@workflow/core` 引擎注入同一套环境全局变量(`agent`、`parallel`、
`pipeline`、`phase`、`log`、`workflow`、`args`、`budget`),并执行同样的沙箱规则。
`@workflow/host-opencode` 把这些映射到 opencode SDK 上。结果就是:同样的字节码可以
运行在两个宿主上。

```
@workflow/core           与宿主无关的运行时(沙箱、校验器、编排)
  └── HostAdapter        通向具体平台的唯一边界
@workflow/host-opencode  opencode 适配器 + 插件 + 无头 CLI
docs/spec/               契约、编写指南以及示例脚本(纯文档,非发布包)
```

## 安装与构建

```sh
bun install
bun run build      # 跨各 package 执行 tsc -b
bun test packages/core/test packages/host-opencode/test
bun run scripts/portability-check.ts   # 根据契约校验示例
```

## 在 opencode 中使用

共有三个入口点,它们都共享同一个引擎。

### 1. `workflow` 工具(可由 LLM 调用)

全局或按项目注册插件。

- **全局**:把构建好的插件软链接/拷贝到 `~/.config/opencode/plugins/`,
  或将其添加到 `~/.config/opencode/opencode.json`:

  ```json
  {
    "plugin": [
      ["@workflow/host-opencode", {
        "concurrency": 3,
        "budgetTotal": 500000,
        "modelMap": { "opus": { "providerID": "anthropic", "modelID": "claude-opus-4-8" } },
        "agentTypeMap": { "Explore": "explore", "general-purpose": "general" }
      }]
    ]
  }
  ```

随后模型即可调用 `workflow` 工具,传入 `script`(内联)、`scriptPath` 或 `name`
(位于 `.opencode/workflows/` 下的文件)三者之一,外加可选的 `input`(以 `args`
的形式暴露给脚本)。该工具的描述里内嵌了完整的编写指南,因此模型也可以**编写**
符合契约的工作流。

### 2. `/workflow` 命令(由用户触发)

插件会注入一个 `/workflow <scriptPath-or-name>` 命令,用于驱动同一个工具。

### 3. 无头 CLI

```sh
workflow-run path/to/my.workflow.js --args '{"files":["src/a.ts"]}' --concurrency 3 --budget 200000
```

使用内嵌的 opencode 服务器在聊天之外运行脚本——非常适合 CI、批量运行,以及验证
跨宿主的一致性。

### 4. 编写指引 skill(仅 opencode)

工具描述只放精简的编写契约;深度的编写指引与踩坑清单放在 opencode skill
`workflow-authoring`,在模型动手写 workflow 时按需加载。

该 skill **随插件一起发布**(`packages/host-opencode/skills/`,见 package 的 `files`),
并由插件的 `config` 钩子把这个包内目录注册进 opencode 的 `skills.paths`——**无需用户手动
拷贝或建符号链接**,装了插件的任意项目都会自动拥有。首次安装后可能需要重启一次 opencode 才会
被扫描到。如不需要,设插件选项 `{ "skill": false }` 关闭。

## 配置(插件选项)

| 选项 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `concurrency` | number | `min(16, cores-2)` | 在途子代理的最大数量 |
| `budgetTotal` | number \| null | `null` | 输出 token 上限(硬限制) |
| `budgetMode` | `"throw"` \| `"degrade"` | `"throw"` | 耗尽时的行为:抛出异常(与 Claude Code 兼容)或返回 `null` |
| `agentTimeoutMs` | number | 无 | 单个代理的超时 |
| `globalTimeoutMs` | number | 无 | 整个运行的挂钟超时(会中止该运行) |
| `retry` | object | `{retries:3,baseMs:500,factor:2,maxMs:8000,jitter:0.2}` | 瞬时错误的重试/退避 |
| `schemaRetries` | number | `2` | schema 约束输出的重试次数 |
| `maxJournalEntries` | number | 无上限 | 内存中缓存结果数量的上限 |
| `modelMap` | record | `{}` | 逻辑模型名 → `{ providerID, modelID }` |
| `effortMap` | record | 合理默认 | 推理强度档位 → 逻辑模型名 |
| `agentTypeMap` | record | `{}` | Claude Code 代理类型 → opencode 子代理 |
| `defaultModel` | string | 继承 | 未指定时使用的逻辑模型 |
| `dashboard` | boolean | `true` | 启用实时 Web 仪表盘(仅 opencode) |
| `dashboardPort` | number | `4178` | 首选的仪表盘端口(被占用时自动递增) |

### 实时 Web 仪表盘(仅 opencode)

当工作流运行在 opencode 下时,插件会启动一个小型的 **localhost Web 仪表盘**
(以 toast 形式打印出来,例如 `http://127.0.0.1:4178`),你可以在其中实时观察:

- **工作流进度树**——各阶段 → 各代理及其实时状态
  (运行中 / 已完成 / null+原因 / 重试中)、token 与重试次数,以及运行汇总;
- **每个代理的对话**——点击某个代理即可实时流式查看其子会话消息;
- **主代理的对话**——发起本次运行的父会话。

进度来自工作流自身的事件;对话来自 opencode 的消息流(通过插件的 `event` 钩子捕获,
仅限定于本次运行的会话——你日常的聊天绝不会被捕获)。它无需改动 opencode 源码,
通过 `{ "dashboard": false }` 即可禁用。该特性**不属于**可移植契约——它只存在于
opencode 宿主上。

### DFX / 可靠性

为长时间运行的多代理任务而构建:瞬时错误(429/5xx/网络)会以指数退避重试;
token 预算是硬上限(抛出异常,与契约一致);失败的子代理降级为 `null`,并在
**运行汇总**中体现(`succeeded`、`nullsByReason`、`retries`、`dropped`、
`outputTokens`、`costUsd`、`durationMs`);`parallel`/`pipeline` 会记录每一个被丢弃的
条目(不会有静默截断);取消时子会话会被中止;运行是**可恢复的**——传入
`resume: <priorRunId>`(工具)或 `--resume <runId>`(CLI),未变化的 `agent()` 调用
会从日志中回放,而变化/失败的则实时运行。跨宿主契约及其回归测试记录在
[`docs/spec/SPEC_TEST_MATRIX.md`](./docs/spec/SPEC_TEST_MATRIX.md)。

默认情况下模型**从宿主会话继承**——只有当你希望像 `"opus"` 这样的逻辑名解析到
特定提供方时,才需要配置 `modelMap`。

## 状态

已实现并经过测试(`tsc -b` 干净,89 个测试):核心编排
(`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`)、schema 约束输出、
模型/代理映射、全部三个入口点、可移植性校验器,以及 DFX 加固
(重试/退避、硬预算、跨运行恢复、全局超时、会话清理、运行汇总、丢弃条目日志),
还有仅 opencode 的实时 Web 仪表盘。Worktree 隔离已搭好骨架
(`isolation: "worktree"` 会被接受并优雅降级),留待后续里程碑。契约与回归覆盖见
[`docs/spec/SPEC_TEST_MATRIX.md`](./docs/spec/SPEC_TEST_MATRIX.md)。

## 许可证

MIT
