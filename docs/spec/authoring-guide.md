# 编写指南

编写可移植工作流脚本的实用指引。规范性的规则请参见
[WORKFLOW_SCRIPT_SPEC.md](./WORKFLOW_SCRIPT_SPEC.md);面向"动手写一个 workflow"的深度层与
踩坑清单见 opencode skill `workflow-authoring`
(`packages/host-opencode/skills/workflow-authoring/SKILL.md`,随插件发布、由 `config` 钩子
注册进 opencode)。本文件、该 skill、以及嵌入工具描述的
`packages/host-opencode/src/authoring-guide.ts` 三者内容应保持一致,改其一时同步另两处。

## 心智模型

工作流是一个确定性的*编排器*。你编写普通 JS,调用 `agent()` 把工作委派给子代理,
并用 `parallel()` / `pipeline()` 把这些工作扇出。脚本本身不发起任何模型调用——
它只负责安排这些调用。

## 反模式(最容易浪费 token / 结果没汇总)

**独立的 agent 一定要并发。** 互不依赖的 `agent()` 不要逐个 `await`——那不省 token,
只会把墙钟拉长成"各 agent 之和"。放进 `parallel()`(纯扇出)或 `pipeline()`(每条目多阶段),
并发上限为 `min(16, cores-2)`。

**`return` 是结果回到会话的唯一通道。** 工具只把脚本 `return` 的值回传给会话;各子 agent 的
中间产出只进 dashboard / journal,不进会话。若扇出多个 agent 产出大量细节、却只 `return` 一个
被压缩的小摘要,那些昂贵细节就白烧了。要回传**收集到的材料**,而不仅是有损摘要;且脚本务必有
`return`(无 return → 结果为 `undefined`)。

**让 fan-out 规模匹配产物。** 有损综合(大量详细输入 → 很小输出)会付两遍 token——一遍产出
细节、一遍把细节当输入再读。产物很小就别配重型探索军团。

## 模式

**默认使用 pipeline。**当各阶段对每个条目而言相互独立时,优先使用
`pipeline()` 而非 `parallel()`——条目无屏障地流经各阶段,因此快的条目不必等待
慢的条目。

```js
const results = await pipeline(
  files,
  (_, file) => agent(`Review ${file}`, { schema: FINDINGS }),
  (review) => parallel((review?.findings ?? []).map((f) => () =>
    agent(`Verify: ${f.issue}`, { schema: VERDICT }).then((v) => ({ ...f, verdict: v })))),
);
```

**对抗式验证。**对于你将据以采取行动的发现,派出多个独立的验证者,只保留多数
确认的那些。多样性(不同的审视视角)胜过冗余。

**循环直到枯竭。**对于规模未知的发现任务,持续派出查找者,直到连续 N 轮都没有
新东西浮现为止——单纯的计数器会漏掉尾部。

**结构化输出。**对任何你需要据以分支的内容传入 `schema`。在 opencode 上,schema 通过
提示指令 + 校验 + 重试来强制执行;在 Claude Code 上则由原生强制执行。无论哪种方式,
你的脚本看到的都是一个经过校验的对象或 `null`。

## 确定性

绝不要调用 `Date.now()`、`Math.random()`,或不带参数的 `new Date()`——校验器会
拒绝它们。如果工作流需要种子或时间戳,通过 `args` 传入并从那里读取。正是这一点
让同一份脚本能够缓存、恢复,并在两个宿主上表现完全一致。

## null 处理

`agent()`、`parallel()` 和 `pipeline()` 会把失败降级为 `null` 而非抛出异常。
在消费它们的结果之前,务必先 `.filter(Boolean)`,并把 schema 约束的结果当作
可能为 `null` 来对待。

## 预算感知的伸缩

当某次运行设有 token 预算时,据此伸缩你的扇出规模:

```js
const fleet = budget.total ? Math.floor(budget.total / 100000) : 5;
```
