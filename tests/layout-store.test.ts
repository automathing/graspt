import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LayoutStore } from '../packages/core/layout';

test('LayoutStore isolates repos that share a declaration name', () => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-repo-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt-repo-b-'));
  try {
    const store = new LayoutStore();
    store.saveLayout(rootA, 'SameDecl', { 'g:1': { x: 1, y: 2 } });
    store.saveLayout(rootB, 'SameDecl', { 'g:1': { x: 9, y: 9 } });
    // The in-memory cache must not bleed repo B's positions into repo A.
    assert.deepEqual(store.loadLayout(rootA, 'SameDecl'), { 'g:1': { x: 1, y: 2 } });
    assert.deepEqual(store.loadLayout(rootB, 'SameDecl'), { 'g:1': { x: 9, y: 9 } });
    // And a fresh store reads each repo's own file from disk.
    const fresh = new LayoutStore();
    assert.deepEqual(fresh.loadLayout(rootA, 'SameDecl'), { 'g:1': { x: 1, y: 2 } });
    assert.deepEqual(fresh.loadLayout(rootB, 'SameDecl'), { 'g:1': { x: 9, y: 9 } });
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});
