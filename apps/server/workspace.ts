import * as fs from 'fs';
import * as path from 'path';

// Browser folder uploads: the browser cannot hand the server a filesystem
// path, so the selected files themselves are sent and materialised into a
// server-owned working copy under the store dir. The user's real folder
// is never written by this path.

const SKIP_DIRS = new Set(['.git', '.lake', 'node_modules', 'dist']);
export const UPLOAD_MAX_FILES = 300;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export interface UploadFile { path: string; content: string }

let seq = 0;

export function workspacesRoot(storeDir: string): string {
  return path.join(storeDir, 'workspaces');
}

function uploadAllowed(rel: string): boolean {
  const base = rel.split('/').pop() ?? '';
  return rel.endsWith('.lean') || base === 'lakefile.toml' || base === 'lakefile.lean' || base === 'lean-toolchain';
}

/**
 * Materialise an upload into a fresh workspace directory. Only Lean
 * sources and Lake project files are kept; every path is confined to the
 * new workspace (no `..`, no skipped dirs), with file/byte caps.
 * Throws with a user-readable reason when nothing usable arrived.
 */
export function createUploadWorkspace(storeDir: string, name: string, files: UploadFile[]): string {
  if (!Array.isArray(files) || files.length === 0) throw new Error('no files uploaded');
  if (files.length > UPLOAD_MAX_FILES) throw new Error(`too many files (max ${UPLOAD_MAX_FILES})`);
  const safeName = (name || 'upload').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '') || 'upload';
  const dir = path.join(workspacesRoot(storeDir), `upload-${safeName}-${Date.now()}-${++seq}`);
  let total = 0;
  let leanFiles = 0;
  for (const f of files) {
    const rel = String(f?.path ?? '').replace(/\\/g, '/');
    const parts = rel.split('/').filter((p) => p && p !== '.');
    if (!parts.length || parts.some((p) => p === '..' || SKIP_DIRS.has(p))) continue;
    const clean = parts.join('/');
    if (!uploadAllowed(clean)) continue;
    const content = String(f?.content ?? '');
    total += Buffer.byteLength(content);
    if (total > UPLOAD_MAX_BYTES) throw new Error(`upload too large (max ${UPLOAD_MAX_BYTES} bytes)`);
    const target = path.join(dir, clean);
    if (!target.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    if (clean.endsWith('.lean')) leanFiles++;
  }
  if (!leanFiles) throw new Error('no .lean files in the uploaded folder');
  return dir;
}
