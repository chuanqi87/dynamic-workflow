import React, { useState } from "react";
import { answerRun, cancelRun, type RunSnapshot } from "./api.js";

export function TopBar({ run }: { run: RunSnapshot }): React.ReactElement {
  const [answer, setAnswer] = useState("");
  return (
    <header
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
        borderBottom: "1px solid var(--border)", background: "var(--surface)",
      }}
    >
      <strong>{run.name}</strong>
      <span className={`badge ${run.status}`}>{run.status}</span>
      <div style={{ flex: 1 }} />
      {run.status === "running" && (
        <button onClick={() => cancelRun(run.runId)} style={btn()}>Cancel</button>
      )}
      {run.pendingQuestion && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>❓ {run.pendingQuestion.question}</span>
          {(run.pendingQuestion.options ?? []).map((o) => (
            <button key={o} onClick={() => answerRun(run.runId, o)} style={btn()}>{o}</button>
          ))}
          <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="answer…" />
          <button onClick={() => { answerRun(run.runId, answer); setAnswer(""); }} style={btn()}>Send</button>
        </div>
      )}
    </header>
  );
}

function btn(): React.CSSProperties {
  return {
    border: "1px solid var(--border)", background: "var(--surface)", borderRadius: 8,
    padding: "4px 10px", cursor: "pointer", font: "12px system-ui",
  };
}
