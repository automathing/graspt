import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTrace, normaliseSource, runGeneration, starterFallback } from '../apps/server/generate';
import type { TraceResult } from '../packages/core/types';

function fakeTrace(decls: TraceResult['decls'], messages: TraceResult['messages'] = []): TraceResult {
  return { file: 'Generated.lean', decls, messages, elapsedMs: 1, headerCached: false };
}
const goodDecl = { name: 'graspt_generated', startLine: 3, endLine: 4, steps: [], goals: [] };
const sorryDecl = { name: 'graspt_generated', startLine: 3, endLine: 4, goals: [], steps: [{ idx: 0, tactic: 'sorry', kind: 'tacticSorry', depth: 0, parent: null, startLine: 4, startCol: 2, endLine: 4, endCol: 7, before: [], after: [], constants: [], used: [] }] };

test('normaliseSource forces the header and rejects escape hatches', () => {
  assert.equal(normaliseSource('```lean\nimport Mathlib\ntheorem t : True := by trivial\n```'), 'import Mathlib.Tactic\n\ntheorem t : True := by trivial\n');
  assert.equal(normaliseSource('theorem t : True := by sorry'), undefined);
  assert.equal(normaliseSource('just prose, no code'), undefined);
});

test('checkTrace requires a declaration, no errors, and no sorry', () => {
  assert.equal(checkTrace(fakeTrace([goodDecl])).ok, true);
  assert.equal(checkTrace(fakeTrace([sorryDecl])).ok, false);
  assert.equal(checkTrace(fakeTrace([goodDecl], [{ severity: 'error', line: 1, col: 0, endLine: 1, endCol: 1, text: 'bad' }])).ok, false);
  assert.equal(checkTrace(fakeTrace([])).ok, false);
});

test('runGeneration repairs a rejected draft and succeeds on the second attempt', async () => {
  let asks = 0;
  const outcome = await runGeneration({
    ask: async () => { asks++; return '```lean\ntheorem graspt_generated : True := by trivial\n```'; },
    trace: async () => asks === 1 ? fakeTrace([sorryDecl]) : fakeTrace([goodDecl]),
  }, 'prove True');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.declName, 'graspt_generated');
});

test('runGeneration falls back to a pre-verified starter when the model keeps failing', async () => {
  const outcome = await runGeneration({
    ask: async () => 'no code at all',
    trace: async (_f, content) => content.includes('even_mul_succ_self') ? fakeTrace([goodDecl]) : fakeTrace([sorryDecl]),
  }, STARTER_PROMPT);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.source, 'starter-fallback');
});

test('runGeneration fails honestly when nothing checks', async () => {
  const outcome = await runGeneration({
    ask: async () => '```lean\ntheorem graspt_generated : True := by trivial\n```',
    trace: async () => fakeTrace([sorryDecl]),
  }, 'prove something unlisted');
  assert.equal(outcome.ok, false);
  assert.match(outcome.diagnostics.join(' '), /sorry/);
});

const STARTER_PROMPT = 'Prove that for every natural number n, n * (n + 1) is even.';

test('starterFallback only matches the maintained starter prompts', () => {
  assert.ok(starterFallback(STARTER_PROMPT));
  assert.ok(starterFallback('Prove that the sum of the first n odd numbers equals n^2.'));
  assert.equal(starterFallback('Prove Fermat for n=3'), undefined);
});
