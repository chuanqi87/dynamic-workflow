/**
 * Pure projection of a run snapshot into a node/edge graph for the dashboard.
 * Decoupled from React Flow and from RunView: it takes only the structural
 * subset it needs, so it stays in the offline test suite. Deterministic.
 */

export interface GraphAgent {
  sessionId?: string;
  label: string;
  phase?: string;
  status: "running" | "done" | "null" | "retrying";
  tokens?: number;
  retries: number;
  nullReason?: string;
  group?: { id: string; kind: "parallel" | "pipeline"; parentId?: string; index: number; stageIndex?: number };
}

export interface GraphRun {
  phases: string[];
  agents: GraphAgent[];
}

export interface GraphNode {
  id: string;
  type: "agent" | "group" | "phase";
  label: string;
  parentId?: string;
  status?: GraphAgent["status"];
  sessionId?: string;
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

const phaseId = (title: string): string => `phase:${title}`;
const groupId = (gid: string): string => `group:${gid}`;

export function buildGraph(run: GraphRun): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // 1) Phase nodes, in order, chained along the spine.
  const phases = run.phases.length > 0 ? run.phases : agentPhases(run.agents);
  phases.forEach((title, i) => {
    nodes.push({ id: phaseId(title), type: "phase", label: title, data: { order: i } });
    const prev = phases[i - 1];
    if (prev !== undefined) {
      edges.push({ id: `e:${phaseId(prev)}->${phaseId(title)}`, source: phaseId(prev), target: phaseId(title) });
    }
  });
  const phaseSet = new Set(phases);
  const fallbackPhase = phases[0];

  const parentOfAgent = (a: GraphAgent): string | undefined => {
    if (a.group) return groupId(a.group.id);
    if (a.phase && phaseSet.has(a.phase)) return phaseId(a.phase);
    return fallbackPhase !== undefined ? phaseId(fallbackPhase) : undefined;
  };

  // 2) Group nodes — one per distinct group id, including referenced parents.
  const groupMeta = new Map<string, { kind?: "parallel" | "pipeline"; parentId?: string; phase?: string }>();
  for (const a of run.agents) {
    const g = a.group;
    if (!g) continue;
    if (!groupMeta.has(g.id)) groupMeta.set(g.id, {});
    const m = groupMeta.get(g.id)!;
    m.kind ??= g.kind;
    m.parentId ??= g.parentId;
    m.phase ??= a.phase;
    if (g.parentId && !groupMeta.has(g.parentId)) groupMeta.set(g.parentId, {});
  }
  for (const [gid, m] of groupMeta) {
    const parent =
      m.parentId !== undefined
        ? groupId(m.parentId)
        : m.phase && phaseSet.has(m.phase)
          ? phaseId(m.phase)
          : fallbackPhase !== undefined
            ? phaseId(fallbackPhase)
            : undefined;
    nodes.push({
      id: groupId(gid),
      type: "group",
      label: m.kind ?? "group",
      parentId: parent,
      data: { kind: m.kind },
    });
  }

  // 3) Agent nodes. Use a Map to track nodeId per agent instance (avoids mutation).
  const agentNodeId = (a: GraphAgent, seq: number): string =>
    a.sessionId ? `agent:${a.sessionId}` : `agent:${a.phase ?? ""}:${a.label}:${seq}`;

  const agentIds = new Map<GraphAgent, string>();
  run.agents.forEach((a, seq) => {
    const id = agentNodeId(a, seq);
    agentIds.set(a, id);
    nodes.push({
      id,
      type: "agent",
      label: a.label,
      parentId: parentOfAgent(a),
      status: a.status,
      sessionId: a.sessionId,
      data: { tokens: a.tokens, retries: a.retries, nullReason: a.nullReason, group: a.group },
    });
  });

  // 4) Pipeline stage edges: same group id + same item index, stageIndex k -> k+1.
  const byItem = new Map<string, GraphAgent[]>();
  for (const a of run.agents) {
    const g = a.group;
    if (!g || g.kind !== "pipeline" || g.stageIndex === undefined) continue;
    const key = `${g.id}#${g.index}`;
    let bucket = byItem.get(key);
    if (!bucket) {
      bucket = [];
      byItem.set(key, bucket);
    }
    bucket.push(a);
  }
  for (const group of byItem.values()) {
    const sorted = [...group].sort((x, y) => {
      const d = x.group!.stageIndex! - y.group!.stageIndex!;
      if (d !== 0) return d;
      return (agentIds.get(x) ?? "").localeCompare(agentIds.get(y) ?? "");
    });
    for (let i = 1; i < sorted.length; i++) {
      // Every agent in run.agents was registered in agentIds above, so these lookups are total.
      const from = agentIds.get(sorted[i - 1]!)!;
      const to = agentIds.get(sorted[i]!)!;
      edges.push({ id: `e:${from}->${to}`, source: from, target: to });
    }
  }

  return { nodes, edges };
}

/** Fallback phase list when the run never called phase() but has agents. */
function agentPhases(agents: GraphAgent[]): string[] {
  const seen: string[] = [];
  for (const a of agents) {
    const p = a.phase ?? "—";
    if (!seen.includes(p)) seen.push(p);
  }
  return seen.length ? seen : ["—"];
}
