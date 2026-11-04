import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  areaColor,
  canExplore,
  canSplice,
  canonicalGoalKey,
  canonicalGoalText,
  detectLoopClosures,
  computeLocalView,
  neighbourhood,
  parseHypotheses,
} from '../packages/core/nav';
import { buildProofMap, inferArea, isTypeBoundaryTactic } from '../packages/core/model';
import { LayoutStore, resolvePositions } from '../packages/core/layout';

test('canonicalGoalKey normalizes whitespace, hygiene markers, and unicode arrows', () => {
  const k1 = canonicalGoalKey('  stepSucc   (ρ   i) =  ρ  (i + 1) ');
  const k2 = canonicalGoalKey('stepSucc (ρ i) = ρ (i + 1)');
  assert.equal(k1, k2);

  assert.equal(canonicalGoalText('A -> B <-> C'), '⊢ A → B ↔ C');
  assert.equal(canonicalGoalText('x✝¹ + y._@.Mathlib.hyg.42 = z'), '⊢ x + y = z');
});

test('place identity includes hypothesis context, not just the target', () => {
  const ppA = 'i : ℤ\nh : i % 4 = 0\n⊢ stepSucc (ρ i) = ρ (i + 1)';
  const ppB = 'i : ℤ\nh : i % 4 = 1\n⊢ stepSucc (ρ i) = ρ (i + 1)';
  const ppA2 = 'j : ℤ\nh2 : i % 4 = 0\n⊢ stepSucc (ρ i) = ρ (i + 1)';
  const target = 'stepSucc (ρ i) = ρ (i + 1)';

  // Same target, different local context => different places (no false loop closure)
  assert.notEqual(canonicalGoalKey(target, ppA), canonicalGoalKey(target, ppB));
  // Hypothesis names/order do not matter; hypothesis types do (alpha-level identity)
  assert.equal(canonicalGoalKey(target, ppA), canonicalGoalKey(target, ppA2));
});

test('loop closure only for identical Γ ⊢ T', () => {
  const goals = [
    { id: 'a', target: 'T', pp: 'h : P\n⊢ T' },
    { id: 'b', target: 'T', pp: 'h : Q\n⊢ T' },
    { id: 'c', target: 'T', pp: 'x : P\n⊢ T' },
  ];
  const loops = detectLoopClosures(goals);
  assert.equal(loops.has('a'), true);
  assert.equal(loops.has('b'), false);
  assert.deepEqual(loops.get('a'), ['c']);
});

test('parseHypotheses extracts structured local context from ppGoal', () => {
  const pp = `case h1
n m : Nat
h : n ≤ m
⊢ n + 1 ≤ m + 1`;
  const hyps = parseHypotheses(pp);
  assert.equal(hyps.length, 2);
  assert.deepEqual(hyps[0], { name: 'n m', type: 'Nat' });
  assert.deepEqual(hyps[1], { name: 'h', type: 'n ≤ m' });
});

test('isTypeBoundaryTactic recognizes DTT cut boundaries (have, suffices, obtain)', () => {
  assert.equal(isTypeBoundaryTactic('have h : P := by simp'), true);
  assert.equal(isTypeBoundaryTactic('suffices Q by exact h'), true);
  assert.equal(isTypeBoundaryTactic('intro x'), false);
});

test('detectLoopClosures identifies equivalent subgoals across branches', () => {
  const goals = [
    { id: 'g1', target: 'x + y = y + x', pp: '⊢ x + y = y + x' },
    { id: 'g2', target: 'a * b = b * a', pp: '⊢ a * b = b * a' },
    { id: 'g3', target: 'x + y = y + x', pp: '⊢ x + y = y + x' },
  ];
  const loops = detectLoopClosures(goals);
  assert.ok(loops.has('g1'));
  assert.ok(loops.has('g3'));
  assert.deepEqual(loops.get('g1'), ['g3']);
  assert.deepEqual(loops.get('g3'), ['g1']);
  assert.equal(loops.has('g2'), false);
});

test('buildProofMap marks loop closure equivalence edges and counts', () => {
  const mockDecl = {
    name: 'loop_closure_test',
    startLine: 1,
    endLine: 20,
    steps: [
      {
        idx: 0,
        tactic: 'by_cases h : P',
        kind: 'tacticByCases',
        depth: 0,
        parent: null,
        startLine: 2,
        startCol: 2,
        endLine: 2,
        endCol: 16,
        before: ['g_root'],
        after: ['g_left', 'g_right'],
        constants: [],
        used: [],
      },
      {
        idx: 1,
        tactic: 'simp',
        kind: 'tacticSimp',
        depth: 1,
        parent: 0,
        startLine: 3,
        startCol: 4,
        endLine: 3,
        endCol: 8,
        before: ['g_left'],
        after: ['g_target_1'],
        constants: [],
        used: [],
      },
      {
        idx: 2,
        tactic: 'simp',
        kind: 'tacticSimp',
        depth: 1,
        parent: 0,
        startLine: 4,
        startCol: 4,
        endLine: 4,
        endCol: 8,
        before: ['g_right'],
        after: ['g_target_2'],
        constants: [],
        used: [],
      },
    ],
    goals: [
      { id: 'g_root', target: 'Outcome', pp: '⊢ Outcome' },
      { id: 'g_left', target: 'P → Outcome', pp: '⊢ P → Outcome' },
      { id: 'g_right', target: '¬P → Outcome', pp: '⊢ ¬P → Outcome' },
      { id: 'g_target_1', target: 'FinalGoal', pp: '⊢ FinalGoal' },
      { id: 'g_target_2', target: 'FinalGoal', pp: '⊢ FinalGoal' }, // Same place! Loop closure
    ],
  };

  const map = buildProofMap(mockDecl, { landmarkThreshold: 10 });
  assert.equal('level' in map, false);
  assert.equal(map.stats.loopClosures, 1);
  const loopEdge = map.edges.find((e) => e.kind === 'equiv');
  assert.ok(loopEdge, 'equivalence loop closure edge should be emitted');
  assert.ok(
    (loopEdge.source === 'g:g_target_1' && loopEdge.target === 'g:g_target_2') ||
      (loopEdge.source === 'g:g_target_2' && loopEdge.target === 'g:g_target_1'),
  );

  const local1 = computeLocalView(mockDecl, map, 'g_target_1');
  assert.ok(local1);
  assert.deepEqual(local1.equivalentGoals, ['g_target_2']);
});

test('computeLocalView gives parent and siblings for a branched goal', () => {
  const mockDecl = {
    name: 'test_decl', startLine: 1, endLine: 10,
    steps: [
      { idx: 0, tactic: 'intro x', kind: 'tacticIntro', depth: 0, parent: null, startLine: 2, startCol: 2, endLine: 2, endCol: 9, before: ['g1'], after: ['g2'], constants: [], used: [] },
      { idx: 1, tactic: 'rcases x with ⟨a, b⟩', kind: 'tacticRcases', depth: 1, parent: 0, startLine: 3, startCol: 2, endLine: 3, endCol: 20, before: ['g2'], after: ['g3', 'g4'], constants: [], used: [] },
    ],
    goals: [
      { id: 'g1', target: 'P', pp: '\u22a2 P' },
      { id: 'g2', target: 'Q', pp: '\u22a2 Q' },
      { id: 'g3', target: 'R1', pp: '\u22a2 R1' },
      { id: 'g4', target: 'R2', pp: '\u22a2 R2' },
    ],
  };
  const map = buildProofMap(mockDecl, { landmarkThreshold: 10 });
  const local = computeLocalView(mockDecl, map, 'g3');
  assert.ok(local);
  assert.equal(local.isFrontier, true);
  assert.equal(local.parent?.goalId, 'g2');
  assert.equal(local.siblings.length, 1);
  assert.equal(local.siblings[0].goalId, 'g4');
});

test('neighbourhood ranks nearest goals and landmarks around the cursor, capped at 10', () => {
  const decl = {
    name: 'nb_test', startLine: 1, endLine: 10,
    steps: [
      { idx: 0, tactic: 'rcases x with ⟨a, b⟩', kind: 'tacticRcases', depth: 0, parent: null, startLine: 2, startCol: 2, endLine: 2, endCol: 20, before: ['g2'], after: ['g3', 'g4'], constants: ['Nat.add_comm'], used: [] },
    ],
    goals: [
      { id: 'g2', target: 'Q', pp: '⊢ Q' },
      { id: 'g3', target: 'R1', pp: '⊢ R1' },
      { id: 'g4', target: 'R2', pp: '⊢ R2' },
    ],
  };
  const map = buildProofMap(decl, { landmarkThreshold: 0 });
  const nb = neighbourhood(decl, map, 'g3');
  assert.ok(nb);
  assert.equal(nb.centre.goalId, 'g3');
  assert.ok(nb.neighbours.length <= 10);
  const rels = nb.neighbours.map((n) => n.relation);
  assert.ok(rels.includes('parent'), 'parent goal is a neighbour');
  assert.ok(rels.includes('sibling'), 'sibling goal is a neighbour');
  assert.ok(nb.neighbours.every((n) => n.distance >= 1));
  // parent/sibling goals rank before any fill-in landmarks
  assert.equal(nb.neighbours[0].relation, 'parent');
  // leaf goal g3 is a dead end (no child subgoals forward)
  assert.equal(nb.neighbours.some((n) => n.relation === 'child'), false);

  // parent goal g2 lists all spawned subgoals (g3 and g4) as child neighbours
  const nbParent = neighbourhood(decl, map, 'g2');
  assert.ok(nbParent);
  const childIds = nbParent.neighbours.filter((n) => n.relation === 'child').map((n) => n.nodeId);
  assert.deepEqual(childIds, ['g:g3', 'g:g4']);
});

test('buildProofMap tracks one lemma at full detail with no granularity level', () => {
  const decl = {
    name: 'MyLemma', startLine: 1, endLine: 10,
    steps: [
      { idx: 0, tactic: 'intro x', kind: 'tacticIntro', depth: 0, parent: null, startLine: 2, startCol: 2, endLine: 2, endCol: 9, before: ['g1'], after: ['g2'], constants: [], used: [] },
      { idx: 1, tactic: 'simp', kind: 'tacticSimp', depth: 0, parent: null, startLine: 3, startCol: 2, endLine: 3, endCol: 6, before: ['g2'], after: ['g3'], constants: [], used: [] },
      { idx: 2, tactic: 'exact h', kind: 'tacticExact', depth: 0, parent: null, startLine: 4, startCol: 2, endLine: 4, endCol: 8, before: ['g3'], after: [], constants: [], used: [] },
    ],
    goals: [
      { id: 'g1', target: 'P', pp: '⊢ P' },
      { id: 'g2', target: 'Q', pp: '⊢ Q' },
      { id: 'g3', target: 'R', pp: '⊢ R' },
    ],
  };
  const map = buildProofMap(decl, { landmarkThreshold: 10 });
  assert.equal(map.decl, 'MyLemma');
  assert.equal('level' in map, false);
  // Linear plumbing chain is not contracted away: zoom, not a level, controls visibility.
  assert.equal(map.nodes.filter((n) => n.kind === 'move').length, 3);
});

test('re-trace never moves existing nodes; new nodes land next to their parent', () => {
  const nodes = [
    { id: 'g:old1', kind: 'goal', canonicalKey: 'gk_a' },
    { id: 'g:old2', kind: 'goal', canonicalKey: 'gk_b' },
    { id: 'g:new1', kind: 'goal', canonicalKey: 'gk_c' },
  ] as any;
  const edges = [{ id: 'e1', source: 'g:old2', target: 'g:new1', kind: 'flow' }] as any;
  // MVarIds changed on re-trace: saved positions are keyed by canonical key only.
  const saved = { 'canon:gk_a': { x: 10, y: 20 }, 'canon:gk_b': { x: 110, y: 20 } };
  const out = resolvePositions(nodes, edges, saved);
  assert.deepEqual(out['g:old1'], { x: 10, y: 20 });
  assert.deepEqual(out['g:old2'], { x: 110, y: 20 });
  // New node is placed near its parent (downstream), not by a global relayout.
  assert.ok(Math.abs(out['g:new1'].x - 110) <= 120 && out['g:new1'].y > 20);
  // Every node gets a position so the webview never needs a global relayout.
  assert.equal(Object.keys(out).length, 3);
});

test('landmark colour comes only from its Mathlib area; unknown areas are Core grey', () => {
  assert.equal(areaColor('Mathlib.Algebra'), '#7a62c9');
  assert.equal(areaColor('Mathlib.Data.Nat.Basic'), areaColor('Mathlib.Data'));
  assert.equal(areaColor('Something.Unmapped'), areaColor('Core'));
  assert.equal(areaColor(undefined), areaColor('Core'));
  // The model must not fabricate an area from a constant's name when the atlas has none.
  assert.equal(inferArea('Nat.add_comm', new Set()), 'Core');
  assert.equal(inferArea('MyFile.helper', new Set(['MyFile.helper'])), 'Local');
  assert.equal(inferArea('Nat.add_comm', new Set(), 'Mathlib.Data'), 'Mathlib.Data');
});

test('Mode A is read-only; only Lean-verified ghosts splice, and only in Mode B', () => {
  assert.equal(canExplore('explore'), false);
  assert.equal(canExplore('contribute'), true);
  assert.equal(canSplice('contribute', true), true);
  assert.equal(canSplice('contribute', false), false);
  assert.equal(canSplice('explore', true), false);
});

test('LayoutStore preserves and recovers node coordinates across re-traces', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graspt_layout_test_'));
  const store = new LayoutStore();
  const declName = 'Demo.LocalLayout.stepSucc_ρ';

  // Initially empty
  const initial = store.loadLayout(tmpDir, declName);
  assert.deepEqual(initial, {});

  // Save coordinates
  const coords = {
    'g:g1': { x: 100, y: 150 },
    'g:g2': { x: 200, y: 350 },
    'mv:m0': { x: 100, y: 250 },
  };
  store.saveLayout(tmpDir, declName, coords);

  // New store instance reads from disk
  const freshStore = new LayoutStore();
  const loaded = freshStore.loadLayout(tmpDir, declName);
  assert.deepEqual(loaded, coords);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
