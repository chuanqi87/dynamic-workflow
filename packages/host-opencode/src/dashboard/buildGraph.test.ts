import { describe, expect, test } from "bun:test";
import { buildGraph, type GraphRun } from "./buildGraph.js";

const agent = (over: Partial<GraphRun["agents"][number]>): GraphRun["agents"][number] => ({
  label: "a",
  status: "done",
  retries: 0,
  ...over,
});

describe("buildGraph", () => {
  test("phases become ordered phase nodes connected in sequence", () => {
    const run: GraphRun = { phases: ["Find", "Verify"], agents: [] };
    const { nodes, edges } = buildGraph(run);
    const phaseIds = nodes.filter((n) => n.type === "phase").map((n) => n.id);
    expect(phaseIds).toEqual(["phase:Find", "phase:Verify"]);
    expect(edges).toContainEqual(
      expect.objectContaining({ source: "phase:Find", target: "phase:Verify" }),
    );
  });

  test("a parallel group yields one group node parenting its agents", () => {
    const run: GraphRun = {
      phases: ["Find"],
      agents: [
        agent({ label: "p0", phase: "Find", sessionId: "s0", group: { id: "g1", kind: "parallel", index: 0 } }),
        agent({ label: "p1", phase: "Find", sessionId: "s1", group: { id: "g1", kind: "parallel", index: 1 } }),
      ],
    };
    const { nodes } = buildGraph(run);
    const group = nodes.find((n) => n.type === "group" && n.id === "group:g1");
    expect(group).toBeDefined();
    expect(group!.parentId).toBe("phase:Find");
    const agents = nodes.filter((n) => n.type === "agent");
    expect(agents).toHaveLength(2);
    expect(agents.every((a) => a.parentId === "group:g1")).toBe(true);
  });

  test("pipeline stage chain connects stageIndex k -> k+1 for the same item", () => {
    const run: GraphRun = {
      phases: ["Run"],
      agents: [
        agent({ label: "s0", phase: "Run", sessionId: "a", group: { id: "p", kind: "pipeline", index: 0, stageIndex: 0 } }),
        agent({ label: "s1", phase: "Run", sessionId: "b", group: { id: "p", kind: "pipeline", index: 0, stageIndex: 1 } }),
      ],
    };
    const { nodes, edges } = buildGraph(run);
    const s0 = nodes.find((n) => n.type === "agent" && n.label === "s0")!;
    const s1 = nodes.find((n) => n.type === "agent" && n.label === "s1")!;
    expect(edges).toContainEqual(expect.objectContaining({ source: s0.id, target: s1.id }));
  });

  test("nested group links to its parent group", () => {
    const run: GraphRun = {
      phases: ["Run"],
      agents: [
        agent({ label: "child", sessionId: "c", group: { id: "g2", kind: "parallel", parentId: "g1", index: 0 } }),
      ],
    };
    const { nodes } = buildGraph(run);
    expect(nodes.find((n) => n.id === "group:g2")!.parentId).toBe("group:g1");
  });

  test("top-level agent (no group) parents directly to its phase", () => {
    const run: GraphRun = {
      phases: ["Run"],
      agents: [agent({ label: "solo", phase: "Run", sessionId: "x" })],
    };
    const { nodes } = buildGraph(run);
    expect(nodes.find((n) => n.type === "agent")!.parentId).toBe("phase:Run");
  });

  test("is deterministic for the same input", () => {
    const run: GraphRun = {
      phases: ["A"],
      agents: [agent({ label: "x", phase: "A", sessionId: "s" })],
    };
    expect(buildGraph(run)).toEqual(buildGraph(run));
  });

  test("every group and agent node is reachable from a phase via edges", () => {
    const run: GraphRun = {
      phases: ["Work"],
      agents: [
        agent({ label: "pa", phase: "Work", sessionId: "sa", group: { id: "grp1", kind: "parallel", index: 0 } }),
        agent({ label: "pb", phase: "Work", sessionId: "sb", group: { id: "grp1", kind: "parallel", index: 1 } }),
      ],
    };
    const { nodes, edges } = buildGraph(run);

    // Collect all edge targets and sources.
    const edgeTargets = new Set(edges.map((e) => e.target));

    // Every non-phase node must appear as a target of at least one edge.
    const nonPhaseNodes = nodes.filter((n) => n.type !== "phase");
    for (const n of nonPhaseNodes) {
      expect(edgeTargets.has(n.id)).toBe(true);
    }

    // The group node must have an incoming edge whose source is its phase.
    const groupNode = nodes.find((n) => n.type === "group" && n.id === "group:grp1")!;
    expect(groupNode).toBeDefined();
    expect(edges.some((e) => e.source === "phase:Work" && e.target === groupNode.id)).toBe(true);

    // Each parallel agent must have an incoming edge whose source is the group.
    const agentNodes = nodes.filter((n) => n.type === "agent");
    expect(agentNodes).toHaveLength(2);
    for (const a of agentNodes) {
      expect(edges.some((e) => e.source === "group:grp1" && e.target === a.id)).toBe(true);
    }
  });
});
