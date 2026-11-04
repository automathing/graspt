import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseTraceOutput, traceInvocation, tracerBinaryPath } from '../apps/server/ingest';

test('external projects are traced via lake env + the Graspt binary, never lake exe', () => {
  const { cmd, args } = traceInvocation('/opt/graspt/lean/.lake/build/bin/graspt-trace', 'GlimpseOfLean.lean');
  assert.equal(cmd, 'lake');
  assert.deepEqual(args, ['env', '/opt/graspt/lean/.lake/build/bin/graspt-trace', 'GlimpseOfLean.lean']);
  assert.ok(!args.includes('exe'), 'lake exe would look up graspt-trace in the target project lakefile and fail');
});

test('parseTraceOutput tolerates lake build noise before the JSON line', () => {
  const noisy = '✔ Built Mathlib.Foo\n✔ Built GlimpseOfLean\n{"file":"GlimpseOfLean.lean","decls":[],"messages":[],"elapsedMs":2,"headerCached":false}\n';
  const r = parseTraceOutput(noisy);
  assert.equal(r.file, 'GlimpseOfLean.lean');
  assert.deepEqual(r.decls, []);
  assert.throws(() => parseTraceOutput('no json at all'));
});

test('tracer binary lives under the bundled lean project build output', () => {
  const bin = tracerBinaryPath();
  assert.ok(bin.endsWith(path.join('lean', '.lake', 'build', 'bin', 'graspt-trace')), bin);
});
