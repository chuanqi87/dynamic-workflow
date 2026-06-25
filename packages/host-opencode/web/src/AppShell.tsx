import React, { useEffect, useState } from "react";
import { fetchRuns, type RunListItem } from "./api.js";
import { GraphCanvas } from "./GraphCanvas.js";
import { NodeDrawer } from "./NodeDrawer.js";

export function AppShell(): React.ReactElement {
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => void fetchRuns().then(setRuns);
    tick();
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="shell">
      <aside className="rail">
        <h2 style={{ font: "600 11px system-ui", textTransform: "uppercase", color: "var(--muted)", padding: "12px" }}>
          Runs
        </h2>
        {runs.map((r) => (
          <button
            key={r.runId}
            onClick={() => setSelected(r.runId)}
            style={{
              display: "block", width: "100%", textAlign: "left", border: "none",
              background: r.runId === selected ? "#eef2ff" : "transparent",
              padding: "8px 12px", cursor: "pointer", font: "13px system-ui",
            }}
          >
            {r.name} <span className={`badge ${r.status}`}>{r.status}</span>
            <div style={{ color: "var(--muted)", fontSize: 11 }}>{r.agents} agents</div>
          </button>
        ))}
        {runs.length === 0 && <div style={{ color: "var(--muted)", padding: 12 }}>No runs yet.</div>}
      </aside>
      <main className="main">
        {selected ? (
          <GraphCanvas runId={selected} onSelectNode={setSelectedNode} />
        ) : (
          <div style={{ padding: 24, color: "var(--muted)" }}>Select a run.</div>
        )}
        {selectedNode && (
          <NodeDrawer sessionId={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </main>
    </div>
  );
}
