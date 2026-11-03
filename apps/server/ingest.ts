import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { TraceResult } from '../../packages/core/types';
import { repoFromTraces, type Repo } from './store';

export interface Job {
  id: string;
  state: 'queued' | 'scanning' | 'tracing' | 'ready' | 'failed';
  detail: string;
  repoId?: string;
  createdAt: number;
}

const jobs = new Map<string, Job>();
let seq = 0;
export function getJob(id: string) { return jobs.get(id); }
export function listJobs() { return [...jobs.values()]; }

/** Clones live under /tmp/graspt-clones — scratch space owned by the server, never a user repo. */
export function cloneDirFor(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  const name = url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('-').replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo';
  return path.join(os.tmpdir(), 'graspt-clones', `${name}-${h.toString(16)}`);
}

function validGitUrl(url: string): boolean {
  return /^https:\/\/[^\s]+$/.test(url) || /^git@[^\s:]+:[^\s]+$/.test(url);
}

/** Clone (or update) a remote Lean repo into /tmp, then ingest it like a folder. */
export async function cloneAndIngest(url: string, storeDir: string, register: (r: Repo) => void): Promise<Job> {
  const job: Job = { id: `job-${++seq}`, state: 'queued', detail: 'queued', createdAt: Date.now() };
  jobs.set(job.id, job);
  void (async () => {
    try {
      const clean = url.trim();
      if (!validGitUrl(clean)) throw new Error(`Invalid git URL: ${clean} (expected https://… or git@host:owner/repo)`);
      const dest = cloneDirFor(clean);
      if (fs.existsSync(path.join(dest, '.git'))) {
        job.state = 'scanning'; job.detail = `updating existing clone in ${dest}`;
        await new Promise<void>((resolve, reject) => {
          execFile('git', ['-C', dest, 'pull', '--ff-only'], { timeout: 180_000 }, (err) => (err ? reject(new Error(`git pull failed: ${err.message}`)) : resolve()));
        });
      } else {
        job.state = 'scanning'; job.detail = `git clone --depth 1 ${clean} → ${dest} (saved in /tmp)`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await new Promise<void>((resolve, reject) => {
          execFile('git', ['clone', '--depth', '1', clean, dest], { timeout: 600_000 }, (err) => (err ? reject(new Error(`git clone failed: ${err.message}`)) : resolve()));
        });
      }
      // Reuse the folder pipeline by delegating: easiest is a fresh job chain —
      // mark this job ready once the nested ingestion registers the repo.
      const inner = await ingestFolder(dest, storeDir, register);
      const poll = setInterval(() => {
        job.state = inner.state === 'ready' ? 'ready' : inner.state === 'failed' ? 'failed' : 'tracing';
        job.detail = inner.detail; job.repoId = inner.repoId;
        if (inner.state === 'ready' || inner.state === 'failed') clearInterval(poll);
      }, 500);
    } catch (e) {
      job.state = 'failed'; job.detail = e instanceof Error ? e.message : String(e);
    }
  })();
  return job;
}

function leanFiles(root: string, cap = 40): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= cap || depth > 4) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.lean')) out.push(p);
      if (out.length >= cap) return;
    }
  };
  walk(root, 0);
  return out.sort();
}

function runTrace(lakeRoot: string, relFile: string, timeoutMs = 180000): Promise<TraceResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${process.env.HOME}/.elan/bin:${process.env.PATH ?? ''}` };
    execFile('lake', ['exe', 'graspt-trace', relFile], { cwd: lakeRoot, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`graspt-trace failed for ${relFile}: ${err.message}`));
      try { resolve(JSON.parse(stdout) as TraceResult); } catch { reject(new Error(`graspt-trace returned non-JSON for ${relFile}`)); }
    });
  });
}

/**
 * Ingest a folder as a read-only repo. Writes go only to the server store
 * dir (traces), never into the opened folder itself.
 * Order: precomputed trace JSON → lake project trace (≤3 files) → failure with reason.
 */
export async function ingestFolder(folder: string, storeDir: string, register: (r: Repo) => void): Promise<Job> {
  const job: Job = { id: `job-${++seq}`, state: 'queued', detail: 'queued', createdAt: Date.now() };
  jobs.set(job.id, job);
  void (async () => {
    try {
      const root = path.resolve(folder);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`folder not found: ${root}`);
      job.state = 'scanning'; job.detail = `scanning ${root}`;
      const precomputed = [path.join(root, '.graspt', 'trace.json'), path.join(root, 'trace.json')].find((p) => fs.existsSync(p));
      if (precomputed) {
        const trace = JSON.parse(fs.readFileSync(precomputed, 'utf8')) as TraceResult;
        const repo = repoFromTraces(`folder-${seq}`, path.basename(root), root, [trace]);
        register(repo); job.repoId = repo.id; job.state = 'ready'; job.detail = `loaded precomputed trace ${precomputed}`;
        return;
      }
      const files = leanFiles(root);
      if (!files.length) throw new Error('no .lean files found in folder');
      // lake project root = nearest ancestor (incl. self) with lakefile
      let lakeRoot = root;
      while (!fs.existsSync(path.join(lakeRoot, 'lakefile.lean')) && !fs.existsSync(path.join(lakeRoot, 'lakefile.toml'))) {
        const parent = path.dirname(lakeRoot);
        if (parent === lakeRoot) break;
        lakeRoot = parent;
      }
      if (!fs.existsSync(path.join(lakeRoot, 'lakefile.lean')) && !fs.existsSync(path.join(lakeRoot, 'lakefile.toml'))) {
        throw new Error(`found ${files.length} .lean files but no lakefile — cannot trace. Precompute .graspt/trace.json with graspt-trace instead.`);
      }
      job.state = 'tracing';
      const traces: TraceResult[] = [];
      for (const f of files.slice(0, 3)) {
        const rel = path.relative(lakeRoot, f);
        job.detail = `tracing ${rel} (Lean elaboration, may take minutes on 4 cores)`;
        traces.push(await runTrace(lakeRoot, rel));
      }
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(path.join(storeDir, `${job.id}.traces.json`), JSON.stringify(traces));
      const repo = repoFromTraces(`folder-${seq}`, path.basename(root), root, traces);
      register(repo); job.repoId = repo.id; job.state = 'ready'; job.detail = `traced ${traces.length} file(s), ${traces.reduce((a, t) => a + t.decls.length, 0)} declaration(s)`;
    } catch (e) {
      job.state = 'failed'; job.detail = e instanceof Error ? e.message : String(e);
    }
  })();
  return job;
}
