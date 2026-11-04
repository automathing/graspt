import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cloneDirFor } from '../apps/server/ingest';
import { LEAN_TOOLCHAIN, defaultStoreDir, readSetupManifest, writeSetupManifest } from '../apps/server/setup';
import { computeAtlasFingerprint, validateAtlasCache } from '../apps/server/atlas-cache';
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

test('default store is persistent under ~/.graspt, never the tmp dir; GRASPT_STORE overrides', () => {
  const home = path.join(os.tmpdir(), 'fake-home');
  assert.equal(defaultStoreDir({}, home), path.join(home, '.graspt', 'store'));
  assert.equal(defaultStoreDir({ GRASPT_STORE: '/data/graspt' }, home), '/data/graspt');
  assert.ok(!defaultStoreDir({}, home).startsWith(path.join(os.tmpdir(), 'graspt-store')));
});

test('atlas fingerprint is a stable sha256 that changes with generator source or revision', () => {
  const a = computeAtlasFingerprint({ toolchain: 't1', mathlibRevision: 'r1', atlasSource: 'source A' });
  const b = computeAtlasFingerprint({ toolchain: 't1', mathlibRevision: 'r1', atlasSource: 'source A' });
  const c = computeAtlasFingerprint({ toolchain: 't1', mathlibRevision: 'r1', atlasSource: 'source B' });
  const d = computeAtlasFingerprint({ toolchain: 't1', mathlibRevision: 'r2', atlasSource: 'source A' });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
});

function writeAtlasFixture(store: string, mutate?: (atlas: any, imp: any) => void) {
  const dir = path.join(store, 'atlas');
  fs.mkdirSync(dir, { recursive: true });
  const atlas: any = {
    roots: ['Mathlib'], declarations: 123,
    areas: [{ id: 'Mathlib.Algebra', decls: 10 }, { id: 'Core', decls: 3 }],
    areaEdges: [{ source: 'Mathlib.Algebra', target: 'Core', weight: 25 }],
    landmarks: [{ name: 'Nat.add', kind: 'theorem', module: 'Mathlib.Algebra.Basic', area: 'Mathlib.Algebra', uses: 9, type: '', deps: [] }],
  };
  const imp: any = { areas: ['Core', 'Mathlib.Algebra'], table: { 'Nat.add': [9, 1] } };
  mutate?.(atlas, imp);
  fs.writeFileSync(path.join(dir, 'atlas.json'), JSON.stringify(atlas));
  fs.writeFileSync(path.join(dir, 'importance.json'), JSON.stringify(imp));
}

test('atlas cache validation parses and counts, not just existence', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-atlas-'));
  assert.equal(validateAtlasCache(store).ok, false);
  writeAtlasFixture(store);
  const v = validateAtlasCache(store);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.declarations, 123);
  assert.equal(v.landmarks, 1);
  assert.equal(v.importanceEntries, 1);
});

test('atlas cache validation fails closed on corrupt or inconsistent files', () => {
  const corrupt = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-atlas-'));
  writeAtlasFixture(corrupt);
  fs.writeFileSync(path.join(corrupt, 'atlas', 'atlas.json'), '{not json');
  assert.equal(validateAtlasCache(corrupt).ok, false);

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-atlas-'));
  writeAtlasFixture(empty, (a) => { a.landmarks = []; });
  assert.equal(validateAtlasCache(empty).ok, false);

  const badIndex = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-atlas-'));
  writeAtlasFixture(badIndex, (_a, imp) => { imp.table['Nat.add'] = [9, 99]; });
  assert.equal(validateAtlasCache(badIndex).ok, false);
});

test('setup manifest round-trips atomically and leaves no temp file behind', () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-manifest-'));
  const m = writeSetupManifest(store);
  assert.equal(readSetupManifest(store)?.atlasFingerprint, m.atlasFingerprint);
  assert.equal(m.toolchain, LEAN_TOOLCHAIN);
  assert.ok(m.mathlibRevision.length > 0);
  assert.deepEqual(fs.readdirSync(store), ['setup-manifest.json']);
});
