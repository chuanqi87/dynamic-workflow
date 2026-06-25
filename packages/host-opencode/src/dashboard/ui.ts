/** Self-contained dashboard page (no build step, vanilla JS + SSE). */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Workflow Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #0d1117; color: #c9d1d9; display: grid; grid-template-columns: 240px 1fr 1fr; height: 100vh; }
  .col { overflow-y: auto; padding: 12px; border-right: 1px solid #21262d; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #8b949e; margin: 0 0 8px; }
  .run, .agent { padding: 6px 8px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; }
  .run:hover, .agent:hover { background: #161b22; }
  .run.sel, .agent.sel { background: #1f2937; outline: 1px solid #30363d; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px; margin-left: 6px; }
  .running { background: #1f6feb33; color: #79c0ff; }
  .done, .completed { background: #2ea04333; color: #56d364; }
  .null, .failed { background: #f8514933; color: #ff7b72; }
  .retrying { background: #d2992233; color: #e3b341; }
  .phase { color: #8b949e; margin: 10px 0 4px; font-size: 11px; text-transform: uppercase; }
  .meta { color: #6e7681; font-size: 11px; }
  .summary { font-size: 11px; color: #8b949e; margin: 8px 0; white-space: pre-wrap; }
  .msg { border-left: 2px solid #30363d; padding: 4px 0 4px 10px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }
  .role { font-size: 10px; text-transform: uppercase; color: #8b949e; }
  .role.assistant { color: #79c0ff; } .role.user { color: #56d364; }
  .tabs { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
  .tab { padding: 4px 8px; border: 1px solid #30363d; border-radius: 6px; cursor: pointer; font-size: 11px; }
  .tab.sel { background: #1f2937; }
  .empty { color: #6e7681; padding: 20px 8px; }
</style>
</head>
<body>
  <div class="col" id="runs"><h2>Runs</h2><div id="runlist"></div></div>
  <div class="col" id="tree"><div class="empty">Select a run.</div></div>
  <div class="col" id="convo"><div class="empty">Select an agent.</div></div>
<script>
const $ = (id) => document.getElementById(id);
let selRun = null, runEs = null, convoEs = null, selSession = null, curRun = null;

async function refreshRuns() {
  try {
    const runs = await (await fetch('/api/runs')).json();
    $('runlist').innerHTML = runs.map(r =>
      \`<div class="run \${r.runId===selRun?'sel':''}" data-id="\${r.runId}">
        \${esc(r.name)} <span class="badge \${r.status}">\${r.status}</span>
        <div class="meta">\${r.agents} agents\${r.currentPhase?' · '+esc(r.currentPhase):''}</div>
      </div>\`).join('') || '<div class="empty">No runs yet.</div>';
    for (const el of document.querySelectorAll('.run'))
      el.onclick = () => selectRun(el.dataset.id);
  } catch {}
}

function selectRun(id) {
  selRun = id;
  if (runEs) runEs.close();
  runEs = new EventSource('/api/runs/'+encodeURIComponent(id)+'/stream');
  runEs.onmessage = (e) => renderTree(JSON.parse(e.data));
  refreshRuns();
}

function renderTree(run) {
  if (!run) return;
  curRun = run;
  const byPhase = {};
  for (const a of run.agents) (byPhase[a.phase||'—'] ||= []).push(a);
  const s = run.summary;
  let html = \`<h2>\${esc(run.name)} <span class="badge \${run.status}">\${run.status}</span></h2>\`;
  html += \`<div class="tabs"><div class="tab" data-main="1">main agent</div>\`;
  if (run.status === 'running') html += \`<div class="tab" data-cancel="1">cancel</div>\`;
  html += \`</div>\`;
  if (s) html += \`<div class="summary">agents \${s.agents} · ok \${s.succeeded} · null \${sumNull(s.nullsByReason)} · retries \${s.retries} · dropped \${s.dropped} · \${s.outputTokens} out-tok · \${s.durationMs}ms</div>\`;
  if (run.pendingQuestion) {
    const opts = (run.pendingQuestion.options || []).map(o => \`<button class="tab" data-ans="\${esc(o)}">\${esc(o)}</button>\`).join('');
    html += \`<div class="summary" style="border:1px solid #d29922;border-radius:6px;padding:8px">❓ \${esc(run.pendingQuestion.question)}<div style="margin-top:6px">\${opts}<input id="ansInput" placeholder="type an answer…" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 8px"/><button class="tab" id="ansSend">send</button></div></div>\`;
  }
  for (const [phase, agents] of Object.entries(byPhase)) {
    html += \`<div class="phase">\${esc(phase)}</div>\`;
    for (const a of agents) {
      html += \`<div class="agent \${a.sessionId===selSession?'sel':''}" data-sid="\${a.sessionId||''}">
        \${esc(a.label)} <span class="badge \${a.status}">\${a.status}\${a.nullReason?':'+a.nullReason:''}</span>
        <div class="meta">\${a.tokens!=null?a.tokens+' tok':''}\${a.retries?' · '+a.retries+' retries':''}</div>
      </div>\`;
    }
  }
  $('tree').innerHTML = html;
  for (const el of document.querySelectorAll('.agent'))
    if (el.dataset.sid) el.onclick = () => openSession(el.dataset.sid);
  const mt = document.querySelector('.tab[data-main]');
  if (mt) mt.onclick = () => run.mainSessionId && openSession(run.mainSessionId);
  const ct = document.querySelector('.tab[data-cancel]');
  if (ct) ct.onclick = () => fetch('/api/runs/'+encodeURIComponent(run.runId)+'/cancel', { method: 'POST' }).catch(()=>{});
  const answer = (v) => fetch('/api/runs/'+encodeURIComponent(run.runId)+'/answer?value='+encodeURIComponent(v), { method: 'POST' }).catch(()=>{});
  for (const b of document.querySelectorAll('.tab[data-ans]')) b.onclick = () => answer(b.dataset.ans);
  const send = $('ansSend');
  if (send) send.onclick = () => answer(($('ansInput')||{}).value || '');
}

function openSession(sid) {
  selSession = sid;
  if (convoEs) convoEs.close();
  convoEs = new EventSource('/api/sessions/'+encodeURIComponent(sid)+'/stream');
  convoEs.onmessage = (e) => renderConvo(JSON.parse(e.data));
  if (curRun) renderTree(curRun);
}

function renderConvo(msgs) {
  if (!msgs || !msgs.length) { $('convo').innerHTML = '<div class="empty">No messages yet.</div>'; return; }
  $('convo').innerHTML = msgs.map(m =>
    \`<div class="msg"><div class="role \${m.role}">\${esc(m.role)}\${m.tokens!=null?' · '+m.tokens+' tok':''}</div>\${esc(m.text)}</div>\`
  ).join('');
  $('convo').scrollTop = $('convo').scrollHeight;
}

function sumNull(n){ return Object.values(n||{}).reduce((a,b)=>a+b,0); }
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

refreshRuns();
setInterval(refreshRuns, 2000);
</script>
</body>
</html>`;
