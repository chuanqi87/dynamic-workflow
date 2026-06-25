import type { TranscriptDelta } from "@workflow/host-support";

/** A loose view of the opencode event envelope we care about. */
export interface OpencodeEventLike {
  type: string;
  properties?: Record<string, unknown>;
}

/** Per-(session,message) accumulated text + last-known role/usage, so each
 *  emitted delta carries the FULL current message text. */
interface Acc {
  role: string;
  parts: Map<string, string>;
  tokens?: number;
  cost?: number;
}

/**
 * Stateful translator: opencode message/part events → normalized TranscriptDeltas.
 * One instance per plugin process (shared across runs); keyed by message id.
 */
export class OpencodeTranscriptTranslator {
  private readonly acc = new Map<string, Acc>();

  translate(event: OpencodeEventLike): TranscriptDelta[] {
    if (event.type === "message.updated") {
      const info = event.properties?.info as
        | { id?: string; sessionID?: string; role?: string; cost?: number; tokens?: { output?: number } }
        | undefined;
      if (!info?.sessionID || !info.id) return [];
      const a = this.ensure(info.id);
      if (info.role) a.role = info.role;
      if (typeof info.cost === "number") a.cost = info.cost;
      if (typeof info.tokens?.output === "number") a.tokens = info.tokens.output;
      return [this.delta(info.sessionID, info.id, a)];
    }
    if (event.type === "message.part.updated") {
      const part = event.properties?.part as
        | { sessionID?: string; messageID?: string; id?: string; type?: string; text?: string }
        | undefined;
      if (!part?.sessionID || !part.messageID) return [];
      if (part.type !== "text" && part.type !== "reasoning") return [];
      const a = this.ensure(part.messageID);
      a.parts.set(part.id ?? "0", part.text ?? "");
      return [this.delta(part.sessionID, part.messageID, a)];
    }
    if (event.type === "message.part.removed") {
      const p = event.properties as
        | { sessionID?: string; messageID?: string; partID?: string }
        | undefined;
      if (!p?.sessionID || !p.messageID) return [];
      const a = this.acc.get(p.messageID);
      if (a && p.partID) a.parts.delete(p.partID);
      return a ? [this.delta(p.sessionID, p.messageID, a)] : [];
    }
    return [];
  }

  private ensure(messageId: string): Acc {
    let a = this.acc.get(messageId);
    if (!a) {
      a = { role: "assistant", parts: new Map() };
      this.acc.set(messageId, a);
    }
    return a;
  }

  private delta(sessionId: string, messageId: string, a: Acc): TranscriptDelta {
    return {
      sessionId,
      messageId,
      role: a.role,
      text: [...a.parts.values()].join(""),
      tokens: a.tokens,
      cost: a.cost,
    };
  }
}
