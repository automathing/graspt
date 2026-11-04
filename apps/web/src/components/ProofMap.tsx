import { useMemo, useState } from 'react';
import type { MapNode, ProofMapData } from '@/lib/api';

export function areaColor(colors: Record<string, string>, area?: string): string {
  if (!area) return colors.Core ?? '#94a3b8';
  if (colors[area]) return colors[area];
  let best = '';
  for (const k of Object.keys(colors)) if (area.startsWith(k) && k.length > best.length) best = k;
  return best ? colors[best] : (colors.Core ?? '#94a3b8');
}

function layout(map: ProofMapData): Record<string, { x: number; y: number }> {
  if (map.positions && Object.keys(map.positions).length) return map.positions;
  const depth = new Map<string, number>();
  const byDepth = new Map<number, string[]>();
  const flow = map.edges.filter((e) => e.kind === 'flow');
  const root = map.nodes.find((n) => n.kind === 'theorem') ?? map.nodes[0];
  if (root) {
    depth.set(root.id, 0);
    const q = [root.id];
    while (q.length) {
      const id = q.shift()!;
      for (const e of flow.filter((x) => x.source === id)) {
        if (!depth.has(e.target)) { depth.set(e.target, (depth.get(id) ?? 0) + 1); q.push(e.target); }
      }
    }
  }
  let maxD = 0;
  for (const n of map.nodes) {
    const d = depth.get(n.id) ?? ++maxD;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n.id);
  }
  const out: Record<string, { x: number; y: number }> = {};
  for (const [d, ids] of byDepth) ids.forEach((id, i) => { out[id] = { x: 90 + i * 210, y: 60 + d * 115 }; });
  return out;
}

function shape(n: MapNode, fill: string, stroke: string) {
  switch (n.kind) {
    case 'landmark':
      return <rect x="-10" y="-10" width="20" height="20" rx="3" transform="rotate(45)" fill={fill} stroke={stroke} />;
    case 'frontier':
      return <path d="M0,-14 L13,10 L-13,10 Z" fill={fill} stroke={stroke} strokeLinejoin="round" />;
    case 'move':
      return <rect x="-8" y="-8" width="16" height="16" rx="3" fill={fill} stroke={stroke} />;
    case 'known':
      return (<><circle r="13" fill={fill} stroke={stroke} /><path d="M-6,0 L-2,4 L7,-5" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></>);
    default:
      return <circle r="14" fill={fill} stroke={stroke} />;
  }
}

export function ProofMap({ map, colors, selectedId, onSelect }: {
  map: ProofMapData;
  colors: Record<string, string>;
  selectedId?: string;
  onSelect: (n: MapNode) => void;
}) {
  const pos = useMemo(() => layout(map), [map]);
  const [zoom, setZoom] = useState(1);

  // Compute ancestor flow path (edges & nodes) from root theorem to selectedId for perceptual backtracing
  const activeTrail = useMemo(() => {
    const edgeIds = new Set<string>();
    const nodeIds = new Set<string>();
    if (!selectedId) return { edgeIds, nodeIds };
    const flowEdges = map.edges.filter((e) => e.kind === 'flow');
    let curr: string | undefined = selectedId;
    let safety = 60;
    while (curr && safety-- > 0) {
      nodeIds.add(curr);
      const inc = flowEdges.find((e) => e.target === curr);
      if (!inc) break;
      edgeIds.add(inc.id);
      curr = inc.source;
    }
    return { edgeIds, nodeIds };
  }, [map, selectedId]);

  const maxX = Math.max(...Object.values(pos).map((p) => p.x), 600);
  const maxY = Math.max(...Object.values(pos).map((p) => p.y), 400);
  const w = maxX + 240, h = maxY + 110;
  const zw = w / zoom, zh = h / zoom;
  const viewBox = `${(w - zw) / 2} ${(h - zh) / 2} ${zw} ${zh}`;

  return (
    <div className="relative">
      <div className="absolute right-3 top-3 z-10 flex gap-1">
        <button className="h-8 w-8 rounded-md border border-stone-300 bg-white text-lg leading-none" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.55, z / 1.25))}>−</button>
        <button className="h-8 rounded-md border border-stone-300 bg-white px-2 text-xs font-semibold" onClick={() => setZoom(1)}>Fit</button>
        <button className="h-8 w-8 rounded-md border border-stone-300 bg-white text-lg leading-none" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3.2, z * 1.25))}>+</button>
      </div>
      <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-1 text-[11px] font-semibold">
        {([['Goal', '#fff'], ['Landmark', '#c28a2d'], ['Frontier', '#f6ad55'], ['Move', '#dce5df'], ['Grounded', '#177245']] as const).map(([label, bg]) => (
          <span key={label} className="rounded-full border border-stone-200 bg-white/95 px-2 py-0.5"><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: bg }} />{label}</span>
        ))}
      </div>
      <svg viewBox={viewBox} className="block h-[500px] w-full bg-[#f7f8f4]" role="group" aria-label="Proof map. Tab through nodes, Enter to stand on one."
        style={{ backgroundImage: 'radial-gradient(circle, #c9d6cc 1px, transparent 1px)', backgroundSize: '24px 24px' }}>
        <defs>
          <marker id="arrow-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 Z" fill="#71867a" />
          </marker>
          <marker id="arrow-trail" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 Z" fill="#0f766e" />
          </marker>
        </defs>
        {map.edges.map((e) => {
          const a = pos[e.source], b = pos[e.target];
          if (!a || !b) return null;
          const onTrail = activeTrail.edgeIds.has(e.id);
          const cls = onTrail
            ? 'stroke-teal-700'
            : e.kind === 'equiv' ? 'stroke-amber-600 [stroke-dasharray:5_4]' : e.kind === 'uses' ? 'stroke-stone-300 [stroke-dasharray:2_4]' : 'stroke-[#91a79b]';
          return (
            <path key={e.id} d={`M${a.x},${a.y} L${b.x},${b.y}`} className={`${cls} fill-none`}
              strokeWidth={onTrail ? '2.6' : '1.35'}
              markerEnd={onTrail ? 'url(#arrow-trail)' : e.kind === 'flow' ? 'url(#arrow-flow)' : undefined} />
          );
        })}
        {map.nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const fill = n.kind === 'landmark' ? areaColor(colors, n.area)
            : n.kind === 'frontier' ? '#f6ad55'
            : n.kind === 'theorem' ? '#14332b'
            : n.kind === 'known' ? '#177245'
            : n.kind === 'move' ? '#dce5df' : '#ffffff';
          const stroke = n.kind === 'goal' || n.kind === 'theorem' ? '#0f766e' : n.kind === 'frontier' ? '#c56b12' : '#71867a';
          const selected = selectedId === n.id;
          const onTrail = !selected && activeTrail.nodeIds.has(n.id);
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} tabIndex={0} role="button"
              aria-label={`${n.kind}: ${n.label}`}
              className="cursor-pointer focus:outline-none"
              onClick={() => onSelect(n)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(n); } }}>
              <circle r="24" fill="transparent"
                stroke={selected ? '#c28a2d' : onTrail ? '#0f766e' : 'transparent'}
                strokeWidth={selected ? 3 : onTrail ? 2 : 0}
                strokeDasharray={selected ? '4 3' : onTrail ? '2 3' : undefined} />
              <title>{`${n.kind}: ${n.label}`}</title>
              {shape(n, fill, stroke)}
              <text x="19" y="4" className="fill-stone-900 font-mono text-[10px] font-semibold" style={{ paintOrder: 'stroke', stroke: 'rgba(255,255,255,.92)', strokeWidth: 3 }}>
                {(n.label || '').split('\n')[0].slice(0, 36)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
