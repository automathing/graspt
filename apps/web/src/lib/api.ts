export interface RepoInfo { id: string; name: string; root: string; source: string; decls: number }
export interface DeclInfo { name: string; steps: number; goals: number; frontier: number; complete: boolean }
export interface AtlasData { declarations: number; areas: { id: string; decls: number }[]; landmarks: { name: string; area: string; uses: number }[]; decls: DeclInfo[] }
export interface MapNode { id: string; kind: string; label: string; detail?: string; area?: string; uses?: number; collapsed?: number; canonicalKey?: string }
export interface ProofMapData {
  decl: string;
  nodes: MapNode[];
  edges: { id: string; source: string; target: string; kind: string }[];
  stats: { steps: number; goals: number; frontier: number; landmarks: number; complete: boolean };
  positions?: Record<string, { x: number; y: number }>;
}
export interface Neighbour { nodeId: string; kind: string; label: string; area?: string; distance: number; relation: string; tacticSuggestion?: string }
export interface NeighbourhoodData { centre: { goalId: string; target: string; pp: string; isFrontier: boolean }; neighbours: Neighbour[]; trail: string[] }
export interface Candidate { tactic: string; rationale?: string }
export interface ChatReply { answer: string; verified: boolean; reason?: string; agent: string; candidates: Candidate[] }
export interface ApplyReply { ok: boolean; verified: boolean; explanation: string; diagnostics?: string[]; map?: ProofMapData }

export async function api<T = any>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, opts);
  const t = await r.text();
  try { return JSON.parse(t) as T; } catch { return t as T; }
}

export const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
