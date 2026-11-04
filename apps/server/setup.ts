import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run, which } from './exec';
import { hasMetaApiKey, metaModel, META_API_BASE } from './meta';
import { packageRoot } from './store';
import { atlasDir, computeAtlasFingerprint, validateAtlasCache, type AtlasValidation } from './atlas-cache';

// Provisioning is staged and offline: Lean (via elan) → Mathlib cache →
// global Atlas. Each stage skips itself when fresh. Nothing here runs on
// the demo/opening path, and nothing downloads silently at install time —
// Lean + Mathlib are gigabytes, so setup is one explicit long job.

export const LEAN_TOOLCHAIN = 'leanprover/lean4:v4.36.0-rc2';

/** Persistent store: GRASPT_STORE override, else ~/.graspt/store. Never /tmp by default. */
export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.GRASPT_STORE?.trim();
  return override ? path.resolve(override) : path.join(home, '.graspt', 'store');
}

export function mathlibRevision(): string {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'lean', 'lake-manifest.json'), 'utf8')) as { packages?: { name?: string; rev?: string }[] };
    return manifest.packages?.find((p) => p.name === 'mathlib')?.rev ?? 'unknown';
  } catch { return 'unknown'; }
}

function atlasSource(): string {
  try {
    return fs.readFileSync(path.join(packageRoot(), 'lean', 'Graspt', 'AtlasMain.lean'), 'utf8');
  } catch { return 'missing-atlas-source'; }
}

export function currentAtlasFingerprint(): string {
  return computeAtlasFingerprint({ toolchain: LEAN_TOOLCHAIN, mathlibRevision: mathlibRevision(), atlasSource: atlasSource() });
}

export interface SetupManifest {
  toolchain: string;
  mathlibRevision: string;
  atlasFingerprint: string;
  node: string;
  updatedAt: string;
  declarations?: number;
  areas?: number;
  landmarks?: number;
}

/** Atomic manifest write: temp file in the same directory, then rename. */
export function writeSetupManifest(storeDir: string = defaultStoreDir()): SetupManifest {
  const v = validateAtlasCache(storeDir);
  const m: SetupManifest = {
    toolchain: LEAN_TOOLCHAIN,
    mathlibRevision: mathlibRevision(),
    atlasFingerprint: currentAtlasFingerprint(),
    node: process.version,
    updatedAt: new Date().toISOString(),
    ...(v.ok ? { declarations: v.declarations, areas: v.areas, landmarks: v.landmarks } : {}),
  };
  fs.mkdirSync(storeDir, { recursive: true });
  const tmp = path.join(storeDir, `.setup-manifest.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, path.join(storeDir, 'setup-manifest.json'));
  return m;
}

export function readSetupManifest(storeDir: string = defaultStoreDir()): SetupManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(storeDir, 'setup-manifest.json'), 'utf8')) as SetupManifest;
  } catch { return undefined; }
}

/** Fresh = cache validates AND the manifest fingerprint matches today's inputs. */
export function atlasFresh(storeDir: string = defaultStoreDir()): AtlasValidation & { fingerprint: string } {
  const fingerprint = currentAtlasFingerprint();
  const v = validateAtlasCache(storeDir);
  if (!v.ok) return { ...v, fingerprint };
  const manifest = readSetupManifest(storeDir);
  if (!manifest) return { ok: false, reason: 'atlas cache present but setup-manifest.json is missing — rerun: graspt setup', fingerprint };
  if (manifest.atlasFingerprint !== fingerprint) {
    return { ok: false, reason: `atlas cache is stale (fingerprint ${manifest.atlasFingerprint.slice(0, 12)}… ≠ current ${fingerprint.slice(0, 12)}…) — rerun: graspt setup`, fingerprint };
  }
  return { ...v, fingerprint };
}

function bundledLeanProject(): string | undefined {
  const p = path.join(packageRoot(), 'lean');
  return fs.existsSync(path.join(p, 'lakefile.lean')) ? p : undefined;
}

export interface SetupStatus {
  lean: { installed: boolean; version?: string; lake: boolean };
  mathlib: { cached: boolean; project?: string; note: string };
  atlas: { cached: boolean; fingerprint: string; note: string; declarations?: number; areas?: number; landmarks?: number };
  meta: { endpoint: string; keySaved: boolean; model: string };
  storeDir: string;
}

export async function setupStatus(storeDir: string = defaultStoreDir()): Promise<SetupStatus> {
  const leanBin = await which('lean');
  const lakeBin = await which('lake');
  let leanVersion: string | undefined;
  if (leanBin) { const r = await run('lean', ['--version'], { timeoutMs: 15000 }); leanVersion = r.stdout.trim().split('\n')[0]; }
  const project = bundledLeanProject();
  const mathlibCached = !!project && fs.existsSync(path.join(project, '.lake', 'packages', 'mathlib'));
  const fresh = atlasFresh(storeDir);
  return {
    lean: { installed: !!leanBin, version: leanVersion, lake: !!lakeBin },
    mathlib: {
      cached: mathlibCached,
      project,
      note: mathlibCached ? 'Mathlib cache present in the bundled lean/ project.' : project ? 'Bundled lean/ project found but Mathlib cache missing — run: graspt setup' : 'No bundled Lean project in this install; Mathlib comes with any cloned/opened Lake project (lake exe cache get).',
    },
    atlas: {
      cached: fresh.ok,
      fingerprint: fresh.fingerprint,
      note: fresh.ok ? `Global Mathlib atlas cached and fresh (${fresh.declarations} declarations, ${fresh.areas} areas, ${fresh.landmarks} landmarks).` : `${fresh.reason} — run: graspt setup`,
      declarations: fresh.declarations,
      areas: fresh.areas,
      landmarks: fresh.landmarks,
    },
    meta: { endpoint: META_API_BASE, keySaved: hasMetaApiKey(), model: metaModel() },
    storeDir,
  };
}

export interface DemoStage { name: string; ok: boolean; detail: string; fix?: string }

/** Offline demo readiness. Reports named stages; never regenerates anything. */
export async function demoReady(storeDir: string = defaultStoreDir()): Promise<{ ready: boolean; stages: DemoStage[] }> {
  const status = await setupStatus(storeDir);
  const fixtures = fs.existsSync(path.join(packageRoot(), 'fixtures', 'demo'));
  const stages: DemoStage[] = [
    { name: 'lean', ok: status.lean.installed, detail: status.lean.version ?? 'Lean not installed', fix: 'graspt setup' },
    { name: 'mathlib', ok: status.mathlib.cached, detail: status.mathlib.note, fix: 'graspt setup' },
    { name: 'atlas', ok: status.atlas.cached, detail: status.atlas.note, fix: 'graspt setup' },
    { name: 'fixtures', ok: fixtures, detail: fixtures ? 'pre-indexed demo traces present' : 'fixtures/demo missing' },
    { name: 'model-key', ok: status.meta.keySaved, detail: status.meta.keySaved ? 'key saved' : 'no Meta API key (browsing and smoke still work; chat/generation need a key)', fix: 'paste MODEL_API_KEY in the website' },
  ];
  return { ready: stages.filter((s) => s.name !== 'model-key').every((s) => s.ok), stages };
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

export function generateAtlas(storeDir: string = defaultStoreDir()): SetupJob {
  return startJob('generate-atlas', async (job) => {
    if (atlasFresh(storeDir).ok) {
      job.detail = 'global Mathlib atlas already fresh — skipped';
      writeSetupManifest(storeDir);
      return;
    }
    const project = bundledLeanProject();
    if (!project) throw new Error('No bundled Lean project (lean/) in this install — atlas generation needs a git clone of the Graspt repo, not the npm tarball.');
    const out = atlasDir(storeDir);
    fs.mkdirSync(out, { recursive: true });
    job.detail = `graspt-atlas over Mathlib → ${out} (slowest setup stage; importing all of Mathlib, one long job)`;
    const r = await run('lake', ['exe', 'graspt-atlas', out, 'Mathlib'], { cwd: project, timeoutMs: 1_800_000 });
    if (r.timedOut) throw new Error('Atlas generation timed out after 1800s — rerun graspt setup as one long job without a short shell timeout');
    if (r.code !== 0) throw new Error(`graspt-atlas failed: ${(r.stderr || r.stdout).slice(-400)}`);
    const v = validateAtlasCache(storeDir);
    if (!v.ok) throw new Error(`graspt-atlas finished but the cache does not validate: ${v.reason}`);
    writeSetupManifest(storeDir);
    job.detail = `global Mathlib atlas generated and cached (${v.declarations} declarations, ${v.landmarks} landmarks)`;
  });
}

export { atlasDir };
