// Navigation logic: canonical keys, loop closure, LocalView (Compass), Tape and Gauge extraction,
// hypothesis extraction, and history stack.

import type { DeclTrace, GoalView, GrasptMode, LocalView, Neighbourhood, ProofMap } from './types';
import { isSorryStep, relationOf } from './model';

// ---------------------------------------------------------------------------
// The single source of landmark colour. Colour = Mathlib area only;
// selection/cursor/frontier are rings and fills of other channels, never this.

export const AREA_COLORS: Record<string, string> = {
  'Mathlib.Topology': '#2f9e6e',
  'Mathlib.Algebra': '#7a62c9',
  'Mathlib.Analysis': '#3a8fd9',
  'Mathlib.Data': '#b98f1d',
  'Mathlib.Order': '#d97a36',
  'Mathlib.NumberTheory': '#d95f8e',
  'Mathlib.LinearAlgebra': '#5a67c9',
  'Mathlib.MeasureTheory': '#2a9d8f',
  'Mathlib.CategoryTheory': '#d95f5f',
  'Mathlib.Tactic': '#7a8794',
  Local: '#1f8aa5',
  Core: '#94a3b8',
};

/** Area colour, longest-prefix matched; anything unmapped is Core grey, never an invented hue. */
export function areaColor(area?: string): string {
  if (!area) return AREA_COLORS.Core;
  if (AREA_COLORS[area]) return AREA_COLORS[area];
  let best = '';
  for (const k of Object.keys(AREA_COLORS)) if (area.startsWith(k) && k.length > best.length) best = k;
  return best ? AREA_COLORS[best] : AREA_COLORS.Core;
}

// ---------------------------------------------------------------------------
// Modes: Mode A (`explore`) is read-only; Mode B (`contribute`) is the
// only mode that may run frontier exploration or splice a ghost, and a ghost
// may splice only when Lean verified it feasible.

export function canExplore(mode: GrasptMode): boolean {
  return mode === 'contribute';
}

export function canSplice(mode: GrasptMode, feasible: boolean): boolean {
  return mode === 'contribute' && feasible;
}

function normalizeExpr(s: string): string {
  return s
    .replace(/\._@\.[^\s)]+/g, '')
    .replace(/✝([₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹0-9]*)/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*<->\s*/g, ' ↔ ')
    .replace(/\s*->\s*/g, ' → ')
    .trim();
}

/**
 * Readable canonical place text: a place is `Γ ⊢ T`, not just `T`.
 * Hypothesis names are dropped (α-level identity); hypothesis types are sorted
 * so order in the pretty-printer does not create distinct places.
 */
export function canonicalGoalText(target: string, pp?: string): string {
  const hypTypes = (pp ? parseHypotheses(pp) : []).map((h) => normalizeExpr(h.type)).sort();
  const t = normalizeExpr(target);
  return hypTypes.length ? `${hypTypes.join(', ')} ⊢ ${t}` : `⊢ ${t}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Stable place identity for topological SLAM.
 * Hash of `canonicalGoalText`, so the same `Γ ⊢ T` across branches and
 * re-traces (where MVarIds change) maps to the same place, while the same
 * target under different hypotheses does not. Heuristic string identity,
 * not a defeq check.
 */
export function canonicalGoalKey(target: string, pp?: string): string {
  return `gk_${fnv1a(canonicalGoalText(target, pp))}`;
}

/**
 * Extracts structured hypotheses `{ name, type }` from a Lean pretty-printed goal (`ppGoal`).
 */
export function parseHypotheses(pp: string): { name: string; type: string }[] {
  if (!pp) return [];
  const lines = pp.split('\n');
  const turnstileIdx = lines.findIndex((l) => l.trim().startsWith('⊢'));
  const hypLines = turnstileIdx >= 0 ? lines.slice(0, turnstileIdx) : [];
  const out: { name: string; type: string }[] = [];

  for (const raw of hypLines) {
    const line = raw.trim();
    if (!line || line.startsWith('case ')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const name = line.slice(0, colonIdx).trim();
      const type = line.slice(colonIdx + 1).trim();
      if (name && type) {
        out.push({ name, type });
      }
    }
  }
  return out;
}

/**
 * Finds all groups of goals that share the same canonical target.
 * When |group| >= 2, this is a topological Loop Closure (revisiting an equivalent state).
 */
export function detectLoopClosures(goals: GoalView[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const g of goals) {
    const key = canonicalGoalKey(g.target, g.pp);
    if (!key || key === '?') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(g.id);
  }

  const loopMap = new Map<string, string[]>();
  for (const [, ids] of groups) {
    if (ids.length > 1) {
      for (const id of ids) {
        loopMap.set(
          id,
          ids.filter((other) => other !== id),
        );
      }
    }
  }
  return loopMap;
}

/**
 * Suggests an affordance tactic for a landmark given a goal target.
 */
export function inferLandmarkAffordance(landmarkName: string, target: string): string {
  const rel = relationOf(target);
  if (rel === 'eq' || rel === 'iff') return `rw [${landmarkName}]`;
  if (landmarkName.includes('dvd') || landmarkName.includes('le') || landmarkName.includes('lt')) {
    return `apply ${landmarkName}`;
  }
  return `apply ${landmarkName}`;
}

/**
 * Computes the egocentric LocalView (Piccinini Model 3 Compass) for a specific goal.
 * Answers:
 *   North (↑) = predecessor / parent goal
 *   South (↓) = successor / child goal
 *   East/West (←/→) = sibling branches
 *   Surroundings = attached landmarks & loop closure portals
 */
export function computeLocalView(
  decl: DeclTrace,
  proofMap: ProofMap,
  rawGoalId?: string,
): LocalView | undefined {
  if (!decl.goals.length) return undefined;

  const goalId = rawGoalId ? rawGoalId.replace(/^g:/, '') : decl.goals[0].id;
  const goal = decl.goals.find((g) => g.id === goalId) ?? decl.goals[0];
  const canonKey = canonicalGoalKey(goal.target, goal.pp);

  // Identify root goal
  const firstStepWithBefore = decl.steps.find((s) => s.before.length > 0);
  const rootId = firstStepWithBefore?.before[0];
  const isRoot = goal.id === rootId;

  // Identify if this is a frontier (sorry step or unconsumed target)
  const sorryStep = decl.steps.find((s) => isSorryStep(s) && s.before.includes(goal.id));
  const isFrontier = !!sorryStep || proofMap.nodes.some((n) => n.id === `g:${goal.id}` && n.kind === 'frontier');

  // Find parent move (the move whose .to includes this goal)
  const incomingFlowEdge = proofMap.edges.find((e) => e.target === `g:${goal.id}` && e.kind === 'flow');
  let parent: LocalView['parent'] = null;
  const siblings: LocalView['siblings'] = [];

  if (incomingFlowEdge) {
    const moveNode = proofMap.nodes.find((n) => n.id === incomingFlowEdge.source && n.kind === 'move');
    if (moveNode) {
      const originEdge = proofMap.edges.find((e) => e.target === moveNode.id && e.kind === 'flow');
      const originGoalId = originEdge ? originEdge.source.replace(/^g:/, '') : undefined;
      parent = {
        goalId: originGoalId ?? '',
        moveId: moveNode.id,
        tactic: moveNode.label,
        relation: moveNode.relation,
      };

      const siblingEdges = proofMap.edges.filter(
        (e) => e.source === moveNode.id && e.kind === 'flow' && e.target !== `g:${goal.id}` && e.target !== 'known',
      );
      for (const se of siblingEdges) {
        const sibId = se.target.replace(/^g:/, '');
        const sibGoal = decl.goals.find((g) => g.id === sibId);
        if (sibGoal) {
          siblings.push({
            goalId: sibId,
            target: sibGoal.target,
            relation: relationOf(sibGoal.target),
          });
        }
      }
    }
  }

  // Find successor (move whose source is this goal)
  const outgoingFlowEdge = proofMap.edges.find((e) => e.source === `g:${goal.id}` && e.kind === 'flow');
  let succ: LocalView['succ'] = null;
  if (outgoingFlowEdge) {
    const moveNode = proofMap.nodes.find((n) => n.id === outgoingFlowEdge.target && n.kind === 'move');
    if (moveNode) {
      const targetEdge = proofMap.edges.find((e) => e.source === moveNode.id && e.kind === 'flow');
      const targetGoalId = targetEdge ? targetEdge.target.replace(/^g:/, '') : 'known';
      succ = {
        goalId: targetGoalId,
        moveId: moveNode.id,
        tactic: moveNode.label,
        relation: moveNode.relation,
      };
    }
  }

  // Nearby landmarks attached to this node or its direct moves
  const attachedMoveIds = new Set(
    proofMap.edges
      .filter((e) => (e.source === `g:${goal.id}` || e.target === `g:${goal.id}`) && e.kind === 'flow')
      .map((e) => (e.source.startsWith('mv:') ? e.source : e.target)),
  );
  let landmarkNodes = proofMap.nodes.filter(
    (n) =>
      n.kind === 'landmark' &&
      proofMap.edges.some((e) => e.source === n.id && attachedMoveIds.has(e.target) && e.kind === 'uses'),
  );
  if (landmarkNodes.length === 0) {
    // Fallback to top landmarks in this declaration so the Compass Lens always has Landmark Rays
    landmarkNodes = proofMap.nodes.filter((n) => n.kind === 'landmark').slice(0, 6);
  }
  const landmarks = landmarkNodes.map((ln) => ({
    name: ln.label,
    area: ln.area ?? 'Core',
    uses: ln.uses ?? 0,
    affordance: inferLandmarkAffordance(ln.label, goal.target),
  }));

  // Loop closure equivalent goals
  const loopClosures = detectLoopClosures(decl.goals);
  const equivalentGoals = loopClosures.get(goal.id) ?? [];

  // Trail: follow parent links backwards from this goal to root to form the true branch path
  const trail: string[] = [];
  let currParentId = parent?.goalId;
  let safety = 30;
  while (currParentId && safety-- > 0) {
    const parentGoal = currParentId;
    const edgeToParent = proofMap.edges.find((e) => e.target === `g:${parentGoal}` && e.kind === 'flow');
    if (!edgeToParent) break;
    const parentMove = proofMap.nodes.find((n) => n.id === edgeToParent.source && n.kind === 'move');
    if (parentMove) {
      trail.unshift(parentMove.label);
      const grandParentEdge = proofMap.edges.find((e) => e.target === parentMove.id && e.kind === 'flow');
      currParentId = grandParentEdge ? grandParentEdge.source.replace(/^g:/, '') : undefined;
    } else {
      break;
    }
  }
  if (parent?.tactic) {
    trail.push(parent.tactic);
  }

  const ss = sorryStep ?? decl.steps.find((s) => s.before.includes(goal.id));
  const range = ss ? { startLine: ss.startLine, startCol: ss.startCol, endLine: ss.endLine, endCol: ss.endCol } : undefined;

  return {
    goalId: goal.id,
    canonicalKey: canonKey,
    target: goal.target,
    pp: goal.pp,
    hypotheses: parseHypotheses(goal.pp),
    relation: relationOf(goal.target),
    isRoot,
    isFrontier,
    sorryStep: sorryStep?.idx,
    parent,
    succ,
    siblings,
    landmarks,
    equivalentGoals,
    trail,
    range,
  };
}

/**
 * Egocentric neighbourhood: the current goal centred, with the
 * nearest goals/landmarks around it. No fixed directions — ranking is graph
 * distance first (parent/child/sibling/attached landmark/equivalent), then
 * landmark usefulness (`uses`). Capped at 10 neighbours.
 */
export function neighbourhood(
  decl: DeclTrace,
  proofMap: ProofMap,
  rawGoalId?: string,
): Neighbourhood | undefined {
  const lv = computeLocalView(decl, proofMap, rawGoalId);
  if (!lv) return undefined;
  const out: Neighbourhood['neighbours'] = [];
  const seen = new Set<string>();
  const push = (n: Neighbourhood['neighbours'][number]) => {
    if (seen.has(n.nodeId) || n.nodeId === `g:${lv.goalId}`) return;
    seen.add(n.nodeId);
    out.push(n);
  };
  const goalNode = (id: string) => proofMap.nodes.find((n) => n.id === `g:${id}`);

  if (lv.parent?.goalId) {
    push({ nodeId: `g:${lv.parent.goalId}`, kind: 'goal', label: decl.goals.find((g) => g.id === lv.parent!.goalId)?.target ?? lv.parent.goalId, distance: 1, relation: 'parent' });
  }
  if (lv.succ?.moveId) {
    const childEdges = proofMap.edges.filter(
      (e) => e.source === lv.succ!.moveId && e.kind === 'flow' && e.target !== 'known',
    );
    for (const ce of childEdges) {
      const cid = ce.target.replace(/^g:/, '');
      push({
        nodeId: `g:${cid}`,
        kind: goalNode(cid)?.kind === 'frontier' ? 'frontier' : 'goal',
        label: decl.goals.find((g) => g.id === cid)?.target ?? cid,
        distance: 1,
        relation: 'child',
      });
    }
  } else if (lv.succ?.goalId && lv.succ.goalId !== 'known') {
    push({ nodeId: `g:${lv.succ.goalId}`, kind: goalNode(lv.succ.goalId)?.kind === 'frontier' ? 'frontier' : 'goal', label: decl.goals.find((g) => g.id === lv.succ!.goalId)?.target ?? lv.succ.goalId, distance: 1, relation: 'child' });
  }
  for (const s of lv.siblings) {
    push({ nodeId: `g:${s.goalId}`, kind: goalNode(s.goalId)?.kind === 'frontier' ? 'frontier' : 'goal', label: s.target, distance: 1, relation: 'sibling' });
  }
  for (const lm of lv.landmarks) {
    push({ nodeId: `lm:${lm.name}`, kind: 'landmark', label: lm.name, area: lm.area, uses: lm.uses, distance: 1, relation: 'landmark', tacticSuggestion: lm.affordance });
  }
  for (const eq of lv.equivalentGoals) {
    push({ nodeId: `g:${eq}`, kind: 'goal', label: decl.goals.find((g) => g.id === eq)?.target ?? eq, distance: 1, relation: 'equivalent' });
  }
  if (out.length < 10) {
    const fill = proofMap.nodes
      .filter((n) => n.kind === 'landmark')
      .sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0));
    for (const ln of fill) {
      if (out.length >= 10) break;
      push({ nodeId: ln.id, kind: 'landmark', label: ln.label, area: ln.area, uses: ln.uses, distance: 2, relation: 'landmark', tacticSuggestion: inferLandmarkAffordance(ln.label, lv.target) });
    }
  }
  return {
    centre: { goalId: lv.goalId, canonicalKey: lv.canonicalKey, target: lv.target, pp: lv.pp, isFrontier: lv.isFrontier },
    neighbours: out.slice(0, 10),
    trail: lv.trail,
  };
}
