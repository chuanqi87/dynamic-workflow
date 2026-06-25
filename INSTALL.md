# 安装与实机冒烟测试(opencode)

## 构建

```sh
bun install
bun run build          # tsc -b → packages/*/dist
```

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
- 运行某个工作流时会弹出带有仪表盘 URL 的 toast。

## 实机冒烟测试(真实模型)

无头、无聊天:

```sh
# 在仓库中运行(使用内嵌的 opencode 服务器)
bun packages/host-opencode/dist/cli-runner.js \
  packages/spec/examples/hello.workflow.js --concurrency 3
```

在 TUI 中,让代理用 `scriptPath: packages/spec/examples/hello.workflow.js` 运行
workflow 工具,然后从 toast 中打开仪表盘 URL,实时观看进度树以及每个代理的对话。

> 实机运行会发起真实的模型调用(产生费用 + 需要鉴权)。单元/集成测试套件
> (`bun test`,90+ 个测试)以及 `bun run scripts/portability-check.ts` 会在离线状态下
> 覆盖其余所有内容。
