#!/usr/bin/env node
import { spawn } from 'child_process';
import { startServer } from '../server/server';
import { setupStatus, installLean, fetchMathlib, type SetupJob } from '../server/setup';

async function waitJob(job: SetupJob) {
  while (job.state === 'running') { await new Promise((r) => setTimeout(r, 2000)); }
  if (job.state === 'failed') throw new Error(job.detail);
  console.log(`  ✓ ${job.kind}: ${job.detail}`);
}

/** `graspt setup` — provision Lean (elan + toolchain) and Mathlib cache. Chat needs only a Meta API key. Explicit, never silent. */
async function setup() {
  const before = await setupStatus();
  console.log(`Lean:    ${before.lean.installed ? before.lean.version : 'missing'}`);
  console.log(`Mathlib: ${before.mathlib.cached ? 'cached' : before.mathlib.note}`);
  console.log(`Meta AI: ${before.meta.keySaved ? `key saved, model ${before.meta.model}` : 'no API key — paste MODEL_API_KEY next to the chatbox in the website'} (${before.meta.endpoint})`);

  if (!before.lean.installed) { console.log('Installing Lean via elan (large download)…'); await waitJob(installLean()); }
  const after = await setupStatus();
  if (!after.mathlib.cached && after.mathlib.project) { console.log('Fetching Mathlib cache (large download)…'); await waitJob(fetchMathlib(after.mathlib.project)); }
  const done = await setupStatus();
  console.log(`Setup complete. Lean: ${done.lean.installed}, Mathlib cached: ${done.mathlib.cached}, Meta key: ${done.meta.keySaved}. Run: graspt [folder]`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'setup') { await setup(); return; }
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('Usage:\n  graspt [folder] [--port N] [--no-open]   Start the website (default port 4173)\n  graspt setup                              Install Lean and the Mathlib cache (chat needs only a Meta API key)\n  graspt <https://…git-url>                 Clone into /tmp/graspt-clones and open it');
    return;
  }
  const portFlag = args.indexOf('--port');
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) : Number(process.env.GRASPT_PORT ?? 4173);
  const noOpen = args.includes('--no-open');
  const folder = args.find((a, i) => !a.startsWith('--') && (portFlag < 0 || i !== portFlag + 1));

  const isGitUrl = !!folder && (/^https:\/\//.test(folder) || /^git@/.test(folder));
  const { url } = await startServer({ port, repoRoot: folder });
  console.log(`Graspt — allocentric proof navigation (read-only)`);
  const s = await setupStatus();
  console.log(`Setup — Lean: ${s.lean.installed ? 'ok' : 'missing (run: graspt setup)'}, Mathlib: ${s.mathlib.cached ? 'cached' : 'not cached'}, Meta key: ${s.meta.keySaved ? 'saved' : 'not set (paste it next to the chatbox)'}`);
  if (folder) {
    const endpoint = isGitUrl ? 'api/repos/clone' : 'api/repos/open';
    const payload = isGitUrl ? { url: folder } : { path: folder };
    console.log(`${isGitUrl ? `Cloning into /tmp: POST ${url}${endpoint}` : `Opening folder via ingestion job: POST ${url}${endpoint}`}  ${JSON.stringify(payload)}`);
    try {
      await fetch(`${url}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch { /* job start is best-effort; UI can retry */ }
  }
  console.log(`Open this URL in your browser: ${url}`);
  if (!noOpen) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(cmd, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref(); } catch { /* print-only fallback */ }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
