import { computed, signal } from 'amoxi';
import type { BeanInfo } from 'amoxi';

const ROW = 48;
const WIDTH = 120; // SVG units; CSS scales the gutter horizontally on small screens
const CX = 112;

/** The bean graph as an arc diagram in creation order. Hover or focus a bean to trace its links. */
export default function WiringDiagram(props: { beans: BeanInfo[] }) {
  const { beans } = props;
  const [hovered, setHovered] = signal<number | null>(null);
  const pos = new Map(beans.map((b, i) => [b.id, i]));
  const byId = new Map(beans.map((b) => [b.id, b]));
  const edges = beans.flatMap((b) => b.dependencies.map((d) => [b.id, d] as const));
  const maxDist = Math.max(1, ...edges.map(([a, b]) => Math.abs(pos.get(a)! - pos.get(b)!)));
  const y = (id: number): number => pos.get(id)! * ROW + ROW / 2;
  const height = beans.length * ROW;

  const related = computed(() => {
    const id = hovered();
    const set = new Set<number>();
    if (id === null) return set;
    set.add(id);
    for (const [from, to] of edges) if (from === id || to === id) set.add(from).add(to);
    return set;
  });

  return (
    <div class="wiring">
      <svg
        class={() => (hovered() === null ? 'arcs' : 'arcs focusing')}
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="none"
        style={`height:${height}px`}
        aria-hidden="true"
      >
        {edges.map(([from, to]) => {
          const rx = 6 + (CX - 14) * (Math.abs(pos.get(from)! - pos.get(to)!) / maxDist);
          return (
            <path
              d={`M ${CX} ${y(from)} A ${rx} ${Math.abs(y(from) - y(to)) / 2} 0 0 1 ${CX} ${y(to)}`}
              vector-effect="non-scaling-stroke"
              class={() => (hovered() !== null && (hovered() === from || hovered() === to) ? 'hot' : undefined)}
            />
          );
        })}
      </svg>
      <ol class="beans" onMouseLeave={() => setHovered(null)}>
        {beans.map((b, i) => {
          const deps = b.dependencies.map((d) => byId.get(d)!.name);
          const extra = b.types.filter((t) => t !== b.name);
          return (
            <li
              class={() => (related().has(b.id) ? 'bean hot' : 'bean')}
              tabindex="0"
              aria-label={`${i + 1}. ${b.name}. ${b.created ? 'Created' : 'Not created yet'}. ${deps.length ? `Needs ${deps.join(', ')}.` : 'Needs nothing.'}`}
              onMouseEnter={() => setHovered(b.id)}
              onFocus={() => setHovered(b.id)}
              onBlur={() => setHovered(null)}
            >
              <span class={b.created ? 'node on' : 'node'} aria-hidden="true" />
              <span class="order" aria-hidden="true">{i + 1}</span>
              <span class="name" aria-hidden="true">{b.name}</span>
              <span class="types" aria-hidden="true">{extra.length ? `as ${extra.join(', ')}` : ''}</span>
              <span class="tags" aria-hidden="true">
                {b.eager && <span class="tag eager">eager</span>}
                {b.scope === 'prototype' && <span class="tag">new each time</span>}
                {b.primary && <span class="tag">primary</span>}
                {b.qualifier && <span class="tag">named {b.qualifier}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
