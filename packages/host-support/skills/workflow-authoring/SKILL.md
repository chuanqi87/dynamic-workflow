---
name: workflow-authoring
description: >-
  编写或运行 workflow 脚本(`workflow` 工具 / MCP)前必读。讲清楚何时该用 workflow、
  如何扇出子 agent、parallel/pipeline/return 的契约,以及高频踩坑——独立 agent 串行 await、
  只 return 有损摘要导致结果没汇总回来、fan-out 规模与产物不匹配白烧 token。触发场景:编写/author
  一个 workflow、调用 workflow 工具、用子 agent 做编排、fan-out、parallel/pipeline、
  "workflow 起了一堆 agent 但浪费 token / 结果没汇总"。
---

# 编写与使用 workflow

`workflow` 是一个 **tool**(Claude Code 上原生、opencode 上由插件镜像、Codex 上由
`workflow-codex-mcp` MCP server 暴露)。你向它传一段 **普通 JavaScript** 脚本,脚本用注入的
全局量(`agent`/`parallel`/`pipeline`/`phase`/`log`/`workflow`/`args`/`budget`)
**确定性地编排子 agent**。脚本自己不调模型,只负责安排调用。

完整规范见仓库 `docs/spec/WORKFLOW_SCRIPT_SPEC.md`。本 skill 是面向"真正动手写一个
workflow"时的深度层,重点在**何时用**和**怎么不踩坑**。

## 何时用 workflow,何时不用

workflow 的价值在**扇出**:把一件大事拆成多个可并行的子任务,各自一个干净 context,最后汇总。
它有真实成本——**每个子 agent 都要读输入 token、写输出 token**,还有进程编排开销。所以:

- **该用**:需要并行覆盖多个文件/维度;需要独立视角做对抗式验证;单个 context 装不下的规模
  (大范围审计、迁移、调研)。
- **不该用**:一个 agent 就能答的问题;最终产物很小(比如"给我 10 行概览")却为它扇出一堆
  重型探索 agent——这是最常见的浪费,见下面踩坑 1 和 3。

一句话:**让扇出的规模匹配最终产物的体量。**

## 脚本骨架

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
// meta 之后是 async 函数体,直接用全局量,以可选的 return 结尾
phase('Review')
const files = (args && args.files) || []
const results = await pipeline(
  files,
  (_, file) => agent('Review ' + file + ' for bugs.', { schema: FINDINGS }),
  (review) => parallel((review?.findings ?? []).map((f) => () =>
    agent('对抗式验证这个 bug 是否真实: ' + f.desc, { schema: VERDICT })
      .then((v) => ({ ...f, verdict: v })))),
)
return results.flat().filter(Boolean).filter((f) => f.verdict?.real)
```

`meta` 必须是纯字面量(无变量、无函数调用、无模板插值)。

**发起 workflow 后,提示用户用宿主的实时面板/状态查询查看进度**(opencode: `/workflow` 面板;
Codex: `workflow_status` 工具)。长任务优先后台运行(`workflow` 工具传 `background: true`),
便于边跑边看进度推进。

## ⚠️ 高频踩坑(本 skill 的核心)

### 1. 独立的 agent 一定要并发,不要逐个 `await`

```js
// ❌ 反模式:四个互不依赖的探索串行跑 —— 墙钟 = 四者之和
const a = await agent('探索 src/')
const b = await agent('探索 scenarios/')
const c = await agent('探索 packages/')
const d = await agent('探索 agents/')

// ✅ 并发 —— 墙钟 ≈ 最慢的那个;并发上限 = min(16, cores-2)
const [a, b, c, d] = await parallel([
  () => agent('探索 src/'),
  () => agent('探索 scenarios/'),
  () => agent('探索 packages/'),
  () => agent('探索 agents/'),
])
```

只要后一个 agent 的 prompt 不依赖前一个的结果,就该放进 `parallel()`(纯扇出)或
`pipeline()`(每个条目多阶段)。串行 `await` 不省 token,但会把墙钟拉长好几倍。

### 2. `return` 是结果回到会话的唯一通道 —— 别只 return 有损摘要

工具回给主会话的,**只有脚本 `return` 的值**(字符串原样返回,否则 `JSON.stringify`)。
各子 agent 的中间产出只进 dashboard / journal / toast,**不会进会话**。

后果:如果你扇出 5 个 agent 产出了大量细节,却让最后一个 synthesis agent 压成"10 行概览"
再 `return overview`,那**前面所有昂贵的探索细节都被丢掉了**——你为它们付了 token,
但一点没回到会话。这正是"起了一堆 agent、结果没汇总回来"的根因。

```js
// ❌ 只回传有损摘要,昂贵的探索细节全丢
const overview = await agent('基于探索结果写 10 行概览', { ... })
return overview

// ✅ 既要摘要、也把收集到的材料一起回传
return { overview, parts: { a, b, c } }
```

并且:**脚本一定要有 `return`。** 没有 return → 结果是 `undefined`,既浪费了整轮运行,
也拿不到任何东西。

### 3. 让 fan-out 规模匹配产物

有损综合(很多详细输入 → 很小的输出)会**付两遍 token**:第一遍是各 agent 产出细节,
第二遍是 synthesis agent 把这些细节当输入再读一遍。如果你最终只要一个小摘要,要么别扇出
重型探索、用 1~2 个"务必简短"的 agent;要么就把细节一起 `return`,让这笔钱花得值。

### 4. `pipeline` 默认优先于 `parallel`

`parallel` 是**屏障**——等所有 thunk 完成才返回。`pipeline` **阶段间无屏障**,每个条目
独立流过所有阶段,快的不等慢的。多阶段处理优先 `pipeline`;只有"必须拿到全部上一阶段结果
才能继续"(例如先去重再做昂贵验证、或 0 命中就整体早退)才用 `parallel` 屏障。

### 5. 失败降级为 `null`,消费前先 `.filter(Boolean)`

`agent()` / `parallel()` / `pipeline()` 把失败(重试耗尽、被跳过、超预算)降级为 `null`
而非抛异常。带 `schema` 的结果也可能是 `null`。用之前务必过滤。

### 6. 需要据以分支的结果,用 `schema`

要对结果做 if/循环判断时,给 `agent()` 传 JSON Schema。opencode/Codex 上靠"提示 + 校验 + 重试"
或原生 `outputSchema` 强制,Claude Code 上原生强制;无论哪端你拿到的都是校验过的对象或 `null`。
纯文本摘要不要用 schema。

### 7. 确定性:禁止 `Date.now()` / `Math.random()` / 无参 `new Date()`

校验器会在运行前拒绝它们。需要时间戳/随机种子,从 `args` 传入。这是同一份脚本能缓存、
能 resume、各端表现一致的前提。

## 推荐模式

- **扇出 + 综合(正确版)**:`parallel` 并发探索 → synthesis 写概览 → `return { overview, ...细节 }`。
- **pipeline 评审**:`pipeline(items, 评审, 验证)`,每个文件评审完立刻进验证,不等别的文件。
- **对抗式验证**:对每个发现派 N 个独立"反驳者",多数确认才保留。多样视角胜过冗余。
- **循环直到枯竭**:规模未知的查找,持续派 finder 直到连续 N 轮无新增——计数器会漏尾部。
- **预算伸缩**:`const fleet = budget.total ? Math.floor(budget.total / 100000) : 5`。
  循环型一定要 `budget.total` 守卫,否则无预算时 `remaining()` 是 Infinity,会一直跑到 agent 上限。

## 复用 / resume

调用工具时传 `resume`(上一次 run id)可复用未改动的 `agent()` 结果(按 `(prompt, opts)` 命中)。
改脚本后用 `scriptPath` + `resume` 迭代:同 prompt 直接命中缓存,只重跑改动的调用。

## 自检清单(写完一个 workflow 后过一遍)

1. 互不依赖的 agent 都在 `parallel`/`pipeline` 里,没有多余的串行 `await`?
2. 有 `return`,且返回的是**需要回到会话的全部材料**,不是被压没的摘要?
3. fan-out 规模和最终产物体量相称?(小产物别配重型探索军团)
4. 所有 `parallel`/`pipeline`/`schema` 结果消费前 `.filter(Boolean)`?
5. 没有 `Date.now()`/`Math.random()`/无参 `new Date()`?
6. `meta` 是纯字面量?
