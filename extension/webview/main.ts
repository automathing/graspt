import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';

cytoscape.use(dagre);

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

const AREA_COLORS: Record<string, string> = {
  'Mathlib.Topology': '#10b981',
  'Mathlib.Algebra': '#a855f7',
  'Mathlib.Analysis': '#38bdf8',
  'Mathlib.Data': '#eab308',
  'Mathlib.Order': '#f97316',
  'Mathlib.NumberTheory': '#ec4899',
  'Mathlib.LinearAlgebra': '#6366f1',
  'Mathlib.MeasureTheory': '#14b8a6',
  'Mathlib.CategoryTheory': '#f43f5e',
  'Mathlib.Tactic': '#64748b',
  Local: '#22d3ee',
  Core: '#94a3b8',
};

function areaColor(area?: string): string {
  if (!area) return '#a855f7';
  if (AREA_COLORS[area]) return AREA_COLORS[area];
  for (const [k, v] of Object.entries(AREA_COLORS)) {
    if (area.startsWith(k)) return v;
  }
  return '#a855f7';
}

let activeTab: 'proof' | 'atlas' = 'proof';
let currentMap: any = null;
let currentAtlas: any = null;
let selectedGoalId: string | undefined;
const selectedLandmarks = new Set<string>();

const cy = cytoscape({
  container: document.getElementById('cy'),
  wheelSensitivity: 0.25,
  style: [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        color: '#e5ecf6',
        'font-size': 11,
        'text-wrap': 'wrap',
        'text-max-width': '180px',
        'text-valign': 'center',
        'text-halign': 'center',
        'background-color': '#1e293b',
        'border-width': 2,
        'border-color': '#475569',
        padding: '10px',
        width: 'label',
        height: 'label',
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node[kind = "theorem"]',
      style: {
        'background-color': '#0c4a6e',
        'border-color': '#38bdf8',
        'border-width': 3,
        shape: 'hexagon',
        'font-weight': 'bold',
        'font-size': 12,
      },
    },
    {
      selector: 'node[kind = "goal"]',
      style: {
        'background-color': '#172554',
        'border-color': '#60a5fa',
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node[kind = "frontier"]',
      style: {
        'background-color': '#451a03',
        'border-color': '#f59e0b',
        'border-width': 3,
        'border-style': 'dashed',
        shape: 'diamond',
        'font-weight': 'bold',
      },
    },
    {
      selector: 'node[kind = "move"]',
      style: {
        'background-color': '#1e293b',
        'border-color': '#64748b',
        shape: 'round-tag',
        'font-family': 'monospace',
        'font-size': 10.5,
      },
    },
    {
      selector: 'node[kind = "move"][?milestone]',
      style: {
        'border-color': '#cbd5e1',
        'border-width': 2.5,
      },
    },
    {
      selector: 'node[kind = "landmark"]',
      style: {
        'background-color': '#2e1065',
        'border-color': 'data(color)',
        'border-width': 2.5,
        shape: 'octagon',
        'font-size': 10.5,
      },
    },
    {
      selector: 'node[kind = "known"]',
      style: {
        'background-color': '#064e3b',
        'border-color': '#10b981',
        'border-width': 3,
        shape: 'ellipse',
        'font-weight': 'bold',
      },
    },
    {
      selector: 'node[kind = "ghost-move"]',
      style: {
        'background-color': '#083344',
        'border-color': '#22d3ee',
        'border-style': 'dashed',
        'border-width': 2.5,
        shape: 'round-tag',
        'font-family': 'monospace',
      },
    },
    {
      selector: 'node[kind = "ghost-goal"]',
      style: {
        'background-color': '#0f172a',
        'border-color': '#22d3ee',
        'border-style': 'dotted',
        shape: 'round-rectangle',
      },
    },
    {
      selector: 'node[kind = "area"]',
      style: {
        'background-color': '#1e1b4b',
        'border-color': 'data(color)',
        'border-width': 3,
        shape: 'ellipse',
        'font-weight': 'bold',
      },
    },
    {
      selector: 'node.active-cursor',
      style: {
        'border-color': '#38bdf8',
        'border-width': 4,
        'overlay-color': '#38bdf8',
        'overlay-opacity': 0.18,
        'overlay-padding': 6,
      },
    },
    {
      selector: 'node.lm-selected',
      style: {
        'border-color': '#f59e0b',
        'border-width': 4,
        'background-color': '#4c1d95',
      },
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': '#475569',
        'target-arrow-color': '#475569',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
      },
    },
    {
      selector: 'edge[kind = "uses"]',
      style: {
        width: 1.5,
        'line-style': 'dashed',
        'line-color': '#a855f7',
        'target-arrow-color': '#a855f7',
      },
    },
    {
      selector: 'edge[kind = "ghost"]',
      style: {
        width: 2.5,
        'line-style': 'dashed',
        'line-color': '#22d3ee',
        'target-arrow-color': '#22d3ee',
      },
    },
  ],
});

function renderProofMap() {
  if (!currentMap || activeTab !== 'proof') return;
  cy.elements().remove();

  const elements: any[] = [];
  for (const n of currentMap.nodes) {
    elements.push({
      data: {
        ...n,
        color: areaColor(n.area),
      },
    });
  }
  for (const e of currentMap.edges) {
    elements.push({ data: e });
  }
  cy.add(elements);
  cy.layout({
    name: 'dagre',
    rankDir: 'TB',
    nodeSep: 38,
    rankSep: 52,
    padding: 28,
  } as any).run();

  // Default focus on first frontier if any
  const frontierNode = currentMap.nodes.find((n: any) => n.kind === 'frontier');
  if (frontierNode) {
    selectedGoalId = frontierNode.id;
    updateChatContextBadge(frontierNode.label);
  }
}

function renderAtlasMap() {
  if (!currentAtlas || activeTab !== 'atlas') return;
  cy.elements().remove();
  const elements: any[] = [];
  for (const a of currentAtlas.areas) {
    elements.push({
      data: {
        id: `area:${a.id}`,
        kind: 'area',
        label: `${a.id.replace(/^Mathlib\./, '')}\n(${a.decls} decls)`,
        detail: `Area ${a.id} — ${a.decls} declarations in Mathlib/Core`,
        color: areaColor(a.id),
      },
    });
  }
  for (const e of currentAtlas.areaEdges.slice(0, 80)) {
    elements.push({
      data: {
        id: `ae:${e.source}->${e.target}`,
        source: `area:${e.source}`,
        target: `area:${e.target}`,
        kind: 'flow',
      },
    });
  }
  for (const lm of currentAtlas.landmarks.slice(0, 35)) {
    const lid = `alm:${lm.name}`;
    elements.push({
      data: {
        id: lid,
        kind: 'landmark',
        label: `${lm.name}\n(★${lm.uses})`,
        detail: `${lm.name} : ${lm.type}\nModule: ${lm.module}\nUsed by ${lm.uses} declarations`,
        area: lm.area,
        color: areaColor(lm.area),
      },
    });
    elements.push({
      data: {
        id: `ae:${lid}->${lm.area}`,
        source: lid,
        target: `area:${lm.area}`,
        kind: 'uses',
      },
    });
  }
  cy.add(elements);
  cy.layout({ name: 'cose', padding: 30, animate: false } as any).run();
}

function updateSelectedLandmarksUI() {
  const card = document.getElementById('selected-landmarks-card')!;
  const list = document.getElementById('selected-landmarks-list')!;
  if (selectedLandmarks.size === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  list.innerHTML = [...selectedLandmarks]
    .map((n) => `<span class="badge" style="background:#3b0764;color:#e9d5ff;">${n}</span>`)
    .join(' ');
}

function updateChatContextBadge(text: string) {
  const badge = document.getElementById('chat-context')!;
  const clean = text.replace(/\s+/g, ' ').slice(0, 26);
  badge.textContent = `@${clean || 'map'}`;
}

cy.on('tap', 'node', (ev: any) => {
  const n = ev.target;
  const data = n.data();
  const shift = ev.originalEvent && (ev.originalEvent as MouseEvent).shiftKey;

  document.getElementById('node-kind')!.textContent = `${String(data.kind).toUpperCase()}${data.area ? ` · ${data.area}` : ''}`;
  document.getElementById('node-title')!.textContent = String(data.label).replace(/\n/g, ' — ');
  document.getElementById('node-detail')!.textContent = data.detail || data.label || '';

  const actions = document.getElementById('node-actions')!;
  actions.innerHTML = '';

  if (data.range) {
    vscode.postMessage({ type: 'revealRange', range: data.range });
  }

  if (data.kind === 'landmark') {
    const lmName = String(data.id).replace(/^a?lm:/, '');
    if (shift) {
      if (selectedLandmarks.has(lmName)) {
        selectedLandmarks.delete(lmName);
        n.removeClass('lm-selected');
      } else {
        selectedLandmarks.add(lmName);
        n.addClass('lm-selected');
      }
      updateSelectedLandmarksUI();
    }
    const btnToggle = document.createElement('button');
    btnToggle.textContent = selectedLandmarks.has(lmName) ? 'Remove from Combination' : '+ Select Landmark to Combine';
    btnToggle.onclick = () => {
      if (selectedLandmarks.has(lmName)) {
        selectedLandmarks.delete(lmName);
        n.removeClass('lm-selected');
      } else {
        selectedLandmarks.add(lmName);
        n.addClass('lm-selected');
      }
      updateSelectedLandmarksUI();
      btnToggle.textContent = selectedLandmarks.has(lmName) ? 'Remove from Combination' : '+ Select Landmark to Combine';
    };
    actions.appendChild(btnToggle);
  }

  if (data.kind === 'move' && Array.isArray(data.steps) && data.steps.length > 1) {
    const btnUnpack = document.createElement('button');
    btnUnpack.textContent = `Unpack (${data.steps.length} micro-steps)`;
    btnUnpack.onclick = () => vscode.postMessage({ type: 'unpackMove', steps: data.steps });
    actions.appendChild(btnUnpack);
  }

  if (data.kind === 'goal') {
    selectedGoalId = data.id;
    updateChatContextBadge(data.label);
    const btnChunk = document.createElement('button');
    btnChunk.textContent = 'I grok this — Chunk / Collapse';
    btnChunk.onclick = () => vscode.postMessage({ type: 'chunkGoal', goalId: data.id });
    actions.appendChild(btnChunk);
  }

  if (data.kind === 'frontier') {
    selectedGoalId = data.id;
    updateChatContextBadge(data.label);
    const btnExp = document.createElement('button');
    btnExp.textContent = '✦ Explore Branches in Worktrees';
    btnExp.onclick = () =>
      vscode.postMessage({
        type: 'exploreFrontier',
        goalId: data.id,
        selectedLandmarks: [...selectedLandmarks],
      });
    actions.appendChild(btnExp);
  }

  if (data.kind === 'ghost-move') {
    const parts = String(data.id).split(':');
    const frontierGoalId = parts[2];
    const branchIdx = Number(parts[3]);
    const btnApply = document.createElement('button');
    btnApply.textContent = '✓ Commit Verified Branch to .lean';
    btnApply.style.borderColor = '#10b981';
    btnApply.onclick = () => vscode.postMessage({ type: 'applyGhostBranch', frontierGoalId, branchIdx });
    actions.appendChild(btnApply);
  }
});

// Header controls
document.getElementById('tab-proof')!.onclick = () => {
  activeTab = 'proof';
  document.getElementById('tab-proof')!.classList.add('active');
  document.getElementById('tab-atlas')!.classList.remove('active');
  renderProofMap();
};

document.getElementById('tab-atlas')!.onclick = () => {
  activeTab = 'atlas';
  document.getElementById('tab-atlas')!.classList.add('active');
  document.getElementById('tab-proof')!.classList.remove('active');
  if (!currentAtlas) {
    vscode.postMessage({ type: 'runFix', command: 'graspt.buildAtlas' });
  } else {
    renderAtlasMap();
  }
};

document.querySelectorAll('[data-level]').forEach((btn) => {
  (btn as HTMLButtonElement).onclick = () => {
    document.querySelectorAll('[data-level]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    vscode.postMessage({ type: 'setLevel', level: Number((btn as HTMLElement).dataset.level) });
  };
});

document.getElementById('decl-select')!.onchange = (ev) => {
  const val = (ev.target as HTMLSelectElement).value;
  vscode.postMessage({ type: 'selectDecl', name: val });
};

document.getElementById('btn-explore')!.onclick = () => {
  vscode.postMessage({
    type: 'exploreFrontier',
    goalId: selectedGoalId,
    selectedLandmarks: [...selectedLandmarks],
  });
};

document.getElementById('btn-fit')!.onclick = () => cy.fit(undefined, 28);

document.getElementById('btn-meta-key')!.onclick = () => {
  const strip = document.getElementById('meta-key-strip')!;
  strip.classList.toggle('open');
  if (strip.classList.contains('open')) {
    (document.getElementById('meta-key-input') as HTMLInputElement).focus();
  }
};

document.getElementById('btn-save-meta-key')!.onclick = () => {
  const key = (document.getElementById('meta-key-input') as HTMLInputElement).value.trim();
  const model = (document.getElementById('meta-model-select') as HTMLSelectElement).value;
  vscode.postMessage({ type: 'saveMetaKey', key, model });
  (document.getElementById('meta-key-input') as HTMLInputElement).value = '';
  document.getElementById('meta-key-strip')!.classList.remove('open');
};

document.getElementById('btn-vscode-prompt-key')!.onclick = () => {
  vscode.postMessage({ type: 'promptMetaKey' });
};

document.getElementById('btn-doctor')!.onclick = () => {
  const strip = document.getElementById('doctor-strip')!;
  strip.classList.toggle('open');
  if (strip.classList.contains('open')) {
    vscode.postMessage({ type: 'refreshDoctor' });
  }
};

document.getElementById('btn-combine')!.onclick = () => {
  vscode.postMessage({
    type: 'exploreFrontier',
    goalId: selectedGoalId,
    selectedLandmarks: [...selectedLandmarks],
  });
};

document.getElementById('btn-clear-lm')!.onclick = () => {
  selectedLandmarks.clear();
  cy.nodes('.lm-selected').removeClass('lm-selected');
  updateSelectedLandmarksUI();
};

function sendChat() {
  const input = document.getElementById('chat-input') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const replyBox = document.getElementById('chat-reply')!;
  replyBox.style.display = 'block';
  replyBox.textContent = `You: ${text}\nThinking …`;
  vscode.postMessage({
    type: 'chat',
    text,
    goalId: selectedGoalId,
    selectedLandmarks: [...selectedLandmarks],
  });
}

document.getElementById('chat-send')!.onclick = sendChat;
document.getElementById('chat-input')!.onkeydown = (ev) => {
  if (ev.key === 'Enter') sendChat();
};

function highlightCursorLine(line: number) {
  cy.nodes().removeClass('active-cursor');
  cy.nodes('[kind = "move"]').forEach((n: any) => {
    const r = n.data('range');
    if (r && line >= r.startLine && line <= r.endLine) {
      n.addClass('active-cursor');
    }
  });
}

function renderDoctor(report: any, forceOpen?: boolean) {
  const strip = document.getElementById('doctor-strip')!;
  if (forceOpen || !report.ok) strip.classList.add('open');
  const grid = document.getElementById('doctor-grid')!;
  grid.innerHTML = '';
  for (const c of report.checks) {
    const card = document.createElement('div');
    card.className = `check-card ${c.status}`;
    const title = document.createElement('div');
    title.className = 'check-title';
    title.innerHTML = `<span>${c.label}</span><span>${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'}</span>`;
    const detail = document.createElement('div');
    detail.className = 'check-detail';
    detail.textContent = c.detail;
    card.appendChild(title);
    card.appendChild(detail);
    if (c.fix) {
      const btn = document.createElement('button');
      btn.style.marginTop = '4px';
      btn.textContent = c.fix.label;
      btn.onclick = () => vscode.postMessage({ type: 'runFix', command: c.fix.command });
      card.appendChild(btn);
    }
    grid.appendChild(card);
  }
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'status': {
      document.getElementById('status-text')!.textContent = msg.text;
      break;
    }
    case 'doctor': {
      renderDoctor(msg.report, msg.showModal);
      if (msg.metaConfig) {
        const btn = document.getElementById('btn-meta-key')!;
        btn.textContent = msg.metaConfig.hasKey ? '🔑 Meta Muse ✓' : '🔑 Meta Muse Key';
        btn.style.borderColor = msg.metaConfig.hasKey ? '#10b981' : '#f59e0b';
        const st = document.getElementById('meta-key-status')!;
        st.textContent = msg.metaConfig.hasKey ? `✓ Saved in pi (meta/${msg.metaConfig.model})` : 'No META_API_KEY saved yet';
        if (msg.metaConfig.model) {
          (document.getElementById('meta-model-select') as HTMLSelectElement).value = msg.metaConfig.model;
        }
      }
      break;
    }
    case 'atlas': {
      currentAtlas = msg.atlas;
      if (activeTab === 'atlas') renderAtlasMap();
      break;
    }
    case 'proofMap': {
      currentMap = msg.map;
      const sel = document.getElementById('decl-select') as HTMLSelectElement;
      sel.innerHTML = '';
      for (const d of msg.decls ?? []) {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = `${d.complete ? '✓' : '◎'} ${d.name}`;
        if (d.name === msg.map.decl) opt.selected = true;
        sel.appendChild(opt);
      }
      renderProofMap();
      if (msg.cursorLine) highlightCursorLine(msg.cursorLine);
      break;
    }
    case 'cursorLine': {
      highlightCursorLine(msg.line);
      break;
    }
    case 'exploreResult': {
      const replyBox = document.getElementById('chat-reply')!;
      replyBox.style.display = 'block';
      const lines = (msg.branches ?? []).map(
        (b: any) =>
          `  ${b.feasible ? (b.closesGoal ? '★ CLOSES GOAL' : '✓ feasible') : '✗ rejected'}  \`${b.candidate.tactic.replace(/\n/g, '; ')}\` (${b.elapsedMs}ms)`,
      );
      replyBox.textContent = `[${msg.agent}] ${msg.summary}\n${lines.join('\n')}`;
      break;
    }
    case 'chatReply': {
      const replyBox = document.getElementById('chat-reply')!;
      replyBox.style.display = 'block';
      replyBox.textContent = `[${msg.agent}] ${msg.text}`;
      break;
    }
  }
});

vscode.postMessage({ type: 'ready' });
