import React from "react";
import { Handle, Position } from "@xyflow/react";

type Status = "running" | "done" | "null" | "retrying";

export function AgentNode({
  data,
}: {
  data: { label: string; status?: Status; tokens?: number; retries?: number };
}): React.ReactElement {
  return (
    <div
      style={{
        width: 180, padding: "8px 12px", background: "var(--surface)",
        border: "1px solid var(--border)", borderLeft: `4px solid ${color(data.status)}`,
        borderRadius: 10, boxShadow: "var(--shadow)", font: "13px system-ui",
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {data.label}
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        <span className={`badge ${data.status ?? ""}`}>{data.status}</span>
        {data.tokens != null ? ` · ${data.tokens} tok` : ""}
        {data.retries ? ` · ${data.retries} retries` : ""}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function color(status?: Status): string {
  return status === "done"
    ? "var(--done)"
    : status === "null"
      ? "var(--null)"
      : status === "retrying"
        ? "var(--retrying)"
        : "var(--running)";
}
