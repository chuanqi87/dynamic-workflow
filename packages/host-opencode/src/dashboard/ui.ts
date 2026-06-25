/** Fallback page shown when the built dashboard assets are absent. */
export const FALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Workflow Dashboard</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#f6f8fa; color:#1f2328; }
  .card { max-width:520px; padding:28px 32px; background:#fff; border:1px solid #d0d7de;
    border-radius:12px; box-shadow:0 1px 3px rgba(27,31,36,.08); }
  code { background:#eef1f4; padding:2px 6px; border-radius:6px; font-family:ui-monospace,monospace; }
  h1 { font-size:18px; margin:0 0 8px; }
  p { margin:8px 0; color:#57606a; }
</style></head>
<body><div class="card">
  <h1>Workflow Dashboard</h1>
  <p>The dashboard UI has not been built yet.</p>
  <p>Run <code>bun run build:dashboard</code> (or <code>bun run build</code>) and reload.</p>
</div></body></html>`;
