import type { TraceResult } from '../../packages/core/types';
import { askMeta } from './meta';

// Scratch generation: conversational intent -> whole-file Lean draft ->
// tracer elaboration -> diagnostic-driven repair -> verified trace.
// The kernel, not the model, decides success: a result is only ever
// registered as a repo when Lean elaborated it with no errors and no sorry.

export const STANDARD_HEADER = 'import Mathlib.Tactic';
export const MAX_ATTEMPTS = 3;

const FORBIDDEN = [/\bsorry\b/, /\baxiom\b/, /\bnative_decide\b/, /\bunsafe\b/, /#eval/, /#print\s+axioms/];

/** Extract Lean code from a model reply (fenced block preferred). */
export function extractLeanCode(text: string): string {
  const fenced = text.match(/```(?:lean)?\s*\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const trimmed = (text ?? '').trim();
  return /\b(theorem|lemma|def|example)\b/.test(trimmed) ? trimmed : '';
}

/** Force the standard header and reject escape hatches. Undefined = unacceptable. */
export function normaliseSource(raw: string): string | undefined {
  const code = extractLeanCode(raw);
  if (!code) return undefined;
  if (FORBIDDEN.some((re) => re.test(code))) return undefined;
  if (!/\b(theorem|lemma|example)\b/.test(code)) return undefined;
  const body = code.split('\n').filter((l) => !/^\s*(public\s+)?import\s/.test(l)).join('\n').trim();
  if (!body) return undefined;
  return `${STANDARD_HEADER}\n\n${body}\n`;
}

export interface TraceCheck { ok: boolean; diagnostics: string[] }

export function checkTrace(trace: TraceResult): TraceCheck {
  const diagnostics: string[] = [];
  if (trace.error) diagnostics.push(trace.error);
  for (const m of trace.messages ?? []) {
    if (m.severity === 'error') diagnostics.push(`line ${m.line}: ${m.text}`);
    else if (/sorry/i.test(m.text)) diagnostics.push(`line ${m.line}: ${m.text}`);
  }
  if ((trace.decls ?? []).length === 0) diagnostics.push('no declaration was elaborated');
  for (const d of trace.decls ?? []) {
    if (d.steps.some((s) => s.tactic.trim() === 'sorry')) diagnostics.push(`${d.name} still contains a sorry`);
  }
  return { ok: diagnostics.length === 0, diagnostics };
}

export function generationPrompt(userPrompt: string): string {
  return [
    'Write one short, self-contained Lean 4 proof. Reply with Lean code only, in a single ```lean fenced block.',
    `The file will start with "${STANDARD_HEADER}" — do not add any other import.`,
    'Rules: no sorry, no axiom, no native_decide, no unsafe, no #eval. Name the theorem graspt_generated. State the theorem exactly as the problem asks.',
    '',
    `Problem: ${userPrompt}`,
  ].join('\n');
}

export function repairPrompt(userPrompt: string, code: string, diagnostics: string[]): string {
  return [
    generationPrompt(userPrompt),
    '',
    'Your previous attempt failed Lean elaboration. Fix it; reply with the whole corrected file in one ```lean block.',
    'Previous attempt:',
    '```lean', code, '```',
    'Lean diagnostics:',
    diagnostics.slice(0, 12).join('\n'),
  ].join('\n');
}

/**
 * Pre-verified fallbacks for the three maintained starter prompts. Demo
 * insurance: if the live model cannot produce a checkable proof, a starter
 * still opens a real, Lean-verified map — labelled as a fallback, never
 * passed off as the model's work.
 */
export const STARTER_FALLBACKS: { match: RegExp; code: string }[] = [
  {
    match: /n\s*\*\s*\(n \+ 1\).*even|even.*n\s*\*\s*\(n \+ 1\)/i,
    code: `${STANDARD_HEADER}\n\ntheorem graspt_generated (n : ℕ) : 2 ∣ n * (n + 1) := by\n  exact (Nat.even_mul_succ_self n).two_dvd\n`,
  },
  {
    match: /sum of the first n odd/i,
    code: `${STANDARD_HEADER}\n\ntheorem graspt_generated (n : ℕ) : ∑ i ∈ Finset.range n, (2 * i + 1) = n ^ 2 := by\n  induction n with\n  | zero => simp\n  | succ n ih =>\n    rw [Finset.sum_range_succ, ih]\n    ring\n`,
  },
  {
    match: /revers.*twice|reverse.*reverse/i,
    code: `${STANDARD_HEADER}\n\ntheorem graspt_generated (xs : List ℕ) : xs.reverse.reverse = xs := by\n  induction xs with\n  | nil => rfl\n  | cons a xs ih => simp [List.reverse_cons, ih]\n`,
  },
];

export function starterFallback(prompt: string): string | undefined {
  return STARTER_FALLBACKS.find((f) => f.match.test(prompt))?.code;
}

export interface GenerationDeps {
  ask: (prompt: string) => Promise<string>;
  trace: (file: string, content: string) => Promise<TraceResult>;
  maxAttempts?: number;
}

export interface GenerationOutcome {
  ok: boolean;
  code?: string;
  trace?: TraceResult;
  declName?: string;
  attempts: number;
  diagnostics: string[];
  source: 'ai' | 'starter-fallback';
  stage: 'drafting' | 'elaborating' | 'repairing' | 'ready' | 'failed';
}

export async function runGeneration(
  deps: GenerationDeps,
  userPrompt: string,
  onStage?: (stage: GenerationOutcome['stage'], attempt: number) => void,
): Promise<GenerationOutcome> {
  const max = deps.maxAttempts ?? MAX_ATTEMPTS;
  let diagnostics: string[] = [];
  let code = '';
  for (let attempt = 1; attempt <= max; attempt++) {
    onStage?.(attempt === 1 ? 'drafting' : 'repairing', attempt);
    const reply = await deps.ask(attempt === 1 ? generationPrompt(userPrompt) : repairPrompt(userPrompt, code, diagnostics));
    const normalised = normaliseSource(reply);
    if (!normalised) {
      diagnostics = ['model reply contained no acceptable Lean code (missing theorem, or used sorry/axiom/native_decide/unsafe)'];
      code = extractLeanCode(reply);
      continue;
    }
    code = normalised;
    onStage?.('elaborating', attempt);
    const trace = await deps.trace('Generated.lean', code);
    const check = checkTrace(trace);
    if (check.ok) {
      return { ok: true, code, trace, declName: trace.decls[0]?.name, attempts: attempt, diagnostics: [], source: 'ai', stage: 'ready' };
    }
    diagnostics = check.diagnostics;
  }
  // Live generation failed: try the maintained starter fallback, still gated by Lean.
  const fallback = starterFallback(userPrompt);
  if (fallback) {
    onStage?.('elaborating', max);
    const trace = await deps.trace('Generated.lean', fallback);
    const check = checkTrace(trace);
    if (check.ok) {
      return { ok: true, code: fallback, trace, declName: trace.decls[0]?.name, attempts: max, diagnostics: [], source: 'starter-fallback', stage: 'ready' };
    }
    diagnostics = [...diagnostics, `starter fallback also failed: ${check.diagnostics.join(' | ')}`];
  }
  return { ok: false, code, attempts: max, diagnostics, source: 'ai', stage: 'failed' };
}

// ---- scratch generation jobs ----

export type ScratchJobState = 'drafting' | 'elaborating' | 'repairing' | 'ready' | 'failed';
export interface ScratchJob {
  id: string;
  prompt: string;
  state: ScratchJobState;
  detail: string;
  attempts: number;
  repoId?: string;
  declName?: string;
  code?: string;
  source?: GenerationOutcome['source'];
  diagnostics: string[];
}

const jobs = new Map<string, ScratchJob>();
let seq = 0;

export function getScratchJob(id: string) { return jobs.get(id); }

export function startScratchGeneration(
  prompt: string,
  traceFn: (file: string, content: string) => Promise<TraceResult>,
  onReady: (job: ScratchJob, trace: TraceResult) => void,
): ScratchJob {
  const job: ScratchJob = {
    id: `scratch-${Date.now()}-${++seq}`, prompt: prompt.trim(), state: 'drafting',
    detail: 'drafting with Meta AI…', attempts: 0, diagnostics: [],
  };
  jobs.set(job.id, job);
  void (async () => {
    try {
      const outcome = await runGeneration(
        { ask: async (p) => { const r = await askMeta(p); if (!r.text) throw new Error(r.error ?? 'Meta AI returned no text'); return r.text; }, trace: traceFn },
        job.prompt,
        (stage, attempt) => {
          job.state = stage; job.attempts = attempt;
          job.detail = stage === 'drafting' ? 'drafting with Meta AI…'
            : stage === 'repairing' ? `Lean rejected the draft — repairing (attempt ${attempt} of ${MAX_ATTEMPTS})…`
            : 'Lean is elaborating the draft…';
        },
      );
      job.attempts = outcome.attempts;
      job.diagnostics = outcome.diagnostics;
      if (outcome.ok && outcome.trace && outcome.code) {
        job.code = outcome.code;
        job.declName = outcome.declName;
        job.source = outcome.source;
        job.state = 'ready';
        job.detail = outcome.source === 'starter-fallback'
          ? 'the live model could not produce a checkable proof, so a pre-verified starter was used — Lean verified it'
          : `verified by Lean in ${outcome.attempts} attempt(s)`;
        onReady(job, outcome.trace);
      } else {
        job.state = 'failed';
        job.detail = `could not produce a Lean-verified proof after ${outcome.attempts} attempt(s): ${outcome.diagnostics[0] ?? 'unknown error'}`;
      }
    } catch (e) {
      job.state = 'failed';
      job.detail = e instanceof Error ? e.message : String(e);
    }
  })();
  return job;
}
