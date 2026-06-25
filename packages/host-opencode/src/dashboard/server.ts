import { readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RunRegistry } from "./run-registry.js";
import { FALLBACK_HTML } from "./ui.js";

// dist layout: <pkg>/dist/dashboard/server.js → <pkg>/dashboard-dist
const ASSET_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard-dist");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return CONTENT_TYPES[path.slice(dot)] ?? "application/octet-stream";
}

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4178;
const PORT_TRIES = 16;

interface SseClient {
  res: ServerResponse;
  /** Filter: which changes this client cares about. */
  wants(kind: "run" | "session", id: string): boolean;
  /** Produce the payload to push for the matched change. */
  snapshot(): unknown;
}

/**
 * A localhost web dashboard for live workflow + agent conversation viewing.
 * opencode-only: lives entirely in the host package. Lazily started and shared
 * across runs in the plugin process.
 */
export interface DashboardServerOptions {
  /** Cancel a run by id (wired to the RunManager). Returns false if not active. */
  cancel?: (runId: string) => boolean;
  /** Answer a run's pending question(). Returns false if none is pending. */
  answer?: (runId: string, value: string) => boolean;
  /** Provide persisted history for the runs list (e.g. across restarts). */
  history?: () => Promise<unknown[]>;
}

export class DashboardServer {
  readonly registry: RunRegistry;
  private server?: Server;
  private url?: string;
  private starting?: Promise<string>;
  private readonly clients = new Set<SseClient>();
  private readonly opts: DashboardServerOptions;

  constructor(registry?: RunRegistry, opts: DashboardServerOptions = {}) {
    this.registry = registry ?? new RunRegistry();
    this.opts = opts;
    this.registry.on((change) => this.broadcast(change));
  }

  /** Start (once) and return the base URL. Concurrent callers share one start. */
  ensureStarted(preferredPort = DEFAULT_PORT): Promise<string> {
    if (this.url) return Promise.resolve(this.url);
    this.starting ??= this.listen(preferredPort).then((url) => {
      this.url = url;
      return url;
    });
    return this.starting;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private listen(preferredPort: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const server = createServer((req, res) => void this.handle(req, res));
      const tryPort = (): void => {
        const port = preferredPort + attempt;
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < PORT_TRIES) {
            attempt++;
            tryPort();
          } else {
            reject(err);
          }
        });
        server.listen(port, HOST, () => {
          this.server = server;
          // Use the actually-bound port so ephemeral (port 0) works too.
          const addr = server.address();
          const actual = typeof addr === "object" && addr ? addr.port : port;
          resolve(`http://${HOST}:${actual}`);
        });
      };
      tryPort();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const path = url.pathname;

    if (path === "/api/runs") {
      return json(res, this.registry.list().map(runListItem));
    }
    let m = /^\/api\/runs\/([^/]+)\/cancel$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const ok = req.method === "POST" && this.opts.cancel ? this.opts.cancel(id) : false;
      return json(res, { cancelled: ok });
    }
    m = /^\/api\/runs\/([^/]+)\/answer$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const value = url.searchParams.get("value") ?? "";
      const ok = req.method === "POST" && this.opts.answer ? this.opts.answer(id, value) : false;
      return json(res, { answered: ok });
    }
    m = /^\/api\/runs\/([^/]+)\/stream$/.exec(path);
    if (m) return this.openSse(res, "run", decodeURIComponent(m[1]!));
    m = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (m) {
      const run = this.registry.get(decodeURIComponent(m[1]!));
      return run ? json(res, run) : notFound(res);
    }
    m = /^\/api\/sessions\/([^/]+)\/stream$/.exec(path);
    if (m) return this.openSse(res, "session", decodeURIComponent(m[1]!));
    m = /^\/api\/sessions\/([^/]+)\/transcript$/.exec(path);
    if (m) return json(res, this.registry.transcript(decodeURIComponent(m[1]!)));

    // Non-API: serve the built dashboard (or the placeholder).
    if (!path.startsWith("/api/")) return this.serveStatic(path, res);
    notFound(res);
  }

  /** Serve a built asset; fall back to index.html (SPA); fall back to the
   *  placeholder page when nothing is built. */
  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "/index.html" : pathname;
    // Prevent path traversal: resolved file must stay under ASSET_ROOT.
    const filePath = normalize(join(ASSET_ROOT, rel));
    if (!filePath.startsWith(ASSET_ROOT)) return this.serveFallback(res);
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(body);
      return;
    } catch {
      // SPA fallback: serve index.html for unknown non-asset routes.
      if (!rel.includes(".")) {
        try {
          const index = await readFile(join(ASSET_ROOT, "index.html"));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(index);
          return;
        } catch {
          /* fall through to placeholder */
        }
      }
      return this.serveFallback(res);
    }
  }

  private serveFallback(res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FALLBACK_HTML);
  }

  private openSse(res: ServerResponse, kind: "run" | "session", id: string): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const snapshot = () =>
      kind === "run" ? this.registry.get(id) : this.registry.transcript(id);
    const client: SseClient = {
      res,
      wants: (k, cid) => k === kind && cid === id,
      snapshot,
    };
    this.clients.add(client);
    send(res, snapshot());
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(client);
    });
  }

  private broadcast(change: { kind: "run" | "session"; runId?: string; sessionId?: string }): void {
    const id = change.kind === "run" ? change.runId : change.sessionId;
    if (!id) return;
    for (const c of this.clients) {
      if (c.wants(change.kind, id)) send(c.res, c.snapshot());
    }
  }
}

function runListItem(r: ReturnType<RunRegistry["list"]>[number]) {
  return {
    runId: r.runId,
    name: r.name,
    status: r.status,
    currentPhase: r.currentPhase,
    agents: r.agents.length,
    startedAt: r.startedAt,
  };
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

function send(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data ?? null)}\n\n`);
}
