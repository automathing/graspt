// Persistent allocentric layout store: keeps node positions stable across re-traces.

import * as fs from 'fs';
import * as path from 'path';

export interface NodePosition {
  x: number;
  y: number;
}

export type LayoutMap = Record<string, NodePosition>;

function sanitizeDeclName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function layoutPath(root: string, declName: string): string {
  return path.join(root, '.graspt', 'layout', `${sanitizeDeclName(declName)}.json`);
}

export interface LayoutNode {
  id: string;
  canonicalKey?: string;
}

export interface LayoutEdge {
  source: string;
  target: string;
  kind: string;
}

/**
 * Stable allocentric layout (sum_5 §2.3): saved positions are recovered by
 * node id or, across re-traces where MVarIds change, by canonical goal key,
 * and are returned unchanged. Nodes with no saved position are placed next to
 * an already-placed flow neighbour. Returns `{}` when nothing is saved, which
 * signals the caller to run its one-time first layout.
 */
export function resolvePositions(nodes: LayoutNode[], edges: LayoutEdge[], saved: LayoutMap): LayoutMap {
  const out: LayoutMap = {};
  for (const n of nodes) {
    const pos = saved[n.id] ?? (n.canonicalKey ? (saved[`canon:${n.canonicalKey}`] ?? saved[n.canonicalKey]) : undefined);
    if (pos) out[n.id] = { x: pos.x, y: pos.y };
  }
  if (Object.keys(out).length === 0) return {};

  const placedChildren = new Map<string, number>();
  let progress = true;
  while (Object.keys(out).length < nodes.length && progress) {
    progress = false;
    for (const n of nodes) {
      if (out[n.id]) continue;
      const incoming = edges.find((e) => e.kind === 'flow' && e.target === n.id && out[e.source]);
      if (incoming) {
        const p = out[incoming.source];
        const k = placedChildren.get(incoming.source) ?? 0;
        placedChildren.set(incoming.source, k + 1);
        out[n.id] = { x: p.x + k * 180, y: p.y + 96 };
        progress = true;
        continue;
      }
      const outgoing = edges.find((e) => e.kind === 'flow' && e.source === n.id && out[e.target]);
      if (outgoing) {
        const p = out[outgoing.target];
        out[n.id] = { x: p.x, y: p.y - 96 };
        progress = true;
        continue;
      }
      const usedBy = edges.find((e) => e.kind === 'uses' && e.source === n.id && out[e.target]);
      if (usedBy) {
        const p = out[usedBy.target];
        out[n.id] = { x: p.x - 180, y: p.y };
        progress = true;
      }
    }
  }
  const placed = Object.values(out);
  const cx = placed.reduce((a, p) => a + p.x, 0) / placed.length;
  const cy = placed.reduce((a, p) => a + p.y, 0) / placed.length;
  let i = 0;
  for (const n of nodes) {
    if (!out[n.id]) out[n.id] = { x: cx + (i % 6) * 180, y: cy + 140 + Math.floor(i / 6) * 96, };
    if (!nodes[i]) break;
    i++;
  }
  return out;
}

export class LayoutStore {
  private memCache = new Map<string, LayoutMap>();

  /** Cache is keyed by root + decl: two repos may declare the same name. */
  private cacheKey(workspaceRoot: string, declName: string): string {
    return `${workspaceRoot}::${declName}`;
  }

  loadLayout(workspaceRoot: string, declName: string): LayoutMap {
    const key = this.cacheKey(workspaceRoot, declName);
    if (this.memCache.has(key)) {
      return { ...this.memCache.get(key)! };
    }
    const p = layoutPath(workspaceRoot, declName);
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const map = JSON.parse(raw) as LayoutMap;
        this.memCache.set(key, map);
        return map;
      }
    } catch {
      // Fallback to empty if read fails
    }
    return {};
  }

  saveLayout(workspaceRoot: string, declName: string, positions: LayoutMap): void {
    this.memCache.set(this.cacheKey(workspaceRoot, declName), { ...positions });
    const p = layoutPath(workspaceRoot, declName);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(positions, null, 2), 'utf8');
    } catch (err) {
      console.warn(`[graspt layout] could not save layout for ${declName}:`, err);
    }
  }

  mergePositions(existing: LayoutMap, newPositions: LayoutMap): LayoutMap {
    return { ...existing, ...newPositions };
  }
}
