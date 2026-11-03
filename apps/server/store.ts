import * as fs from 'fs';
import * as path from 'path';
import type { Atlas, ProofMap, TraceResult } from '../../packages/core/types';
import { buildProofMap } from '../../packages/core/model';
import { areaColor } from '../../packages/core/nav';

export interface Repo {
  id: string;
  name: string;
  root: string;
  traces: TraceResult[];
  source: 'demo' | 'folder';
}

/** Walk up from the compiled file until the `graspt` package.json — layout-proof. */
export function packageRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === 'graspt') return dir;
    } catch { /* keep walking up */ }
    dir = path.dirname(dir);
  }
  return path.resolve(__dirname, '..', '..', '..');
}

export function loadDemoRepo(): Repo {
  const demoDir = path.join(packageRoot(), 'fixtures', 'demo');
  const traces: TraceResult[] = [];
  if (fs.existsSync(demoDir)) {
    for (const f of fs.readdirSync(demoDir).filter((x) => x.endsWith('.trace.json')).sort()) {
      try { traces.push(JSON.parse(fs.readFileSync(path.join(demoDir, f), 'utf8')) as TraceResult); } catch { /* skip bad demo file */ }
    }
  }
  return { id: 'demo', name: 'Pre-indexed demo (Lean Demo)', root: demoDir, traces, source: 'demo' };
}

export function repoFromTraces(id: string, name: string, root: string, traces: TraceResult[]): Repo {
  return { id, name, root, traces, source: 'folder' };
}

export function allDeclNames(repo: Repo): string[] {
  return repo.traces.flatMap((t) => t.decls.map((d) => d.name));
}

export function proofMapFor(repo: Repo, declName: string): ProofMap | undefined {
  for (const t of repo.traces) {
    const decl = t.decls.find((d) => d.name === declName);
    if (!decl) continue;
    const localNames = new Set(repo.traces.flatMap((x) => x.decls.map((d) => d.name)));
    return buildProofMap(decl, { landmarkThreshold: 10, localNames });
  }
  return undefined;
}

export function declTrace(repo: Repo, declName: string) {
  for (const t of repo.traces) {
    const decl = t.decls.find((d) => d.name === declName);
    if (decl) return decl;
  }
  return undefined;
}

/** Atlas derived from traced declarations: areas, landmark ranking, decl list. */
export function atlasFor(repo: Repo): Atlas & { decls: { name: string; steps: number; goals: number; frontier: number; complete: boolean }[] } {
  const landmarks = new Map<string, { name: string; kind: string; module: string; area: string; uses: number; type: string; deps: string[] }>();
  const areaCounts = new Map<string, number>();
  const decls: { name: string; steps: number; goals: number; frontier: number; complete: boolean }[] = [];
  for (const name of allDeclNames(repo)) {
    const map = proofMapFor(repo, name);
    if (!map) continue;
    decls.push({ name, steps: map.stats.steps, goals: map.stats.goals, frontier: map.stats.frontier, complete: map.stats.complete });
    for (const n of map.nodes) {
      if (n.kind !== 'landmark') continue;
      const area = n.area ?? 'Core';
      areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
      const prev = landmarks.get(n.label);
      if (!prev || (n.uses ?? 0) > prev.uses) {
        landmarks.set(n.label, { name: n.label, kind: 'landmark', module: area, area, uses: n.uses ?? 0, type: '', deps: [] });
      }
    }
  }
  const areas = [...areaCounts.entries()].map(([id, declsCount]) => ({ id, decls: declsCount }));
  // area colour is attached client-side via areaColor; keep server payload factual
  return {
    roots: decls.map((d) => d.name),
    declarations: decls.length,
    areas,
    areaEdges: [],
    landmarks: [...landmarks.values()].sort((a, b) => b.uses - a.uses),
    decls,
  };
}

export { areaColor };
