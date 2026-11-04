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

export interface Acceptance { ok: boolean; diagnostics: string[] }

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
  return { ok: diagnostics.length === 0, diagnostics };
}
