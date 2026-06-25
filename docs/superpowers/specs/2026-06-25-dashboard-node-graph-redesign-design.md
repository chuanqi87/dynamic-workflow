# 设计:节点图式现代 Dashboard 改造

- 日期:2026-06-25
- 状态:已审阅待批准
- 范围:`@workflow/host-opencode` 的 dashboard(opencode-only,**不属于可移植性契约**)+ `@workflow/core` 的一处增量遥测改动

## 1. 背景与目标

当前 dashboard([packages/host-opencode/src/dashboard/ui.ts](../../../packages/host-opencode/src/dashboard/ui.ts))是一段自包含的 HTML 字符串:等宽字体、GitHub-dark 配色、三栏网格(运行列表 · 按 phase 分组的 agent 列表 · 对话),整体是"终端感"很重的 TUI 风格。

用户目标(两点):

1. **现代前端视觉**:摆脱纯等宽终端感,换成现代 Web 应用审美。
2. **节点图可视化**:把当前 workflow 以**节点图**呈现,每个节点显示状态,点击查看详情。

### 已确定的关键取舍(brainstorm 结论)

| 维度 | 选择 |
| --- | --- |
| 技术路线 | 引入前端构建:**React + Vite + React Flow** |
| 图精度 | **真实依赖 DAG**(需增强 core 事件) |
| 布局 | **图为主 + 右侧详情抽屉**,运行列表收左侧 |
| 视觉风格 | **清爽浅色**(system-ui / Inter、卡片、柔和阴影) |
| 构建接线 | `bun run build` = `tsc -b` 先跑 → 再 `vite build`,一条命令出全部产物 |

## 2. 现状数据模型(约束来源)

进度事件 [packages/core/src/types.ts](../../../packages/core/src/types.ts) 的 `ProgressEvent`:

```
run-start | phase | log | agent-start(label, phase?, sessionId?)
| agent-done | agent-null | agent-retry | dropped | run-end | warning
```

只能推出 `run → 有序 phase → phase 内 agent`,**没有 agent 之间的依赖边**。

`parallel(thunks)` 与 `pipeline(items, ...stages)`([packages/core/src/runtime-context.ts](../../../packages/core/src/runtime-context.ts))接收的是**不透明闭包**——运行时不知道闭包内部调了哪个 `agent()`(`agent()` 是 `deps.runner.run`,在用户闭包里被调用)。因此要给 agent 节点打"它属于哪个 parallel/pipeline、第几阶段"的标签,**不能靠 parallel/pipeline 传参**,必须用**环境上下文**在编排时埋帧、`agent()` 发事件时读取。

## 3. 架构总览

```
packages/host-opencode/
  web/                              ← 新增:Vite + React + React Flow 前端工程(独立 tsconfig)
    index.html
    vite.config.ts
    tsconfig.json                   ← bundler 解析,独立于 core 的 NodeNext tsc -b 图
    src/
      main.tsx
      AppShell.tsx                  ← 浅色主题外壳 + 布局
      TopBar.tsx
      RunsRail.tsx
      GraphCanvas.tsx               ← React Flow + dagre
      NodeDrawer.tsx
      nodes/                        ← 自定义节点/分组节点组件
      buildGraph.ts                 ← 纯函数:RunView → {nodes, edges}(可离线单测)
      buildGraph.test.ts
      api.ts                        ← SSE / fetch 封装
      theme.css                     ← 浅色设计令牌(CSS 变量)
  dashboard-dist/                   ← vite 构建产物(随包发布;加入 package.json files)
  src/dashboard/server.ts           ← 改:静态文件服务 + 保留全部 /api 与 SSE
  src/dashboard/ui.ts               ← 改:退化为"未构建"占位页(或删除)
packages/core/src/
  orchestration-context.ts          ← 新增:AsyncLocalStorage 帧栈 + group 计数器
  runtime-context.ts                ← 改:parallel/pipeline 埋帧
  agent-runner.ts                   ← 改:agent-start 带出 group 元数据
  types.ts                          ← 改:agent-start 增加可选 group 字段
packages/spec/                      ← 改:契约说明 + 测试矩阵
```

数据通道完全复用现有接口,**不新增网络端点**:`/api/runs`、`/api/runs/:id`、`/api/runs/:id/stream`(run 快照 SSE)、`/api/sessions/:id/stream`(对话 SSE)、`/api/runs/:id/cancel`、`/api/runs/:id/answer`。改动只是让 RunView 里的 agent 多带 group 字段。

## 4. Core 增强:让"真实依赖"可被捕获

### 4.1 新模块 `orchestration-context.ts`

- 一个模块级 `AsyncLocalStorage<Frame[]>`(帧栈,栈顶为最内层 group)。
- 帧类型:
  - `{ kind: "parallel", groupId: string, parentId?: string, index: number }`
  - `{ kind: "pipeline", groupId: string, parentId?: string, itemIndex: number, stageIndex: number }`
- **确定性 group id**:由一个计数器生成(如 `g1`、`g2`…),计数器随 `SharedState` 走。**不使用** `Math.random()` / `Date.now()`(被 portability-validator 禁止,且破坏 resume 确定性)。脚本同序重放 → 同 id。
- 导出:`runInFrame(frame, fn)`(`als.run([...current, frame], fn)`)与 `currentFrames()`(`als.getStore() ?? []`)。

> `import { AsyncLocalStorage } from "node:async_hooks"` 出现在 **core 源码**中,不在用户脚本中——portability-validator 只约束用户脚本,core 由 tsc 正常编译,Node/Bun 均支持。

### 4.2 `runtime-context.ts` 埋帧

- `parallel`:每个 thunk 在 `runInFrame({kind:"parallel", groupId, parentId, index:i}, () => t())` 内执行。
- `pipeline`:每个 stage 调用在 `runInFrame({kind:"pipeline", groupId, parentId, itemIndex:index, stageIndex:k}, () => stage(...))` 内执行。
- `groupId` 由计数器在**进入 parallel/pipeline 调用时**分配一次(整组共享);`parentId` 取进入时栈顶帧的 `groupId`。AsyncLocalStorage 天然支持嵌套(parallel-in-pipeline 等)。

### 4.3 `agent-runner.ts` 读帧

- `AgentRunner.run` 发 `agent-start` 前调用 `currentFrames()`,把派生的 group 信息塞进事件:
  ```ts
  group?: {
    id: string;            // 最内层 groupId
    kind: "parallel" | "pipeline";
    parentId?: string;     // 外层 groupId(嵌套时)
    index: number;         // parallel: thunk 下标;pipeline: itemIndex
    stageIndex?: number;   // 仅 pipeline
  }
  ```
- 顶层(无 parallel/pipeline)`agent()` → `currentFrames()` 为空 → 不带 group → 图中为独立节点。

### 4.4 `types.ts` 契约改动(纯增量)

`agent-start` 事件加一个**可选** `group?` 字段(结构同上)。全部可选 →

- 向后兼容,Claude Code 原生运行时不发该字段不受影响;
- **脚本面向的契约(globals / sandbox / 确定性规则)零改动**;
- 不进 journal key,**resume 不受影响**(纯遥测)。

### 4.5 spec 同步

[WORKFLOW_SCRIPT_SPEC.md](../../../packages/spec/WORKFLOW_SCRIPT_SPEC.md) 与 [SPEC_TEST_MATRIX.md](../../../packages/spec/SPEC_TEST_MATRIX.md) 增加一节,明确:`agent-start.group` 是 **host 内部遥测**、**非脚本可见**、可选;并登记对应回归测试。

## 5. 图模型:`buildGraph(run): { nodes, edges }`(纯函数)

输入 `RunView`(已带 group 字段的 agents),输出 React Flow 的 nodes/edges。规则:

- **Phase = 有序泳道**:按 `run.phases` 顺序从左到右,作为 workflow 叙事主轴(泳道用带标签的背景区块呈现)。
- **Group 容器节点**:每个 `groupId` 一个分组框,使用 React Flow 嵌套父节点;支持 `parentId` 嵌套。
- **Agent 节点**:挂在所属 group 下;无 group 的挂在所属 phase 下。
- **真实依赖边**:
  - *pipeline*:同 `groupId` 同 `itemIndex`,`stageIndex k → k+1`(真实数据依赖:下一阶段消费上一阶段结果)。
  - *parallel*:`spawn 锚点 → 各子节点 → join 锚点`(parallel 是 barrier,join 是真实汇聚点)。
  - *块间*:相邻 phase / 块按顺序串接。
- **布局**:用 `dagre` 做有向分层(rank 方向与 phase 主轴一致),React Flow 提供 pan / zoom / minimap / controls。
- 纯函数、无副作用 → 可离线单测(`buildGraph.test.ts`)。

## 6. 前端(清爽浅色)

- **栈**:Vite + React + TypeScript + `@xyflow/react` + `dagre`;字体 system-ui / Inter。
- **设计令牌**(`theme.css`,CSS 变量):浅色底、卡片、柔和阴影、单一 accent 色;状态语义色——
  - running:蓝(脉冲动画) · done:绿 · null/failed:红 · retrying:琥珀 · pending:石板灰
- **组件**:
  - `TopBar`:run 名 + 状态徽标 + cancel 按钮 + `pendingQuestion` 提问区(复用 `/answer`)。
  - `RunsRail`(左):运行列表,实时刷新(沿用 `/api/runs` 轮询或快照)。
  - `GraphCanvas`(主):自定义节点类型,卡片化,显示 label / tokens / retries,按状态着色;分组框带 phase/parallel/pipeline 标识。
  - `NodeDrawer`(右抽屉):点节点滑出——状态、tokens、cost、retries、nullReason + 该 session 的实时对话(复用 `/api/sessions/:id/stream`)。
- **实时数据**:`api.ts` 封装现有 SSE/JSON;run 快照驱动图与列表,session 流驱动抽屉对话。

## 7. Server 改造([server.ts](../../../packages/host-opencode/src/dashboard/server.ts))

- 把单一 `DASHBOARD_HTML` 路由换成**静态文件处理器**:
  - 服务 `dashboard-dist/` 下的 `index.html` 与带 hash 的资源,按扩展名设 content-type;路径相对编译后文件位置(`import.meta.url`)定位。
  - 非 `/api` 的未命中路径回退 `index.html`(SPA fallback)。
- `/api/*` 与 SSE 路由**全部保持不变**。
- **优雅降级**:`dashboard-dist/` 缺失(纯 dev 未构建)时,返回最简占位页,提示运行 `bun run build:dashboard`。
- [ui.ts](../../../packages/host-opencode/src/dashboard/ui.ts) 的大 HTML 字符串退化为该占位页(或删除,占位页内联在 server 中)。

## 8. 构建接线

- **host 包 `package.json`**:
  - 加 devDeps:`vite`、`@vitejs/plugin-react`、`react`、`react-dom`、`@xyflow/react`、`dagre`、相应 `@types/*`。
  - 加脚本:`"build:dashboard": "vite build"`(产物输出 `dashboard-dist/`);`"build"` 改为 `tsc -p tsconfig.json && vite build`。
  - `files` 加入 `dashboard-dist`。
- **根 `package.json`**:`"build"` 改为先 `tsc -b`(typecheck 把关)再触发 dashboard 构建,使一条命令产出全部。`typecheck` 仍是纯 `tsc -b`。
- **web 工程独立 tsconfig**(bundler 解析、`jsx: react-jsx`),**不进** core 的 NodeNext `tsc -b` 项目引用图,避免污染严格 Node ESM 构建。

## 9. 测试

- **新增**:
  - `buildGraph.test.ts`:RunView(含各种 group 组合)→ 期望 nodes/edges。
  - core 编排上下文单测:`parallel` / `pipeline`(含嵌套)下 `agent-start` 带正确 `group`;顶层 agent 不带。
- **更新**:[server.test.ts](../../../packages/host-opencode/src/dashboard/server.test.ts) / [dashboard.test.ts](../../../packages/host-opencode/src/dashboard/dashboard.test.ts) 中"页面包含 `Workflow Dashboard`"的断言改为匹配静态页/占位页;[SPEC_TEST_MATRIX.md](../../../packages/spec/SPEC_TEST_MATRIX.md) 登记新增遥测字段的回归项。
- 前端组件交互测试不在本次范围(仓库未配 React 测试运行器);可测逻辑全部下沉到纯函数 `buildGraph`,由 bun 覆盖。

## 10. 范围边界与已知限制

- **范围外(YAGNI)**:不做图编辑 / workflow 编排;无新增持久化;仅浅色单主题(不做暗色 / 主题切换)。
- **已知限制(沿用现状)**:
  - 历史运行(从 `RunIndex` 导入)`agents: []`,图为空、仅显示 summary;
  - 历史对话不在内存,抽屉对话仅对在内存的活跃运行可用。

## 11. 实现阶段划分(供后续 plan 参考)

1. Core:`orchestration-context.ts` + 埋帧 + `agent-start.group` + 单测 + spec 同步。
2. Server:静态文件服务 + 降级占位 + 测试更新。
3. Web 工程脚手架:Vite/React/tsconfig + 构建接线(根 + host 包)。
4. `buildGraph` 纯函数 + 单测。
5. 前端组件:AppShell / TopBar / RunsRail / GraphCanvas(+dagre)/ NodeDrawer + 浅色主题。
6. 端到端连通(SSE → 图 → 抽屉)与人工冒烟([INSTALL.md](../../../INSTALL.md))。
