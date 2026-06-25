import { cpus } from "node:os";

/** Default concurrency mirrors Claude Code: min(16, cores - 2), floor 1. */
export function autoConcurrency(): number {
  const cores = cpus().length || 4;
  return Math.min(16, Math.max(1, cores - 2));
}
