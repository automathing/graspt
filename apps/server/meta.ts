import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

// Direct Meta AI API client — no agent CLI in between. This wraps exactly:
//   curl -X POST https://api.meta.ai/v1/responses \
//     -H "Authorization: Bearer $MODEL_API_KEY" -H "Content-Type: application/json" \
//     -d '{"model":"muse-wonder-1.0","input":[{"role":"user","content":[{"type":"input_text","text":"…"}]}],"stream":false}'
// implemented with fetch so the key never appears in process argv.
// Key env names: MODEL_API_KEY (canonical, per the curl) or META_API_KEY.
// META_API_BASE_URL overrides the endpoint (used by tests with a stub).

export const META_API_BASE = 'https://api.meta.ai/v1';
export const DEFAULT_MODEL = 'muse-wonder-1.0';

export interface Candidate { tactic: string; rationale?: string }
export interface MetaReply { agent: string; text: string; candidates: Candidate[]; error?: string }

// --- API key: runtime value from the UI, persisted server-side only (~/.graspt, 0600). Never returned by any API.
let runtimeKey: string | undefined;
function grasptHome(): string { return path.join(os.homedir(), '.graspt'); }
function keyFile(): string { return path.join(grasptHome(), '.meta_api_key'); }

/**
 * Users paste all kinds of shapes into the key box: the bare token, a
 * `Bearer …` header, or the whole example curl command. Extract the token;
 * anything else returns undefined so the caller can reject it instead of
 * silently storing garbage that will 401 forever.
 */
export function extractApiKey(input: string | undefined): string | undefined {
  const raw = (input ?? '').trim();
  if (!raw) return undefined;
  const bearer = raw.match(/Bearer\s+([A-Za-z0-9\-._~+/=]+)/);
  if (bearer) return bearer[1];
  const token = raw.replace(/^["']|["']$/g, '');
  if (/^[A-Za-z0-9\-._~+/=]+$/.test(token)) return token;
  return undefined;
}

/** Also pull `"model": "…"` out of a pasted curl, if present. */
export function extractModel(input: string | undefined): string | undefined {
  const m = (input ?? '').match(/"model"\s*:\s*"([^"]+)"/);
  return m ? m[1] : undefined;
}

export function setMetaApiKey(key: string | undefined): void {
  runtimeKey = extractApiKey(key);
  try {
    fs.mkdirSync(grasptHome(), { recursive: true });
    if (runtimeKey) fs.writeFileSync(keyFile(), runtimeKey, { mode: 0o600 });
    else if (fs.existsSync(keyFile())) fs.unlinkSync(keyFile());
  } catch { /* in-memory value still applies */ }
}

export function getMetaApiKey(): string | undefined {
  if (runtimeKey) return runtimeKey;
  if (process.env.MODEL_API_KEY?.trim()) return process.env.MODEL_API_KEY.trim();
  if (process.env.META_API_KEY?.trim()) return process.env.META_API_KEY.trim();
  try {
    const k = fs.readFileSync(keyFile(), 'utf8').trim();
    if (k) return k;
  } catch { /* no stored key */ }
  return undefined;
}

export function hasMetaApiKey(): boolean { return !!getMetaApiKey(); }

// --- Model selection (persisted server-side, default muse-wonder-1.0)
let runtimeModel: string | undefined;
function modelFile(): string { return path.join(grasptHome(), '.meta_model'); }

export function setModel(model: string | undefined): void {
  runtimeModel = model?.trim() || undefined;
  try {
    fs.mkdirSync(grasptHome(), { recursive: true });
    if (runtimeModel) fs.writeFileSync(modelFile(), runtimeModel, 'utf8');
    else if (fs.existsSync(modelFile())) fs.unlinkSync(modelFile());
  } catch { /* in-memory still applies */ }
}

export function metaModel(): string {
  if (runtimeModel) return runtimeModel;
  try {
    const saved = fs.readFileSync(modelFile(), 'utf8').trim();
    if (saved) return saved;
  } catch { /* not set */ }
  return process.env.GRASPT_MODEL?.trim() || DEFAULT_MODEL;
}

export function metaStatus(): { preset: string; agent: string | null; available: string[]; hasMetaKey: boolean; model: string; hint: string } {
  const model = metaModel();
  const has = hasMetaApiKey();
  return {
    preset: 'meta',
    agent: has ? `Meta AI (${model})` : null,
    available: [],
    hasMetaKey: has,
    model,
    hint: has ? `Chat is answered by Meta AI (${model}) via api.meta.ai.` : 'No Meta API key saved. Paste your key (MODEL_API_KEY) in the box next to the chat.',
  };
}

export interface Position {
  declName: string;
  goal: string;
  goalNodeId?: string;
  trail: string[];
  landmarks: { name: string; nodeId: string; area: string; tacticSuggestion?: string }[];
  neighbours: string[];
}

export function chatPrompt(p: Position, question: string): string {
  return [
    'You are the AI inside Graspt, an allocentric topological proof navigator for Lean 4 + Mathlib.',
    'The human navigates a map of the proof; you are their symbolic partner. Answer briefly and concretely, in the language of the human\'s question.',
    'Lean DTT frame: a place is a goal Γ ⊢ T; a tactic is a partial function Goal → List Goal; a landmark is a named declaration whose type unifies against T (apply/exact) or rewrites it (rw).',
    `Declaration: ${p.declName}`,
    p.goalNodeId ? `Current place node id: ${p.goalNodeId} — cite graph nodes exactly like (node: ${p.goalNodeId}) when you refer to them. Never invent node ids.` : '',
    'Current goal (Lean pretty-printed, hypotheses above ⊢):',
    '```',
    p.goal,
    '```',
    p.trail.length ? `Trail from root: ${p.trail.join(' ; ')}` : 'At the root goal.',
    p.neighbours.length ? `Nearest neighbours: ${p.neighbours.join(' | ')}` : '',
    p.landmarks.length ? `Nearby landmarks:\n${p.landmarks.map((l) => `  - (node: ${l.nodeId}) ${l.name} [${l.area}]${l.tacticSuggestion ? ` — suggested: ${l.tacticSuggestion}` : ''}`).join('\n')}` : '',
    '',
    `Human: ${question}`,
    '',
    'If you suggest tactics, ALSO append a JSON array on its own last line, e.g. [{"tactic": "apply Foo.bar", "rationale": "unifies with the target"}]. Suggestions are unverified until Lean checks them — say so.',
  ].filter(Boolean).join('\n');
}

export function parseCandidates(text: string): Candidate[] {
  const matches = [...text.matchAll(/\[[\s\S]*?\](?=\s*(```)?\s*$)|\[\s*\{[\s\S]*?\}\s*\]/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const arr = JSON.parse(matches[i][0]);
      if (Array.isArray(arr)) {
        return arr.filter((c) => c && typeof c.tactic === 'string' && c.tactic.trim())
          .map((c) => ({ tactic: String(c.tactic).trim(), rationale: c.rationale ? String(c.rationale) : undefined }));
      }
    } catch { /* try previous */ }
  }
  return [];
}

/** Extract assistant text from a Responses API payload (`output_text` or output[].content[]). */
export function extractOutputText(data: unknown): string {
  const d = data as { output_text?: string; output?: { content?: { type?: string; text?: string }[] }[] };
  if (typeof d?.output_text === 'string' && d.output_text.trim()) return d.output_text.trim();
  const parts: string[] = [];
  for (const item of d?.output ?? []) {
    for (const c of item?.content ?? []) {
      if ((c.type === 'output_text' || c.type === 'text') && typeof c.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Ask Meta AI via the Vercel AI SDK. The SDK's OpenAI provider is pointed at
 * Meta's API base and used through its Responses API surface, which is the
 * same POST /v1/responses the raw curl used — the SDK just owns the wire
 * format, parsing, and errors. API key never leaves the Authorization header.
 */
export async function askMeta(prompt: string): Promise<MetaReply> {
  const model = metaModel();
  const agent = `Meta AI (${model})`;
  const key = getMetaApiKey();
  if (!key) return { agent: 'none', text: '', candidates: [], error: 'NO_KEY' };
  const base = (process.env.META_API_BASE_URL ?? META_API_BASE).replace(/\/$/, '');
  const timeoutMs = Number(process.env.META_TIMEOUT_SEC ?? 120) * 1000;
  try {
    const meta = createOpenAI({ name: 'meta', apiKey: key, baseURL: `${base}/` });
    const { text } = await generateText({
      model: meta.responses(model),
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const clean = text.trim();
    if (!clean) return { agent, text: '', candidates: [], error: 'Meta API returned no text.' };
    return { agent, text: clean, candidates: parseCandidates(clean) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
    // Surface the API's own status/message (e.g. 401 invalid_api_key) instead of SDK noise.
    const status = (e as { statusCode?: number })?.statusCode;
    return {
      agent,
      text: '',
      candidates: [],
      error: timedOut ? `Meta API timed out after ${timeoutMs / 1000}s.` : `Meta API${status ? ` HTTP ${status}` : ''}: ${msg.slice(0, 400)}`,
    };
  }
}
