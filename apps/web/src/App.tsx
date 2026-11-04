import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [walkOpen, setWalkOpen] = useState(false);
  const [walkText, setWalkText] = useState('');
  const [declsOpen, setDeclsOpen] = useState(true);
  const [navHistory, setNavHistory] = useState<MapNode[]>([]);
  const [visitedIds, setVisitedIds] = useState<Set<string>>(new Set());

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
    setDecl(undefined); setMap(null); setGoal(undefined); setNb(null); setSelectedNode(undefined); setDeclsOpen(true); setNavHistory([]); setVisitedIds(new Set());
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

  async function uploadFolder(name: string, files: { path: string; content: string }[]) {
    setJobStatus(`uploading ${files.length} file(s) from ${name}…`);
    const job = await api<any>('/api/repos/upload', post({ name, files }));
    if (!job || job.error) { setJobStatus(`upload failed: ${job?.error ?? 'empty response'}`); return; }
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
    setDeclsOpen(false);
    setGoal(undefined); setNb(null); setSelectedNode(undefined); setWalkOpen(false); setWalkText(''); setNavHistory([]); setVisitedIds(new Set());
    const m = await api<ProofMapData>(`/api/repos/${encodeURIComponent(id)}/proof/${encodeURIComponent(name)}`);
    setMap(m);
    const root = m.nodes.find((n) => n.kind === 'theorem');
    if (root) void selectGoal(root, name, id, { pushHistory: false, mapOverride: m });
  }

  async function selectGoal(
    n: MapNode,
    declName: string | undefined = decl,
    id: string = repoId,
    opts?: { pushHistory?: boolean; mapOverride?: ProofMapData },
  ) {
    if (!declName) return;
    if (opts?.pushHistory !== false && selectedNode && selectedNode.id !== n.id) {
      setNavHistory((prev) => {
        const top = prev[prev.length - 1];
        if (top?.id === selectedNode.id) return prev;
        return [...prev.slice(-49), selectedNode];
      });
    }
    setVisitedIds((prev) => {
      if (prev.has(n.id)) return prev;
      const next = new Set(prev);
      next.add(n.id);
      return next;
    });
    setSelectedNode(n);
    const activeMap = opts?.mapOverride ?? map;
    if (n.id.startsWith('lm:') || (n.kind !== 'goal' && n.kind !== 'theorem' && n.kind !== 'frontier')) {
      if (!nb && activeMap) {
        const flowEdges = activeMap.edges.filter((e) => e.kind === 'flow');
        let anchorGoalId: string | undefined;
        if (n.id.startsWith('lm:')) {
          const usesEdge = activeMap.edges.find((e) => e.source === n.id && e.kind === 'uses');
          const incToMove = usesEdge ? flowEdges.find((e) => e.target === usesEdge.target) : undefined;
          anchorGoalId = incToMove?.source;
        } else if (n.kind === 'move') {
          anchorGoalId = flowEdges.find((e) => e.target === n.id)?.source;
        } else if (n.kind === 'known') {
          const incToKnown = flowEdges.find((e) => e.target === n.id);
          const incToMove = incToKnown ? flowEdges.find((e) => e.target === incToKnown.source) : undefined;
          anchorGoalId = incToMove?.source;
        }
        const fallbackId = (anchorGoalId ?? activeMap.nodes.find((x) => x.kind === 'theorem')?.id)?.replace(/^g:/, '');
        if (fallbackId) {
          setGoal(fallbackId);
          const view = await api<NeighbourhoodData>(`/api/repos/${encodeURIComponent(id)}/neighbourhood/${encodeURIComponent(declName)}?goal=${encodeURIComponent(fallbackId)}`);
          if (!(view as any)?.error) setNb(view);
        }
      }
      return;
    }
    const goalId = n.id.replace(/^g:/, '');
    setGoal(goalId);
    const view = await api<NeighbourhoodData>(`/api/repos/${encodeURIComponent(id)}/neighbourhood/${encodeURIComponent(declName)}?goal=${encodeURIComponent(goalId)}`);
    if (!(view as any)?.error) setNb(view);
  }

  async function toggleWalk() {
    if (!decl) return;
    if (walkOpen) {
      setWalkOpen(false);
      return;
    }
    setWalkOpen(true);
    const w = await api<any>(`/api/repos/${encodeURIComponent(repoId)}/walk/${encodeURIComponent(decl)}${goal ? `?goal=${encodeURIComponent(goal)}` : ''}`);
    setWalkText(!w || w.error ? 'no walk available' : (w.steps?.length ? `walk: ${w.steps.map((s: any) => s.tactic).join(' → ')} (${w.note})` : w.note));
  }

  // Interactive step-by-step backtrace chain from root theorem to the currently selected node
  const backtraceSteps = useMemo(() => {
    if (!map || !selectedNode) return [];
    const flowEdges = map.edges.filter((e) => e.kind === 'flow');
    const nodesById = new Map(map.nodes.map((n) => [n.id, n]));
    const chain: { goalNode: MapNode; moveLabel?: string }[] = [];
    let currId: string | undefined = selectedNode.id;

    // When standing on a landmark, move, or known terminal node, keep it at the tip of the chain
    // and trace back from the connected move/goal so the backtrace never disappears at a dead end.
    if (selectedNode.kind === 'landmark') {
      const usesEdges = map.edges.filter((e) => e.source === selectedNode.id && e.kind === 'uses');
      const preferredMoveEdge =
        (goal ? usesEdges.find((ue) => flowEdges.some((fe) => fe.target === ue.target && fe.source === `g:${goal}`)) : undefined) ??
        usesEdges[0];
      const moveNode = preferredMoveEdge ? nodesById.get(preferredMoveEdge.target) : undefined;
      chain.unshift({ goalNode: selectedNode, moveLabel: moveNode?.label ?? 'uses' });
      const incToMove = moveNode ? flowEdges.find((e) => e.target === moveNode.id) : undefined;
      currId = incToMove?.source ?? (goal ? `g:${goal}` : undefined);
    } else if (selectedNode.kind === 'move') {
      chain.unshift({ goalNode: selectedNode, moveLabel: selectedNode.label });
      currId = flowEdges.find((e) => e.target === selectedNode.id)?.source;
    } else if (selectedNode.kind === 'known') {
      const incEdges = flowEdges.filter((e) => e.target === selectedNode.id);
      const preferredInc =
        (goal ? incEdges.find((ie) => flowEdges.some((fe) => fe.target === ie.source && fe.source === `g:${goal}`)) : undefined) ??
        incEdges[0];
      const moveNode = preferredInc ? nodesById.get(preferredInc.source) : undefined;
      chain.unshift({ goalNode: selectedNode, moveLabel: moveNode?.label ?? 'grounded' });
      const incToMove = moveNode ? flowEdges.find((e) => e.target === moveNode.id) : undefined;
      currId = incToMove?.source ?? (goal ? `g:${goal}` : undefined);
    }

    let safety = 40;
    while (currId && safety-- > 0) {
      const currNode = nodesById.get(currId);
      if (!currNode) break;
      const incToGoal = flowEdges.find((e) => e.target === currId);
      if (!incToGoal) {
        if (currNode.kind === 'theorem' || currNode.kind === 'goal' || currNode.kind === 'frontier') {
          chain.unshift({ goalNode: currNode });
        }
        break;
      }
      const prevNode = nodesById.get(incToGoal.source);
      if (prevNode?.kind === 'move') {
        if (currNode.kind === 'theorem' || currNode.kind === 'goal' || currNode.kind === 'frontier') {
          chain.unshift({ goalNode: currNode, moveLabel: prevNode.label });
        }
        const incToMove = flowEdges.find((e) => e.target === prevNode.id);
        currId = incToMove?.source;
      } else {
        if (currNode.kind === 'theorem' || currNode.kind === 'goal' || currNode.kind === 'frontier') {
          chain.unshift({ goalNode: currNode });
        }
        currId = incToGoal.source;
      }
    }
    return chain;
  }, [map, selectedNode, goal]);

  const isNonGoalNode = Boolean(
    selectedNode && selectedNode.kind !== 'goal' && selectedNode.kind !== 'theorem' && selectedNode.kind !== 'frontier',
  );

  const childNeighbours = useMemo(() => {
    if (!nb || !map || isNonGoalNode) return [];
    return nb.neighbours
      .filter((n) => n.relation === 'child')
      .map((n) => map.nodes.find((x) => x.id === n.nodeId))
      .filter((n): n is MapNode => Boolean(n));
  }, [nb, map, isNonGoalNode]);

  const isDeadEnd = Boolean(selectedNode && (isNonGoalNode || (nb && childNeighbours.length === 0)));

  const parentGoalNode = backtraceSteps.length > 1 ? backtraceSteps[backtraceSteps.length - 2].goalNode : undefined;
  const prevHistoryNode = navHistory.length > 0 ? navHistory[navHistory.length - 1] : undefined;
  const rootTheoremNode = useMemo(() => map?.nodes.find((n) => n.kind === 'theorem'), [map]);
  const backTargetNode =
    (prevHistoryNode && prevHistoryNode.id !== selectedNode?.id ? prevHistoryNode : undefined) ??
    parentGoalNode ??
    (rootTheoremNode && rootTheoremNode.id !== selectedNode?.id ? rootTheoremNode : undefined);

  const nextBranchNode = useMemo(() => {
    if (!map || !selectedNode) return undefined;
    const flowEdges = map.edges.filter((e) => e.kind === 'flow');
    const nodesById = new Map(map.nodes.map((n) => [n.id, n]));
    const sibs = (nb?.neighbours ?? [])
      .filter((n) => n.relation === 'sibling')
      .map((n) => nodesById.get(n.nodeId))
      .filter((n): n is MapNode => Boolean(n));
    const unvisitedSib = sibs.find((s) => !visitedIds.has(s.id)) ?? sibs[0];
    if (unvisitedSib && unvisitedSib.id !== selectedNode.id) return unvisitedSib;

    const chainIds = new Set(backtraceSteps.map((s) => s.goalNode.id));
    for (let i = backtraceSteps.length - 2; i >= 0; i--) {
      const anc = backtraceSteps[i].goalNode;
      const outMoves = flowEdges.filter((e) => e.source === anc.id).map((e) => e.target);
      for (const mvId of outMoves) {
        const children = flowEdges
          .filter((e) => e.source === mvId && e.target !== 'known')
          .map((e) => nodesById.get(e.target))
          .filter((n): n is MapNode => Boolean(n));
        const unvisitedChild = children.find((c) => !visitedIds.has(c.id) && !chainIds.has(c.id));
        if (unvisitedChild) return unvisitedChild;
      }
    }
    return map.nodes.find((n) => n.kind === 'frontier' && n.id !== selectedNode.id && !visitedIds.has(n.id));
  }, [map, selectedNode, nb, backtraceSteps, visitedIds]);

  const nonGoalConnections = useMemo(() => {
    if (!map || !selectedNode || !isNonGoalNode) return [];
    const flowEdges = map.edges.filter((e) => e.kind === 'flow');
    const nodesById = new Map(map.nodes.map((n) => [n.id, n]));
    const out: { node: MapNode; badge: string }[] = [];
    const seen = new Set<string>();
    const add = (node: MapNode | undefined, badge: string) => {
      if (!node || seen.has(node.id)) return;
      seen.add(node.id);
      out.push({ node, badge });
    };
    if (selectedNode.kind === 'landmark') {
      const usesEdges = map.edges.filter((e) => e.source === selectedNode.id && e.kind === 'uses');
      for (const ue of usesEdges) {
        const inc = flowEdges.find((fe) => fe.target === ue.target);
        if (inc) add(nodesById.get(inc.source), '↑ Used at goal');
      }
    } else if (selectedNode.kind === 'move') {
      for (const ie of flowEdges.filter((fe) => fe.target === selectedNode.id)) {
        add(nodesById.get(ie.source), '↑ Parent goal');
      }
      for (const oe of flowEdges.filter((fe) => fe.source === selectedNode.id && fe.target !== 'known')) {
        add(nodesById.get(oe.target), '↓ Subgoal');
      }
    } else if (selectedNode.kind === 'known') {
      for (const ie of flowEdges.filter((fe) => fe.target === selectedNode.id)) {
        const incToMove = flowEdges.find((fe) => fe.target === ie.source);
        if (incToMove) add(nodesById.get(incToMove.source), '↑ Grounded from goal');
      }
    }
    return out;
  }, [map, selectedNode, isNonGoalNode]);

  function goBack() {
    if (navHistory.length > 0) {
      const prev = navHistory[navHistory.length - 1];
      setNavHistory((h) => h.slice(0, -1));
      if (prev.id !== selectedNode?.id) {
        void selectGoal(prev, decl, repoId, { pushHistory: false });
        return;
      }
    }
    if (parentGoalNode && parentGoalNode.id !== selectedNode?.id) {
      void selectGoal(parentGoalNode, decl, repoId, { pushHistory: false });
      return;
    }
    if (rootTheoremNode && selectedNode?.id !== rootTheoremNode.id) {
      void selectGoal(rootTheoremNode, decl, repoId, { pushHistory: false });
    }
  }

  // Egocentric step navigation: steps into an unvisited child subgoal when available;
  // when at a dead end (or all child subgoals visited), automatically goes back.
  function stepEgocentric() {
    if (!isDeadEnd && childNeighbours.length > 0) {
      const unvisitedChild = childNeighbours.find((c) => !visitedIds.has(c.id));
      const target = unvisitedChild ?? (!backTargetNode ? childNeighbours[0] : undefined);
      if (target) {
        void selectGoal(target);
        return;
      }
    }
    goBack();
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

            <FolderEntry onUpload={uploadFolder} />
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

      <div className="grid flex-1 gap-4 p-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_390px]">
        <main className="min-w-0 space-y-3">
          {(declsOpen || !decl) && (
            <section className="rounded-lg border border-stone-200 bg-white/90 p-2.5 shadow-sm" aria-label="Declarations">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                <div className="flex items-center gap-2">
                  <Input type="search" placeholder="Filter declarations…" value={search} onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search declarations" className="h-8 w-52 bg-white text-xs sm:w-64" />
                  <span className="text-xs text-stone-500">{visibleDecls.length}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {presentAreas.map(([area, c]) => (
                    <span key={area} className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-[10px] font-semibold">
                      <i className="h-2 w-2 rounded-full" style={{ background: c }} />{area}
                    </span>
                  ))}
                  {decl && (
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-stone-500" onClick={() => setDeclsOpen(false)}>
                      Hide
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex gap-2 overflow-x-auto scroll-smooth pb-1.5 pt-0.5">
                {visibleDecls.map((d) => {
                  const active = decl === d.name;
                  const pct = d.goals > 0 ? Math.max(0, Math.min(100, Math.round(((d.goals - d.frontier) / d.goals) * 100))) : 100;
                  return (
                    <button key={d.name} onClick={() => openProof(d.name)}
                      className={`group w-52 shrink-0 rounded-md border px-2.5 py-2 text-left transition-all ${active ? 'border-teal-800 bg-teal-50/90 ring-1 ring-teal-700/40' : 'border-stone-200 bg-white hover:border-teal-700'}`}>
                      <span className="flex items-center justify-between gap-1.5">
                        <b className="truncate font-mono text-xs text-stone-900" title={d.name}>{d.name}</b>
                        <Badge variant={d.complete ? 'success' : 'warning'} className="px-1.5 py-0 text-[10px]">
                          {d.complete ? 'Done' : `${d.frontier} open`}
                        </Badge>
                      </span>
                      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-stone-200">
                        <i className="block h-full bg-teal-700" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="mt-1 block text-[11px] text-stone-500">{d.steps} steps · {d.goals} goals</span>
                    </button>
                  );
                })}
                {visibleDecls.length === 0 && (
                  <p className="py-2 text-xs text-stone-500">{atlas ? 'No declarations match.' : 'No declarations yet.'}</p>
                )}
              </div>
            </section>
          )}

          {decl && map ? (
            <>
              <div className="rounded-lg border border-stone-200 bg-white p-3 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-52 flex-1">
                    <p className="text-[11px] font-extrabold uppercase tracking-widest text-teal-800">Allocentric proof map</p>
                    <div className="flex flex-wrap items-baseline gap-2.5">
                      <h2 className="break-all font-mono text-base font-bold">{decl}</h2>
                      <span className="text-xs text-stone-500">{map.stats.steps} steps · {map.stats.goals} goals · {map.stats.frontier} frontier · {map.stats.landmarks} landmarks</span>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-expanded={declsOpen}
                    onClick={() => setDeclsOpen((o) => !o)}>
                    {declsOpen ? 'Hide declarations' : `Declarations (${visibleDecls.length})`}
                  </Button>
                  <Button
                    variant={walkOpen ? 'default' : 'secondary'}
                    size="sm"
                    aria-pressed={walkOpen}
                    onClick={toggleWalk}>
                    {walkOpen ? 'Hide walk' : 'Navigator walk'}
                  </Button>
                </div>
                {walkOpen && walkText && (
                  <div className="mt-2.5 rounded-md border border-teal-800/20 bg-teal-50/60 px-3 py-2 font-mono text-xs text-teal-950" role="status">
                    {walkText}
                  </div>
                )}
              </div>

              <Card className="overflow-hidden">
                <ProofMap map={map} colors={colors} selectedId={selectedNode?.id} onSelect={selectGoal} />
              </Card>

              <Card aria-label="Egocentric view" className="border-stone-300">
                <CardContent className="space-y-4 pt-4">
                  <div className="rounded-md border border-stone-200 bg-stone-50/90 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-extrabold uppercase tracking-wider text-stone-600">
                        Backtrace
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {backTargetNode && (
                          <button
                            className="rounded border border-teal-700/40 bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-teal-900 hover:bg-teal-50"
                            onClick={goBack}
                            title={`Go back to ${(backTargetNode.label || '').split('\n').pop() || backTargetNode.id}`}>
                            ← Go back
                          </button>
                        )}
                        {parentGoalNode && parentGoalNode.id !== backTargetNode?.id && (
                          <button
                            className="rounded border border-stone-300 bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-stone-700 hover:border-teal-700 hover:bg-teal-50"
                            onClick={() => void selectGoal(parentGoalNode)}>
                            ↑ Parent
                          </button>
                        )}
                        {(childNeighbours.length > 0 || backTargetNode) && (
                          <button
                            className={`rounded border px-2 py-0.5 font-mono text-[11px] font-semibold transition-colors ${
                              isDeadEnd || childNeighbours.every((c) => visitedIds.has(c.id))
                                ? 'border-amber-600/50 bg-amber-50 text-amber-950 hover:bg-amber-100'
                                : 'border-teal-800 bg-teal-800 text-stone-50 hover:bg-teal-900'
                            }`}
                            onClick={stepEgocentric}
                            title={
                              isDeadEnd || childNeighbours.every((c) => visitedIds.has(c.id))
                                ? 'Dead end reached — step back automatically'
                                : 'Step forward to next unvisited subgoal'
                            }>
                            {isDeadEnd || childNeighbours.every((c) => visitedIds.has(c.id))
                              ? '↩ Dead end · Go back'
                              : 'Step ↓'}
                          </button>
                        )}
                      </div>
                    </div>
                    {backtraceSteps.length > 0 ? (
                      <div className="mt-1.5 flex max-h-24 flex-wrap items-center gap-1.5 overflow-y-auto pr-1">
                        {backtraceSteps.map((step, idx) => {
                          const isCurrent = step.goalNode.id === selectedNode?.id;
                          const shortLabel = (step.goalNode.label || '').split('\n').pop()?.slice(0, 32) || step.goalNode.id;
                          return (
                            <span key={`${step.goalNode.id}-${idx}`} className="inline-flex items-center gap-1.5">
                              {step.moveLabel && (
                                <span className="rounded bg-stone-200/80 px-1.5 py-0.5 font-mono text-[11px] text-stone-700" title="Tactic move">
                                  ─[{step.moveLabel}]→
                                </span>
                              )}
                              <button
                                onClick={() => void selectGoal(step.goalNode)}
                                className={`rounded-md border px-2 py-0.5 font-mono text-xs transition-colors ${
                                  isCurrent
                                    ? 'border-brass bg-forest text-stone-50 font-bold shadow-sm'
                                    : 'border-stone-300 bg-white text-stone-800 hover:border-teal-700 hover:bg-teal-50'
                                }`}
                                title={`Step ${idx + 1}: ${step.goalNode.label}`}>
                                <span className="mr-1 opacity-60">#{idx + 1}</span>
                                {idx === 0 && step.goalNode.kind === 'theorem' ? 'Root' : shortLabel}
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="mt-1 font-mono text-xs text-stone-500">
                        {nb ? (nb.trail.length ? nb.trail.join(' → ') : 'Root') : '—'}
                      </p>
                    )}
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1.45fr)]">
                    <div className="flex min-w-0 flex-col">
                      <div className="flex flex-wrap items-center justify-between gap-1.5">
                        <p className="text-[11px] font-extrabold uppercase tracking-widest text-teal-800">Egocentric (Γ ⊢ T)</p>
                        <div className="flex items-center gap-1.5">
                          {isNonGoalNode && selectedNode && (
                            <Badge variant="outline" className="text-[10px] uppercase">{selectedNode.kind}</Badge>
                          )}
                          {nb?.centre.isFrontier && <Badge variant="warning" className="text-[10px]">Open Frontier</Badge>}
                          {isDeadEnd && !nb?.centre.isFrontier && (
                            <Badge variant="secondary" className="text-[10px]">Dead end</Badge>
                          )}
                        </div>
                      </div>
                      <pre className="contours mt-1.5 flex-1 max-h-64 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded-md bg-forest-deep p-3.5 font-mono text-xs leading-relaxed text-teal-50 shadow-inner">
                        {isNonGoalNode && selectedNode
                          ? `${selectedNode.label}\nKind: ${selectedNode.kind}${selectedNode.area ? `\nArea: ${selectedNode.area}` : ''}${selectedNode.uses !== undefined ? `\nUses: ${selectedNode.uses}` : ''}${nb ? `\n\n── Active goal (${nb.centre.goalId}) ──\n${nb.centre.pp || nb.centre.target}` : ''}`
                          : nb
                            ? (nb.centre.pp || nb.centre.target)
                            : '—'}
                      </pre>
                    </div>

                    <div className="min-w-0 space-y-2.5">
                      <h3 className="text-[11px] font-extrabold uppercase tracking-widest text-stone-600">Nearest Neighbours</h3>

                      {isDeadEnd && (backTargetNode || nextBranchNode) && (
                        <div className="rounded-md border border-amber-500/50 bg-amber-50/80 px-3 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono text-[11px] font-bold text-amber-950">
                              {isNonGoalNode
                                ? `Dead end (${selectedNode?.kind}) — no subgoals forward`
                                : nb?.centre.isFrontier
                                  ? 'Open frontier — end of current branch'
                                  : 'Branch grounded — no further subgoals'}
                            </span>
                            <div className="flex flex-wrap items-center gap-1.5">
                              {backTargetNode && (
                                <button
                                  onClick={goBack}
                                  className="rounded border border-amber-700/50 bg-white px-2.5 py-1 font-mono text-xs font-bold text-amber-950 shadow-sm transition-colors hover:border-teal-800 hover:bg-teal-50">
                                  ← Go back ({backTargetNode.kind === 'theorem' ? 'Root' : (backTargetNode.label || '').split('\n').pop()?.slice(0, 22) || backTargetNode.id})
                                </button>
                              )}
                              {nextBranchNode && nextBranchNode.id !== backTargetNode?.id && (
                                <button
                                  onClick={() => void selectGoal(nextBranchNode)}
                                  className="rounded border border-teal-700/50 bg-teal-800 px-2.5 py-1 font-mono text-xs font-bold text-stone-50 shadow-sm transition-colors hover:bg-teal-900">
                                  ↪ Next branch ({(nextBranchNode.label || '').split('\n').pop()?.slice(0, 22) || nextBranchNode.id})
                                </button>
                              )}
                              {rootTheoremNode && rootTheoremNode.id !== selectedNode?.id && rootTheoremNode.id !== backTargetNode?.id && (
                                <button
                                  onClick={() => void selectGoal(rootTheoremNode)}
                                  className="rounded border border-stone-300 bg-white px-2 py-1 font-mono text-xs font-semibold text-stone-700 hover:border-teal-700">
                                  ↺ Root
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="max-h-64 space-y-2.5 overflow-y-auto overflow-x-hidden pr-1">
                        {nonGoalConnections.length > 0 && (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {nonGoalConnections.map(({ node, badge }) => (
                              <button key={node.id}
                                className="min-w-0 rounded-md border border-stone-200 border-l-4 border-l-teal-700 bg-stone-50/70 px-2.5 py-2 text-left transition-colors hover:border-teal-700 hover:bg-teal-50/40"
                                onClick={() => void selectGoal(node)}>
                                <span className="flex items-center justify-between gap-1 text-[10px] font-bold uppercase tracking-wider text-teal-900">
                                  <span>{badge}</span>
                                  <span className="font-normal text-stone-400">d=1</span>
                                </span>
                                <b className="mt-0.5 block truncate font-mono text-xs text-stone-900" title={node.label}>{node.label}</b>
                              </button>
                            ))}
                          </div>
                        )}

                        {nb ? (
                          <div className="space-y-2.5">
                            {nb.neighbours.some((n) => n.relation !== 'landmark') && (
                              <div className="grid gap-2 sm:grid-cols-2">
                                {nb.neighbours.filter((n) => n.relation !== 'landmark').map((n) => {
                                  const visited = visitedIds.has(n.nodeId);
                                  const dirBadge = n.relation === 'parent' ? '↑ Parent'
                                    : n.relation === 'child' ? (visited ? '↓ Subgoal · Visited' : '↓ Subgoal')
                                    : n.relation === 'sibling' ? '↔ Sibling'
                                    : '≡ Equivalent';
                                  const borderTone = n.relation === 'parent' ? 'border-l-4 border-l-teal-700'
                                    : n.kind === 'frontier' ? 'border-l-4 border-l-amber-500'
                                    : 'border-l-4 border-l-stone-400';
                                  return (
                                    <button key={n.nodeId}
                                      className={`min-w-0 rounded-md border border-stone-200 ${borderTone} bg-stone-50/70 px-2.5 py-2 text-left transition-colors hover:border-teal-700 hover:bg-teal-50/40`}
                                      onClick={() => { const node = map.nodes.find((x) => x.id === n.nodeId); if (node) void selectGoal(node); }}>
                                      <span className="flex items-center justify-between gap-1 text-[10px] font-bold uppercase tracking-wider text-teal-900">
                                        <span>{dirBadge}</span>
                                        <span className="font-normal text-stone-400">d={n.distance}</span>
                                      </span>
                                      <b className="mt-0.5 block truncate font-mono text-xs text-stone-900" title={n.label}>{n.label}</b>
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            {nb.neighbours.some((n) => n.relation === 'landmark') && (
                              <div>
                                <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-stone-500">Landmarks</p>
                                <div className="grid gap-1.5 sm:grid-cols-2">
                                  {nb.neighbours.filter((n) => n.relation === 'landmark').map((n) => (
                                    <button key={n.nodeId}
                                      className="flex min-w-0 flex-col justify-between rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-left transition-colors hover:border-teal-700"
                                      onClick={() => { const node = map.nodes.find((x) => x.id === n.nodeId); if (node) void selectGoal(node); }}>
                                      <span className="flex min-w-0 items-center justify-between gap-1.5">
                                        <b className="truncate font-mono text-xs text-stone-900" title={n.label}>
                                          <i className="mr-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: areaColor(colors, n.area) }} />
                                          {n.label}
                                        </b>
                                        {n.area && <span className="shrink-0 text-[10px] text-stone-400">{n.area.replace(/^Mathlib\./, '')}</span>}
                                      </span>
                                      {n.tacticSuggestion && (
                                        <span className="mt-1 inline-block max-w-full truncate rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600" title={n.tacticSuggestion}>
                                          {n.tacticSuggestion}
                                        </span>
                                      )}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-stone-400">—</p>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <h2 className="font-serif text-lg font-bold">Select a declaration above</h2>
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

const UPLOADABLE = (name: string) => name.endsWith('.lean') || name === 'lakefile.toml' || name === 'lakefile.lean' || name === 'lean-toolchain';
const SKIP = new Set(['.git', '.lake', 'node_modules', 'dist']);

async function readFiles(picked: { file: File; path: string }[]): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = [];
  for (const { file, path } of picked) {
    if (!UPLOADABLE(path.split('/').pop() ?? '')) continue;
    out.push({ path, content: await file.text() });
    if (out.length >= 300) break;
  }
  return out;
}

async function traverseEntry(entry: FileSystemEntry, prefix: string, acc: { file: File; path: string }[]): Promise<void> {
  if (SKIP.has(entry.name)) return;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    acc.push({ file, path: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    for (const c of children) await traverseEntry(c, `${prefix}${entry.name}/`, acc);
  }
}

function FolderEntry({ onUpload }: { onUpload: (name: string, files: { path: string; content: string }[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // webkitdirectory is not a standard React prop; set it on the DOM node.
    if (inputRef.current) {
      inputRef.current.setAttribute('webkitdirectory', '');
      inputRef.current.setAttribute('directory', '');
    }
  }, []);

  async function fromPicker(files: FileList | null) {
    if (!files?.length) return;
    const picked = [...files].map((file) => ({ file, path: (file as any).webkitRelativePath || file.name }));
    const name = picked[0]?.path.split('/')[0] || 'upload';
    onUpload(name, await readFiles(picked));
  }

  async function fromDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const acc: { file: File; path: string }[] = [];
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file');
    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (entry) await traverseEntry(entry, '', acc);
      else { const f = item.getAsFile(); if (f) acc.push({ file: f, path: f.name }); }
    }
    if (!acc.length) return;
    const name = acc[0].path.split('/')[0] || 'upload';
    onUpload(name, await readFiles(acc));
  }

  return (
    <div className="py-6">
      <EntryHeading n={2} title="Local Lean folder" desc="Your browser reads the folder and uploads its Lean sources to a server working copy. The original folder is never written." />
      <div
        role="button" tabIndex={0} aria-label="Drop a Lean folder here, or click to choose one"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={fromDrop}
        className={`mt-3 cursor-pointer rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors ${dragging ? 'border-teal-700 bg-teal-50' : 'border-stone-300 bg-white/60 hover:border-teal-700'}`}>
        <p className="font-serif text-base font-bold text-stone-800">Drag &amp; drop a Lean folder here</p>
        <p className="mt-1 text-sm text-stone-500">or click to choose a folder — only <code className="font-mono text-xs">.lean</code> sources and Lake files are uploaded (≤300 files, ≤10 MB)</p>
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => { void fromPicker(e.target.files); e.target.value = ''; }} />
      </div>
    </div>
  );
}
