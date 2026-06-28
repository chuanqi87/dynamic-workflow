# dynamic-workflow

把 Claude Code 的**动态工作流（dynamic workflow）**能力带到 **opencode** 与 **OpenAI Codex**——
并让每一个工作流脚本都能**在三个宿主之间可移植**。只需编写一份工作流脚本,即可原封
不动地运行在 Claude Code 原生的 `Workflow` 工具上,*或*通过 `@workflow/host-opencode`
运行在 opencode 上,*或*通过 `@workflow/host-codex` 运行在 Codex 上。

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
每个宿主适配器把这些映射到各自平台的 SDK 上。结果就是:同一份脚本可以原封不动地
运行在三个宿主上。

```
@workflow/core           与宿主无关的运行时(沙箱、校验器、编排)
  └── HostAdapter        通向具体平台的唯一边界
@workflow/host-support   两个 host 共享的基础设施:dashboard UI、运行生命周期
                         (RunManager)、worktree 隔离、journal 助手、CLI 解析、
                         源解析。不属于可移植契约
@workflow/host-opencode  opencode 适配器 + 插件 + 无头 CLI(workflow-run)
@workflow/host-codex     Codex 适配器 + 无头 CLI(workflow-run-codex)+ MCP 服务器
                         (workflow-codex-mcp)
docs/spec/               契约、编写指南以及示例脚本(纯文档,非发布包)
```

只有 `core` 必须保持纯净;宿主专属能力(如 dashboard)放在 `host-support` 或具体的
host 包里,绝不渗入 `core`。

## 安装与构建

```sh
bun install
bun run build      # tsc -b 跨各 package,并经 Vite 构建 dashboard(同时即是类型检查)
bun run test       # 离线测试套件(216 个测试 / 28 个文件)
bun run scripts/portability-check.ts   # 根据契约校验示例
```

`bun run build` **就是**类型检查——没有单独的 lint 步骤;它必须干净(`tsc -b`)之后
测试才有意义,因为各 package 相互引用对方的 `dist`。需要单独重建 dashboard UI 时,
执行 `bun run --filter='@workflow/host-support' build:dashboard`(仅 Vite)。

实机冒烟测试(对真实模型,产生费用 + 需鉴权)见 [INSTALL.md](./INSTALL.md);离线套件
覆盖其余所有内容。

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
的形式暴露给脚本)。该工具的描述里内嵌了精简的编写契约,因此模型也可以**编写**
符合契约的工作流。

### 2. `/workflow` 命令(打开 dashboard)

插件会注入一个 `/workflow` 命令,它**只做一件事:直接在浏览器里拉起实时执行面板
(dashboard)**。命令触发时,插件经 `command.execute.before` 钩子启动面板服务并自动
打开浏览器——不绕工具、不需要你手动点链接;面板里能实时看到所有 run 的进度树和每个
子 agent 的对话。这与 Claude Code 对齐:工具负责发起、命令负责监控。发起 workflow 由
`workflow-authoring` skill 引导,直接用自然语言描述任务即可让模型调用 `workflow` 工具;
每次发起后,模型都会提示你用 `/workflow` 打开面板查看进度。

### 3. 无头 CLI(`workflow-run`)

```sh
workflow-run path/to/my.workflow.js --args '{"files":["src/a.ts"]}' --concurrency 3 --budget 200000
```

使用内嵌的 opencode 服务器在聊天之外运行脚本——非常适合 CI、批量运行,以及验证
跨宿主的一致性。

## 在 Codex 中使用

`@workflow/host-codex` 把同一份脚本映射到 OpenAI Codex SDK 上。每个子会话是一个
Codex thread;结构化输出走 `TurnOptions.outputSchema`。两个入口点:

### 1. 无头 CLI(`workflow-run-codex`)

```sh
workflow-run-codex path/to/my.workflow.js --args '{"topic":"..."}' --concurrency 3 --budget 100000
```

### 2. MCP 服务器(`workflow-codex-mcp`)

在 Codex 的 MCP 配置(`~/.codex/config.json` 或项目 `.codex/config.json`)中注册后,
即可向 Codex 暴露 `workflow`、`workflow_cancel`、`workflow_status`、`workflow_answer`
四个工具。`@openai/codex-sdk` 是 peer dependency,需手动安装;鉴权读取 `OPENAI_API_KEY`。
完整步骤(安装、MCP 配置、名称注册表)见 [INSTALL.md](./INSTALL.md)。

工作流名称注册表:项目级在 `.codex/workflows/`,全局在 `~/.codex/workflows/`
(对应 opencode 的 `.opencode/workflows/`)。

## 编写指引 skill

工具描述只放精简的编写契约;深度的编写指引与踩坑清单放在 `workflow-authoring` skill,
在模型动手写 workflow 时按需加载。该 skill 是 **host 无关**的,随 `@workflow/host-support`
发布(`packages/host-support/skills/`),两个 host 各自注册它:

- **opencode**:插件的 `config` 钩子把这个包内目录注册进 `skills.paths`——**无需用户手动
  拷贝或建符号链接**,装了插件的任意项目都会自动拥有(首次可能需重启一次 opencode 才被扫描
  到)。设插件选项 `{ "skill": false }` 可关闭。
- **Codex**:`workflow-codex-mcp` 把它暴露为 MCP **prompt** `workflow-authoring` + **工具**
  `workflow_guide`(返回完整指引);同时 `workflow` 工具描述也带上了精简编写契约。

## 配置(opencode 插件选项)

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

dashboard 的底层基础设施放在共享的 `@workflow/host-support` 里,但**只有 opencode 宿主
会真正拉起它**。当工作流运行在 opencode 下时,插件会启动一个小型的 **localhost Web 仪表盘**
(以 toast 形式打印出来,例如 `http://127.0.0.1:4178`),你可以在其中实时观察:

- **工作流进度树**——各阶段 → 各代理及其实时状态
  (运行中 / 已完成 / null+原因 / 重试中)、token 与重试次数,以及运行汇总;
- **每个代理的对话**——点击某个代理即可实时流式查看其子会话消息;
- **主代理的对话**——发起本次运行的父会话。

进度来自工作流自身的事件;对话来自 opencode 的消息流(通过插件的 `event` 钩子捕获,
仅限定于本次运行的会话——你日常的聊天绝不会被捕获)。它无需改动 opencode 源码,
通过 `{ "dashboard": false }` 即可禁用。该特性**不属于**可移植契约。

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

已实现并经过测试(`tsc -b` 干净,216 个测试 / 28 个文件):核心编排
(`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`)、schema 约束输出、
模型/代理映射、全部三个宿主(opencode 的工具 + 命令 + CLI,Codex 的 CLI + MCP)、
可移植性校验器,以及 DFX 加固(重试/退避、硬预算、跨运行恢复、全局超时、会话清理、
运行汇总、丢弃条目日志)。Worktree 隔离(`isolation: "worktree"`)已落地并接入两个
适配器——非 git 仓库时优雅降级为不隔离。还有仅 opencode 的实时 Web 仪表盘。契约与
回归覆盖见 [`docs/spec/SPEC_TEST_MATRIX.md`](./docs/spec/SPEC_TEST_MATRIX.md)。

## 许可证

MIT
