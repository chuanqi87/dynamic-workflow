import { afterEach, describe, expect, test } from "bun:test";
import { DashboardServer } from "../../src/dashboard/server.js";

let server: DashboardServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("DashboardServer", () => {
  test("serves the dashboard page and the runs API", async () => {
    server = new DashboardServer();
    const url = await server.ensureStarted(0); // ephemeral port
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Root serves a non-empty 200 — the built SPA when present, else a plain
    // build hint. (Build-state-independent so the offline suite is stable.)
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect((await page.text()).length).toBeGreaterThan(0);

    server.registry.startRun("R1", "demo", "main-1");
    server.registry.applyProgress("R1", { type: "agent-start", label: "scout", sessionId: "a-1" });

    const runs = await (await fetch(`${url}/api/runs`)).json();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "R1", name: "demo", agents: 1 });

    const run = await (await fetch(`${url}/api/runs/R1`)).json();
    expect(run.agents[0]).toMatchObject({ label: "scout", sessionId: "a-1" });

    const missing = await fetch(`${url}/api/runs/none`);
    expect(missing.status).toBe(404);
  });

  test("streams run snapshots over SSE", async () => {
    server = new DashboardServer();
    const url = await server.ensureStarted(0);
    server.registry.startRun("R1", "demo", "main-1");

    const ac = new AbortController();
    const res = await fetch(`${url}/api/runs/R1/stream`, { signal: ac.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("data:");
    expect(chunk).toContain("\"runId\":\"R1\"");
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });
});
