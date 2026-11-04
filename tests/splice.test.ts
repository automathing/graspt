import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { cleanTactic, findSorryStep, judgeApplication, replaceRange } from '../apps/server/splice';
import type { TraceResult } from '../packages/core/types';

const basicsSource = fs.readFileSync(path.join(__dirname, '..', '..', 'lean', 'Demo', 'Basics.lean'), 'utf8');
const basicsTrace = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'demo', 'basics.trace.json'), 'utf8')) as TraceResult;
const twoDvd = basicsTrace.decls.find((d) => d.name === 'two_dvd_mul_succ')!;

test('findSorryStep locates the frontier sorry of two_dvd_mul_succ', () => {
  const step = findSorryStep(twoDvd, twoDvd.goals[0].id);
  assert.ok(step);
  assert.equal(step!.tactic, 'sorry');
});

test('replaceRange splices a tactic exactly over the sorry token', () => {
  const step = findSorryStep(twoDvd)!;
  const out = replaceRange(basicsSource, step, 'exact (Nat.even_mul_succ_self n).two_dvd');
  const lines = out.split('\n');
  assert.equal(lines[step.startLine - 1].trim(), 'exact (Nat.even_mul_succ_self n).two_dvd');
  assert.ok(!out.includes('sorry'));
  // Neighbouring declarations untouched.
  assert.ok(out.includes('theorem compact_image_closed'));
  assert.ok(out.includes('theorem even_add_even'));
});

test('cleanTactic refuses empty, multi-line, and escape-hatch tactics', () => {
  assert.throws(() => cleanTactic('  '));
  assert.throws(() => cleanTactic('intro n\nomega'));
  assert.throws(() => cleanTactic('sorry'));
  assert.throws(() => cleanTactic('exact native_decide'));
  assert.equal(cleanTactic('  omega '), 'omega');
});

test('judgeApplication requires no errors and one fewer sorry', () => {
  // Same trace back: sorry remains -> rejected.
  const same = judgeApplication(twoDvd, basicsTrace, 'two_dvd_mul_succ');
  assert.equal(same.ok, false);
  assert.match(same.diagnostics.join(' '), /still open/);

  // Error trace: rejected even though the sorry step is gone (omega case).
  const omegaTrace: TraceResult = {
    ...basicsTrace,
    messages: [{ severity: 'error', line: 32, col: 2, endLine: 32, endCol: 7, text: 'omega could not prove the goal' }],
    decls: basicsTrace.decls.map((d) => d.name === 'two_dvd_mul_succ' ? { ...d, steps: d.steps.filter((s) => s.tactic !== 'sorry') } : d),
  };
  const omega = judgeApplication(twoDvd, omegaTrace, 'two_dvd_mul_succ');
  assert.equal(omega.ok, false);
  assert.match(omega.diagnostics.join(' '), /omega could not prove/);

  // Clean trace without the sorry: accepted.
  const cleanTrace: TraceResult = {
    ...basicsTrace,
    messages: [],
    decls: basicsTrace.decls.map((d) => d.name === 'two_dvd_mul_succ' ? { ...d, steps: d.steps.filter((s) => s.tactic !== 'sorry') } : d),
  };
  assert.equal(judgeApplication(twoDvd, cleanTrace, 'two_dvd_mul_succ').ok, true);
});
