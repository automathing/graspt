import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { atlasFor, loadAtlasCache, loadDemoRepo, packageRoot, proofMapFor, declTrace, repoFromTraces, type Repo } from './store';
import { neighbourhood, areaColor, AREA_COLORS } from '../../packages/core/nav';
import { resolvePositions, LayoutStore } from '../../packages/core/layout';
import { answerChat, navigatorWalk } from './chat';
import { metaStatus, setMetaApiKey, setModel, metaModel, extractApiKey, extractModel, askMeta, hasMetaApiKey } from './meta';
import { setupStatus, installLean, fetchMathlib, generateAtlas, demoReady, defaultStoreDir, getSetupJob } from './setup';
import { cleanTactic, findSorryStep, judgeApplication, judgeAdvancingApplication, replaceRange, replaceRangeWithSorry, sorryCount, tacticRepairPrompt, MAX_REPAIR_ROUNDS, type TryStepLog } from './splice';
import { traceClient } from './trace-client';
import { getScratchJob, startScratchGeneration } from './generate';
import { createUploadWorkspace, type UploadFile } from './workspace';
import { cloneAndIngest } from './ingest';
import { ingestFolder, getJob, listJobs } from './ingest';

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export interface ServerOptions { port: number; repoRoot?: string; storeDir?: string; }

export function createServer(opts: ServerOptions) {
  const repos = new Map<string, Repo>();
  const demo = loadDemoRepo();
  repos.set(demo.id, demo);
  // Session working copies: repoId:file -> source after verified splices.
  // The opened repo on disk is never written; only Lean-verified content
  // replaces the in-memory source, and the map is redrawn from its trace.
  const sourceOverrides = new Map<string, string>();
  const sourceFor = (repo: Repo, file: string): string | undefined => {
    const override = sourceOverrides.get(`${repo.id}:${file}`);
    if (override !== undefined) return override;
    const base = repo.source === 'demo' ? path.join(packageRoot(), 'lean') : repo.root;
    try { return fs.readFileSync(path.join(base, file), 'utf8'); } catch { return undefined; }
  };
  const storeDir = opts.storeDir ?? defaultStoreDir();
  loadAtlasCache(storeDir);
  const layoutStore = new LayoutStore();
  // Layout lives in the server store, never in an opened repo — and is
  // namespaced per repo so two repos sharing a decl name never share a map.
  const layoutRootFor = (repoId: string) => path.join(storeDir, 'layout-host', repoId);

  const send = (res: http.ServerResponse, code: number, body: unknown, type = 'application/json') => {
    const data = type === 'application/json' ? JSON.stringify(body) : String(body);
    res.writeHead(code, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
    });
    res.end(data);
  };
  const readBody = (req: http.IncomingMessage, limit = 1_000_000) => new Promise<string>((resolve, reject) => {
    let d = '';
    let settled = false;
    req.on('data', (c) => {
      d += c;
      if (d.length > limit && !settled) { settled = true; reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(d); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      // ---- static web (Vite build output) ----
      if (req.method === 'GET' && (url.pathname === '/' || !url.pathname.startsWith('/api/'))) {
        const webRoot = path.resolve(packageRoot(), 'apps', 'web', 'dist');
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        let decoded = rel;
        try { decoded = decodeURIComponent(rel); } catch { send(res, 400, 'bad path', 'text/plain'); return; }
        const file = path.resolve(webRoot, decoded);
        const inside = file === webRoot || file.startsWith(webRoot + path.sep);
        if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) { send(res, 404, 'not found', 'text/plain'); return; }
        send(res, 200, fs.readFileSync(file, 'utf8'), MIME[path.extname(file)] ?? 'text/plain');
        return;
      }

      if (seg[0] !== 'api') { send(res, 404, { error: 'not found' }); return; }

      // GET /api/repos
      if (req.method === 'GET' && seg.length === 2 && seg[1] === 'repos') {
        send(res, 200, [...repos.values()].map((r) => ({ id: r.id, name: r.name, root: r.root, source: r.source, decls: r.traces.reduce((a, t) => a + t.decls.length, 0) })));
        return;
      }
      // POST /api/repos/open {path}
      if (req.method === 'POST' && seg.length === 3 && seg[1] === 'repos' && seg[2] === 'open') {
        const body = JSON.parse((await readBody(req)) || '{}') as { path?: string };
        if (!body.path) { send(res, 400, { error: 'path required' }); return; }
        const job = await ingestFolder(body.path, storeDir, (r) => repos.set(r.id, r));
        send(res, 202, job); return;
      }
      // POST /api/repos/scratch {prompt} — start scratch generation: the agent
      // drafts Lean from intent, the tracer elaborates it (with repair), and
      // only a Lean-verified trace becomes a repo with a map. Poll the job.
      if (req.method === 'POST' && seg.length === 3 && seg[1] === 'repos' && seg[2] === 'scratch') {
        const body = JSON.parse((await readBody(req)) || '{}') as { prompt?: string };
        if (!body.prompt?.trim()) { send(res, 400, { error: 'prompt required — say what to prove' }); return; }
        const job = startScratchGeneration(body.prompt, (f, c) => traceClient().trace(f, c), (done, trace) => {
          const repo = repoFromTraces(done.id, `Scratch: ${done.prompt.slice(0, 60)}`, storeDir, [trace], 'scratch');
          repos.set(repo.id, repo);
          done.repoId = repo.id;
          if (done.code) sourceOverrides.set(`${repo.id}:${trace.file}`, done.code);
        });
        send(res, 202, job);
        return;
      }
      if (req.method === 'GET' && seg.length === 3 && seg[1] === 'scratch-jobs') {
        const job = getScratchJob(seg[2]);
        send(res, job ? 200 : 404, job ?? { error: 'unknown scratch job' });
        return;
      }
      // POST /api/repos/upload {name, files:[{path,content}]} — browser folder
      // picker / drag-and-drop: files are materialised into a server-owned
      // working copy, then ingested like a folder. The user's real folder
      // is only ever read by their own browser.
      if (req.method === 'POST' && seg.length === 3 && seg[1] === 'repos' && seg[2] === 'upload') {
        const body = JSON.parse((await readBody(req, 12_000_000)) || '{}') as { name?: string; files?: UploadFile[] };
        try {
          const ws = createUploadWorkspace(storeDir, body.name ?? 'upload', body.files ?? []);
          send(res, 202, await ingestFolder(ws, storeDir, (r) => repos.set(r.id, r)));
        } catch (e) { send(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
        return;
      }
      // POST /api/repos/clone {url} — clone into /tmp/graspt-clones, then ingest (before the :id guard)
      if (req.method === 'POST' && seg.length === 3 && seg[1] === 'repos' && seg[2] === 'clone') {
        const body = JSON.parse((await readBody(req)) || '{}') as { url?: string };
        if (!body.url) { send(res, 400, { error: 'url required' }); return; }
        send(res, 202, await cloneAndIngest(body.url, storeDir, (r) => repos.set(r.id, r))); return;
      }
      if (req.method === 'GET' && seg[1] === 'jobs') {
        if (seg.length === 2) { send(res, 200, listJobs()); return; }
        const job = getJob(seg[2]); send(res, job ? 200 : 404, job ?? { error: 'unknown job' }); return;
      }

      const repo = seg[2] ? repos.get(seg[2]) : undefined;
      if (seg[1] === 'repos' && seg[2] && !repo) { send(res, 404, { error: `unknown repo ${seg[2]}` }); return; }

      // GET /api/repos/:id/atlas
      if (req.method === 'GET' && seg[3] === 'atlas' && repo) { send(res, 200, atlasFor(repo)); return; }
      // GET /api/repos/:id/proof/:decl
      if (req.method === 'GET' && seg[3] === 'proof' && repo) {
        const declName = seg[4];
        const map = proofMapFor(repo, declName);
        if (!map) { send(res, 404, { error: `unknown declaration ${declName}` }); return; }
        const saved = layoutStore.loadLayout(layoutRootFor(repo.id), declName);
        const savedByCanon: Record<string, { x: number; y: number }> = {};
        // re-key saved positions canonically is handled in resolvePositions via canon: keys stored by webview
        Object.assign(savedByCanon, saved);
        const positions = resolvePositions(map.nodes, map.edges, savedByCanon);
        send(res, 200, { ...map, positions }); return;
      }
      // POST /api/repos/:id/layout/:decl {positions} — stored server-side only
      if (req.method === 'POST' && seg[3] === 'layout' && repo) {
        const body = JSON.parse((await readBody(req)) || '{}') as { positions?: Record<string, { x: number; y: number }> };
        if (body.positions !== undefined) {
          const entries = Object.entries(body.positions ?? {});
          const valid = entries.length <= 5000 && entries.every(([k, v]) => typeof k === 'string' && v && Number.isFinite(v.x) && Number.isFinite(v.y));
          if (!valid) { send(res, 400, { error: 'positions must be an object of finite {x, y} points (max 5000)' }); return; }
          layoutStore.saveLayout(layoutRootFor(repo.id), seg[4], body.positions);
        }
        send(res, 200, { ok: true }); return;
      }
      // GET /api/repos/:id/neighbourhood/:decl?goal=
      if (req.method === 'GET' && seg[3] === 'neighbourhood' && repo) {
        const decl = declTrace(repo, seg[4]); const map = proofMapFor(repo, seg[4]);
        if (!decl || !map) { send(res, 404, { error: 'unknown declaration' }); return; }
        const nb = neighbourhood(decl, map, url.searchParams.get('goal') ?? undefined);
        send(res, nb ? 200 : 404, nb ?? { error: 'no neighbourhood' }); return;
      }
      // GET /api/repos/:id/walk/:decl?goal=
      if (req.method === 'GET' && seg[3] === 'walk' && repo) {
        const walk = navigatorWalk(repo, seg[4], url.searchParams.get('goal') ?? undefined);
        send(res, walk ? 200 : 404, walk ?? { error: 'no walk' }); return;
      }
      // POST /api/repos/:id/apply {decl, goal?, tactic} — the verified action:
      // splice the candidate over the frontier sorry in the session working
      // copy, re-elaborate with the warm tracer, and loop with diagnostic-driven
      // agent repair until something interesting happens (the frontier closes or
      // advances to a new verified subgoal) or MAX_REPAIR_ROUNDS is reached.
      if (req.method === 'POST' && seg[3] === 'apply' && repo) {
        const body = JSON.parse((await readBody(req)) || '{}') as { decl?: string; goal?: string; tactic?: string; loop?: boolean };
        if (!body.decl || !body.tactic) { send(res, 400, { error: 'decl and tactic required' }); return; }
        let initialTactic: string;
        try { initialTactic = cleanTactic(body.tactic); } catch (e) { send(res, 400, { error: e instanceof Error ? e.message : String(e) }); return; }
        const trace = repo.traces.find((t) => t.decls.some((d) => d.name === body.decl));
        const decl = trace?.decls.find((d) => d.name === body.decl);
        if (!trace || !decl) { send(res, 404, { error: `unknown declaration ${body.decl}` }); return; }
        const step = findSorryStep(decl, body.goal);
        if (!step) { send(res, 400, { error: `${body.decl} has no open frontier (sorry) to apply a tactic at in this demo slice` }); return; }
        const source = sourceFor(repo, trace.file);
        if (source === undefined) { send(res, 400, { error: `no Lean source available for ${trace.file} in this session` }); return; }
        const beforeSorries = sorryCount(decl);
        const targetGoal = decl.goals.find((g) => step.before.includes(g.id)) ?? decl.goals[0];
        const curMap = proofMapFor(repo, body.decl);
        const landmarks = (curMap?.nodes ?? []).filter((n) => n.kind === 'landmark').map((n) => n.label);
        const attempts: TryStepLog[] = [];
        const triedSet = new Set<string>();
        const queue: string[] = [initialTactic];
        const maxRounds = body.loop === false ? 1 : MAX_REPAIR_ROUNDS;

        try {
          for (let round = 1; round <= maxRounds; round++) {
            while (queue.length > 0) {
              const rawCand = queue.shift()!;
              let cand: string;
              try { cand = cleanTactic(rawCand); } catch { continue; }
              if (triedSet.has(cand)) continue;
              triedSet.add(cand);

              // 1. Try closing the frontier outright (`sorry` -> `cand`)
              const closeSource = replaceRange(source, step, cand);
              const afterClose = await traceClient().trace(trace.file, closeSource);
              const closeVerdict = judgeApplication(decl, afterClose, body.decl);
              if (closeVerdict.ok) {
                attempts.push({ round, tactic: cand, outcome: 'closed', detail: 'frontier closed' });
                const idx = repo.traces.indexOf(trace);
                if (idx >= 0) repo.traces[idx] = afterClose;
                sourceOverrides.set(`${repo.id}:${trace.file}`, closeSource);
                const afterDecl = afterClose.decls.find((d) => d.name === body.decl);
                const map = proofMapFor(repo, body.decl);
                const saved = layoutStore.loadLayout(layoutRootFor(repo.id), body.decl);
                const positions = map ? resolvePositions(map.nodes, map.edges, { ...saved }) : undefined;
                send(res, 200, {
                  ok: true, verified: true, kind: 'closed', decl: body.decl, tactic: cand, attempts,
                  explanation: `Lean accepted \`${cand}\` (attempt ${attempts.length}) and closed the frontier at ${body.decl}. Open frontiers went from ${beforeSorries} to ${sorryCount(afterDecl)}; the map has been redrawn.`,
                  map: map ? { ...map, positions } : undefined,
                });
                return;
              }

              // 2. If the tactic didn't close the goal outright, check if it advances the frontier
              // cleanly into a new subgoal (`sorry` -> `cand\n  sorry`).
              const hasUnsolvedMsg = closeVerdict.diagnostics.some((d) => /unsolved goals|still open/i.test(d));
              const hasHardSyntaxOrTypeErr = closeVerdict.diagnostics.some((d) => !/unsolved goals|still open/i.test(d));
              if (hasUnsolvedMsg && !hasHardSyntaxOrTypeErr) {
                const advSource = replaceRangeWithSorry(source, step, cand);
                const afterAdv = await traceClient().trace(trace.file, advSource);
                const advVerdict = judgeAdvancingApplication(decl, afterAdv, body.decl, targetGoal?.target);
                if (advVerdict.ok) {
                  attempts.push({ round, tactic: cand, outcome: 'advanced', detail: `advanced to new subgoal: ${advVerdict.unsolvedGoalPp ?? ''}` });
                  const idx = repo.traces.indexOf(trace);
                  if (idx >= 0) repo.traces[idx] = afterAdv;
                  sourceOverrides.set(`${repo.id}:${trace.file}`, advSource);
                  const map = proofMapFor(repo, body.decl);
                  const saved = layoutStore.loadLayout(layoutRootFor(repo.id), body.decl);
                  const positions = map ? resolvePositions(map.nodes, map.edges, { ...saved }) : undefined;
                  send(res, 200, {
                    ok: true, verified: true, kind: 'advanced', decl: body.decl, tactic: cand, attempts,
                    explanation: `Lean accepted \`${cand}\` (attempt ${attempts.length}) as a verified step that advances the frontier to a new subgoal. The map has been extended in place.`,
                    map: map ? { ...map, positions } : undefined,
                  });
                  return;
                }
              }

              attempts.push({
                round,
                tactic: cand,
                outcome: 'rejected',
                detail: closeVerdict.diagnostics.join(' | ') || 'rejected by Lean',
              });
            }

            // 3. Nothing in the queue worked on this round — ask the AI agent to repair/propose next tactics
            // using Lean's exact diagnostics, unless we are out of rounds or have no API key.
            if (round < maxRounds && hasMetaApiKey()) {
              const prompt = tacticRepairPrompt(
                body.decl,
                targetGoal?.pp || targetGoal?.target || body.decl,
                landmarks,
                attempts,
              );
              const reply = await askMeta(prompt);
              for (const c of reply.candidates) {
                if (c.tactic && !triedSet.has(c.tactic.trim())) queue.push(c.tactic.trim());
              }
              if (queue.length === 0) break;
            } else {
              break;
            }
          }

          const last = attempts[attempts.length - 1];
          send(res, 200, {
            ok: false, verified: false, kind: 'rejected', decl: body.decl, tactic: last?.tactic ?? initialTactic, attempts,
            explanation: `Tried ${attempts.length} tactic(s) with Lean (${attempts.map((a) => `\`${a.tactic}\``).join(' → ')}); none closed or advanced the frontier. Last diagnostic: ${last?.detail ?? 'none'}`,
            diagnostics: attempts.map((a) => `${a.tactic}: ${a.detail}`),
          });
        } catch (e) {
          send(res, 200, { ok: false, verified: false, decl: body.decl, tactic: initialTactic, attempts, explanation: `The tracer could not check \`${initialTactic}\`: ${e instanceof Error ? e.message : String(e)}`, diagnostics: [e instanceof Error ? e.message : String(e)] });
        }
        return;
      }
      // POST /api/repos/:id/chat {decl, goal?, question} — answered by the real agent CLI
      if (req.method === 'POST' && seg[3] === 'chat' && repo) {
        const body = JSON.parse((await readBody(req)) || '{}') as { decl?: string; goal?: string; question?: string };
        if (!body.question) { send(res, 400, { error: 'question required' }); return; }
        send(res, 200, await answerChat(repo, body.decl ?? '', body.goal, body.question)); return;
      }
      // GET /api/agent/status
      if (req.method === 'GET' && seg[1] === 'agent' && seg[2] === 'status') { send(res, 200, metaStatus()); return; }
      // Setup provisioning: GET status, POST install-lean|fetch-mathlib|generate-atlas, GET job
      if (req.method === 'GET' && seg[1] === 'setup' && seg[2] === 'status') { send(res, 200, await setupStatus(storeDir)); return; }
      if (req.method === 'GET' && seg[1] === 'setup' && seg[2] === 'demo-ready') { send(res, 200, await demoReady(storeDir)); return; }
      if (req.method === 'GET' && seg[1] === 'setup' && seg[2] === 'job') { const j = getSetupJob(seg[3] ?? ''); send(res, j ? 200 : 404, j ?? { error: 'unknown setup job' }); return; }
      if (req.method === 'POST' && seg[1] === 'setup') {
        if (seg[2] === 'install-lean') { send(res, 202, installLean()); return; }
        if (seg[2] === 'generate-atlas') { send(res, 202, generateAtlas(storeDir)); return; }
        if (seg[2] === 'fetch-mathlib') { const b = JSON.parse((await readBody(req)) || '{}') as { project?: string }; send(res, 202, fetchMathlib(b.project)); return; }
      }
      // POST /api/agent/key {apiKey} — stored server-side only, never echoed back
      if (req.method === 'POST' && seg[1] === 'agent' && seg[2] === 'key') {
        const body = JSON.parse((await readBody(req)) || '{}') as { apiKey?: string };
        if (body.apiKey?.trim() && !extractApiKey(body.apiKey)) {
          const placeholder = /\$(MODEL_API_KEY|META_API_KEY)/.test(body.apiKey);
          send(res, 400, { error: placeholder
            ? 'That paste contains the placeholder $MODEL_API_KEY, not your actual key. Paste the real token value (the key itself, not the example curl).'
            : 'That does not look like an API key. Paste only the token (a pasted curl or Bearer header also works — the token is extracted).' });
          return;
        }
        const pastedModel = extractModel(body.apiKey);
        if (pastedModel) setModel(pastedModel);
        setMetaApiKey(body.apiKey);
        send(res, 200, metaStatus()); return;
      }
      // Agent model: GET list offered by this pi, POST to select (persisted server-side)
      if (req.method === 'GET' && seg[1] === 'agent' && seg[2] === 'models') { send(res, 200, { models: [metaModel()] }); return; }
      if (req.method === 'POST' && seg[1] === 'agent' && seg[2] === 'model') {
        const body = JSON.parse((await readBody(req)) || '{}') as { model?: string };
        setModel(body.model);
        send(res, 200, metaStatus()); return;
      }
      // GET /api/colours — landmark area colours (single source: core/nav AREA_COLORS)
      if (req.method === 'GET' && seg[1] === 'colours') { send(res, 200, AREA_COLORS); return; }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof SyntaxError) send(res, 400, { error: `invalid JSON body: ${msg}` });
      else if (msg === 'request body too large') send(res, 413, { error: msg });
      else send(res, 500, { error: msg });
    }
  });

  return { server, repos, storeDir };
}

export function startServer(opts: ServerOptions): Promise<{ url: string; server: http.Server }> {
  const { server } = createServer(opts);
  return new Promise((resolve) => {
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ url: `http://127.0.0.1:${port}/`, server });
    });
  });
}

export { areaColor };
