import type React from "react";
import dagre from "dagre";
import type { Edge as RFEdge, Node as RFNode } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "../../src/dashboard/buildGraph.js";

const NODE_W = 180;
const NODE_H = 52;

export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { rfNodes: RFNode[]; rfEdges: RFEdge[] } {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const rfNodes: RFNode[] = nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: n.type === "agent" ? "agentNode" : "default",
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { label: n.label, status: n.status, sessionId: n.sessionId, ...n.data },
      ...(n.type !== "agent" ? { style: groupStyle(n.type) } : {}),
    };
  });
  const rfEdges: RFEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    animated: false,
  }));
  return { rfNodes, rfEdges };
}

function groupStyle(type: GraphNode["type"]): React.CSSProperties {
  return type === "phase"
    ? { background: "#eef2ff", border: "1px dashed #c7d2fe", borderRadius: 10, fontWeight: 600 }
    : { background: "#f6f8fa", border: "1px solid #d0d7de", borderRadius: 10 };
}
