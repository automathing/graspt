import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapNode, ProofMapData } from '@/lib/api';

export function areaColor(colors: Record<string, string>, area?: string): string {
  if (!area) return colors.Core ?? '#94a3b8';
  if (colors[area]) return colors[area];
  let best = '';
  for (const k of Object.keys(colors)) if (area.startsWith(k) && k.length > best.length) best = k;
  return best ? colors[best] : (colors.Core ?? '#94a3b8');
}

function displayLabel(n: MapNode): string {
  const raw = (n.label || '').trim();
  if (!raw) return n.id;
  if (n.kind === 'known') return 'Grounded';
  const line = n.kind === 'goal' || n.kind === 'theorem' || n.kind === 'frontier'
    ? (raw.split('\n').pop()?.trim() || raw.split('\n')[0].trim())
    : raw.split('\n')[0].trim();
  const maxLen = n.kind === 'move' ? 26 : n.kind === 'landmark' ? 24 : 30;
  return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

function nodeBoxMetrics(n: MapNode): { text: string; pillW: number; pillH: number; halfW: number; topH: number; bottomH: number } {
  const text = displayLabel(n);
  const charW = n.kind === 'move' ? 6.4 : 6.6;
  const pillW = Math.max(n.kind === 'move' ? 64 : 58, Math.round(text.length * charW + 20));
  const pillH = n.kind === 'move' ? 26 : 21;
  if (n.kind === 'move') {
    return { text, pillW, pillH, halfW: pillW / 2 + 8, topH: 18, bottomH: 18 };
  }
  return { text, pillW, pillH, halfW: Math.max(24, pillW / 2 + 8), topH: 22, bottomH: 44 };
}

function layout(map: ProofMapData): Record<string, { x: number; y: number }> {
  if (map.positions && Object.keys(map.positions).length) return map.positions;
  const depth = new Map<string, number>();
  const byDepth = new Map<number, MapNode[]>();
  const flow = map.edges.filter((e) => e.kind === 'flow');
  const uses = map.edges.filter((e) => e.kind === 'uses');
  const root = map.nodes.find((n) => n.kind === 'theorem') ?? map.nodes[0];

  if (root) {
    depth.set(root.id, 0);
    const q = [root.id];
    while (q.length) {
      const id = q.shift()!;
      for (const e of flow.filter((x) => x.source === id)) {
        if (!depth.has(e.target)) {
          depth.set(e.target, (depth.get(id) ?? 0) + 1);
          q.push(e.target);
        }
      }
    }
  }

  let maxFlowDepth = 0;
  for (const d of depth.values()) if (d > maxFlowDepth) maxFlowDepth = d;

  const landmarks: MapNode[] = [];
  for (const n of map.nodes) {
    if (n.kind === 'landmark') {
      landmarks.push(n);
      continue;
    }
    const d = depth.get(n.id) ?? ++maxFlowDepth;
    depth.set(n.id, d);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n);
  }

  const centerX = 420;
  const rowGap = 104;
  const out: Record<string, { x: number; y: number }> = {};

  // Center each flow depth row horizontally with spacing proportional to node label widths
  let maxRowHalfSpan = 160;
  for (const [d, rowNodes] of byDepth) {
    const widths = rowNodes.map((n) => Math.max(150, nodeBoxMetrics(n).pillW + 44));
    const totalW = widths.reduce((a, b) => a + b, 0);
    let cursorX = centerX - totalW / 2;
    rowNodes.forEach((n, idx) => {
      const w = widths[idx];
      const x = Math.round(cursorX + w / 2);
      const y = 56 + d * rowGap;
      out[n.id] = { x, y };
      cursorX += w;
      maxRowHalfSpan = Math.max(maxRowHalfSpan, Math.abs(x - centerX) + w / 2);
    });
  }

  // Place landmarks flanking the flow spine at the depth of the move they feed
  const rightCountByDepth = new Map<number, number>();
  const leftCountByDepth = new Map<number, number>();
  landmarks.forEach((lm, idx) => {
    const targetMoves = uses
      .filter((e) => e.source === lm.id)
      .map((e) => depth.get(e.target))
      .filter((d): d is number => d !== undefined);
    const targetDepth = targetMoves.length
      ? Math.round(targetMoves.reduce((a, b) => a + b, 0) / targetMoves.length)
      : Math.min(maxFlowDepth, idx + 1);
    const placeRight = idx % 2 === 0;
    const slot = placeRight
      ? (rightCountByDepth.get(targetDepth) ?? 0)
      : (leftCountByDepth.get(targetDepth) ?? 0);
    if (placeRight) rightCountByDepth.set(targetDepth, slot + 1);
    else leftCountByDepth.set(targetDepth, slot + 1);

    const sideOffset = maxRowHalfSpan + 95 + slot * 175;
    out[lm.id] = {
      x: Math.round(placeRight ? centerX + sideOffset : centerX - sideOffset),
      y: 56 + targetDepth * rowGap,
    };
  });

  return out;
}

function shape(n: MapNode, fill: string, stroke: string, pillW: number, pillH: number) {
  switch (n.kind) {
    case 'landmark':
      return <rect x="-11" y="-11" width="22" height="22" rx="3.5" transform="rotate(45)" fill={fill} stroke={stroke} strokeWidth="1.6" />;
    case 'frontier':
      return <path d="M0,-15 L14,10 L-14,10 Z" fill={fill} stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />;
    case 'move':
      return (
        <rect
          x={-pillW / 2}
          y={-pillH / 2}
          width={pillW}
          height={pillH}
          rx="7"
          fill={fill}
          stroke={stroke}
          strokeWidth="1.4"
        />
      );
    case 'known':
      return (
        <>
          <circle r="14" fill={fill} stroke={stroke} strokeWidth="1.6" />
          <path d="M-5.5,0 L-1.5,4 L6.5,-4.5" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" />
        </>
      );
    default:
      return <circle r="15" fill={fill} stroke={stroke} strokeWidth="1.8" />;
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
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [map.decl]);

  // Compute ancestor flow path (edges & nodes) from root theorem to selectedId for perceptual backtracing
  const activeTrail = useMemo(() => {
    const edgeIds = new Set<string>();
    const nodeIds = new Set<string>();
    if (!selectedId) return { edgeIds, nodeIds };
    const flowEdges = map.edges.filter((e) => e.kind === 'flow');
    let curr: string | undefined = selectedId;
    if (curr.startsWith('lm:')) {
      nodeIds.add(curr);
      const usesEdge = map.edges.find((e) => e.source === curr && e.kind === 'uses');
      if (usesEdge) {
        edgeIds.add(usesEdge.id);
        curr = usesEdge.target;
      } else {
        curr = undefined;
      }
    }
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

  const bounds = useMemo(() => {
    if (!map.nodes.length) return { minX: 0, minY: 0, w: 680, h: 380 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of map.nodes) {
      const p = pos[n.id];
      if (!p) continue;
      const m = nodeBoxMetrics(n);
      minX = Math.min(minX, p.x - m.halfW);
      maxX = Math.max(maxX, p.x + m.halfW);
      minY = Math.min(minY, p.y - m.topH);
      maxY = Math.max(maxY, p.y + m.bottomH);
    }
    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, w: 680, h: 380 };
    const padX = 52;
    const padY = 54;
    const rawW = maxX - minX + padX * 2;
    const rawH = maxY - minY + padY * 2;
    const w = Math.max(rawW, 560);
    const h = Math.max(rawH, 320);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return { minX: cx - w / 2, minY: cy - h / 2, w, h };
  }, [map.nodes, pos]);

  const zw = bounds.w / zoom;
  const zh = bounds.h / zoom;
  const vx = bounds.minX + (bounds.w - zw) / 2 - pan.x;
  const vy = bounds.minY + (bounds.h - zh) / 2 - pan.y;
  const viewBox = `${vx} ${vy} ${zw} ${zh}`;
  const svgHeight = Math.min(520, Math.max(340, Math.round(bounds.h * 0.85)));

  return (
    <div className="relative select-none">
      <div className="absolute right-3 top-3 z-10 flex gap-1">
        <button className="h-7 w-7 rounded-md border border-stone-300 bg-white/95 text-base leading-none shadow-xs hover:border-teal-700" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.55, z / 1.2))}>−</button>
        <button className="h-7 rounded-md border border-stone-300 bg-white/95 px-2 text-xs font-semibold shadow-xs hover:border-teal-700" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit</button>
        <button className="h-7 w-7 rounded-md border border-stone-300 bg-white/95 text-base leading-none shadow-xs hover:border-teal-700" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3.2, z * 1.2))}>+</button>
      </div>
      <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-1 text-[11px] font-semibold">
        {([['Goal', '#fff'], ['Landmark', '#c28a2d'], ['Frontier', '#f6ad55'], ['Move', '#dce5df'], ['Grounded', '#177245']] as const).map(([label, bg]) => (
          <span key={label} className="rounded-full border border-stone-200 bg-white/95 px-2 py-0.5 shadow-2xs"><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: bg }} />{label}</span>
        ))}
      </div>
      <svg
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        style={{ height: `${svgHeight}px`, backgroundImage: 'radial-gradient(circle, #c9d6cc 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        className="block w-full cursor-grab bg-[#f7f8f4] active:cursor-grabbing"
        role="group"
        aria-label="Proof map. Tab through nodes, Enter to stand on one."
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest('g[role="button"]')) return;
          dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
        }}
        onMouseMove={(e) => {
          if (!dragRef.current) return;
          const scale = (bounds.w / zoom) / Math.max(e.currentTarget.clientWidth, 300);
          setPan({
            x: dragRef.current.panX + (e.clientX - dragRef.current.startX) * scale,
            y: dragRef.current.panY + (e.clientY - dragRef.current.startY) * scale,
          });
        }}
        onMouseUp={() => { dragRef.current = null; }}
        onMouseLeave={() => { dragRef.current = null; }}>
        <defs>
          <marker id="arrow-flow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
            <path d="M0,0.5 L9,5 L0,9.5 Z" fill="#71867a" />
          </marker>
          <marker id="arrow-trail" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0.5 L9,5 L0,9.5 Z" fill="#0f766e" />
          </marker>
        </defs>
        {map.edges.map((e) => {
          const a = pos[e.source], b = pos[e.target];
          if (!a || !b) return null;
          const onTrail = activeTrail.edgeIds.has(e.id);
          const cls = onTrail
            ? 'stroke-teal-700'
            : e.kind === 'equiv' ? 'stroke-amber-600 [stroke-dasharray:5_4]' : e.kind === 'uses' ? 'stroke-stone-300 [stroke-dasharray:2_4]' : 'stroke-[#91a79b]';
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const startPad = e.kind === 'flow' ? 16 : 12;
          const endPad = e.kind === 'flow' ? 19 : 14;
          const x1 = dist > startPad + endPad ? a.x + (dx / dist) * startPad : a.x;
          const y1 = dist > startPad + endPad ? a.y + (dy / dist) * startPad : a.y;
          const x2 = dist > startPad + endPad ? b.x - (dx / dist) * endPad : b.x;
          const y2 = dist > startPad + endPad ? b.y - (dy / dist) * endPad : b.y;
          return (
            <path key={e.id} d={`M${x1},${y1} L${x2},${y2}`} className={`${cls} fill-none`}
              strokeWidth={onTrail ? '2.4' : '1.4'}
              markerEnd={onTrail ? 'url(#arrow-trail)' : e.kind === 'flow' ? 'url(#arrow-flow)' : undefined} />
          );
        })}
        {map.nodes.map((n) => {
          const p = pos[n.id];
          if (!p) return null;
          const m = nodeBoxMetrics(n);
          const fill = n.kind === 'landmark' ? areaColor(colors, n.area)
            : n.kind === 'frontier' ? '#f6ad55'
            : n.kind === 'theorem' ? '#14332b'
            : n.kind === 'known' ? '#177245'
            : n.kind === 'move' ? '#e5ece8' : '#ffffff';
          const stroke = n.kind === 'goal' || n.kind === 'theorem' ? '#0f766e' : n.kind === 'frontier' ? '#c56b12' : '#71867a';
          const selected = selectedId === n.id;
          const onTrail = !selected && activeTrail.nodeIds.has(n.id);
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`} tabIndex={0} role="button"
              aria-label={`${n.kind}: ${n.label}`}
              className="cursor-pointer focus:outline-none"
              onClick={() => onSelect(n)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onSelect(n); } }}>
              {n.kind === 'move' ? (
                <rect
                  x={-m.pillW / 2 - 4}
                  y={-m.pillH / 2 - 4}
                  width={m.pillW + 8}
                  height={m.pillH + 8}
                  rx="10"
                  fill="transparent"
                  stroke={selected ? '#c28a2d' : onTrail ? '#0f766e' : 'transparent'}
                  strokeWidth={selected ? 2.8 : onTrail ? 2 : 0}
                  strokeDasharray={selected ? '4 3' : onTrail ? '2 3' : undefined}
                />
              ) : (
                <circle r="21" fill="transparent"
                  stroke={selected ? '#c28a2d' : onTrail ? '#0f766e' : 'transparent'}
                  strokeWidth={selected ? 2.8 : onTrail ? 2 : 0}
                  strokeDasharray={selected ? '4 3' : onTrail ? '2 3' : undefined} />
              )}
              <title>{`${n.kind}: ${n.label}`}</title>
              {shape(n, fill, stroke, m.pillW, m.pillH)}
              {n.kind === 'theorem' && (
                <circle r="5" fill="#f2c66d" />
              )}
              {n.kind === 'move' ? (
                <text
                  x="0"
                  y="3.5"
                  textAnchor="middle"
                  className="fill-stone-800 font-mono text-[10.5px] font-semibold">
                  {m.text}
                </text>
              ) : (
                <g transform="translate(0, 26)">
                  <rect
                    x={-m.pillW / 2}
                    y={-11}
                    width={m.pillW}
                    height={m.pillH}
                    rx="5.5"
                    fill={selected ? '#14332b' : 'rgba(255, 255, 255, 0.94)'}
                    stroke={selected ? '#c28a2d' : onTrail ? '#0f766e' : '#d6d3d1'}
                    strokeWidth={selected ? '1.5' : '1'}
                  />
                  <text
                    x="0"
                    y="3"
                    textAnchor="middle"
                    className={`font-mono text-[10.5px] font-semibold ${selected ? 'fill-stone-50' : 'fill-stone-900'}`}>
                    {m.text}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
