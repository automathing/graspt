import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, post, type AtlasData, type MapNode, type NeighbourhoodData, type ProofMapData, type RepoInfo } from '@/lib/api';
import { ProofMap, areaColor } from '@/components/ProofMap';
import { ChatRail } from '@/components/ChatRail';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type Screen = 'start' | 'workspace';

const STARTERS = [
  { label: 'n·(n+1) is even', prompt: 'Prove that for every natural number n, n * (n + 1) is even.' },
  { label: 'Sum of odds = n²', prompt: 'Prove that the sum of the first n odd numbers equals n^2.' },
  { label: 'reverse ∘ reverse = id', prompt: 'Prove that reversing a list twice gives back the list.' },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>('start');
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoId, setRepoId] = useState('demo');
  const [atlas, setAtlas] = useState<AtlasData | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({ Core: '#94a3b8' });
  const [search, setSearch] = useState('');
  const [decl, setDecl] = useState<string | undefined>();
  const [map, setMap] = useState<ProofMapData | null>(null);
  const [goal, setGoal] = useState<string | undefined>();
  const [selectedNode, setSelectedNode] = useState<MapNode | undefined>();
  const [nb, setNb] = useState<NeighbourhoodData | null>(null);
  const [jobStatus, setJobStatus] = useState('');
  const [scratchPrompt, setScratchPrompt] = useState('');
  const [chatSeed, setChatSeed] = useState('');
  const [walkText, setWalkText] = useState('');

  const repo = repos.find((r) => r.id === repoId);

  const loadAtlas = useCallback(async (id: string) => {
    const a = await api<AtlasData>(`/api/repos/${encodeURIComponent(id)}/atlas`);
    setAtlas(a);
    return a;
  }, []);

  const loadRepos = useCallback(async () => {
    const rs = await api<RepoInfo[]>('/api/repos');
    setRepos(rs);
    return rs;
  }, []);

  useEffect(() => {
    void (async () => {
      try { setColors(await api('/api/colours')); } catch { /* keep default */ }
      const rs = await loadRepos();
      const id = rs.some((r) => r.id === 'demo') ? 'demo' : rs[0]?.id;
      if (id) { setRepoId(id); await loadAtlas(id); }
    })();
  }, [loadRepos, loadAtlas]);

  async function enterWorkspace(id: string) {
    setRepoId(id);
    setDecl(undefined); setMap(null); setGoal(undefined); setNb(null); setSelectedNode(undefined);
    await loadAtlas(id);
    setScreen('workspace');
  }

  async function pollJob(jobId: string) {
    for (;;) {
      const j = await api<any>(`/api/jobs/${jobId}`);
      setJobStatus(`${j.state}: ${j.detail}`);
      if (j.state === 'ready') {
        await loadRepos();
        if (j.repoId) await enterWorkspace(j.repoId);
        return;
      }
      if (j.state === 'failed') return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function openFolder(path: string) {
    if (!path.trim()) return;
    setJobStatus('ingesting…');
    const job = await api<any>('/api/repos/open', post({ path: path.trim() }));
    void pollJob(job.id);
  }

  async function cloneRepo(url: string) {
    if (!url.trim()) return;
    setJobStatus('cloning…');
    const job = await api<any>('/api/repos/clone', post({ url: url.trim() }));
    void pollJob(job.id);
  }

  async function startScratch() {
    if (!scratchPrompt.trim()) { setJobStatus('say what to prove first'); return; }
    setJobStatus('starting scratch generation…');
    const job = await api<any>('/api/repos/scratch', post({ prompt: scratchPrompt }));
    if (!job || job.error) { setJobStatus(`scratch failed: ${job?.error ?? 'empty response'}`); return; }
    for (;;) {
      const j = await api<any>(`/api/scratch-jobs/${job.id}`);
      setJobStatus(`${j.state}: ${j.detail}`);
      if (j.state === 'ready' && j.repoId) {
        await loadRepos();
        setChatSeed('');
        await enterWorkspace(j.repoId);
        if (j.declName) await openProof(j.declName, j.repoId);
        setJobStatus(j.detail);
        return;
      }
      if (j.state === 'failed') return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function openProof(name: string, id: string = repoId) {
    setDecl(name);
    setGoal(undefined); setNb(null); setSelectedNode(undefined); setWalkText('');
    const m = await api<ProofMapData>(`/api/repos/${encodeURIComponent(id)}/proof/${encodeURIComponent(name)}`);
    setMap(m);
    const root = m.nodes.find((n) => n.kind === 'theorem');
    if (root) void selectGoal(root, name, id);
  }

  async function selectGoal(n: MapNode, declName: string | undefined = decl, id: string = repoId) {
    if (!declName) return;
    setSelectedNode(n);
    if (n.id.startsWith('lm:') || (n.kind !== 'goal' && n.kind !== 'theorem' && n.kind !== 'frontier')) {
      setNb(null);
      return;
    }
    const goalId = n.id.replace(/^g:/, '');
    setGoal(goalId);
    const view = await api<NeighbourhoodData>(`/api/repos/${encodeURIComponent(id)}/neighbourhood/${encodeURIComponent(declName)}?goal=${encodeURIComponent(goalId)}`);
    if (!(view as any)?.error) setNb(view);
  }

  async function walk() {
    if (!decl) return;
    const w = await api<any>(`/api/repos/${encodeURIComponent(repoId)}/walk/${encodeURIComponent(decl)}${goal ? `?goal=${encodeURIComponent(goal)}` : ''}`);
    setWalkText(!w || w.error ? 'no walk available' : (w.steps?.length ? `walk: ${w.steps.map((s: any) => s.tactic).join(' → ')} (${w.note})` : w.note));
  }

  const visibleDecls = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (atlas?.decls ?? []).filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [atlas, search]);

  const presentAreas = useMemo(() => {
    const seen = new Map<string, string>();
    for (const lm of atlas?.landmarks ?? []) if (!seen.has(lm.area)) seen.set(lm.area, areaColor(colors, lm.area));
    return [...seen.entries()];
  }, [atlas, colors]);

  const contextLabel = decl
    ? `${decl}${goal ? ` · goal ${goal} — agent works from here` : ''}`
    : repo?.source === 'scratch' ? 'scratch session' : 'atlas — open a declaration';

  if (screen === 'start') {
    return (
      <div className="grid min-h-full lg:grid-cols-[minmax(340px,5fr)_7fr]">
        <section className="contours flex flex-col justify-between bg-forest-deep px-6 py-8 text-stone-100 sm:px-10">
          <div>
            <div className="flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-[50%_50%_50%_8px] bg-[#f2c66d] font-serif text-2xl font-extrabold text-forest">G</span>
              <strong className="font-serif text-2xl">Graspt</strong>
            </div>
            <h1 className="mt-14 max-w-md font-serif text-4xl font-bold leading-tight sm:text-[44px]">
              Stand on the map.<br />Direct the agent.<br />Lean tells the truth.
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-stone-300">
              Proved mathematics as territory you can walk: a stable allocentric map, your current
              place up close, and an AI agent that writes the Lean while you judge the direction.
            </p>
          </div>
          <div className="mt-12">
            <dl className="grid grid-cols-3 gap-4 border-t border-white/15 pt-5 font-serif">
              <div><dt className="text-[11px] uppercase tracking-widest text-stone-400">Demo proofs</dt><dd className="mt-1 text-2xl font-bold">{atlas?.declarations ?? '—'}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-widest text-stone-400">Landmarks</dt><dd className="mt-1 text-2xl font-bold">{atlas?.landmarks.length ?? '—'}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-widest text-stone-400">Frontiers</dt><dd className="mt-1 text-2xl font-bold">{(atlas?.decls ?? []).reduce((a, d) => a + d.frontier, 0)}</dd></div>
            </dl>
            <Button className="mt-6 bg-[#f2c66d] text-forest hover:bg-[#eabd57]" onClick={() => enterWorkspace('demo')}>
              Open the demo map →
            </Button>
            <p className="mt-3 text-xs text-stone-400">Pre-indexed — opens instantly, no Lean run needed.</p>
          </div>
        </section>

        <section className="px-6 py-8 sm:px-10" aria-label="Entry points">
          <h2 className="font-serif text-xl font-bold text-forest">Or start from your own work</h2>
          <p className="mb-2 mt-1 text-sm text-stone-500">Every way in converges to the same map, egocentric view, and agent chat.</p>

          <div className="divide-y divide-stone-300/80">
            <div className="py-6">
              <EntryHeading n={1} title="From scratch" desc="State a theorem in plain words. The agent drafts Lean; nothing is proved until Lean checks it." />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input placeholder="Prove that n * (n + 1) is always even…" value={scratchPrompt} onChange={(e) => setScratchPrompt(e.target.value)} aria-label="Theorem to prove from scratch" className="bg-white" />
                <Button onClick={startScratch} className="shrink-0">Start</Button>
              </div>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {STARTERS.map((s) => (
                  <Button key={s.label} size="sm" variant="outline" onClick={() => setScratchPrompt(s.prompt)}>{s.label}</Button>
                ))}
              </div>
            </div>

            <EntryRow n={2} title="Local Lean folder" desc="Open a Lean project on this machine. It is read, never written, until you fire a commit." placeholder="/path/to/lean-project" button="Open folder" onGo={openFolder} />
            <EntryRow n={3} title="Remote repository" desc="Clone a git repository into server scratch space and navigate its proofs." placeholder="https://github.com/owner/lean-repo.git" button="Clone repository" onGo={cloneRepo} />

            <div className="py-6">
              <EntryHeading n={4} title="Precomputed demos" desc="The built-in Lean demos on the left, plus anything you open appears here." />
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <select value={repoId} onChange={(e) => setRepoId(e.target.value)} aria-label="Repository"
                  className="h-10 flex-1 rounded-md border border-stone-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/40">
                  {repos.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.decls} decls)</option>)}
                </select>
                <Button variant="secondary" className="shrink-0" onClick={() => enterWorkspace(repoId)}>Open on the map</Button>
              </div>
            </div>
          </div>
          {jobStatus && <p className="mt-2 text-sm font-medium text-teal-900" role="status">{jobStatus}</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center gap-3 border-b-4 border-[#c28a2d] bg-forest px-4 py-2 text-stone-50 sm:px-6">
        <Button variant="ghost" className="text-stone-50 hover:bg-white/10" onClick={() => setScreen('start')}>← Start</Button>
        <strong className="font-serif text-lg">Graspt</strong>
        <span className="text-sm text-stone-300">{repo?.name ?? repoId}</span>
        {atlas && <span className="text-xs text-stone-400">{atlas.declarations} declarations · {atlas.landmarks.length} landmarks · {(atlas.decls ?? []).reduce((a, d) => a + d.frontier, 0)} open frontiers</span>}
      </header>

      <div className="grid flex-1 gap-4 p-4 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)_380px]">
        <aside className="space-y-3" aria-label="Declarations">
          <Input type="search" placeholder="Search declarations…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search declarations" />
          {presentAreas.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {presentAreas.map(([area, c]) => (
                <span key={area} className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] font-semibold"><i className="h-2 w-2 rounded-full" style={{ background: c }} />{area}</span>
              ))}
            </div>
          )}
          <div className="space-y-2">
            {visibleDecls.map((d) => (
              <button key={d.name} onClick={() => openProof(d.name)}
                className={`w-full rounded-lg border p-3 text-left shadow-sm transition-colors ${decl === d.name ? 'border-teal-800 bg-teal-50' : 'border-stone-200 bg-white hover:border-teal-700'}`}>
                <span className="flex items-start justify-between gap-2">
                  <b className="break-all font-mono text-[13px]">{d.name}</b>
                  <Badge variant={d.complete ? 'success' : 'warning'}>{d.complete ? 'Complete' : 'Open'}</Badge>
                </span>
                <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-stone-200"><i className="block h-full bg-teal-700" style={{ width: `${d.goals > 0 ? Math.max(0, Math.min(100, Math.round(((d.goals - d.frontier) / d.goals) * 100))) : 100}%` }} /></span>
                <span className="mt-1 block text-xs text-stone-500">{d.steps} steps · {d.goals} goals · {d.frontier} frontier</span>
              </button>
            ))}
            {visibleDecls.length === 0 && <p className="text-sm text-stone-500">{atlas ? 'No declarations match your search.' : 'No declarations yet — direct the agent in the chat.'}</p>}
          </div>
        </aside>

        <main className="min-w-0 space-y-4">
          {decl && map ? (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
                <div className="min-w-52 flex-1">
                  <p className="text-[11px] font-extrabold uppercase tracking-widest text-teal-800">Allocentric proof map</p>
                  <h2 className="break-all font-mono text-lg font-bold">{decl}</h2>
                  <span className="text-xs text-stone-500">{map.stats.steps} steps · {map.stats.goals} goals · {map.stats.frontier} frontier · {map.stats.landmarks} landmarks</span>
                </div>
                <Button variant="secondary" size="sm" onClick={walk}>Navigator walk</Button>
              </div>
              {walkText && <p className="break-words text-sm text-teal-900" role="status">{walkText}</p>}
              <Card className="overflow-hidden">
                <ProofMap map={map} colors={colors} selectedId={selectedNode?.id} onSelect={selectGoal} />
                <p className="border-t border-stone-200 px-3 py-2 text-xs text-stone-500">Tab through nodes, press Enter to stand on one — the egocentric view below follows, and the agent’s context moves with you.</p>
              </Card>

              <Card aria-label="Egocentric view">
                <CardContent className="grid gap-5 pt-5 lg:grid-cols-[1.25fr_.75fr_1.6fr]">
                  <div>
                    <p className="text-[11px] font-extrabold uppercase tracking-widest text-teal-800">Egocentric — where am I?</p>
                    <pre className="contours mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-forest-deep p-3.5 font-mono text-xs leading-relaxed text-teal-50 shadow-inner">
                      {selectedNode && !nb ? `${selectedNode.label}\nKind: ${selectedNode.kind}${selectedNode.area ? `\nArea: ${selectedNode.area}` : ''}${selectedNode.uses !== undefined ? `\nUses: ${selectedNode.uses}` : ''}${selectedNode.kind === 'landmark' ? '\n\nSuggested tactic is unverified until Lean checks it.' : ''}` : nb ? (nb.centre.pp || nb.centre.target) : 'Click a goal node.'}
                    </pre>
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500">Trail from root</h3>
                    <p className="mt-2 break-words font-mono text-xs leading-relaxed text-stone-600">{nb ? (nb.trail.length ? nb.trail.join(' → ') : 'At the root goal.') : 'Select a circular goal node.'}</p>
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-stone-500">Nearest neighbours</h3>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {(nb?.neighbours ?? []).map((n) => (
                        <button key={n.nodeId} className="rounded-md border border-stone-200 bg-white p-2.5 text-left hover:border-teal-700"
                          onClick={() => { const node = map.nodes.find((x) => x.id === n.nodeId); if (node) void selectGoal(node); }}>
                          <b className="block break-words font-mono text-[13px]">{n.kind === 'landmark' && <i className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: areaColor(colors, n.area) }} />}{n.label}</b>
                          <span className="mt-0.5 block text-xs text-stone-500">{n.relation} · distance {n.distance}{n.area ? ` · ${n.area}` : ''}{n.tacticSuggestion ? ` · suggested (unverified): ${n.tacticSuggestion}` : ''}</span>
                        </button>
                      ))}
                      {!nb && <p className="text-sm text-stone-500">Select a goal to see what is near it.</p>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <h2 className="font-serif text-xl font-bold">Pick a declaration to stand in its proof</h2>
                <p className="mt-1 text-sm text-stone-500">The allocentric map opens here, the egocentric view below it, and the agent on the right works from wherever you stand.</p>
              </CardContent>
            </Card>
          )}
        </main>

        <div className="lg:sticky lg:top-[72px] lg:h-[calc(100vh-88px)]">
          <ChatRail repoId={repoId} decl={decl} goal={goal} contextLabel={contextLabel} initialPrompt={chatSeed}
            onMapUpdate={(m) => { setMap(m); const root = m.nodes.find((n) => n.kind === 'theorem'); if (root) void selectGoal(root); }} />
        </div>
      </div>
    </div>
  );
}

function EntryHeading({ n, title, desc }: { n: number; title: string; desc: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="font-serif text-sm font-bold text-brass">{String(n).padStart(2, '0')}</span>
      <div>
        <h3 className="font-serif text-lg font-bold leading-snug text-stone-900">{title}</h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-500">{desc}</p>
      </div>
    </div>
  );
}

function EntryRow({ n, title, desc, placeholder, button, onGo }: {
  n: number; title: string; desc: string; placeholder: string; button: string; onGo: (v: string) => void;
}) {
  const [v, setV] = useState('');
  return (
    <div className="py-6">
      <EntryHeading n={n} title={title} desc={desc} />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} aria-label={title} className="bg-white" />
        <Button variant="secondary" className="shrink-0" onClick={() => onGo(v)}>{button}</Button>
      </div>
    </div>
  );
}
