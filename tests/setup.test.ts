import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import { cloneDirFor } from '../apps/server/ingest';
import { LEAN_TOOLCHAIN } from '../apps/server/setup';
import { META_API_BASE, DEFAULT_MODEL } from '../apps/server/meta';

test('clones are saved under /tmp/graspt-clones with a stable per-URL dir', () => {
  const a = cloneDirFor('https://github.com/owner/lean-repo.git');
  const b = cloneDirFor('https://github.com/owner/lean-repo.git');
  const c = cloneDirFor('https://github.com/owner/other.git');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith(path.join(os.tmpdir(), 'graspt-clones')));
  assert.match(path.basename(a), /lean-repo/);
});

test('chat is a direct Meta API call: pinned endpoint, model, and Lean toolchain (no agent CLI)', () => {
  assert.equal(META_API_BASE, 'https://api.meta.ai/v1');
  assert.equal(DEFAULT_MODEL, 'muse-wonder-1.0');
  assert.equal(LEAN_TOOLCHAIN, 'leanprover/lean4:v4.36.0-rc2');
});
