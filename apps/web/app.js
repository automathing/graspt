'use strict';
const $ = (s) => document.querySelector(s);
let COLORS = { Core: '#94a3b8' };
let repoId = 'demo', currentDecl = null, currentGoal = null, currentMap = null;
let atlasDecls = [], mapViewBox = null, mapZoom = 1;

async function api(path, opts) { const r = await fetch(path, opts); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }
function areaColor(area) {
  if (!area) return COLORS.Core;
  if (COLORS[area]) return COLORS[area];
  let best = '';
  for (const k of Object.keys(COLORS)) if (area.startsWith(k) && k.length > best.length) best = k;
  return best ? COLORS[best] : COLORS.Core;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function loadRepos() {
  const repos = await api('/api/repos');
  $('#repo-select').innerHTML = repos.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} (${r.decls} decls)</option>`).join('');
  if (repos.some((r) => r.id === repoId)) $('#repo-select').value = repoId;
  repoId = $('#repo-select').value || 'demo';
  await loadAtlas();
}

function renderDecls(filter = '') {
  const q = filter.trim().toLowerCase();
  const visible = atlasDecls.filter((d) => !q || d.name.toLowerCase().includes(q));
  $('#decl-count').textContent = q ? `${visible.length} of ${atlasDecls.length}` : `${atlasDecls.length} declarations`;
  $('#decl-empty').hidden = visible.length > 0;
  $('#decl-list').innerHTML = visible.map((d) => {
    const completion = d.goals > 0 ? Math.max(0, Math.min(100, Math.round(((d.goals - d.frontier) / d.goals) * 100))) : 100;
    return `<button class="decl-card" data-decl="${esc(d.name)}" aria-label="Open proof ${esc(d.name)}">
      <span class="decl-card-top"><b>${esc(d.name)}</b><span class="badge ${d.complete ? '' : 'open'}">${d.complete ? 'Complete' : 'Open'}</span></span>
      <span class="decl-progress" aria-hidden="true"><i style="width:${completion}%"></i></span>
      <span class="decl-metrics"><span>${d.steps} steps</span><span>${d.goals} goals</span><span>${d.frontier} frontier</span></span>
    </button>`;
  }).join('');
  document.querySelectorAll('.decl-card').forEach((el) => el.addEventListener('click', () => openProof(el.dataset.decl)));
}

async function loadAtlas() {
  const a = await api(`/api/repos/${encodeURIComponent(repoId)}/atlas`);
  atlasDecls = a.decls || [];
  $('#atlas-title').textContent = 'Explore the territory';
  $('#atlas-stats').textContent = `${a.declarations} declarations across ${a.areas.length} mathematical areas. Select one to see how its proof is connected.`;
  $('#metric-decls').textContent = a.declarations;
  $('#metric-landmarks').textContent = a.landmarks.length;
  $('#metric-complete').textContent = atlasDecls.filter((d) => d.complete).length;
  $('#metric-frontiers').textContent = atlasDecls.reduce((sum, d) => sum + d.frontier, 0);
  const present = new Map();
  for (const lm of a.landmarks) present.set(lm.area, areaColor(lm.area));
  $('#legend').innerHTML = [...present.entries()].map(([area, c]) => `<span><i class="dot" style="background:${c}"></i>${esc(area)}</span>`).join('');
  renderDecls($('#decl-search').value);
  document.querySelector('#landmark-table tbody').innerHTML = a.landmarks.slice(0, 40).map((lm) => `<tr><td><i class="chip" style="background:${areaColor(lm.area)}"></i><code>${esc(lm.name)}</code></td><td>${esc(lm.area)}</td><td>${lm.uses}</td></tr>`).join('');
}

function layout(map) {
  const pos = map.positions && Object.keys(map.positions).length ? map.positions : null;
  if (pos) return pos;
  // fallback: layered by BFS depth over flow edges
  const depth = new Map(), byDepth = new Map();
  const flow = map.edges.filter((e) => e.kind === 'flow');
  const root = map.nodes.find((n) => n.kind === 'theorem') || map.nodes[0];
  if (root) { depth.set(root.id, 0); const q = [root.id]; while (q.length) { const id = q.shift(); for (const e of flow.filter((x) => x.source === id)) if (!depth.has(e.target)) { depth.set(e.target, depth.get(id) + 1); q.push(e.target); } } }
  let maxD = 0; for (const n of map.nodes) { const d = depth.get(n.id) ?? ++maxD; if (!byDepth.has(d)) byDepth.set(d, []); byDepth.get(d).push(n.id); }
  const out = {}; for (const [d, ids] of byDepth) ids.forEach((id, i) => { out[id] = { x: 90 + i * 200, y: 60 + d * 110 }; });
  for (const n of map.nodes) if (!out[n.id]) out[n.id] = { x: 90 + (Object.keys(out).length % 5) * 200, y: 60 + (5 + Math.floor(Object.keys(out).length / 5)) * 40 };
  return out;
}

async function openProof(decl) {
  currentDecl = decl; currentGoal = null;
  currentMap = await api(`/api/repos/${encodeURIComponent(repoId)}/proof/${encodeURIComponent(decl)}`);
  $('#atlas-view').hidden = true; $('#proof-view').hidden = false;
  $('#proof-title').textContent = decl;
  $('#proof-stats').textContent = `${currentMap.stats.steps} steps · ${currentMap.stats.goals} goals · ${currentMap.stats.frontier} frontier · ${currentMap.stats.landmarks} landmarks`;
  drawMap();
  const root = currentMap.nodes.find((n) => n.kind === 'theorem');
  if (root) selectGoal(root.id);
}

function applyMapZoom() {
  const svg = $('#map');
  if (!mapViewBox) return;
  const { x, y, w, h } = mapViewBox;
  const zw = w / mapZoom, zh = h / mapZoom;
  svg.setAttribute('viewBox', `${x + (w - zw) / 2} ${y + (h - zh) / 2} ${zw} ${zh}`);
}

function nodeShape(n, fill, stroke) {
  if (n.kind === 'landmark') return `<rect x="-10" y="-10" width="20" height="20" rx="3" transform="rotate(45)" fill="${fill}" stroke="${stroke}"/>`;
  if (n.kind === 'frontier') return `<path d="M0,-14 L13,10 L-13,10 Z" fill="${fill}" stroke="${stroke}" stroke-linejoin="round"/>`;
  if (n.kind === 'move') return `<rect x="-8" y="-8" width="16" height="16" rx="3" fill="${fill}" stroke="${stroke}"/>`;
  if (n.kind === 'known') return `<circle r="13" fill="${fill}" stroke="${stroke}"/><path d="M-6,0 L-2,4 L7,-5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`;
  return `<circle r="14" fill="${fill}" stroke="${stroke}"/>`;
}

function activateNode(id) {
  if (id.startsWith('g:')) selectGoal(id);
  else if (id.startsWith('lm:')) showLandmark(id);
  else showNodeDetail(id);
}

function drawMap() {
  const svg = $('#map'); const pos = layout(currentMap);
  const maxX = Math.max(...Object.values(pos).map((p) => p.x), 600), maxY = Math.max(...Object.values(pos).map((p) => p.y), 400);
  mapViewBox = { x: 0, y: 0, w: maxX + 220, h: maxY + 100 };
  mapZoom = 1;
  applyMapZoom();
  let html = '<defs><marker id="arrow-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#71867a"/></marker></defs>';
  for (const e of currentMap.edges) {
    const a = pos[e.source], b = pos[e.target]; if (!a || !b) continue;
    html += `<path class="edge ${e.kind}" marker-end="${e.kind === 'flow' ? 'url(#arrow-flow)' : ''}" d="M${a.x},${a.y} L${b.x},${b.y}"/>`;
  }
  for (const n of currentMap.nodes) {
    const p = pos[n.id]; if (!p) continue;
    const fill = n.kind === 'landmark' ? areaColor(n.area) : n.kind === 'frontier' ? '#f6ad55' : n.kind === 'theorem' ? '#14332b' : n.kind === 'known' ? '#177245' : n.kind === 'move' ? '#dce5df' : '#ffffff';
    const stroke = n.kind === 'goal' || n.kind === 'theorem' ? '#0f766e' : n.kind === 'frontier' ? '#c56b12' : '#71867a';
    const label = (n.label || '').split('\n')[0].slice(0, 36);
    const accessibleLabel = `${n.kind}: ${n.label || n.id}`;
    html += `<g class="node" data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(accessibleLabel)}" transform="translate(${p.x},${p.y})"><circle class="hit-area" r="24"/><title>${esc(accessibleLabel)}</title>${nodeShape(n, fill, stroke)}<text class="node-label" x="19" y="4">${esc(label)}</text></g>`;
  }
  svg.innerHTML = html;
  svg.querySelectorAll('g.node').forEach((g) => {
    g.addEventListener('click', () => activateNode(g.dataset.id));
    g.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateNode(g.dataset.id); }
    });
  });
}

async function selectGoal(nodeId) {
  currentGoal = nodeId.replace(/^g:/, '');
  setChatContext(`${currentDecl} · goal ${currentGoal} — agent works from here`);
  document.querySelectorAll('#map g.node').forEach((g) => g.classList.toggle('selected', g.dataset.id === nodeId));
  const nb = await api(`/api/repos/${encodeURIComponent(repoId)}/neighbourhood/${encodeURIComponent(currentDecl)}?goal=${encodeURIComponent(currentGoal)}`);
  if (!nb || nb.error) { $('#ego-centre').textContent = 'No neighbourhood.'; return; }
  $('#ego-centre').textContent = nb.centre.pp || nb.centre.target;
  $('#ego-trail').textContent = nb.trail.length ? `Trail: ${nb.trail.join(' → ')}` : 'At the root goal.';
  $('#ego-neighbours').innerHTML = nb.neighbours.map((n) => `<button class="neighbour" data-id="${esc(n.nodeId)}" data-kind="${esc(n.kind)}"><b>${n.kind === 'landmark' ? `<i class="chip" style="background:${areaColor(n.area)}"></i>` : ''}${esc(n.label)}</b><span>${esc(n.relation)} · distance ${n.distance}${n.area ? ` · ${esc(n.area)}` : ''}${n.tacticSuggestion ? ` · suggested (unverified): ${esc(n.tacticSuggestion)}` : ''}</span></button>`).join('');
  document.querySelectorAll('.neighbour').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.kind === 'landmark') showLandmark(el.dataset.id); else selectGoal(el.dataset.id);
  }));
}

function showNodeDetail(id) {
  const n = currentMap && currentMap.nodes.find((x) => x.id === id);
  if (!n) return;
  document.querySelectorAll('#map g.node').forEach((g) => g.classList.toggle('selected', g.dataset.id === id));
  const kindText = n.kind === 'known' ? 'This branch is grounded in the known: every goal on it was closed by a Lean-verified tactic.' : `Move — tactic step(s) Lean elaborated:\n${n.detail || n.label}`;
  $('#ego-centre').textContent = `${n.label}\nKind: ${n.kind}${n.collapsed ? `\nCollapsed steps: ${n.collapsed}` : ''}\n\n${kindText}`;
  $('#ego-neighbours').innerHTML = '';
  $('#ego-trail').textContent = 'Select a circular goal node to see its neighbourhood.';
}

function showLandmark(id) {
  const n = currentMap && currentMap.nodes.find((x) => x.id === id);
  $('#ego-centre').textContent = n ? `${n.label}\nArea: ${n.area || 'Core'}\nUses: ${n.uses ?? 0}\n\nSuggested tactic is unverified until Lean checks it: apply ${n.label}` : id;
  $('#ego-neighbours').innerHTML = '';
}

function setChatContext(text) { const el = $('#chat-context'); if (el) el.textContent = `Context: ${text}`; }

document.querySelectorAll('.prompt-chip').forEach((chip) => chip.addEventListener('click', () => { $('#scratch-input').value = chip.dataset.prompt; $('#scratch-input').focus(); }));
$('#start-scratch').addEventListener('click', async () => {
  const prompt = $('#scratch-input').value.trim();
  $('#job-status').textContent = 'starting scratch session…';
  try {
    const repo = await api('/api/repos/scratch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
    if (!repo || repo.error) { $('#job-status').textContent = `scratch failed: ${(repo && repo.error) || 'empty response'}`; return; }
    repoId = repo.id;
    await loadRepos();
    $('#repo-select').value = repoId;
    await loadAtlas();
    $('#job-status').textContent = 'scratch session started — direct the agent in the chat on the right.';
    $('#session-status').textContent = 'Scratch session · no declarations yet';
    setChatContext(prompt ? `scratch — “${prompt.slice(0, 80)}”` : 'scratch session');
    const input = $('#chat-input');
    input.value = prompt ? `Prove this in Lean 4: ${prompt} Give me a first draft tactic proof; mark anything Lean has not checked as unverified.` : '';
    input.focus();
  } catch (err) { $('#job-status').textContent = `scratch failed: ${err.message || err}`; }
});
$('#open-demo').addEventListener('click', async () => {
  repoId = $('#repo-select').value || 'demo';
  $('#session-status').textContent = 'On the map · agent writes, Lean verifies';
  setChatContext('atlas');
  await loadAtlas();
  $('#atlas-view').scrollIntoView({ behavior: 'smooth' });
});

$('#back-atlas').addEventListener('click', () => { $('#proof-view').hidden = true; $('#atlas-view').hidden = false; });
$('#brand-home').addEventListener('click', (e) => { e.preventDefault(); $('#proof-view').hidden = true; $('#atlas-view').hidden = false; window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('#decl-search').addEventListener('input', (e) => renderDecls(e.target.value));
$('#zoom-in').addEventListener('click', () => { mapZoom = Math.min(3.2, mapZoom * 1.25); applyMapZoom(); });
$('#zoom-out').addEventListener('click', () => { mapZoom = Math.max(0.55, mapZoom / 1.25); applyMapZoom(); });
$('#zoom-reset').addEventListener('click', () => { mapZoom = 1; applyMapZoom(); });
$('#repo-select').addEventListener('change', (e) => { repoId = e.target.value; loadAtlas(); });
$('#open-folder').addEventListener('click', async () => {
  const p = $('#folder-input').value.trim(); if (!p) return;
  $('#job-status').textContent = 'ingesting…';
  const job = await api('/api/repos/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
  const poll = async () => {
    const j = await api(`/api/jobs/${job.id}`);
    $('#job-status').textContent = `${j.state}: ${j.detail}`;
    if (j.state === 'ready') { await loadRepos(); if (j.repoId) { repoId = j.repoId; $('#repo-select').value = repoId; await loadAtlas(); } }
    else if (j.state !== 'failed') setTimeout(poll, 1500);
  };
  poll();
});
$('#walk-btn').addEventListener('click', async () => {
  if (!currentDecl) return;
  const walk = await api(`/api/repos/${encodeURIComponent(repoId)}/walk/${encodeURIComponent(currentDecl)}${currentGoal ? `?goal=${encodeURIComponent(currentGoal)}` : ''}`);
  if (!walk || walk.error) { $('#walk-status').textContent = 'no walk available'; return; }
  $('#walk-status').textContent = walk.steps.length ? `walk: ${walk.steps.map((s) => s.tactic).join(' → ')} (${walk.note})` : walk.note;
});
async function refreshAgentStatus() {
  try {
    const s = await api('/api/agent/status');
    $('#agent-status').textContent = s.agent ? `Chat: ${s.agent}` : 'Chat: no API key';
    // Once a key is saved, the whole key prompt disappears; clearing brings it back.
    $('#key-form').hidden = !!s.hasMetaKey;
    $('#clear-key').hidden = !s.hasMetaKey;
    $('#key-status').textContent = s.hasMetaKey ? `key saved (${s.model})` : (s.agent ? s.model : s.hint);
    if (document.activeElement !== $('#model-input')) $('#model-input').value = s.model;
    $('#model-input').placeholder = s.model;
    return s;
  } catch { $('#agent-status').textContent = 'Agent: server unreachable'; }
}
$('#save-model').addEventListener('click', async () => {
  const m = $('#model-input').value.trim(); if (!m) return;
  await api('/api/agent/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m }) });
  $('#key-status').textContent = `model set to ${m}`;
  refreshAgentStatus();
});
$('#save-key').addEventListener('click', async () => {
  const key = $('#api-key-input').value.trim();
  if (!key) { $('#key-status').textContent = 'paste your key first'; return; }
  $('#key-status').textContent = 'saving…';
  try {
    const s = await api('/api/agent/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: key }) });
    if (s && s.error) { $('#key-status').textContent = s.error; return; }
    $('#api-key-input').value = '';
    $('#key-status').textContent = s.hasMetaKey ? 'key saved on server ✓ — try the chat' : 'failed to save key';
    refreshAgentStatus();
  } catch (err) { $('#key-status').textContent = `failed: ${err.message || err}`; }
});
$('#clone-repo').addEventListener('click', async () => {
  const u = $('#clone-input').value.trim(); if (!u) return;
  $('#job-status').textContent = 'cloning into /tmp…';
  const job = await api('/api/repos/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) });
  const poll = async () => {
    const j = await api(`/api/jobs/${job.id}`);
    $('#job-status').textContent = `${j.state}: ${j.detail}`;
    if (j.state === 'ready') { await loadRepos(); if (j.repoId) { repoId = j.repoId; $('#repo-select').value = repoId; await loadAtlas(); } }
    else if (j.state !== 'failed') setTimeout(poll, 2000);
  };
  poll();
});
$('#clear-key').addEventListener('click', async () => {
  await api('/api/agent/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) });
  $('#key-status').textContent = 'key cleared';
  refreshAgentStatus();
});

function appendChat(cls, html) {
  const log = $('#chat-log');
  const placeholder = log.querySelector('.chat-placeholder');
  if (placeholder) placeholder.remove();
  const div = document.createElement('div');
  div.className = `chat-msg ${cls}`;
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function applyTactic(tactic, btn) {
  if (!currentDecl) { appendChat('system', 'Open a declaration and stand on its frontier first — then I can have Lean check a tactic there.'); return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Lean is checking…'; }
  appendChat('system', `Asking Lean to check <code>${esc(tactic)}</code> at <b>${esc(currentDecl)}</b>…`);
  try {
    const r = await api(`/api/repos/${encodeURIComponent(repoId)}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decl: currentDecl, goal: currentGoal || undefined, tactic }) });
    if (!r || r.error) { appendChat('system', `Could not apply: ${esc((r && r.error) || 'empty response')}`); return; }
    appendChat(r.ok ? 'verified-msg' : 'system', `${esc(r.explanation)}`);
    if (r.ok && r.map) {
      currentMap = r.map;
      $('#proof-stats').textContent = `${currentMap.stats.steps} steps · ${currentMap.stats.goals} goals · ${currentMap.stats.frontier} frontier · ${currentMap.stats.landmarks} landmarks`;
      drawMap();
      const root = currentMap.nodes.find((n) => n.kind === 'theorem');
      if (root) selectGoal(root.id);
      appendChat('system', 'The map above has been redrawn from Lean’s new elaboration. Places you already know stayed put; the frontier you stood on has moved.');
    }
  } catch (err) {
    appendChat('system', `Could not reach the server (${esc(err.message || String(err))}).`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Try this — Lean checks it'; }
  }
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#chat-input').value.trim(); if (!q) return;
  $('#chat-input').value = '';
  appendChat('human', `<b>You:</b> ${esc(q)}`);
  const pending = appendChat('system', 'Asking Meta AI…');
  try {
    const r = await api(`/api/repos/${encodeURIComponent(repoId)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decl: currentDecl || undefined, goal: currentGoal || undefined, question: q }) });
    pending.remove();
    if (!r || r.error) { appendChat('system', `Server rejected the request: ${esc((r && r.error) || 'empty response')}. Try again.`); return; }
    const badge = `<span class="${r.verified ? 'verified' : 'unverified'}">${r.verified ? '✓ citations verified' : 'unverified' + (r.reason ? ` — ${esc(r.reason)}` : '')}</span> <span>— via ${esc(r.agent || 'none')}</span>`;
    appendChat('agent', `${esc(r.answer)}\n${badge}`);
    for (const c of (r.candidates || [])) {
      const row = appendChat('candidate', `<code>${esc(c.tactic)}</code>${c.rationale ? `<span>${esc(c.rationale)}</span>` : ''}`);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'try-btn';
      btn.textContent = 'Try this — Lean checks it';
      btn.addEventListener('click', () => applyTactic(c.tactic, btn));
      row.appendChild(btn);
    }
    if ((r.candidates || []).length) appendChat('system', 'Suggestions are unverified. Pressing Try sends one tactic to Lean; only if Lean accepts it does the map change.');
  } catch (err) {
    pending.remove();
    appendChat('system', `Could not reach the server (${esc(err && err.message ? err.message : String(err))}). Make sure it is running, then refresh the page.`);
  }
});

(async () => { COLORS = await api('/api/colours'); refreshAgentStatus(); await loadRepos(); })();
