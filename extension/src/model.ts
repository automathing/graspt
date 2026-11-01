// Pure model: turns a traced declaration into a multi-resolution topological proof map.
//
// Map anatomy (the "convex hull" metaphor):
//   theorem  – the target we want to connect to what is known (top of the map)
//   goal     – an intermediate state, identified by its Lean MVarId (exact identity)
//   move     – a (possibly coarse-grained) block of tactics transforming one goal into others
//   landmark – a known declaration (Mathlib / Core / local) that a move leans on
//   known    – the sink: a branch is finished when it is grounded in the known
//   frontier – a goal that is not yet grounded (`sorry`, or left unsolved)
//
// Coarse-graining contracts goals that sit on a linear chain (one move in, one move out)
// according to the reader's level, so an expert sees structural pivots and a learner sees
// every step. `pinned` goals (user unpacked) are never contracted; `chunked` goals (user
// said "I grok this") always are.

import type { DeclTrace, Importance, MapEdge, MapNode, ProofMap, Step } from './types';

export interface BuildOptions {
  level: 1 | 2 | 3;
  importance?: Importance | null;
  landmarkThreshold: number;
  pinned?: Set<string>;
  chunked?: Set<string>;
  maxLandmarksPerMove?: number;
  /** names declared in the same file: always eligible as landmarks */
  localNames?: Set<string>;
}

interface RawMove {
  id: string;
  steps: number[];
  from: string;
  to: string[];
  sorry: boolean;
}

const PLUMBING = new Set([
  'intro', 'intros', 'rintro', 'show', 'change', 'unfold', 'delta', 'dsimp', 'norm_cast',
  'push_cast', 'clear', 'rename_i', 'subst', 'assumption', 'trivial', 'rfl', 'symm',
  'exact_mod_cast', 'skip', 'with_reducible', 'beta_reduce', 'set_option',
]);

const MILESTONE = new Set([
  'have', 'obtain', 'suffices', 'induction', 'cases', 'rcases', 'constructor', 'refine',
  'use', 'exists', 'calc', 'by_contra', 'by_cases', 'contrapose', 'contrapose!', 'interval_cases',
  'fin_cases', 'match', 'let', 'set', 'wlog', 'induction\'', 'cases\'', 'apply', 'exact',
]);

export function tacticHead(tactic: string): string {
  const t = tactic.trim().replace(/^·\s*/, '');
  const m = t.match(/^[A-Za-z_][A-Za-z0-9_'!?]*/);
  return m ? m[0] : t.slice(0, 1);
}

export function relationOf(target: string): string {
  const t = target.trim();
  if (/^(∀|∃|Π|Σ)/.test(t)) return 'quant';
  if (t.includes('↔')) return 'iff';
  if (/(≤|<|≥|>|≠)/.test(t)) return 'order';
  if (/\s=\s/.test(t)) return 'eq';
  if (/(∧|∨|¬)/.test(t)) return 'logic';
  if (/(∣|Even|Odd|Prime)/.test(t)) return 'arith';
  return 'prop';
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function isSorryStep(s: Step): boolean {
  return /^sorry\b/.test(s.tactic.trim()) || /tacticSorry$/.test(s.kind) || s.kind.endsWith('.sorry');
}

/** Turn tactic steps into raw goal-to-goals moves. */
export function rawMoves(decl: DeclTrace): RawMove[] {
  const steps = decl.steps;
  const children = new Map<number, number[]>();
  for (const s of steps) {
    if (s.parent !== null && s.parent !== undefined) {
      if (!children.has(s.parent)) children.set(s.parent, []);
      children.get(s.parent)!.push(s.idx);
    }
  }
  const descendants = (i: number): number[] => {
    const out: number[] = [];
    const stack = [...(children.get(i) ?? [])];
    while (stack.length) {
      const j = stack.pop()!;
      out.push(j);
      stack.push(...(children.get(j) ?? []));
    }
    return out;
  };
  const moves: RawMove[] = [];
  for (const s of steps) {
    if (s.before.length === 0) continue;
    const g = s.before[0];
    const desc = descendants(s.idx);
    // A container whose descendants already handle its main goal (e.g. `· tac`) is transparent.
    if (desc.some((d) => steps[d].before[0] === g)) continue;
    const producedInside = new Set<string>();
    for (const d of desc) for (const a of steps[d].after) producedInside.add(a);
    const spawned: string[] = [];
    for (const d of desc) {
      const b = steps[d].before[0];
      if (b && b !== g && !producedInside.has(b) && !s.before.includes(b) && !spawned.includes(b)) spawned.push(b);
    }
    const newAfter = s.after.filter((a) => !s.before.includes(a));
    const to = [...new Set([...spawned, ...newAfter])];
    moves.push({ id: `m${s.idx}`, steps: [s.idx], from: g, to, sorry: isSorryStep(s) });
  }
  return moves;
}

export function buildProofMap(decl: DeclTrace, opts: BuildOptions): ProofMap {
  const goals = new Map(decl.goals.map((g) => [g.id, g]));
  const stepsByIdx = new Map(decl.steps.map((s) => [s.idx, s]));
  const pinned = opts.pinned ?? new Set<string>();
  const chunked = opts.chunked ?? new Set<string>();
  const maxL = opts.maxLandmarksPerMove ?? (opts.level === 1 ? 2 : 3);
  const table = opts.importance?.table ?? {};
  const areas = opts.importance?.areas ?? [];
  const local = opts.localNames ?? new Set<string>();

  let moves = rawMoves(decl);
  const root = decl.steps.find((s) => s.before.length > 0)?.before[0];

  // frontier: sources of sorry moves, and targets that nothing ever consumes
  const sorryMoves = moves.filter((m) => m.sorry);
  moves = moves.filter((m) => !m.sorry);
  const frontier = new Map<string, number | undefined>();
  for (const m of sorryMoves) frontier.set(m.from, m.steps[0]);
  const consumed = new Set(moves.map((m) => m.from));
  for (const m of moves) for (const t of m.to) if (!consumed.has(t) && !frontier.has(t)) frontier.set(t, undefined);

  const uses = (name: string): number => table[name]?.[0] ?? 0;
  const moveWeight = (m: RawMove): number => {
    let w = 0;
    for (const i of m.steps) {
      const s = stepsByIdx.get(i)!;
      for (const c of [...s.constants, ...s.used]) w = Math.max(w, uses(c));
    }
    return w;
  };
  const heads = (m: RawMove) => m.steps.map((i) => tacticHead(stepsByIdx.get(i)!.tactic));
  const isMinor = (m: RawMove) =>
    heads(m).every((h) => PLUMBING.has(h)) && moveWeight(m) < opts.landmarkThreshold;
  const isMilestone = (m: RawMove) =>
    heads(m).some((h) => MILESTONE.has(h) && h !== 'exact' && h !== 'apply') ||
    moveWeight(m) >= opts.landmarkThreshold * 10;

  // ---- coarse-graining by contracting linear chains --------------------------------------
  if (opts.level > 1 || chunked.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of goals.keys()) {
        if (n === root || frontier.has(n) || pinned.has(n)) continue;
        const ins = moves.filter((m) => m.to.includes(n));
        const outs = moves.filter((m) => m.from === n);
        if (ins.length !== 1 || outs.length !== 1) continue;
        const [m1] = ins;
        const [m2] = outs;
        if (m1.to.length !== 1) continue;
        let contract = chunked.has(n);
        if (!contract && opts.level === 2) contract = isMinor(m1) || isMinor(m2);
        if (!contract && opts.level === 3) contract = !isMilestone(m1) || isMinor(m2);
        if (!contract) continue;
        const merged: RawMove = {
          id: `${m1.id}+${m2.id}`,
          steps: [...m1.steps, ...m2.steps].sort((a, b) => a - b),
          from: m1.from,
          to: m2.to,
          sorry: false,
        };
        moves = moves.filter((m) => m !== m1 && m !== m2);
        moves.push(merged);
        changed = true;
        break;
      }
    }
  }

  // ---- emit nodes & edges -----------------------------------------------------------------
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const seenGoal = new Set<string>();
  const emitGoal = (id: string) => {
    if (seenGoal.has(id)) return;
    seenGoal.add(id);
    const g = goals.get(id);
    const target = g?.target ?? '?';
    const isRoot = id === root;
    const isFrontier = frontier.has(id);
    const sorryStep = frontier.get(id);
    const ss = sorryStep !== undefined ? stepsByIdx.get(sorryStep) : undefined;
    nodes.push({
      id: `g:${id}`,
      kind: isRoot ? 'theorem' : isFrontier ? 'frontier' : 'goal',
      label: isRoot ? `${decl.name.split('.').pop()}\n${truncate(target, 56)}` : truncate(target, 56),
      detail: g?.pp ?? target,
      relation: relationOf(target),
      sorryStep,
      range: ss ? { startLine: ss.startLine, startCol: ss.startCol, endLine: ss.endLine, endCol: ss.endCol } : undefined,
    });
  };

  let hasKnown = false;
  const landmarkSeen = new Set<string>();
  for (const m of moves.sort((a, b) => a.steps[0] - b.steps[0])) {
    emitGoal(m.from);
    const ss = m.steps.map((i) => stepsByIdx.get(i)!);
    const first = ss[0];
    const last = ss[ss.length - 1];
    const hs = ss.map((s) => tacticHead(s.tactic));
    const label =
      ss.length === 1 ? truncate(first.tactic, 30) : `${hs[0]} … ${hs[hs.length - 1]}  ·${ss.length}`;
    const mid = `mv:${m.id}`;
    nodes.push({
      id: mid,
      kind: 'move',
      label,
      detail: ss.map((s) => s.tactic).join('\n'),
      steps: m.steps,
      milestone: isMilestone(m),
      collapsed: ss.length,
      range: { startLine: first.startLine, startCol: first.startCol, endLine: last.endLine, endCol: last.endCol },
    });
    edges.push({ id: `e:${m.from}->${mid}`, source: `g:${m.from}`, target: mid, kind: 'flow' });
    if (m.to.length === 0) {
      hasKnown = true;
      edges.push({ id: `e:${mid}->known`, source: mid, target: 'known', kind: 'flow' });
    }
    for (const t of m.to) {
      emitGoal(t);
      edges.push({ id: `e:${mid}->${t}`, source: mid, target: `g:${t}`, kind: 'flow' });
    }

    // landmarks this move leans on
    const cand = new Map<string, number>();
    for (const s of ss) {
      for (const c of s.constants) {
        const u = uses(c);
        if (u >= opts.landmarkThreshold || local.has(c) || !opts.importance) cand.set(c, Math.max(u, 1) + 1e6);
      }
      for (const c of s.used) {
        const u = uses(c);
        if (u >= opts.landmarkThreshold) cand.set(c, Math.max(cand.get(c) ?? 0, u));
      }
    }
    const top = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxL);
    for (const [name] of top) {
      const lid = `lm:${name}`;
      if (!landmarkSeen.has(name)) {
        landmarkSeen.add(name);
        const entry = table[name];
        nodes.push({
          id: lid,
          kind: 'landmark',
          label: name,
          area: entry ? areas[entry[1]] ?? 'Core' : local.has(name) ? 'Local' : 'Core',
          uses: entry?.[0] ?? 0,
        });
      }
      edges.push({ id: `e:${lid}->${mid}`, source: lid, target: mid, kind: 'uses' });
    }
  }
  for (const f of frontier.keys()) emitGoal(f);
  if (root) emitGoal(root);
  if (hasKnown) nodes.push({ id: 'known', kind: 'known', label: 'grounded in the known' });

  return {
    decl: decl.name,
    level: opts.level,
    nodes,
    edges,
    stats: {
      steps: decl.steps.length,
      goals: seenGoal.size,
      frontier: frontier.size,
      landmarks: landmarkSeen.size,
      complete: frontier.size === 0,
    },
  };
}

/** Goal ids interior to a (coarse) move: unpacking pins them so they reappear. */
export function interiorGoals(decl: DeclTrace, stepIdxs: number[]): string[] {
  const set = new Set(stepIdxs);
  const out = new Set<string>();
  for (const s of decl.steps) {
    if (!set.has(s.idx)) continue;
    for (const a of s.after) out.add(a);
  }
  // keep only goals that are also consumed inside the block (strictly interior)
  const consumedInside = new Set(decl.steps.filter((s) => set.has(s.idx)).map((s) => s.before[0]));
  return [...out].filter((g) => consumedInside.has(g));
}

/** Pick the declaration containing a 1-based line. */
export function declAtLine(decls: DeclTrace[], line: number): DeclTrace | undefined {
  return decls.find((d) => line >= d.startLine && line <= d.endLine) ?? decls[0];
}
