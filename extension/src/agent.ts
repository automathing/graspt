import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENTS } from './doctor';
import { grasptStateDir, run, which, workspaceRoot } from './util';

/**
 * Agent bridge centered on `pi` (pi.dev) running Meta's Muse AI models (`meta/muse-spark-1.3`,
 * `meta/muse-wonder-1.0`, etc.), while remaining compatible with Claude Code, Codex, and OpenCode.
 */

export interface Candidate {
  tactic: string;
  rationale?: string;
}

export interface AgentReply {
  agent: string;
  text: string;
  candidates: Candidate[];
  error?: string;
}

let cachedSecretKey: string | undefined;

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

/**
 * Stores the Meta AI (`META_API_KEY`) credential directly into `~/.pi/agent/auth.json` and
 * sets the selected `meta/<muse-model>` in `~/.pi/agent/settings.json` so `pi` uses Meta's
 * Muse AI model both inside Graspt and in any interactive terminal session.
 */
export function setRuntimeMetaApiKey(key: string | undefined, model?: string) {
  cachedSecretKey = key?.trim() || undefined;
  const dir = grasptStateDir();
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const keyFile = path.join(dir, '.meta_api_key');
      if (cachedSecretKey) {
        fs.writeFileSync(keyFile, cachedSecretKey, { mode: 0o600 });
      } else if (fs.existsSync(keyFile)) {
        fs.unlinkSync(keyFile);
      }
    } catch {
      /* ignore */
    }
  }

  // Sync into ~/.pi/agent/auth.json and ~/.pi/agent/settings.json
  try {
    const pDir = piAgentDir();
    fs.mkdirSync(pDir, { recursive: true });
    const authPath = path.join(pDir, 'auth.json');
    let authObj: Record<string, any> = {};
    if (fs.existsSync(authPath)) {
      try {
        authObj = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      } catch {
        authObj = {};
      }
    }
    if (cachedSecretKey) {
      authObj.meta = { type: 'api_key', key: cachedSecretKey };
    } else {
      delete authObj.meta;
    }
    fs.writeFileSync(authPath, JSON.stringify(authObj, null, 2), { mode: 0o600 });

    if (model) {
      const settingsPath = path.join(pDir, 'settings.json');
      let settingsObj: Record<string, any> = {};
      if (fs.existsSync(settingsPath)) {
        try {
          settingsObj = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch {
          settingsObj = {};
        }
      }
      const fullModel = model.startsWith('meta/') ? model : `meta/${model}`;
      settingsObj.model = fullModel;
      fs.writeFileSync(settingsPath, JSON.stringify(settingsObj, null, 2), 'utf8');
    }
  } catch {
    /* ignore */
  }
}

export function getMetaApiKey(): string | undefined {
  if (cachedSecretKey) return cachedSecretKey;
  const cfgKey = vscode.workspace.getConfiguration('graspt').get<string>('metaAi.apiKey')?.trim();
  if (cfgKey) return cfgKey;
  const envKey = process.env.META_API_KEY?.trim();
  if (envKey) return envKey;
  // Check ~/.pi/agent/auth.json
  try {
    const authPath = path.join(piAgentDir(), 'auth.json');
    if (fs.existsSync(authPath)) {
      const authObj = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (typeof authObj?.meta?.key === 'string' && authObj.meta.key.trim()) {
        return authObj.meta.key.trim();
      }
    }
  } catch {
    /* ignore */
  }
  const dir = grasptStateDir();
  if (dir) {
    const keyFile = path.join(dir, '.meta_api_key');
    if (fs.existsSync(keyFile)) {
      try {
        const k = fs.readFileSync(keyFile, 'utf8').trim();
        if (k) return k;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export function getMetaAiConfig(): { apiKey?: string; model: string } {
  const cfg = vscode.workspace.getConfiguration('graspt');
  return {
    apiKey: getMetaApiKey(),
    model: cfg.get<string>('metaAi.model') || 'muse-spark-1.3',
  };
}

export async function resolveAgent(): Promise<{ id: string; argv: string[] } | undefined> {
  const cfg = vscode.workspace.getConfiguration('graspt');
  const preset = cfg.get<string>('agent.preset') ?? 'pi';
  const meta = getMetaAiConfig();
  const museModel = meta.model.startsWith('meta/') ? meta.model : `meta/${meta.model}`;

  const presets: Record<string, string[]> = {
    pi: meta.apiKey
      ? ['pi', '-p', '--no-session', '--no-tools', '--model', museModel, '--api-key', meta.apiKey, '{prompt}']
      : ['pi', '-p', '--no-session', '--no-tools', '--model', museModel, '{prompt}'],
    claude: ['claude', '-p', '{prompt}'],
    codex: ['codex', 'exec', '{prompt}'],
    opencode: ['opencode', 'run', '{prompt}'],
  };

  if (preset === 'none') return undefined;
  if (preset === 'custom') {
    const argv = cfg.get<string[]>('agent.command') ?? [];
    return argv.length ? { id: argv[0], argv } : undefined;
  }
  if (preset !== 'auto' && presets[preset]) {
    return { id: preset === 'pi' ? `pi (${museModel})` : preset, argv: presets[preset] };
  }
  for (const a of AGENTS) {
    if (await which(a.bin)) {
      return { id: a.id === 'pi' ? `pi (${museModel})` : a.id, argv: presets[a.id] };
    }
  }
  return undefined;
}

export interface Position {
  declName: string;
  goal: string;
  trail: string[];
  landmarks: string[];
  selected: string[];
  fileExcerpt: string;
}

export function explorePrompt(p: Position, k = 4): string {
  return [
    'You are the symbolic motor controller for Graspt, a map-based Lean 4 proof navigator.',
    'The human navigates the map; you propose concrete Lean 4 tactic scripts. Lean will verify every proposal.',
    '',
    `Declaration: ${p.declName}`,
    'Current frontier goal (Lean pretty-printed, hypotheses above ⊢):',
    '```',
    p.goal,
    '```',
    p.trail.length ? `Trail so far (tactics already applied):\n${p.trail.map((t) => `  ${t}`).join('\n')}` : '',
    p.landmarks.length ? `Landmarks already used nearby: ${p.landmarks.join(', ')}` : '',
    p.selected.length ? `The human selected these landmarks to COMBINE: ${p.selected.join(', ')} — prefer branches that use them.` : '',
    'Relevant file excerpt:',
    '```lean',
    p.fileExcerpt,
    '```',
    '',
    `Propose ${k} diverse candidate branches. Each is a short Lean 4 tactic script (1-4 lines, newline separated) that makes progress on the goal; it does not need to close it.`,
    'Use only Lean 4 / Mathlib syntax. Reply with ONLY a JSON array, no prose, like:',
    '[{"tactic": "rcases h with ⟨x, rfl⟩\\nsimp", "rationale": "unpack the witness"}]',
  ]
    .filter(Boolean)
    .join('\n');
}

export function chatPrompt(p: Position, question: string): string {
  return [
    'You are the agent inside Graspt, a map-based Lean 4 proof navigator. Answer briefly (≤ 8 lines) and concretely.',
    `Declaration: ${p.declName}`,
    'Selected position on the map:',
    '```',
    p.goal,
    '```',
    p.trail.length ? `Trail: ${p.trail.join(' ; ')}` : '',
    p.selected.length ? `Selected landmarks: ${p.selected.join(', ')}` : '',
    '',
    `Human: ${question}`,
    '',
    'If you suggest tactics, ALSO append a JSON array on its own last line: [{"tactic": "...", "rationale": "..."}]',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseCandidates(text: string): Candidate[] {
  const matches = [...text.matchAll(/\[[\s\S]*?\](?=\s*(```)?\s*$)|\[\s*\{[\s\S]*?\}\s*\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse(matches[i][0]);
      if (Array.isArray(arr)) {
        return arr
          .filter((c) => c && typeof c.tactic === 'string' && c.tactic.trim())
          .map((c) => ({ tactic: String(c.tactic).trim(), rationale: c.rationale ? String(c.rationale) : undefined }));
      }
    } catch {
      /* try previous */
    }
  }
  return [];
}

export async function askAgent(prompt: string): Promise<AgentReply> {
  const agent = await resolveAgent();
  if (!agent) {
    return {
      agent: 'none',
      text: '',
      candidates: [],
      error: 'No agent configured. Click "🔑 Meta Muse Key" in the header to set your META_API_KEY for pi.',
    };
  }
  const metaKey = getMetaApiKey();
  if (metaKey) {
    process.env.META_API_KEY = metaKey;
  }
  const timeoutMs = (vscode.workspace.getConfiguration('graspt').get<number>('agent.timeoutSec') ?? 120) * 1000;
  const argv = agent.argv.map((a) => (a === '{prompt}' ? prompt : a));
  const r = await run(argv[0], argv.slice(1), { cwd: workspaceRoot(), timeoutMs });
  const text = r.stdout.trim();
  if (r.timedOut) return { agent: agent.id, text, candidates: parseCandidates(text), error: `agent timed out after ${timeoutMs / 1000}s` };
  if (r.code !== 0 && !text) return { agent: agent.id, text: r.stderr.trim(), candidates: [], error: `agent exited with code ${r.code}: ${r.stderr.trim().slice(0, 400)}` };
  return { agent: agent.id, text, candidates: parseCandidates(text) };
}

/** Deterministic "hammer sweep": always available, no LLM needed. */
export function sweepCandidates(selected: string[]): Candidate[] {
  const base = ['simp', 'omega', 'decide', 'norm_num', 'ring', 'linarith', 'positivity', 'simp_all', 'aesop', 'tauto'];
  const out: Candidate[] = [];
  for (const l of selected) {
    out.push({ tactic: `exact ${l}`, rationale: `close directly with ${l}` });
    out.push({ tactic: `apply ${l}`, rationale: `reduce to the premises of ${l}` });
    out.push({ tactic: `rw [${l}]`, rationale: `rewrite with ${l}` });
    out.push({ tactic: `simp [${l}]`, rationale: `simplify using ${l}` });
  }
  for (const t of base) out.push({ tactic: t, rationale: 'built-in automation sweep' });
  return out;
}
