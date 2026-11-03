import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run, which } from './exec';
import { hasMetaApiKey, metaModel, META_API_BASE } from './meta';
import { packageRoot } from './store';

// Provisioning: Lean (via elan) and Mathlib (via a Lake project's cache).
// Chat needs no installation at all — it calls the Meta AI API directly;
// it only needs an API key. Installs are explicit jobs — never silent
// postinstall downloads — because Lean+Mathlib are gigabytes.

export const LEAN_TOOLCHAIN = 'leanprover/lean4:v4.36.0-rc2';

export interface SetupStatus {
  lean: { installed: boolean; version?: string; lake: boolean };
  mathlib: { cached: boolean; project?: string; note: string };
  meta: { endpoint: string; keySaved: boolean; model: string };
}

function bundledLeanProject(): string | undefined {
  const p = path.join(packageRoot(), 'lean');
  return fs.existsSync(path.join(p, 'lakefile.lean')) ? p : undefined;
}

export async function setupStatus(): Promise<SetupStatus> {
  const leanBin = await which('lean');
  const lakeBin = await which('lake');
  let leanVersion: string | undefined;
  if (leanBin) { const r = await run('lean', ['--version'], { timeoutMs: 15000 }); leanVersion = r.stdout.trim().split('\n')[0]; }
  const project = bundledLeanProject();
  const mathlibCached = !!project && fs.existsSync(path.join(project, '.lake', 'packages', 'mathlib'));
  return {
    lean: { installed: !!leanBin, version: leanVersion, lake: !!lakeBin },
    mathlib: {
      cached: mathlibCached,
      project,
      note: mathlibCached ? 'Mathlib cache present in the bundled lean/ project.' : project ? 'Bundled lean/ project found but Mathlib cache missing — run setup.' : 'No bundled Lean project in this install; Mathlib comes with any cloned/opened Lake project (lake exe cache get).',
    },
    meta: { endpoint: META_API_BASE, keySaved: hasMetaApiKey(), model: metaModel() },
  };
}

export interface SetupJob { id: string; kind: string; state: 'running' | 'ready' | 'failed'; detail: string }
const jobs = new Map<string, SetupJob>();
let seq = 0;
export function getSetupJob(id: string) { return jobs.get(id); }

function startJob(kind: string, work: (job: SetupJob) => Promise<void>): SetupJob {
  const job: SetupJob = { id: `setup-${++seq}`, kind, state: 'running', detail: 'starting…' };
  jobs.set(job.id, job);
  void work(job).then(() => { if (job.state === 'running') { job.state = 'ready'; job.detail = 'done'; } })
    .catch((e) => { job.state = 'failed'; job.detail = e instanceof Error ? e.message : String(e); });
  return job;
}

export function installLean(): SetupJob {
  return startJob('install-lean', async (job) => {
    if (await which('elan')) { job.detail = 'elan already present, installing toolchain'; }
    else {
      job.detail = 'downloading elan installer…';
      const script = path.join(os.tmpdir(), 'elan-init.sh');
      const dl = await run('bash', ['-lc', `curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o ${script}`], { timeoutMs: 120_000 });
      if (dl.code !== 0) throw new Error(`elan download failed: ${dl.stderr.slice(-300)}`);
      const inst = await run('bash', [script, '-y', '--default-toolchain', 'none'], { timeoutMs: 300_000 });
      if (inst.code !== 0) throw new Error(`elan install failed: ${(inst.stderr || inst.stdout).slice(-400)}`);
    }
    job.detail = `elan toolchain install ${LEAN_TOOLCHAIN} (large download)`;
    const tc = await run('bash', ['-lc', `export PATH="$HOME/.elan/bin:$PATH"; elan toolchain install ${LEAN_TOOLCHAIN}`], { timeoutMs: 600_000 });
    if (tc.code !== 0) throw new Error(`toolchain install failed: ${(tc.stderr || tc.stdout).slice(-400)}`);
    job.detail = 'Lean toolchain installed';
  });
}

export function fetchMathlib(projectDir?: string): SetupJob {
  return startJob('fetch-mathlib', async (job) => {
    const project = projectDir ?? bundledLeanProject();
    if (!project) throw new Error('No Lean project available for Mathlib. Clone or open a Lake project first.');
    job.detail = `lake exe cache get in ${project} (large download)`;
    const r = await run('lake', ['exe', 'cache', 'get'], { cwd: project, timeoutMs: 900_000 });
    if (r.timedOut) throw new Error('Mathlib cache download timed out after 900s');
    if (r.code !== 0) throw new Error(`lake exe cache get failed: ${(r.stderr || r.stdout).slice(-400)}`);
    job.detail = 'Mathlib cache fetched';
  });
}
