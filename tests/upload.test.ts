import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createUploadWorkspace } from '../apps/server/workspace';

function store() { return fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-upload-')); }

test('upload materialises only Lean sources and Lake files, confined to the workspace', () => {
  const dir = createUploadWorkspace(store(), 'My Project', [
    { path: 'MyProject/A.lean', content: 'theorem a : True := by trivial' },
    { path: 'MyProject/lakefile.toml', content: 'name = "x"' },
    { path: 'MyProject/lean-toolchain', content: 'leanprover/lean4:v4.27.0' },
    { path: 'MyProject/README.md', content: 'not kept' },
    { path: 'MyProject/.lake/build/junk.lean', content: 'not kept either' },
  ]);
  assert.equal(fs.readFileSync(path.join(dir, 'MyProject', 'A.lean'), 'utf8'), 'theorem a : True := by trivial');
  assert.ok(fs.existsSync(path.join(dir, 'MyProject', 'lakefile.toml')));
  assert.ok(!fs.existsSync(path.join(dir, 'MyProject', 'README.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'MyProject', '.lake')));
});

test('upload refuses traversal, empty uploads, and folders with no Lean files', () => {
  const s = store();
  assert.throws(() => createUploadWorkspace(s, 'x', []), /no files/);
  assert.throws(() => createUploadWorkspace(s, 'x', [{ path: 'a.txt', content: 'hi' }]), /no \.lean files/);
  const dir = createUploadWorkspace(s, 'x', [
    { path: '../escape.lean', content: 'theorem e : True := by trivial' },
    { path: 'ok/Real.lean', content: 'theorem r : True := by trivial' },
  ]);
  // The traversal file was dropped; only the confined one landed.
  assert.ok(fs.existsSync(path.join(dir, 'ok', 'Real.lean')));
  assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.lean')));
});
