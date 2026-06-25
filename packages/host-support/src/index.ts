// Barrel export for the shared host-support surface. Populated as modules move in.
export { RunIndex, indexPath } from "./dashboard/run-index.js";
export type { RunIndexEntry, IndexStatus } from "./dashboard/run-index.js";
export { FileJournalSink, journalPath, fileJournalSource } from "./file-journal.js";
export { scriptPath, persistScript } from "./script-store.js";
export { autoConcurrency } from "./concurrency.js";
