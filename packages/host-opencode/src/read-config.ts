import type { RuntimeConfig } from "@workflow/core";

/**
 * Translate opencode plugin options (from `opencode.json`) into a
 * {@link RuntimeConfig}. All fields are optional; unknown values are ignored.
 *
 * Example opencode.json:
 *   "plugin": [["@workflow/host-opencode", {
 *     "concurrency": 3,
 *     "budgetTotal": 500000,
 *     "modelMap": { "opus": { "providerID": "anthropic", "modelID": "claude-opus-4-8" } },
 *     "agentTypeMap": { "Explore": "explore", "general-purpose": "general" }
 *   }]]
 */
export function readConfig(options: Record<string, unknown>): RuntimeConfig {
  const cfg: RuntimeConfig = {};
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  cfg.concurrency = num(options.concurrency);
  cfg.budgetTotal = options.budgetTotal === null ? null : num(options.budgetTotal);
  cfg.agentTimeoutMs = num(options.agentTimeoutMs);
  cfg.schemaRetries = num(options.schemaRetries);
  if (typeof options.defaultModel === "string") cfg.defaultModel = options.defaultModel;
  if (isRecord(options.modelMap)) cfg.modelMap = options.modelMap as RuntimeConfig["modelMap"];
  if (isRecord(options.effortMap)) cfg.effortMap = options.effortMap as RuntimeConfig["effortMap"];
  if (isRecord(options.agentTypeMap)) {
    cfg.agentTypeMap = options.agentTypeMap as RuntimeConfig["agentTypeMap"];
  }

  // Drop undefined keys so RuntimeConfig defaults apply cleanly.
  for (const k of Object.keys(cfg) as Array<keyof RuntimeConfig>) {
    if (cfg[k] === undefined) delete cfg[k];
  }
  return cfg;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
