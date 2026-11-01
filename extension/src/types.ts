// Shared data contracts between the Lean tracer, the extension host and the webview.

export interface GoalView {
  id: string;
  pp: string;
  target: string;
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

export type NodeKind = 'theorem' | 'goal' | 'frontier' | 'move' | 'landmark' | 'known' | 'ghost-move' | 'ghost-goal';

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
  range?: { startLine: number; startCol: number; endLine: number; endCol: number };
  /** for frontier: the sorry step that marks it (if any) */
  sorryStep?: number;
  collapsed?: number;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  kind: 'flow' | 'uses' | 'ghost';
}

export interface ProofMap {
  decl: string;
  level: 1 | 2 | 3;
  nodes: MapNode[];
  edges: MapEdge[];
  stats: { steps: number; goals: number; frontier: number; landmarks: number; complete: boolean };
}
