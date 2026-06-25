import type {
  AgentOpts,
  AgentTypeMap,
  EffortMap,
  HostAgentInfo,
  ModelMap,
} from "./types.js";

export interface MapperConfig {
  modelMap?: ModelMap;
  effortMap?: Partial<EffortMap>;
  agentTypeMap?: AgentTypeMap;
  defaultModel?: string;
  /** `meta.model`, used as a fallback below opts but above defaultModel. */
  metaModel?: string;
  /** Resolves the current phase's `meta.phases[].model`, if any. */
  phaseModelResolver?: () => string | undefined;
}

export interface ResolvedAgent {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

/** Sensible effort → logical-model tiers; only effective if modelMap defines them. */
const DEFAULT_EFFORT_MAP: EffortMap = {
  low: "haiku",
  medium: "sonnet",
  high: "opus",
  xhigh: "opus",
  max: "opus",
};

/**
 * Resolves logical workflow options (`model: "opus"`, `effort: "high"`,
 * `agentType: "reviewer"`) into concrete opencode parameters.
 *
 * Default behaviour is to inherit the host session's model: when nothing
 * resolves, `model` is left undefined so the host decides.
 */
export class ModelAgentMapper {
  private agentsCache: Promise<HostAgentInfo[]> | undefined;

  constructor(
    private readonly config: MapperConfig,
    private readonly listAgents: () => Promise<HostAgentInfo[]>,
  ) {}

  async resolve(opts: AgentOpts | undefined): Promise<ResolvedAgent> {
    const agent = await this.resolveAgent(opts?.agentType);
    const agentInfo = agent ? await this.findAgent(agent) : undefined;

    // If the resolved subagent carries its own model, prefer it unless the
    // script explicitly overrode the model.
    const model = this.resolveModel(opts, agentInfo);
    return { model, agent };
  }

  private resolveModel(
    opts: AgentOpts | undefined,
    agentInfo: HostAgentInfo | undefined,
  ): { providerID: string; modelID: string } | undefined {
    if (opts?.model) {
      const m = this.resolveModelString(opts.model);
      if (m) return m;
    }
    if (agentInfo?.model) return agentInfo.model;
    if (opts?.effort) {
      const map = { ...DEFAULT_EFFORT_MAP, ...this.config.effortMap };
      const logical = map[opts.effort];
      const m = logical ? this.resolveModelString(logical) : undefined;
      if (m) return m;
    }
    const phaseModel = this.config.phaseModelResolver?.();
    if (phaseModel) {
      const m = this.resolveModelString(phaseModel);
      if (m) return m;
    }
    if (this.config.metaModel) {
      const m = this.resolveModelString(this.config.metaModel);
      if (m) return m;
    }
    if (this.config.defaultModel) {
      const m = this.resolveModelString(this.config.defaultModel);
      if (m) return m;
    }
    return undefined; // inherit host session model
  }

  /** Accept either "provider/model-id" or a logical name from modelMap. */
  resolveModelString(name: string): { providerID: string; modelID: string } | undefined {
    const slash = name.indexOf("/");
    if (slash > 0) {
      return { providerID: name.slice(0, slash), modelID: name.slice(slash + 1) };
    }
    return this.config.modelMap?.[name];
  }

  private async resolveAgent(agentType: string | undefined): Promise<string | undefined> {
    if (!agentType) return undefined;
    const mapped = this.config.agentTypeMap?.[agentType];
    if (mapped) return mapped;
    // Pass through only if the host actually has an agent by that name.
    return (await this.findAgent(agentType)) ? agentType : undefined;
  }

  private async findAgent(name: string): Promise<HostAgentInfo | undefined> {
    this.agentsCache ??= this.listAgents();
    const agents = await this.agentsCache;
    return agents.find((a) => a.name === name);
  }
}
