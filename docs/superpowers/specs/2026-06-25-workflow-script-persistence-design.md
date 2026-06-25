# 工作流脚本落盘 (Workflow Script Persistence)

**日期**: 2026-06-25
**范围**: `@workflow/host-opencode` only — 不进 core 契约,不进 spec。

## 背景与动机

`workflow` 工具接受三种来源的脚本:inline `script`(模型现场生成)、`scriptPath`(磁盘已有文件)、`name`(`.opencode/workflows/` 注册项)。三者都经 `resolveSource` → `runWorkflow` 执行。

今天**没有任何机制把脚本源码落盘**:只有 journal(`.workflow/<runId>.jsonl`)和 run index(`.workflow/index.jsonl`)写磁盘。这意味着模型现场生成的脚本在运行后即丢失,无法查看、修复或续跑(resume)。

Claude Code 原生 `Workflow` 工具(本项目镜像其契约)的行为是:每次调用都把脚本持久化到 session 目录,并在工具结果里返回路径,使作者可以通过 `scriptPath` + `resumeFromRunId` 改脚本后续跑。本设计为 opencode host 补齐这一行为。

## 目标

1. 把模型现场生成的 inline `script` 持久化到磁盘。
2. 在工具结果里返回脚本路径,使其可被 `scriptPath` + `resumeFromRunId` 引用续跑。

## 非目标 (YAGNI)

- 不持久化来自 `scriptPath` / `name` 的脚本——它们已在磁盘上,重复落盘只会产生冗余副本。
- 不修改 `RunIndexEntry` 增加 script 字段。
- 不引入新工具或新工具参数(无 `persist` 开关)。
- 不修改 core 运行时或 `HostAdapter` 契约;此为纯 host-opencode 行为,**不进** `WORKFLOW_SCRIPT_SPEC.md` / `SPEC_TEST_MATRIX.md`。

## 设计

### 落盘位置

```text
<project-root>/
  .workflow/
    scripts/
      <runId>.js          ← 新增:落盘的生成脚本
    index.jsonl
    <runId>.jsonl         ← 既有:journal
```

`runId = wf-<messageID>`,与 journal 命名一致,天然按运行配对。

### 新增辅助:`script-store.ts`

在 `packages/host-opencode/src/` 新建 `script-store.ts`,与 `file-journal.ts` 平级。职责单一:计算路径 + 写盘。纯函数 + 一个写入函数,副作用隔离、可独立测试。

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 生成脚本的落盘路径:<directory>/.workflow/scripts/<runId>.js */
export function scriptPath(directory: string, runId: string): string {
  return join(directory, ".workflow", "scripts", `${runId}.js`);
}

/** 将生成脚本写盘。失败不抛——落盘是尽力而为,不应让运行失败。 */
export async function persistScript(
  directory: string,
  runId: string,
  source: string,
): Promise<string | undefined> {
  const path = scriptPath(directory, runId);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, "utf8");
    return path;
  } catch {
    return undefined;
  }
}
```

错误处理与 `FileJournalSink` 一致:落盘是辅助能力,写失败时静默降级(返回 `undefined`),绝不让工作流运行本身失败。

### 接入点:`plugin-entry.ts` 的 `execute`

在 `resolveSource` 解析出 `source` 之后、调用 `runWorkflow` **之前**写盘。仅当来源是 inline `script` 时触发。

判断方式与 `resolveSource` 内部一致:`args.script != null && args.script.trim() !== ""` 即为现场生成的 inline 脚本。

时机为「校验/执行前」:即便脚本校验失败或执行报错,生成的脚本也应保留供查看/修复——这正是 resume 场景所需。

```ts
const source = await resolveSource(args, dir);
const runId = `wf-${ctx.messageID}`;

// 仅落盘现场生成的 inline 脚本(scriptPath/name 已在磁盘上)
const isInline = args.script != null && args.script.trim() !== "";
const savedScriptPath = isInline
  ? await persistScript(dir, runId, source)
  : undefined;

// ... 既有的 registration / dashboard / journal sink ...
// ... runWorkflow(...) ...
```

### 返回路径

`execute` 返回 `{ output, metadata }`(见 `plugin-entry.ts:132-142`)。两处接入,均仅当 `savedScriptPath` 存在(即 inline 且写盘成功)时生效:

1. **`output` 文本**追加一行,措辞对齐原生契约:
   > Script saved to `<savedScriptPath>`. To iterate, edit it and re-run with `scriptPath` + `resume` (run id `<runId>`).

   注:opencode host 的 resume 参数名是 `resume`(映射到 core 的 `resumeFromRunId`,见 `plugin-entry.ts:70-73,115`),措辞用 `resume` 以匹配实际工具参数。

2. **`metadata`** 增加 `scriptPath: savedScriptPath` 字段,便于程序化读取。

`savedScriptPath` 不存在时,`output` / `metadata` 与现状一致。

## 数据流

```text
args.script (inline, 模型生成)
  → resolveSource → source: string
  → [isInline?] persistScript(dir, runId, source) → .workflow/scripts/<runId>.js
  → runWorkflow(source, …) 执行
  → execute 返回结果 + "Script saved to <path>" 行
```

## 错误处理

- 落盘失败:`persistScript` 捕获并返回 `undefined`,运行继续,结果不含 saved 行。
- 校验/执行失败:脚本已在 `runWorkflow` 之前落盘,故失败仍保留脚本,符合 resume 预期。

## 测试

在 `packages/host-opencode/src/` 新建 `script-store.test.ts`(离线、临时目录):

1. **inline 落盘**:给定 `directory` / `runId` / `source`,调用 `persistScript` 后 `.workflow/scripts/<runId>.js` 存在,且内容 `===` 原始 source。
2. **路径计算**:`scriptPath(dir, runId)` 返回预期的 `<dir>/.workflow/scripts/<runId>.js`。
3. **目录自动创建**:`scripts/` 子目录不存在时自动 `mkdir -p`。
4. **写失败降级**:对一个不可写路径(如 directory 指向一个文件),`persistScript` 返回 `undefined` 且不抛。

接入层断言(`run-manager.test.ts` 或现有 plugin 测试中,若已有覆盖 `execute` 的测试):
5. **来源区分**:来自 `scriptPath` 的运行不在 `.workflow/scripts/` 产生新文件(仅 inline 落盘)。

## 受影响文件

| 文件 | 改动 |
|------|------|
| `packages/host-opencode/src/script-store.ts` | 新建:`scriptPath` + `persistScript` |
| `packages/host-opencode/src/plugin-entry.ts` | `execute` 中接入落盘 + 返回路径 |
| `packages/host-opencode/src/script-store.test.ts` | 新建:单元测试 |
