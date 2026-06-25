import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One orchestration frame: where an agent() call sits relative to the
 * parallel/pipeline that spawned it. Pure telemetry — never affects results,
 * the journal key, or resume. Only the opencode dashboard consumes it.
 */
export interface Frame {
  kind: "parallel" | "pipeline";
  /** Stable id of the nearest parallel/pipeline call (deterministic counter). */
  groupId: string;
  /** groupId of the enclosing group, when nested. */
  parentId?: string;
  /** parallel: thunk index; pipeline: item index. */
  index: number;
  /** pipeline only: which stage produced this agent. */
  stageIndex?: number;
}

const store = new AsyncLocalStorage<Frame[]>();

/** The frame stack for the current async context (outermost first). */
export function currentFrames(): Frame[] {
  return store.getStore() ?? [];
}

/** Run `fn` with `frame` pushed onto the current stack. */
export function runInFrame<T>(frame: Frame, fn: () => T): T {
  return store.run([...currentFrames(), frame], fn);
}
