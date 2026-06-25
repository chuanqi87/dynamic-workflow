import React, { useEffect, useState } from "react";
import { streamSession, type ConvoMessage } from "./api.js";

export function NodeDrawer({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}): React.ReactElement {
  const [msgs, setMsgs] = useState<ConvoMessage[]>([]);
  useEffect(() => streamSession(sessionId, setMsgs), [sessionId]);

  return (
    <aside
      style={{
        position: "absolute", top: 0, right: 0, height: "100%", width: 420,
        background: "var(--surface)", borderLeft: "1px solid var(--border)",
        boxShadow: "-4px 0 16px rgba(27,31,36,.08)", display: "flex", flexDirection: "column",
        zIndex: 10,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
        <strong style={{ flex: 1 }}>Agent detail</strong>
        <button onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18 }}>×</button>
      </header>
      <div style={{ overflowY: "auto", padding: 12 }}>
        {msgs.length === 0 && <div style={{ color: "var(--muted)" }}>No messages yet.</div>}
        {msgs.map((m) => (
          <div key={m.messageId} style={{ borderLeft: "2px solid var(--border)", padding: "4px 0 4px 10px", margin: "8px 0", whiteSpace: "pre-wrap" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", color: m.role === "assistant" ? "var(--accent)" : "var(--done)" }}>
              {m.role}{m.tokens != null ? ` · ${m.tokens} tok` : ""}
            </div>
            {m.text}
          </div>
        ))}
      </div>
    </aside>
  );
}
