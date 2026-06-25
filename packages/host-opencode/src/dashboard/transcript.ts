/**
 * Reduces opencode message/part events into a per-session conversation
 * transcript. Pure and host-independent so it can be unit-tested without a
 * live server. Fed by the plugin `event` hook.
 */

/** A loose view of the opencode event envelope we care about. */
export interface OpencodeEventLike {
  type: string;
  properties?: Record<string, unknown>;
}

export interface TranscriptMessage {
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
  cost?: number;
}

interface MsgState {
  messageId: string;
  role: string;
  parts: Map<string, string>;
  tokens?: number;
  cost?: number;
  order: number;
}

/** Extract the session id an event concerns, without mutating any state. */
export function eventSessionId(event: OpencodeEventLike): string | undefined {
  if (event.type === "message.updated") {
    return (event.properties?.info as { sessionID?: string } | undefined)?.sessionID;
  }
  if (event.type === "message.part.updated") {
    return (event.properties?.part as { sessionID?: string } | undefined)?.sessionID;
  }
  if (event.type === "message.part.removed") {
    return (event.properties as { sessionID?: string } | undefined)?.sessionID;
  }
  return undefined;
}

export class TranscriptStore {
  private readonly bySession = new Map<string, Map<string, MsgState>>();
  private readonly order = new Map<string, number>();

  /** Apply an opencode event; returns the session id it touched, if any. */
  apply(event: OpencodeEventLike): string | undefined {
    switch (event.type) {
      case "message.updated": {
        const info = event.properties?.info as
          | { id?: string; sessionID?: string; role?: string; cost?: number; tokens?: { output?: number } }
          | undefined;
        if (!info?.sessionID || !info.id) return undefined;
        const msg = this.ensure(info.sessionID, info.id);
        if (info.role) msg.role = info.role;
        if (typeof info.cost === "number") msg.cost = info.cost;
        if (typeof info.tokens?.output === "number") msg.tokens = info.tokens.output;
        return info.sessionID;
      }
      case "message.part.updated": {
        const part = event.properties?.part as
          | { sessionID?: string; messageID?: string; id?: string; type?: string; text?: string }
          | undefined;
        if (!part?.sessionID || !part.messageID) return undefined;
        if (part.type !== "text" && part.type !== "reasoning") return part.sessionID;
        const msg = this.ensure(part.sessionID, part.messageID);
        const partId = part.id ?? "0";
        msg.parts.set(partId, part.text ?? "");
        return part.sessionID;
      }
      case "message.part.removed": {
        const p = event.properties as { sessionID?: string; messageID?: string; partID?: string } | undefined;
        if (!p?.sessionID || !p.messageID) return undefined;
        const msg = this.bySession.get(p.sessionID)?.get(p.messageID);
        if (msg && p.partID) msg.parts.delete(p.partID);
        return p.sessionID;
      }
      default:
        return undefined;
    }
  }

  /** Ordered transcript for a session. */
  get(sessionId: string): TranscriptMessage[] {
    const msgs = this.bySession.get(sessionId);
    if (!msgs) return [];
    return [...msgs.values()]
      .sort((a, b) => a.order - b.order)
      .map((m) => ({
        messageId: m.messageId,
        role: m.role,
        text: [...m.parts.values()].join(""),
        tokens: m.tokens,
        cost: m.cost,
      }));
  }

  private ensure(sessionId: string, messageId: string): MsgState {
    let msgs = this.bySession.get(sessionId);
    if (!msgs) {
      msgs = new Map();
      this.bySession.set(sessionId, msgs);
    }
    let msg = msgs.get(messageId);
    if (!msg) {
      const n = (this.order.get(sessionId) ?? 0) + 1;
      this.order.set(sessionId, n);
      msg = { messageId, role: "assistant", parts: new Map(), order: n };
      msgs.set(messageId, msg);
    }
    return msg;
  }
}
