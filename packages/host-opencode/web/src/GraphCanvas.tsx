import React, { useEffect, useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, type Node as RFNode } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { buildGraph } from "../../src/dashboard/buildGraph.js";
import { layoutGraph } from "./layout.js";
import { AgentNode } from "./nodes/AgentNode.js";
import { streamRun, type RunSnapshot } from "./api.js";
import { TopBar } from "./TopBar.js";

const nodeTypes = { agentNode: AgentNode };

export function GraphCanvas({
  runId,
  onSelectNode,
}: {
  runId: string;
  onSelectNode: (sessionId: string | null) => void;
}): React.ReactElement {
  const [run, setRun] = useState<RunSnapshot | null>(null);
  useEffect(() => streamRun(runId, setRun), [runId]);

  const { rfNodes, rfEdges } = useMemo(() => {
    if (!run) return { rfNodes: [], rfEdges: [] };
    const { nodes, edges } = buildGraph(run);
    return layoutGraph(nodes, edges);
  }, [run]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {run && <TopBar run={run} />}
      <div style={{ flex: 1 }}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          fitView
          onNodeClick={(_e, node: RFNode) => onSelectNode((node.data as { sessionId?: string }).sessionId ?? null)}
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
