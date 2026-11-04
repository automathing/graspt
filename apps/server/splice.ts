import type { DeclTrace, Step, TraceResult } from '../../packages/core/types';

// The one verified action between chat and map: splice a candidate tactic
// over a `sorry` step in the source, re-elaborate, and accept only when
// Lean reports no errors and that frontier's sorry is gone.

export interface SourceRange { startLine: number; startCol: number; endLine: number; endCol: number }

/** Replace the source range of a step (1-based lines, 0-based cols, as the tracer emits). */
export function replaceRange(source: string, range: SourceRange, replacement: string): string {
  const lines = source.split('\n');
  const startIdx = range.startLine - 1;
  const endIdx = range.endLine - 1;
  if (startIdx < 0 || endIdx >= lines.length || startIdx > endIdx) {
    throw new Error(`source range out of bounds: lines ${range.startLine}-${range.endLine} of ${lines.length}`);
  }
  const before = lines[startIdx].slice(0, range.startCol);
  const after = lines[endIdx].slice(range.endCol);
  const merged = before + replacement + after;
  return [...lines.slice(0, startIdx), merged, ...lines.slice(endIdx + 1)].join('\n');
}

/**
 * Validate a chat-suggested tactic for splicing. Single line only; the
 * Lean elaboration that follows is the real gate, this just refuses
 * shapes that can never be a frontier tactic.
 */
export function cleanTactic(raw: string): string {
  const t = (raw ?? '').trim();
  if (!t) throw new Error('empty tactic');
  if (/\n/.test(t)) throw new Error('multi-line tactics are not supported in the demo slice; suggest one line');
  if (/\bsorry\b|\baxiom\b|\bnative_decide\b|\bunsafe\b/.test(t)) throw new Error('tactic uses sorry/axiom/native_decide/unsafe — not a proof');
  return t;
}

/** The sorry step standing at a goal (or the declaration's first sorry when no goal is named). */
export function findSorryStep(decl: DeclTrace, goalId?: string): Step | undefined {
  const sorries = decl.steps.filter((s) => s.tactic.trim() === 'sorry');
  if (!sorries.length) return undefined;
  if (goalId) {
    const atGoal = sorries.find((s) => s.before.includes(goalId));
    if (atGoal) return atGoal;
  }
  return sorries[0];
}

export function sorryCount(decl: DeclTrace | undefined): number {
  return decl ? decl.steps.filter((s) => s.tactic.trim() === 'sorry').length : 0;
}

export const MAX_REPAIR_ROUNDS = 4;

export interface Acceptance {
  ok: boolean;
  kind?: 'closed' | 'advanced' | 'rejected';
  diagnostics: string[];
  unsolvedGoalPp?: string;
}

/**
 * Replace a single-line sorry with `tactic` followed by `sorry` on a new
 * indented line so an advancing tactic (e.g. `intro`, `rw`, `apply`) can
 * Elaborate cleanly and leave its new subgoals as open frontiers on the map.
 */
export function replaceRangeWithSorry(source: string, range: SourceRange, tactic: string): string {
  const indent = ' '.repeat(Math.max(0, range.startCol));
  return replaceRange(source, range, `${tactic}\n${indent}sorry`);
}

/**
 * Lean disposes: accept only when the re-elaborated trace has no error
 * messages and the target declaration lost at least one sorry.
 */
export function judgeApplication(before: DeclTrace, after: TraceResult, declName: string): Acceptance {
  const diagnostics: string[] = [];
  if (after.error) diagnostics.push(after.error);
  for (const m of after.messages ?? []) {
    if (m.severity === 'error') diagnostics.push(`line ${m.line}: ${m.text}`);
  }
  const afterDecl = (after.decls ?? []).find((d) => d.name === declName);
  if (!afterDecl) diagnostics.push(`declaration ${declName} no longer elaborates`);
  else if (sorryCount(afterDecl) >= sorryCount(before)) {
    diagnostics.push('the frontier is still open (sorry remains) — the tactic did not close this goal');
  }
  const ok = diagnostics.length === 0;
  return { ok, kind: ok ? 'closed' : 'rejected', diagnostics };
}

/**
 * Check whether an advancing tactic (spliced as `tactic\n  sorry`) genuinely
 * transformed the frontier into a *new* subgoal (canonical Γ ⊢ T changed)
 * with zero Lean error diagnostics.
 */
export function judgeAdvancingApplication(before: DeclTrace, after: TraceResult, declName: string, beforeGoalTarget?: string): Acceptance {
  const diagnostics: string[] = [];
  if (after.error) diagnostics.push(after.error);
  for (const m of after.messages ?? []) {
    if (m.severity === 'error') diagnostics.push(`line ${m.line}: ${m.text}`);
  }
  const afterDecl = (after.decls ?? []).find((d) => d.name === declName);
  if (!afterDecl) {
    diagnostics.push(`declaration ${declName} no longer elaborates`);
    return { ok: false, kind: 'rejected', diagnostics };
  }
  if (diagnostics.length > 0) return { ok: false, kind: 'rejected', diagnostics };
  const afterSorry = findSorryStep(afterDecl);
  const afterGoal = afterSorry ? afterDecl.goals.find((g) => afterSorry.before.includes(g.id)) : undefined;
  const changed = (afterDecl.goals.length > before.goals.length) || (afterGoal && beforeGoalTarget && afterGoal.target.trim() !== beforeGoalTarget.trim());
  if (!changed) {
    return { ok: false, kind: 'rejected', diagnostics: ['tactic made no progress on the goal state'] };
  }
  return { ok: true, kind: 'advanced', diagnostics: [], unsolvedGoalPp: afterGoal?.pp ?? afterGoal?.target };
}

export interface TryStepLog {
  round: number;
  tactic: string;
  outcome: 'closed' | 'advanced' | 'rejected';
  detail: string;
}

export function tacticRepairPrompt(
  declName: string,
  goalPp: string,
  landmarks: string[],
  tried: TryStepLog[],
): string {
  return [
    `We are trying to close or advance an open frontier in Lean 4 declaration \`${declName}\`.`,
    'Current goal (Γ ⊢ T):',
    '```',
    goalPp,
    '```',
    landmarks.length ? `Available nearby landmarks: ${landmarks.join(', ')}` : '',
    'Previous tactic attempts rejected by the Lean kernel:',
    ...tried.map((t) => `  - Round ${t.round}: \`${t.tactic}\` → ${t.detail}`),
    '',
    'Propose 1 to 3 DIFFERENT single-line Lean 4 tactics that either close this goal outright OR make a meaningful step (e.g. `exact ...`, `apply ...`, `rw [...]`, `omega`, `ring`, `simp [...]`, `linarith`, ` decide`).',
    'Rules: single-line tactics only; never use sorry, axiom, native_decide, or unsafe.',
    'Reply ONLY with a JSON array of objects: [{"tactic": "...", "rationale": "..."}]',
  ].filter(Boolean).join('\n');
}
