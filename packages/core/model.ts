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
// One map per tracked lemma (declaration), at full step detail. Granularity is not a
// model setting: the webview derives it from the viewport zoom, so zooming in reveals
// minor moves and landmarks and zooming out hides them. The only contraction here is
// explicit: `chunked` goals (user said "I grok this") are folded; `pinned` goals
// (user unpacked) never are.

import type { DeclTrace, Importance, MapEdge, MapNode, ProofMap, Step } from './types';
import { canonicalGoalKey, detectLoopClosures, parseHypotheses } from './nav';

export interface BuildOptions {
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

const MILESTONE = new Set([
  'have', 'obtain', 'suffices', 'induction', 'cases', 'rcases', 'constructor', 'refine',
  'use', 'exists', 'calc', 'by_contra', 'by_cases', 'contrapose', 'contrapose!', 'interval_cases',
  'fin_cases', 'match', 'let', 'set', 'wlog', 'induction\'', 'cases\'', 'apply', 'exact',
]);

const TYPE_BOUNDARY = new Set([
  'have', 'suffices', 'obtain', 'let', 'set', 'wlog', 'calc', 'case',
]);

const KERNEL_NOISE = new Set([
  'Eq', 'Eq.refl', 'Eq.symm', 'Eq.trans', 'Eq.mp', 'Eq.mpr', 'Eq.ndrec', 'Eq.rec', 'rfl',
  'OfNat.ofNat', 'Not', 'True', 'True.intro', 'False', 'Or', 'And', 'Iff', 'Exists',
  'Nat', 'Int', 'Prod', 'Prod.mk', 'Prod.fst', 'Prod.snd', 'PProd', 'MProd',
  'HAdd.hAdd', 'HSub.hSub', 'HMul.hMul', 'HDiv.hDiv', 'HMod.hMod', 'HPow.hPow', 'Neg.neg',
  'ite', 'dite', 'congr', 'congrArg', 'congrFun', "congrFun'", 'Decidable.byContradiction',
  'id', 'Function.comp', 'sorryAx', 'propext', 'funext', 'Classical.choice',
  'ite_eq_left_of_eq_true', 'ite_eq_right_of_eq_false', 'of_eq_true', 'eq_true', 'eq_false',
]);

function isKernelNoise(name: string): boolean {
  if (KERNEL_NOISE.has(name)) return true;
  const last = name.split('.').pop() ?? name;
  if (/^(inst[A-Z]|_@|match_|rec\b|casesOn\b|recOn\b|brecOn\b|below\b|noConfusion)/.test(last)) return true;
  return false;
}

/**
 * A landmark's area comes from the atlas entry when there is one, else from
 * being declared in the user's own file. Never guess an area from a constant's
 * name (sum_5 §3): an unmapped constant is Core, so its colour stays honest.
 */
export function inferArea(name: string, local: Set<string>, entryArea?: string): string {
  if (entryArea) return entryArea;
  if (local.has(name)) return 'Local';
  for (const decl of local) {
    const ns = decl.slice(0, decl.lastIndexOf('.'));
    if (ns && name.startsWith(`${ns}.`)) return 'Local';
  }
  return 'Core';
}

export function isTypeBoundaryTactic(tactic: string): boolean {
  const h = tacticHead(tactic);
  return TYPE_BOUNDARY.has(h) || /^(have|suffices|obtain|case)\b/.test(tactic.trim());
}

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
  const absorbed = new Set<number>();
  const moves: RawMove[] = [];
  for (const s of steps) {
    if (absorbed.has(s.idx)) continue;
    if (s.before.length === 0) continue;
    const rawTac = s.tactic.trim();
    if (s.kind === 'Lean.cdotTk' || s.kind === 'by' || rawTac === '·' || rawTac === 'by') continue;
    const g = s.before[0];
    const desc = descendants(s.idx);
    // A container whose descendants already handle its main goal (e.g. `· tac`) is transparent.
    if (desc.some((d) => steps[d].before[0] === g)) continue;
    const producedInside = new Set<string>();
    for (const d of desc) for (const a of steps[d].after) producedInside.add(a);
    const consumedInside = new Set<string>();
    for (const d of desc) if (steps[d].before[0]) consumedInside.add(steps[d].before[0]);
    const hasSorryInside = desc.some((d) => isSorryStep(steps[d]));
    const hasOpenInside = [...producedInside].some((a) => !consumedInside.has(a));
    // If a tactic block (e.g. `have h : P := by omega`) completely closes its auxiliary subgoal
    // inline without `sorry`, treat the block as a single self-contained move `g -> newAfter`.
    if (desc.length > 0 && !hasSorryInside && !hasOpenInside && s.after.length > 0) {
      for (const d of desc) absorbed.add(d);
      const newAfter = s.after.filter((a) => !s.before.includes(a));
      moves.push({ id: `m${s.idx}`, steps: [s.idx], from: g, to: [...new Set(newAfter)], sorry: isSorryStep(s) });
      continue;
    }
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
  const maxL = opts.maxLandmarksPerMove ?? 3;
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
      for (const c of s.constants) w = Math.max(w, uses(c));
      for (const c of s.used) if (!isKernelNoise(c)) w = Math.max(w, uses(c));
    }
    return w;
  };
  const heads = (m: RawMove) => m.steps.map((i) => tacticHead(stepsByIdx.get(i)!.tactic));
  const hasTypeBoundary = (m: RawMove) =>
    m.steps.some((i) => isTypeBoundaryTactic(stepsByIdx.get(i)!.tactic));
  const isMilestone = (m: RawMove) =>
    hasTypeBoundary(m) ||
    heads(m).some((h) => MILESTONE.has(h) && h !== 'exact' && h !== 'apply') ||
    moveWeight(m) >= opts.landmarkThreshold * 10;

  // ---- explicit chunking only: fold linear chains through goals the user marked "I grok this" --
  if (chunked.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of goals.keys()) {
        const gObj = goals.get(n);
        const canon = gObj ? canonicalGoalKey(gObj.target, gObj.pp) : '';
        const isPinned = pinned.has(n) || (canon !== '' && pinned.has(canon));
        const isChunked = chunked.has(n) || (canon !== '' && chunked.has(canon));
        if (n === root || frontier.has(n) || isPinned || !isChunked) continue;
        const ins = moves.filter((m) => m.to.includes(n));
        const outs = moves.filter((m) => m.from === n);
        if (ins.length !== 1 || outs.length !== 1) continue;
        const [m1] = ins;
        const [m2] = outs;
        if (m1.to.length !== 1) continue;
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
  const loopClosures = detectLoopClosures(decl.goals);
  const seenGoal = new Set<string>();
  const rootTarget = root ? goals.get(root)?.target : undefined;
  const emitGoal = (id: string) => {
    if (seenGoal.has(id)) return;
    seenGoal.add(id);
    const g = goals.get(id);
    const target = g?.target ?? '?';
    const isRoot = id === root;
    const isFrontier = frontier.has(id);
    const sorryStep = frontier.get(id);
    const ss = sorryStep !== undefined ? stepsByIdx.get(sorryStep) : undefined;
    const canon = canonicalGoalKey(target, g?.pp);
    const equiv = loopClosures.get(id);
    let displayTarget = truncate(target, 56);
    if (!isRoot && rootTarget && target === rootTarget && g?.pp) {
      const hyps = parseHypotheses(g.pp);
      const lastHyp = hyps[hyps.length - 1];
      if (lastHyp) {
        displayTarget = `${truncate(`${lastHyp.name} : ${lastHyp.type}`, 44)}\n⊢ ${truncate(target, 48)}`;
      }
    }
    nodes.push({
      id: `g:${id}`,
      kind: isRoot ? 'theorem' : isFrontier ? 'frontier' : 'goal',
      label: isRoot ? `${decl.name.split('.').pop()}\n${truncate(target, 56)}` : displayTarget,
      detail: g?.pp ?? target,
      relation: relationOf(target),
      sorryStep,
      range: ss ? { startLine: ss.startLine, startCol: ss.startCol, endLine: ss.endLine, endCol: ss.endCol } : undefined,
      canonicalKey: canon,
      equivalentTo: equiv,
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
      typeBoundary: hasTypeBoundary(m),
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
        if (isKernelNoise(c)) continue;
        const u = uses(c);
        cand.set(c, Math.max(u, 1) + 1e6);
      }
      for (const c of s.used) {
        if (isKernelNoise(c)) continue;
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
        const entryArea = entry ? areas[entry[1]] : undefined;
        nodes.push({
          id: lid,
          kind: 'landmark',
          label: name,
          area: inferArea(name, local, entryArea),
          uses: entry?.[0] ?? 0,
        });
      }
      edges.push({ id: `e:${lid}->${mid}`, source: lid, target: mid, kind: 'uses' });
    }
  }
  for (const f of frontier.keys()) emitGoal(f);
  if (root) emitGoal(root);
  if (hasKnown) nodes.push({ id: 'known', kind: 'known', label: 'grounded in the known' });

  // Emit loop-closure equivalence edges between equivalent subgoals
  const seenLoops = new Set<string>();
  for (const [gId, equivs] of loopClosures.entries()) {
    for (const otherId of equivs) {
      const pairKey = [gId, otherId].sort().join('<->');
      if (!seenLoops.has(pairKey)) {
        seenLoops.add(pairKey);
        edges.push({
          id: `loop:${pairKey}`,
          source: `g:${gId}`,
          target: `g:${otherId}`,
          kind: 'equiv',
        });
      }
    }
  }

  return {
    decl: decl.name,
    nodes,
    edges,
    stats: {
      steps: decl.steps.length,
      goals: seenGoal.size,
      frontier: frontier.size,
      landmarks: landmarkSeen.size,
      complete: frontier.size === 0,
      loopClosures: seenLoops.size,
    },
  };
}

/** Goal ids and canonical keys interior to a (coarse) move: unpacking pins them so they reappear. */
export function interiorGoals(decl: DeclTrace, stepIdxs: number[]): string[] {
  const set = new Set(stepIdxs);
  const out = new Set<string>();
  for (const s of decl.steps) {
    if (!set.has(s.idx)) continue;
    for (const a of s.after) out.add(a);
  }
  const consumedInside = new Set(decl.steps.filter((s) => set.has(s.idx)).map((s) => s.before[0]));
  const ids = [...out].filter((g) => consumedInside.has(g));
  const keys: string[] = [...ids];
  for (const id of ids) {
    const g = decl.goals.find((x) => x.id === id);
    if (g) {
      const ck = canonicalGoalKey(g.target, g.pp);
      if (ck) keys.push(ck);
    }
  }
  return keys;
}

/** Pick the declaration containing a 1-based line. */
export function declAtLine(decls: DeclTrace[], line: number): DeclTrace | undefined {
  return decls.find((d) => line >= d.startLine && line <= d.endLine) ?? decls[0];
}
