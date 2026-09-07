import React from 'react';
import type { ResearchGraphNode, ResearchGraphResponse } from '@ncos/contracts';
const COLORS = ['#059669', '#2563eb', '#7c3aed', '#db2777', '#d97706', '#0891b2', '#475569'];

function colorFor(value: string): string {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function graphPositions(nodes: ResearchGraphNode[]): Record<string, { x: number; y: number }> {
  const groups = new Map<number, ResearchGraphNode[]>();
  for (const node of nodes) groups.set(node.depth, [...(groups.get(node.depth) ?? []), node]);
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [depth, rows] of groups) {
    rows.forEach((node, index) => {
      if (depth === 0) positions[node.id] = { x: 400, y: 260 };
      else {
        const radius = depth === 1 ? 130 : 210;
        const angle = (Math.PI * 2 * index) / Math.max(1, rows.length) - Math.PI / 2;
        positions[node.id] = { x: 400 + Math.cos(angle) * radius, y: 260 + Math.sin(angle) * radius };
      }
    });
  }
  return positions;
}

export function OpportunityGraph({ graph, selectedId, minimumVolume, onSelect }: { graph: ResearchGraphResponse; selectedId: string; minimumVolume: number; onSelect: (id: string) => void }) {
  const nodes = graph.nodes.filter((node) => node.depth === 0 || (node.volume ?? 0) >= minimumVolume);
  const visible = new Set(nodes.map((node) => node.id));
  const positions = graphPositions(nodes);
  return (
    <svg viewBox="0 0 800 520" className="keyword-graph h-[60vh] min-h-[420px] w-full rounded-xl bg-slate-950" role="img" aria-label="키워드 기회 그래프">
      {graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target)).map((edge) => {
        const source = positions[edge.source]; const target = positions[edge.target];
        return source && target ? <line key={`${edge.source}-${edge.target}`} x1={source.x} y1={source.y} x2={target.x} y2={target.y} stroke="var(--graph-edge, #334155)" strokeWidth="1.5" /> : null;
      })}
      {nodes.map((node) => {
        const point = positions[node.id];
        const radius = node.depth === 0 ? 30 : Math.max(10, Math.min(26, 8 + Math.log10((node.volume ?? 0) + 10) * 4));
        return (
          <g key={node.id} role="button" tabIndex={0} aria-label={`${node.keyword}, 검색량 ${node.volume ?? '결측'}`} onClick={() => onSelect(node.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); } }} className="cursor-pointer outline-none">
            <circle cx={point.x} cy={point.y} r={radius} fill={colorFor(node.cluster)} stroke={selectedId === node.id ? 'var(--graph-selected, #f8fafc)' : node.enrichment_status === 'ok' ? 'var(--graph-ok, #10b981)' : 'var(--graph-pending, #f59e0b)'} strokeWidth={selectedId === node.id ? 5 : 2} />
            <text x={point.x} y={point.y + radius + 13} textAnchor="middle" fill="var(--text, #e2e8f0)" fontSize="11">{node.keyword.slice(0, 13)}</text>
          </g>
        );
      })}
    </svg>
  );
}
