// Barrel export for the shared host-support surface. Populated as modules move in.
export { RunIndex, indexPath } from "./dashboard/run-index.js";
export type { RunIndexEntry, IndexStatus } from "./dashboard/run-index.js";
export { FileJournalSink, journalPath, fileJournalSource } from "./file-journal.js";
export { scriptPath, persistScript } from "./script-store.js";
export { autoConcurrency } from "./concurrency.js";
export { DashboardServer } from "./dashboard/server.js";
export type { DashboardServerOptions } from "./dashboard/server.js";
export { RunRegistry } from "./dashboard/run-registry.js";
export type {
  RunView,
  AgentView,
  RunStatus,
  AgentStatus,
  HistoryEntry,
  RegistryChange,
} from "./dashboard/run-registry.js";
export { TranscriptStore } from "./dashboard/transcript-store.js";
export type { TranscriptDelta, TranscriptMessage } from "./dashboard/transcript-store.js";
export { buildGraph } from "./dashboard/buildGraph.js";
export type { GraphRun, GraphAgent, GraphNode, GraphEdge } from "./dashboard/buildGraph.js";
export { RunManager } from "./run-manager.js";
export type { RunManagerOptions } from "./run-manager.js";
export { createWorktree } from "./worktree.js";
export { resolveSourceFrom } from "./resolve-source.js";
export type { SourceInput } from "./resolve-source.js";
export { shortHash, isCliEntry, parseArgv } from "./cli-helpers.js";
export type { ParsedArgs } from "./cli-helpers.js";
