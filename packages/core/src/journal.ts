import type { AgentOpts } from "./types.js";

/**
 * Append-only run journal + content-addressed cache keys for `agent()` calls.
 *
 * MVP scope: the journal is written for observability and seeds the in-memory
 * cache for the current run. Full cross-run resume (replaying a prior runId's
 * journal to skip unchanged prefixes) is a post-MVP enhancement that reuses the
 * same {@link cacheKey} function.
 */
export interface JournalEvent {
  /** Logical sequence number — NOT wall-clock (scripts must be deterministic). */
  seq: number;
  runId: string;
  type: string;
  key?: string;
  payload?: unknown;
}

/** A sink that persists journal lines (file, memory, remote...). */
export interface JournalSink {
  append(line: string): void | Promise<void>;
  /** Await any buffered writes (durability before run-end / abort). */
  flush?(): Promise<void>;
}

/** Stable JSON stringify: object keys sorted recursively, undefined dropped. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortValue(v);
  }
  return out;
}

/** Normalize agent opts so semantically-equal calls hash identically. */
export function normalizeOpts(opts: AgentOpts | undefined): Record<string, unknown> {
  if (!opts) return {};
  const { label: _label, phase: _phase, ...rest } = opts;
  // label/phase are display-only and must not affect the cache key.
  return sortValue(rest) as Record<string, unknown>;
}

/**
 * A small synchronous FNV-1a hash, hex-encoded. Good enough for cache keys;
 * avoids pulling in node:crypto so the core stays portable to any JS runtime.
 */
export function cacheKey(prompt: string, opts: AgentOpts | undefined): string {
  const material = stableStringify({ prompt, opts: normalizeOpts(opts) });
  let h = 0x811c9dc5;
  for (let i = 0; i < material.length; i++) {
    h ^= material.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Mix length in to further reduce collisions for similar prefixes.
  h ^= material.length;
  h = Math.imul(h, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface JournalOptions {
  sink?: JournalSink;
  /** Max cached agent results held in memory; undefined = unbounded. */
  maxEntries?: number;
  /** Called once when the in-memory cache hits its cap. */
  onCapExceeded?: () => void;
}

export class Journal {
  private seq = 0;
  private readonly cache = new Map<string, unknown>();
  private readonly sink?: JournalSink;
  private readonly maxEntries?: number;
  private readonly onCapExceeded?: () => void;
  private capWarned = false;

  constructor(
    private readonly runId: string,
    options: JournalSink | JournalOptions = {},
  ) {
    const opts: JournalOptions =
      options && typeof (options as JournalSink).append === "function"
        ? { sink: options as JournalSink }
        : (options as JournalOptions);
    this.sink = opts.sink;
    this.maxEntries = opts.maxEntries;
    this.onCapExceeded = opts.onCapExceeded;
  }

  /** Seed the cache from a prior run (resume). */
  seed(entries: Iterable<[string, unknown]>): void {
    for (const [k, v] of entries) this.cache.set(k, v);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get(key: string): unknown {
    return this.cache.get(key);
  }

  record(type: string, key: string | undefined, payload: unknown): void {
    if (key !== undefined && type === "agent") {
      if (this.maxEntries != null && !this.cache.has(key) && this.cache.size >= this.maxEntries) {
        if (!this.capWarned) {
          this.capWarned = true;
          this.onCapExceeded?.();
        }
        // Still journal to disk; just stop growing the in-memory cache.
      } else {
        this.cache.set(key, payload);
      }
    }
    const ev: JournalEvent = { seq: this.seq++, runId: this.runId, type, key, payload };
    void this.sink?.append(JSON.stringify(ev));
  }
}

/**
 * Parse a prior run's jsonl journal into a key→result seed map for resume.
 * Only **successful** agent results (non-null payload) are seeded, so failed
 * or interrupted calls re-run live — matching "everything after the first
 * new/failed call runs live".
 */
export function parseJournal(text: string): Map<string, unknown> {
  const seed = new Map<string, unknown>();
  for (const e of agentEntries(text)) seed.set(e.key, e.payload);
  return seed;
}

/** Ordered successful agent results, for prefix-mode resume. */
export function parseJournalOrdered(text: string): Array<{ key: string; payload: unknown }> {
  return agentEntries(text);
}

function agentEntries(text: string): Array<{ key: string; payload: unknown }> {
  const out: Array<{ key: string; payload: unknown }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: JournalEvent;
    try {
      ev = JSON.parse(trimmed) as JournalEvent;
    } catch {
      continue; // tolerate a torn final line / corruption
    }
    if (ev.type === "agent" && ev.key !== undefined && ev.payload !== null && ev.payload !== undefined) {
      out.push({ key: ev.key, payload: ev.payload });
    }
  }
  return out;
}

/**
 * Prefix-mode resume: replays cached results in their original order while keys
 * match. On the first mismatch (a changed/new call) it "breaks" — that call and
 * everything after it run live, even if their prompts are unchanged. This
 * catches script drift that keyed resume would miss. NOTE: with concurrent
 * `agent()` calls the order is non-deterministic, so prefix mode is best-effort
 * for parallel sections; keyed mode is the concurrency-safe default.
 */
export class PrefixReplay {
  private cursor = 0;
  private broken = false;

  constructor(private readonly ordered: Array<{ key: string; payload: unknown }>) {}

  lookup(key: string): { hit: boolean; value?: unknown } {
    if (this.broken) return { hit: false };
    const next = this.ordered[this.cursor];
    if (next && next.key === key) {
      this.cursor++;
      return { hit: true, value: next.payload };
    }
    this.broken = true;
    return { hit: false };
  }
}
