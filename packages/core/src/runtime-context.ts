import {
  LIMITS,
  type Budget,
  type QuestionOpts,
  type WorkflowGlobals,
  type WorkflowMeta,
} from "./types.js";
import type { AgentRunner } from "./agent-runner.js";
import type { ProgressReporter } from "./progress-reporter.js";
import { currentFrames, runInFrame } from "./orchestration-context.js";

function assertBatch(kind: "parallel" | "pipeline", n: number): void {
  if (n > LIMITS.MAX_BATCH) {
    throw new Error(`${kind}() received ${n} items; the limit is ${LIMITS.MAX_BATCH}`);
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A barrier: await all thunks; a throwing/failed thunk resolves to null. */
export async function parallel(
  thunks: Array<() => Promise<unknown>>,
  onDrop?: (index: number, reason: string) => void,
  allocGroupId?: () => string,
): Promise<unknown[]> {
  assertBatch("parallel", thunks.length);
  const groupId = allocGroupId?.();
  const parentId = currentFrames().at(-1)?.groupId;
  // No semaphore here — concurrency is governed inside agent(). Wrapping a bare
  // agent() in a thunk must not double-queue.
  return Promise.all(
    thunks.map((t, i) =>
      Promise.resolve()
        .then(() =>
          groupId
            ? runInFrame({ kind: "parallel", groupId, parentId, index: i }, () => t())
            : t(),
        )
        .catch((err) => {
          onDrop?.(i, reason(err));
          return null;
        }),
    ),
  );
}

/**
 * Run each item independently through all stages with NO barrier between
 * stages. A stage that throws drops that item to null and skips the rest.
 * Stage signature: (prevResult, originalItem, index).
 */
export async function pipeline(
  items: unknown[],
  ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
): Promise<unknown[]> {
  return pipelineWith(items, undefined, stages);
}

async function pipelineWith(
  items: unknown[],
  onDrop: ((index: number, reason: string) => void) | undefined,
  stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>,
  allocGroupId?: () => string,
): Promise<unknown[]> {
  assertBatch("pipeline", items.length);
  const groupId = allocGroupId?.();
  const parentId = currentFrames().at(-1)?.groupId;
  return Promise.all(
    items.map(async (item, index) => {
      let prev: unknown = item;
      try {
        for (let k = 0; k < stages.length; k++) {
          const stage = stages[k]!;
          prev = groupId
            ? await runInFrame(
                { kind: "pipeline", groupId, parentId, index, stageIndex: k },
                () => stage(prev, item, index),
              )
            : await stage(prev, item, index);
        }
        return prev;
      } catch (err) {
        onDrop?.(index, reason(err));
        return null;
      }
    }),
  );
}

export interface GlobalsDeps {
  runner: AgentRunner;
  reporter: ProgressReporter;
  budget: Budget;
  args: unknown;
  meta: WorkflowMeta;
  /** Mutable holder for the current phase title (drives phase-default model). */
  phaseRef: { current?: string };
  /** Nested workflow runner; throws if nesting depth is exceeded. */
  workflow: (nameOrRef: string | { scriptPath: string }, args?: unknown) => Promise<unknown>;
  /** Host-in-the-loop question resolver. */
  question: (prompt: string, opts?: QuestionOpts) => Promise<string | null>;
  /** Allocate a deterministic group id for the next parallel/pipeline call. */
  allocGroupId: () => string;
}

/** Assemble the ambient globals injected into a workflow script body. */
export function buildGlobals(deps: GlobalsDeps): WorkflowGlobals & { meta: WorkflowMeta } {
  return {
    agent: deps.runner.run,
    parallel: (thunks) =>
      parallel(
        thunks,
        (index, r) => deps.reporter.dropFromBatch("parallel", index, r),
        deps.allocGroupId,
      ),
    pipeline: (items, ...stages) =>
      pipelineWith(
        items,
        (index, r) => deps.reporter.dropFromBatch("pipeline", index, r),
        stages,
        deps.allocGroupId,
      ),
    phase: (title: string) => {
      deps.phaseRef.current = title;
      deps.reporter.phase(title);
    },
    log: (message: string) => deps.reporter.log(message),
    workflow: deps.workflow,
    question: deps.question,
    args: deps.args,
    budget: deps.budget,
    meta: deps.meta,
  };
}
