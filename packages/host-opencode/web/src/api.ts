import type { GraphRun } from "../../src/dashboard/buildGraph.js";

export interface RunListItem {
  runId: string;
  name: string;
  status: string;
  agents: number;
  currentPhase?: string;
}

export interface RunSnapshot extends GraphRun {
  runId: string;
  name: string;
  status: string;
  mainSessionId?: string;
  summary?: Record<string, unknown>;
  pendingQuestion?: { question: string; options?: string[] };
}

export interface ConvoMessage {
  messageId: string;
  role: string;
  text: string;
  tokens?: number;
}

export async function fetchRuns(): Promise<RunListItem[]> {
  const res = await fetch("/api/runs");
  return res.ok ? ((await res.json()) as RunListItem[]) : [];
}

/** Subscribe to a run snapshot stream. Returns an unsubscribe fn. */
export function streamRun(id: string, cb: (run: RunSnapshot | null) => void): () => void {
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
  es.onmessage = (e) => cb(JSON.parse(e.data) as RunSnapshot | null);
  return () => es.close();
}

export function streamSession(id: string, cb: (msgs: ConvoMessage[]) => void): () => void {
  const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/stream`);
  es.onmessage = (e) => cb((JSON.parse(e.data) as ConvoMessage[]) ?? []);
  return () => es.close();
}

export function cancelRun(id: string): void {
  void fetch(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => {});
}

export function answerRun(id: string, value: string): void {
  void fetch(`/api/runs/${encodeURIComponent(id)}/answer?value=${encodeURIComponent(value)}`, {
    method: "POST",
  }).catch(() => {});
}
