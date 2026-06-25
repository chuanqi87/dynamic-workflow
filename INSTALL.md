# 安装与实机冒烟测试(opencode)

## 构建

```sh
bun install
bun run build          # tsc -b → packages/*/dist, then Vite → dashboard-dist/
```

`bun run build` also runs `bun run build:dashboard` (Vite) as a final step, producing
`packages/host-opencode/dashboard-dist/`. If you only need to rebuild the dashboard UI
without touching TypeScript:

```sh
bun run build:dashboard   # Vite only — skips tsc -b
```

> **Unbuilt dashboard:** if `dashboard-dist/` is absent (e.g. a fresh checkout before the
> first build), the HTTP server serves a placeholder page that tells you to run
> `bun run build` or `bun run build:dashboard`.

## 在 opencode 中加载插件

opencode 会加载 `opencode.json` 的 `plugin` 数组中列出的插件(可以是已发布的
npm 名称,或指向已构建文件的绝对路径)。

### A. 本地 / 未发布(本仓库)

让 opencode 指向已构建的入口。在 `~/.config/opencode/opencode.json`(全局)
或 `<project>/.opencode/opencode.json`(项目)中:

```json
{
  "plugin": [
    "/ABS/PATH/opencode-dynamic-workflow/packages/host-opencode/dist/plugin-entry.js"
  ]
}
```

带选项:

```json
{
  "plugin": [
    ["/ABS/PATH/.../dist/plugin-entry.js", {
      "concurrency": 3,
      "budgetTotal": 500000,
      "dashboard": true,
      "dashboardPort": 4178,
      "modelMap": { "opus": { "providerID": "anthropic", "modelID": "claude-opus-4-8" } }
    }]
  ]
}
```

### B. 已发布

```json
{ "plugin": [["@workflow/host-opencode", { "dashboard": true }]] }
```

## 验证是否已加载

在某个项目中启动 opencode 并检查:

- `workflow` 工具已提供给模型,且 `/workflow` 出现在命令列表中;
- 运行某个工作流时会弹出带有仪表盘 URL 的 toast(如 `http://localhost:4178`)。

打开该 URL 即可看到节点图仪表盘(需已执行过 `bun run build` 或 `bun run build:dashboard`
以生成 `dashboard-dist/`);否则将显示占位页并提示运行构建命令。

## 实机冒烟测试(真实模型)

无头、无聊天:

```sh
# 在仓库中运行(使用内嵌的 opencode 服务器)
bun packages/host-opencode/dist/cli-runner.js \
  docs/spec/examples/hello.workflow.js --concurrency 3
```

在 TUI 中,让代理用 `scriptPath: docs/spec/examples/hello.workflow.js` 运行
workflow 工具,然后从 toast 中打开仪表盘 URL,实时观看进度树以及每个代理的对话。

> 实机运行会发起真实的模型调用(产生费用 + 需要鉴权)。单元/集成测试套件
> (`bun test`,90+ 个测试)以及 `bun run scripts/portability-check.ts` 会在离线状态下
> 覆盖其余所有内容。

---

## Codex host 实机冒烟测试

> **付费 / 需要实时网络**。以下步骤不包含在离线测试套件中。

### 安装 Codex SDK

`@openai/codex-sdk` 是 `@workflow/host-codex` 的 peer dependency,需要手动安装:

```sh
bun add @openai/codex-sdk       # 在本仓库根目录安装
# 或者在使用 host-codex 的项目中:
npm install @openai/codex-sdk
```

### 鉴权

Codex SDK 从环境变量中读取 OpenAI API key:

```sh
export OPENAI_API_KEY="sk-..."
```

### 无头运行(`workflow-run-codex`)

```sh
# 构建后直接运行(bin 在 packages/host-codex/dist/cli-runner.js)
bun packages/host-codex/dist/cli-runner.js \
  docs/spec/examples/hello.workflow.js

# 带参数:
bun packages/host-codex/dist/cli-runner.js \
  docs/spec/examples/hello.workflow.js \
  --concurrency 3 \
  --budget 100000 \
  --args '{"topic":"workflow testing"}'

# 全局安装后(bun link 或 npm link):
workflow-run-codex docs/spec/examples/hello.workflow.js
```

### 注册为 MCP 服务器(`workflow-codex-mcp`)

在 Codex 的 MCP 配置文件(`~/.codex/config.json` 或项目 `.codex/config.json`)中添加:

```json
{
  "mcpServers": {
    "workflow": {
      "command": "workflow-codex-mcp",
      "args": ["--directory", "/path/to/your/project"]
    }
  }
}
```

未全局安装时,也可直接指向已构建的入口:

```json
{
  "mcpServers": {
    "workflow": {
      "command": "node",
      "args": ["/ABS/PATH/dynamic-workflow/packages/host-codex/dist/mcp-entry.js",
               "--directory", "/path/to/your/project"]
    }
  }
}
```

MCP 服务器暴露四个工具:
- `workflow` — 运行工作流(内联脚本、文件路径或已注册名称)
- `workflow_cancel` — 按 runId 取消运行中的工作流
- `workflow_status` — 查询运行状态
- `workflow_answer` — 回答工作流中的 `question()` 挂起

### 工作流名称注册表

项目级注册表位于 `.codex/workflows/`(存放 `*.workflow.js` 文件),全局注册表位于
`~/.codex/workflows/`。注册后可按名称运行:

```sh
workflow-run-codex my-workflow-name
```
