/**
 * Reduces normalized {@link TranscriptDelta}s into a per-session conversation
 * transcript. Host-independent: each host translates its native message events
 * into TranscriptDeltas, so this store knows nothing about opencode or codex.
 */

/** One normalized message update from any host. `text` is the full current
 *  text of the message (last-write-wins), not an incremental fragment. */
export interface TranscriptDelta {
  sessionId: string;
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
  cost?: number;
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
  text: string;
  tokens?: number;
  cost?: number;
  order: number;
}

export class TranscriptStore {
  private readonly bySession = new Map<string, Map<string, MsgState>>();
  private readonly order = new Map<string, number>();

  /** Apply a normalized delta; returns the session id it touched. */
  apply(delta: TranscriptDelta): string {
    const msg = this.ensure(delta.sessionId, delta.messageId);
    msg.role = delta.role;
    msg.text = delta.text;
    if (delta.tokens !== undefined) msg.tokens = delta.tokens;
    if (delta.cost !== undefined) msg.cost = delta.cost;
    return delta.sessionId;
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
        text: m.text,
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
      msg = { messageId, role: "assistant", text: "", order: n };
      msgs.set(messageId, msg);
    }
    return msg;
  }
}
