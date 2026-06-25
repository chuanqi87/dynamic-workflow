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
  if (options.replay === "keyed" || options.replay === "prefix") cfg.replay = options.replay;
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

/** Host-only per-agent tool control (not part of the portable RuntimeConfig). */
export interface AgentToolConfig {
  /** Tool enable/disable applied to every sub-agent prompt. */
  defaultTools?: Record<string, boolean>;
  /** Per-agent-name tool enable/disable, merged over {@link defaultTools}. */
  agentTools?: Record<string, Record<string, boolean>>;
}

/** Coerce a record to `{ [tool]: boolean }`, dropping non-boolean entries. */
function toolMap(v: unknown): Record<string, boolean> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "boolean") out[k] = val;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse opencode plugin options into per-agent tool control. opencode runs each
 * sub-agent with the tools its agent type configures; this only narrows that set
 * per run. There is no equivalent of Claude Code's on-demand ToolSearch.
 *
 * Example opencode.json:
 *   "defaultTools": { "write": false },
 *   "agentTools": { "Explore": { "write": false, "edit": false } }
 */
export function readToolConfig(options: Record<string, unknown>): AgentToolConfig {
  const cfg: AgentToolConfig = {};
  const def = toolMap(options.defaultTools);
  if (def) cfg.defaultTools = def;
  if (isRecord(options.agentTools)) {
    const per: Record<string, Record<string, boolean>> = {};
    for (const [agent, map] of Object.entries(options.agentTools)) {
      const tm = toolMap(map);
      if (tm) per[agent] = tm;
    }
    if (Object.keys(per).length > 0) cfg.agentTools = per;
  }
  return cfg;
}
