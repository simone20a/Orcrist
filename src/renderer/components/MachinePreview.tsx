import { useMemo, useRef, useState } from 'react';
import type { Machine, State } from '../../orcrist/ast';
import { exprToString, findState, refToString, typeToString } from '../../orcrist/ast';
import { promptPreview } from '../../orcrist/evaluator';
import { drawingBounds, layoutMachine, type LayoutEdge, type LayoutNode } from '../../orcrist/layout';

interface Props {
  machine: Machine;
}

const OPTS = { col: 168, row: 78, pad: 34, nodeW: 116, nodeH: 36 };

/**
 * The machine drawn at a size you can actually read, for the approval dialog.
 * Hovering a state shows the prompt that state will give — the part of a
 * machine that decides what the model is actually asked to do, and the part a
 * diagram of boxes and arrows otherwise hides.
 */
export function MachinePreview({ machine }: Props) {
  const layout = useMemo(() => layoutMachine(machine, OPTS), [machine]);
  const [hover, setHover] = useState<
    { state: State; x: number; y: number; below: boolean } | undefined
  >();
  const boxRef = useRef<HTMLDivElement>(null);

  const W = layout.nodeW;
  const H = layout.nodeH;
  const byName = new Map(layout.nodes.map((n) => [n.name, n]));
  // 'below' leaves room for the "limit N -> State" caption under a node
  const b = drawingBounds(layout, { selfLoop: 30, backEdge: 38, below: 15, left: 24 });

  const onEnter = (name: string) => (e: React.MouseEvent<SVGGElement>) => {
    const state = findState(machine, name);
    const box = boxRef.current?.getBoundingClientRect();
    if (!state || !box) return;
    const r = (e.currentTarget as SVGGElement).getBoundingClientRect();
    // Flip below the node when there isn't room for the tooltip above it.
    const top = r.top - box.top;
    const below = top < 210;
    setHover({
      state,
      x: r.left - box.left + r.width / 2,
      y: below ? top + r.height : top,
      below,
    });
  };

  return (
    <div className="preview" ref={boxRef} onMouseLeave={() => setHover(undefined)}>
      <svg
        viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`}
        preserveAspectRatio="xMidYMid meet"
        // A three-state machine would otherwise stretch to the dialog's full
        // width and render its labels at headline size; cap the width at what
        // the height budget allows and centre what's left.
        style={{
          width: '100%',
          maxWidth: `${Math.round((b.w / b.h) * 360)}px`,
          height: 'auto',
          display: 'block',
          margin: '0 auto',
        }}
        role="img"
        aria-label={`State machine ${machine.name}`}
      >
        <defs>
          <marker
            id="pv-arw"
            viewBox="0 0 7 7"
            refX="6.5"
            refY="3.5"
            markerWidth="3.4"
            markerHeight="3.4"
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path className="arrowhead" d="M0,0 L7,3.5 L0,7 z" />
          </marker>
        </defs>

        {layout.edges.map((e, i) => (
          <Edge key={i} edge={e} from={byName.get(e.from)} to={byName.get(e.to)} w={W} h={H} />
        ))}

        {layout.nodes.map((n) => {
          const state = findState(machine, n.name);
          const hovered = hover?.state.name === n.name;
          return (
            <g
              key={n.name}
              onMouseEnter={onEnter(n.name)}
              style={{ cursor: state?.final ? 'default' : 'help' }}
            >
              {n.initial && <circle className="start-dot" cx={n.x - 11} cy={n.y + H / 2} r={4} />}
              {n.initial && (
                <path className="edge" d={`M ${n.x - 7} ${n.y + H / 2} L ${n.x - 1} ${n.y + H / 2}`} markerEnd="url(#pv-arw)" />
              )}
              <rect
                className={`pv-box ${n.final ? 'final' : ''} ${hovered ? 'hovered' : ''}`}
                x={n.x}
                y={n.y}
                width={W}
                height={H}
                rx={n.final ? 17 : 7}
              />
              <text
                className={`pv-label ${n.final ? 'final' : ''} ${hovered ? 'on-ink' : ''}`}
                x={n.x + W / 2}
                y={n.y + H / 2 + 4}
                textAnchor="middle"
              >
                {truncate(n.name, 15)}
              </text>
              {state?.limit && (
                <text className="pv-limit" x={n.x + W / 2} y={n.y + H + 11} textAnchor="middle">
                  limit {state.limit.maxVisits} → {state.limit.onExceeded}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hover && (
        <div
          className={`pv-tip ${hover.below ? 'below' : ''}`}
          style={{
            left: Math.max(8, Math.min(hover.x, (boxRef.current?.clientWidth ?? 400) - 8)),
            top: hover.y,
          }}
        >
          <div className="pv-tip-head">
            <span className="mono">{hover.state.name}</span>
            {hover.state.initial && <span className="badge">initial</span>}
            {hover.state.final && <span className="badge ok">final</span>}
          </div>
          {hover.state.final ? (
            <p className="pv-tip-body">A terminal outcome — the run ends here.</p>
          ) : (
            <>
              <p className="pv-tip-body">
                {hover.state.prompt ? promptPreview(hover.state.prompt) : '(no prompt)'}
              </p>
              <dl className="kv">
                {hover.state.writes.length > 0 && (
                  <>
                    <dt>writes</dt>
                    <dd>{hover.state.writes.join(', ')}</dd>
                  </>
                )}
                {hover.state.assignments.length > 0 && (
                  <>
                    <dt>set</dt>
                    <dd>
                      {hover.state.assignments.map((a, i) => (
                        <div key={i}>
                          {refToString(a.target)} = {exprToString(a.value)}
                        </div>
                      ))}
                    </dd>
                  </>
                )}
                {hover.state.transitions.length > 0 && (
                  <>
                    <dt>on</dt>
                    <dd>
                      {hover.state.transitions.map((t, i) => (
                        <div key={i}>
                          {exprToString(t.guard)} → {t.target}
                        </div>
                      ))}
                    </dd>
                  </>
                )}
                {hover.state.fallback && (
                  <>
                    <dt>otherwise</dt>
                    <dd>→ {hover.state.fallback.target}</dd>
                  </>
                )}
              </dl>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Edge({
  edge,
  from,
  to,
  w: W,
  h: H,
}: {
  edge: LayoutEdge;
  from?: LayoutNode;
  to?: LayoutNode;
  w: number;
  h: number;
}) {
  if (!from || !to) return null;
  const cls = `edge ${edge.kind}`;
  const marker = 'url(#pv-arw)';

  if (edge.selfLoop) {
    const x = from.x + W / 2;
    const y = from.y;
    return (
      <path
        className={cls}
        markerEnd={marker}
        d={`M ${x - 16} ${y} C ${x - 22} ${y - 26}, ${x + 22} ${y - 26}, ${x + 14} ${y - 1}`}
      />
    );
  }
  if (edge.backEdge) {
    const x1 = from.x + W / 2;
    const y1 = from.y + H;
    const x2 = to.x + W / 2;
    const y2 = to.y + H;
    const dip = Math.max(y1, y2) + 30;
    return (
      <path
        className={cls}
        markerEnd={marker}
        d={`M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 1}`}
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
      d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 2} ${y2}`}
    />
  );
}

/**
 * Which mark a location carries. Three owners, three shapes — the reader is
 * being told what a guard over this location is actually testing: a claim,
 * a measurement, or a derivation.
 */
export function ownerDot(ownership: string): string {
  return ownership === 'agent' ? 'dot-agent' : ownership === 'observed' ? 'dot-observe' : 'dot-assign';
}

/** The store, shown alongside the diagram — the ownership split at a glance. */
export function MachineLocations({ machine }: { machine: Machine }) {
  if (!machine.locations.length) return null;
  const has = (o: string) => machine.locations.some((l) => l.ownership === o);
  return (
    <>
      <div className="section-title">Store</div>
      {machine.locations.map((l) => (
        <div className="store-row" key={l.name}>
          <span className={ownerDot(l.ownership)} />
          <span className="n">{l.name}</span>
          <span className="v unset">{typeToString(l.type)}</span>
        </div>
      ))}
      <p className="help" style={{ marginTop: 8 }}>
        {has('agent') && (
          <>
            <span className="dot-agent" style={{ display: 'inline-block', marginRight: 5 }} />
            claimed by the agent
          </>
        )}
        {has('observed') && (
          <>
            <span className="dot-observe" style={{ display: 'inline-block', margin: '0 5px 0 14px' }} />
            measured by the runtime
          </>
        )}
        <span className="dot-assign" style={{ display: 'inline-block', margin: '0 5px 0 14px' }} />
        derived by a set
      </p>
    </>
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
