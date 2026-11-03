// Shared data contracts between the Lean tracer, the extension host and the webview.

export interface GoalView {
  id: string;
  pp: string;
  target: string;
  canonicalKey?: string;
}

export interface Step {
  idx: number;
  tactic: string;
  kind: string;
  depth: number;
  parent: number | null;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  before: string[];
  after: string[];
  constants: string[];
  used: string[];
}

export interface DeclTrace {
  name: string;
  startLine: number;
  endLine: number;
  steps: Step[];
  goals: GoalView[];
}

export interface Msg {
  severity: 'error' | 'warning' | 'info';
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

export interface TraceResult {
  file: string;
  decls: DeclTrace[];
  messages: Msg[];
  elapsedMs: number;
  headerCached: boolean;
  error?: string;
}

/** name -> [uses, areaIndex] */
export interface Importance {
  areas: string[];
  table: Record<string, [number, number]>;
}

export interface AtlasLandmark {
  name: string;
  kind: string;
  module: string;
  area: string;
  uses: number;
  type: string;
  deps: string[];
}

export interface Atlas {
  roots: string[];
  declarations: number;
  areas: { id: string; decls: number }[];
  areaEdges: { source: string; target: string; weight: number }[];
  landmarks: AtlasLandmark[];
}

// ---------------------------------------------------------------------------
// The topological proof map (what the webview draws)

export type NodeKind =
  | 'theorem'
  | 'goal'
  | 'frontier'
  | 'move'
  | 'landmark'
  | 'known'
  | 'ghost-move'
  | 'ghost-goal'
  | 'equiv';

export interface MapNode {
  id: string;
  kind: NodeKind;
  label: string;
  detail?: string;
  /** goal relation family, for the visual grammar */
  relation?: string;
  /** area of a landmark (for colour) */
  area?: string;
  uses?: number;
  /** step indices folded into a move node */
  steps?: number[];
  milestone?: boolean;
  /** true if this move represents a type-boundary cut (have, suffices, obtain, case) */
  typeBoundary?: boolean;
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
  /** for frontier: the sorry step that marks it (if any) */
  sorryStep?: number;
  collapsed?: number;
  /** stable canonical target key for place recognition across re-traces */
  canonicalKey?: string;
  /** other goal IDs that are α-equivalent / defeq to this node (loop closure) */
  equivalentTo?: string[];
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  kind: 'flow' | 'uses' | 'ghost' | 'equiv';
}

/** sum_7 two modes: A `explore` is read-only understanding; B `contribute` may verify and splice at the frontier. */
export type GrasptMode = 'explore' | 'contribute';

// ---------------------------------------------------------------------------
// Egocentric view (sum_7): cursor goal plus its nearest neighbours


export interface LocalView {
  goalId: string;
  canonicalKey: string;
  target: string;
  pp: string;
  hypotheses: { name: string; type: string }[];
  relation?: string;
  isRoot: boolean;
  isFrontier: boolean;
  sorryStep?: number;
  parent: { goalId: string; moveId: string; tactic: string; relation?: string } | null;
  succ: { goalId: string; moveId: string; tactic: string; relation?: string } | null;
  siblings: { goalId: string; target: string; relation?: string }[];
  landmarks: { name: string; area: string; uses: number; affordance?: string }[];
  equivalentGoals: string[];
  trail: string[];
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
}

export type NeighbourRelation = 'parent' | 'child' | 'sibling' | 'landmark' | 'equivalent';

export interface Neighbour {
  nodeId: string;
  kind: 'goal' | 'landmark' | 'frontier';
  label: string;
  area?: string;
  uses?: number;
  distance: number;
  relation: NeighbourRelation;
  tacticSuggestion?: string;
}

/** Egocentric view (sum_5 §4): current goal centred, nearest neighbours around it. */
export interface Neighbourhood {
  centre: { goalId: string; canonicalKey: string; target: string; pp: string; isFrontier: boolean };
  neighbours: Neighbour[];
  trail: string[];
}

export interface ProofMap {
  /** the tracked lemma (declaration) name */
  decl: string;
  nodes: MapNode[];
  edges: MapEdge[];
  stats: {
    steps: number;
    goals: number;
    frontier: number;
    landmarks: number;
    complete: boolean;
    loopClosures?: number;
  };
  cursorGoalId?: string;
  mode?: GrasptMode;
  localView?: LocalView;
  neighbourhood?: Neighbourhood;
  positions?: Record<string, { x: number; y: number }>;
}
