import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { TraceResult } from '../../packages/core/types';
import { packageRoot, repoFromTraces, type Repo } from './store';

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
      else if (e.name.endsWith('.lean') && e.name !== 'lakefile.lean') out.push(p);
      if (out.length >= cap) return;
    }
  };
  walk(root, 0);
  // Rank files so self-contained theorem files (e.g. Tape.lean, 01Rewriting.lean)
  // are traced before top-level import-only umbrella files or cross-module files.
  const score = (p: string): number => {
    try {
      const src = fs.readFileSync(p, 'utf8');
      const proofs = (src.match(/\b(theorem|lemma|example)\b[\s\S]*?:=\s*by\b/g) ?? []).length;
      if (proofs === 0) return -1000;
      const imports = src.split('\n').filter((l) => /^\s*(public\s+)?import\s+/.test(l));
      const externalImports = imports.filter((l) => !/\b(Mathlib|Std|Init|Lean|Batteries)\b/.test(l)).length;
      return proofs * 10 - externalImports * 200;
    } catch {
      return -1000;
    }
  };
  return out.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

/** Graspt's own bundled Lean project and tracer binary. */
export function bundledLeanDir(): string {
  return path.join(packageRoot(), 'lean');
}

export function tracerBinaryPath(): string {
  return path.join(bundledLeanDir(), '.lake', 'build', 'bin', 'graspt-trace');
}

/**
 * Trace a file of an *external* project. `lake exe graspt-trace` cannot
 * work there — Lake only knows executables declared in the target
 * project's own lakefile. Instead we run Graspt's tracer binary under the
 * target project's `lake env`, which puts that project's imports and
 * search path in place for elaboration.
 */
export function traceInvocation(bin: string, relFile: string): { cmd: string; args: string[] } {
  return { cmd: 'lake', args: ['env', bin, relFile] };
}

let tracerBuild: Promise<void> | undefined;

/** Build the tracer binary once if setup has not already produced it. */
function ensureTracerBinary(): Promise<void> {
  if (fs.existsSync(tracerBinaryPath())) return Promise.resolve();
  if (!tracerBuild) {
    const project = path.join(packageRoot(), 'lean');
    tracerBuild = new Promise<void>((resolve, reject) => {
      const env = { ...process.env, PATH: `${process.env.HOME}/.elan/bin:${process.env.PATH ?? ''}` };
      execFile('lake', ['build', 'graspt-trace'], { cwd: project, env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 }, (err) => {
        tracerBuild = undefined;
        if (err) reject(new Error(`graspt-trace binary is not built and building it failed (${err.message}). Run: graspt setup`));
        else if (!fs.existsSync(tracerBinaryPath())) reject(new Error('graspt-trace binary still missing after build. Run: graspt setup'));
        else resolve();
      });
    });
  }
  return tracerBuild;
}

/**
 * Parse tracer output. `lake env` may print build progress to stdout
 * before the tracer's single JSON line, so accept the last JSON-looking
 * line (or a JSON object starting at the first `{`) rather than demanding
 * the whole stream be JSON.
 */
export function parseTraceOutput(stdout: string): TraceResult {
  try { return JSON.parse(stdout) as TraceResult; } catch { /* fall through */ }
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) as TraceResult; } catch { /* keep looking */ }
  }
  const start = stdout.indexOf('{');
  if (start >= 0) return JSON.parse(stdout.slice(start)) as TraceResult;
  throw new Error('no JSON in tracer output');
}

function execTrace(cwd: string, fileArg: string, timeoutMs: number): Promise<TraceResult> {
  const { cmd, args } = traceInvocation(tracerBinaryPath(), fileArg);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: `${process.env.HOME}/.elan/bin:${process.env.PATH ?? ''}` };
    execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`graspt-trace failed for ${fileArg}: ${(stderr || err.message).slice(-400)}`));
      try { resolve(parseTraceOutput(stdout)); } catch { reject(new Error(`graspt-trace returned non-JSON for ${fileArg}: ${stdout.slice(0, 200)}`)); }
    });
  });
}

function sameToolchainAsBundled(lakeRoot: string): boolean {
  try {
    const a = fs.readFileSync(path.join(bundledLeanDir(), 'lean-toolchain'), 'utf8').trim();
    const b = fs.readFileSync(path.join(lakeRoot, 'lean-toolchain'), 'utf8').trim();
    return a === b;
  } catch {
    return false;
  }
}

async function runTrace(lakeRoot: string, relFile: string, timeoutMs = 180000): Promise<TraceResult> {
  await ensureTracerBinary();
  const absFile = path.resolve(lakeRoot, relFile);
  // If the target project pins a different Lean toolchain than Graspt's
  // compiled tracer binary (v4.36.0-rc2), its .olean cache is version-locked
  // and incompatible with our binary. Elaborate under Graspt's own cached
  // Mathlib environment first, and normalize the reported file path.
  const bundled = bundledLeanDir();
  if (!sameToolchainAsBundled(lakeRoot) && fs.existsSync(path.join(bundled, 'lakefile.lean'))) {
    try {
      const r = await execTrace(bundled, absFile, timeoutMs);
      if ((r.decls ?? []).length > 0) return { ...r, file: relFile };
    } catch { /* fall back to target lakeRoot */ }
  }
  const r = await execTrace(lakeRoot, relFile, timeoutMs);
  if ((r.decls ?? []).length === 0 && fs.existsSync(path.join(bundled, 'lakefile.lean')) && path.resolve(lakeRoot) !== path.resolve(bundled)) {
    try {
      const fallback = await execTrace(bundled, absFile, timeoutMs);
      if ((fallback.decls ?? []).length > 0) return { ...fallback, file: relFile };
    } catch { /* return original result */ }
  }
  return r;
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
      // Lake project root: nearest ancestor of a Lean file (up to and
      // including the opened root, then above it) that carries a lakefile.
      // Browser uploads keep their top-level folder, so the lakefile may
      // sit one level below the workspace root.
      const hasLakefile = (dir: string) => fs.existsSync(path.join(dir, 'lakefile.lean')) || fs.existsSync(path.join(dir, 'lakefile.toml'));
      let lakeRoot: string | undefined;
      outer: for (const f of files) {
        let dir = path.dirname(f);
        for (;;) {
          if (hasLakefile(dir)) { lakeRoot = dir; break outer; }
          if (dir === root) break;
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
      if (!lakeRoot) {
        let dir = root;
        while (!hasLakefile(dir)) {
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        if (hasLakefile(dir)) lakeRoot = dir;
      }
      if (!lakeRoot) {
        throw new Error(`found ${files.length} .lean files but no lakefile — cannot trace. Precompute .graspt/trace.json with graspt-trace instead.`);
      }
      // A browser-uploaded workspace arrives without `.lake` (build
      // artifacts are never uploaded), so its dependencies have no compiled
      // oleans to elaborate against. Fetch the dependency cache first when
      // the project shares the bundled Lean toolchain and has none; projects
      // on a different toolchain elaborate against Graspt's bundled Mathlib
      // cache instead of downloading a multi-GB incompatible toolchain.
      if (sameToolchainAsBundled(lakeRoot) && !fs.existsSync(path.join(lakeRoot, '.lake', 'packages'))) {
        job.state = 'tracing';
        job.detail = `fetching dependency cache for ${path.basename(lakeRoot)} (lake exe cache get, large download)…`;
        await new Promise<void>((resolve) => {
          const env = { ...process.env, PATH: `${process.env.HOME}/.elan/bin:${process.env.PATH ?? ''}` };
          execFile('lake', ['exe', 'cache', 'get'], { cwd: lakeRoot, env, timeout: 900_000, maxBuffer: 16 * 1024 * 1024 }, () => resolve());
        });
      }
      job.state = 'tracing';
      const traces: TraceResult[] = [];
      for (const f of files.slice(0, 3)) {
        const rel = path.relative(lakeRoot, f);
        job.detail = `tracing ${rel} (Lean elaboration, may take minutes)`;
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
