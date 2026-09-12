import { useMemo } from 'react';
import type { Machine } from '../../orcrist/ast';
import { drawingBounds, layoutMachine, type LayoutEdge, type LayoutNode } from '../../orcrist/layout';


interface Props {
  machine?: Machine;
  currentState?: string;
  visited?: Set<string>;
  lastTransition?: { from: string; to: string };
}

/**
 * A low-detail map of the whole machine with the running state lit up — the
 * "where am I" indicator that sits at the top left while a run is going.
 */
export function FsmThumbnail({ machine, currentState, visited, lastTransition }: Props) {
  const layout = useMemo(() => (machine ? layoutMachine(machine) : undefined), [machine]);
  const W = layout?.nodeW ?? 62;
  const H = layout?.nodeH ?? 20;

  if (!machine || !layout) {
    return (
      <div className="thumb-wrap">
        <div className="thumb-empty">No machine for this run</div>
      </div>
    );
  }

  const byName = new Map(layout.nodes.map((n) => [n.name, n]));
  const b = drawingBounds(layout, { selfLoop: 16, backEdge: 18, below: 0, left: 10 });

  return (
    <div className="thumb-wrap">
      <svg
        viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: 'auto', minHeight: 92, display: 'block' }}
        role="img"
        aria-label={`State machine ${machine.name}`}
      >
        <defs>
          {/* markerUnits defaults to strokeWidth, which made the "hot" arrow —
              drawn with a thicker stroke — noticeably bigger than every other
              one. Pinning them to user space keeps them all the same size. */}
          <marker
            id="arw"
            viewBox="0 0 6 6"
            refX="5.6"
            refY="3"
            markerWidth="3"
            markerHeight="3"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path className="arrowhead" d="M0,0 L6,3 L0,6 z" />
          </marker>
          <marker
            id="arw-hot"
            viewBox="0 0 6 6"
            refX="5.6"
            refY="3"
            markerWidth="3"
            markerHeight="3"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path className="arrowhead hot" d="M0,0 L6,3 L0,6 z" />
          </marker>
        </defs>

        {layout.edges.map((e, i) => (
          <Edge
            key={i}
            edge={e}
            from={byName.get(e.from)}
            to={byName.get(e.to)}
            w={W}
            h={H}
            hot={lastTransition?.from === e.from && lastTransition?.to === e.to}
          />
        ))}

        {layout.nodes.map((n) => {
          const isCurrent = n.name === currentState;
          const cls = [
            'node-box',
            n.final ? 'final' : '',
            visited?.has(n.name) ? 'visited' : '',
            isCurrent ? 'current' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <g key={n.name}>
              {n.initial && <circle className="start-dot" cx={n.x - 6} cy={n.y + H / 2} r={2.5} />}
              <rect
                className={cls}
                x={n.x}
                y={n.y}
                width={W}
                height={H}
                rx={n.final ? 9 : 4}
              />
              <text
                className={`node-label ${isCurrent ? 'current' : ''} ${n.final ? 'final' : ''}`}
                x={n.x + W / 2}
                y={n.y + H / 2 + 2.7}
                textAnchor="middle"
              >
                {truncate(n.name, 11)}
              </text>
              {isCurrent && (
                <rect
                  x={n.x - 2.5}
                  y={n.y - 2.5}
                  width={W + 5}
                  height={H + 5}
                  rx={n.final ? 11 : 6}
                  className="node-halo"
                  fill="none"
                  strokeWidth="1.5"
                >
                  <animate
                    attributeName="stroke-opacity"
                    values="0.35;0.05;0.35"
                    dur="1.8s"
                    repeatCount="indefinite"
                  />
                </rect>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Edge({
  edge,
  from,
  to,
  hot,
  w: W,
  h: H,
}: {
  edge: LayoutEdge;
  from?: LayoutNode;
  to?: LayoutNode;
  hot: boolean;
  w: number;
  h: number;
}) {
  if (!from || !to) return null;
  const cls = `edge ${edge.kind} ${hot ? 'hot' : ''}`;
  const marker = hot ? 'url(#arw-hot)' : 'url(#arw)';

  if (edge.selfLoop) {
    const x = from.x + W / 2;
    const y = from.y;
    return (
      <path
        className={cls}
        markerEnd={marker}
        d={`M ${x - 9} ${y} C ${x - 12} ${y - 13}, ${x + 12} ${y - 13}, ${x + 8} ${y - 0.5}`}
      />
    );
  }

  // back edges bow underneath so they don't overlay the forward flow
  if (edge.backEdge) {
    const x1 = from.x + W / 2;
    const y1 = from.y + H;
    const x2 = to.x + W / 2;
    const y2 = to.y + H;
    const dip = Math.max(y1, y2) + 14;
    return (
      <path
        className={cls}
        markerEnd={marker}
        d={`M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 0.5}`}
      />
    );
  }

  const x1 = from.x + W;
  const y1 = from.y + H / 2;
  const x2 = to.x;
  const y2 = to.y + H / 2;
  const mid = (x1 + x2) / 2;
  return (
    <path
      className={cls}
      markerEnd={marker}
      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 1} ${y2}`}
    />
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
