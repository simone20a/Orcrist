// =====================================================================
// Il grafo della macchina, che nella schermata di esecuzione prende il
// posto della casella del prompt.
//
// Tutti i gesti del puntatore passano da un solo gestore sul
// contenitore. Prima ce n'erano due — pointer sui nodi, mouse sullo
// sfondo — e siccome un pointerdown genera anche un mousedown, lo
// stesso gesto veniva interpretato due volte: si trascinava il nodo e
// insieme si spostava la vista, con il grafo che schizzava via. Ora
// pointerdown decide una volta sola se il bersaglio e' un nodo o lo
// sfondo, e la cattura del puntatore garantisce che il gesto finisca
// anche se il rilascio avviene fuori dalla finestra.
//
// Lo stato in esecuzione e' l'unico elemento verde della vista, con un
// alone che pulsa: a colpo d'occhio si vede dove si trova la macchina
// senza dover leggere niente.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IRMachine } from '../../shared/ir.js';
import type { PositionOverrides } from '../graph/layout.js';
import { layoutMachine, NODE_H, NODE_W } from '../graph/layout.js';

interface Props {
  machine: IRMachine;
  currentState?: string;
  running: boolean;
  visitCounts: Record<string, number>;
  lastTransition?: { from: string; to: string };
  selected?: string;
  /** stato da cui parte una domanda in attesa di risposta */
  askingState?: string;
  positions: PositionOverrides;
  onSelect: (state: string) => void;
  onPositionsChange: (next: PositionOverrides) => void;
}

/** Spostamento oltre il quale il gesto e' un trascinamento, non un click. */
const DRAG_THRESHOLD = 4;
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;

interface View {
  x: number;
  y: number;
  scale: number;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; viewX: number; viewY: number }
  | {
      kind: 'node';
      pointerId: number;
      name: string;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
      moved: boolean;
    };

export function MachineGraph({
  machine,
  currentState,
  running,
  visitCounts,
  lastTransition,
  selected,
  askingState,
  positions,
  onSelect,
  onPositionsChange,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setViewRaw] = useState<View>({ x: 0, y: 0, scale: 1 });
  const gesture = useRef<Gesture | undefined>();
  const [panning, setPanning] = useState(false);
  const [drag, setDrag] = useState<{ name: string; x: number; y: number } | undefined>();

  /**
   * Unico punto da cui si aggiorna la vista. Un valore non finito o
   * una scala fuori scala fanno sparire tutto il disegno e non c'e'
   * modo di accorgersene dall'interfaccia: meglio scartare
   * l'aggiornamento e restare dove si era.
   */
  const setView = useCallback((next: View | ((v: View) => View)) => {
    setViewRaw((prev) => {
      const candidate = typeof next === 'function' ? next(prev) : next;
      if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) || !Number.isFinite(candidate.scale)) {
        return prev;
      }
      return { ...candidate, scale: clamp(candidate.scale, MIN_SCALE, MAX_SCALE) };
    });
  }, []);

  // Durante il trascinamento la posizione vive qui: si sovrascrive
  // quella salvata solo al rilascio, cosi' non si scrive su disco a
  // ogni pixel.
  const effective = useMemo<PositionOverrides>(
    () => (drag ? { ...positions, [drag.name]: { x: drag.x, y: drag.y } } : positions),
    [positions, drag],
  );

  const layout = useMemo(() => layoutMachine(machine, effective), [machine, effective]);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || layout.width <= 0 || layout.height <= 0) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    // Se il contenitore non e' ancora misurato, un fit ora produrrebbe
    // una scala negativa: si rimanda.
    if (w < 80 || h < 80) return;
    const scale = clamp(Math.min(1, (w - 48) / layout.width, (h - 48) / layout.height), MIN_SCALE, MAX_SCALE);
    setView({
      x: (w - layout.width * scale) / 2,
      y: (h - layout.height * scale) / 2,
      scale,
    });
  }, [layout.width, layout.height, setView]);

  // Si inquadra all'apertura e quando cambia macchina, non a ogni
  // trascinamento: altrimenti la vista scapperebbe sotto le dita.
  const fitted = useRef<string>('');
  useEffect(() => {
    const key = `${machine.name}:${machine.states.length}`;
    if (fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [machine, fit]);

  // Quando la macchina avanza, lo stato attivo viene riportato in vista
  // se e' uscito dalla finestra: durante una corsa lunga non si perde.
  useEffect(() => {
    if (!running || !currentState || gesture.current) return;
    const el = containerRef.current;
    const node = layout.nodes.find((n) => n.name === currentState);
    if (!el || !node) return;
    setView((v) => {
      const sx = node.x * v.scale + v.x;
      const sy = node.y * v.scale + v.y;
      const margin = 80;
      const inside = sx > margin && sy > margin && sx < el.clientWidth - margin && sy < el.clientHeight - margin;
      if (inside) return v;
      return {
        ...v,
        x: el.clientWidth / 2 - (node.x + NODE_W / 2) * v.scale,
        y: el.clientHeight / 2 - (node.y + NODE_H / 2) * v.scale,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentState, running]);

  // --- gesti -----------------------------------------------------------

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || gesture.current) return;
    const target = e.target as Element | null;
    // I comandi di zoom stanno dentro la tela ma non sono la tela.
    if (target?.closest('.zoom-controls')) return;

    const el = containerRef.current;
    if (!el) return;

    const nodeEl = target?.closest('[data-state]');
    const name = nodeEl?.getAttribute('data-state') ?? undefined;
    const node = name ? layout.nodes.find((n) => n.name === name) : undefined;

    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* alcuni dispositivi non consentono la cattura: si prosegue lo stesso */
    }

    if (node) {
      gesture.current = {
        kind: 'node',
        pointerId: e.pointerId,
        name: node.name,
        startX: e.clientX,
        startY: e.clientY,
        originX: node.x,
        originY: node.y,
        moved: false,
      };
    } else {
      gesture.current = {
        kind: 'pan',
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        viewX: view.x,
        viewY: view.y,
      };
      setPanning(true);
    }
    // niente selezione di testo o trascinamento nativo sotto le dita
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (g.kind === 'pan') {
      setView((v) => ({ ...v, x: g.viewX + dx, y: g.viewY + dy }));
      return;
    }

    if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    g.moved = true;
    setDrag({
      name: g.name,
      x: Math.round(g.originX + dx / view.scale),
      y: Math.round(g.originY + dy / view.scale),
    });
  };

  const endGesture = (e: React.PointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (!g || g.pointerId !== e.pointerId) return;
    gesture.current = undefined;

    const el = containerRef.current;
    try {
      if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      /* la cattura puo' essere gia' stata persa */
    }

    if (g.kind === 'pan') {
      setPanning(false);
      return;
    }

    if (!g.moved) {
      setDrag(undefined);
      onSelect(g.name);
      return;
    }

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    // niente coordinate negative: il nodo resterebbe fuori dalla tela
    const x = Math.max(0, Math.round(g.originX + dx / view.scale));
    const y = Math.max(0, Math.round(g.originY + dy / view.scale));
    setDrag(undefined);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      onPositionsChange({ ...positions, [g.name]: { x, y } });
    }
  };

  const onWheel = (e: React.WheelEvent): void => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const next = clamp(v.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08), MIN_SCALE, MAX_SCALE);
      const k = next / v.scale;
      return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };

  const movedCount = Object.keys(positions).length;

  return (
    <div
      ref={containerRef}
      className={`canvas${panning ? ' dragging' : ''}`}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      onDragStart={(e) => e.preventDefault()}
    >
      <svg width="100%" height="100%">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path className="arrow-head" d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
          <marker id="arrow-live" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path className="arrow-head live" d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
          <filter id="live-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feFlood className="live-flood" floodOpacity="0.5" result="tint" />
            <feComposite in="tint" in2="blur" operator="in" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {layout.edges.map((e) => {
            const taken = !!lastTransition && lastTransition.from === e.from && lastTransition.to === e.to;
            const showLabel = view.scale > 0.55 && e.label.length < 46;
            return (
              <g key={e.id}>
                <path
                  className={`edge ${e.kind}${taken ? ' taken' : ''}`}
                  d={e.path}
                  markerEnd={`url(#${taken ? 'arrow-live' : 'arrow'})`}
                />
                {showLabel && (
                  <>
                    <rect
                      className="edge-label-bg"
                      x={e.labelX - (e.label.length * 5.4) / 2 - 4}
                      y={e.labelY - 7}
                      width={e.label.length * 5.4 + 8}
                      height={14}
                      rx={3}
                    />
                    <text className={`edge-label${taken ? ' taken' : ''}`} x={e.labelX} y={e.labelY + 3.5}>
                      {e.label}
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {layout.nodes.map((n) => {
            const live = running && currentState === n.name;
            const visits = visitCounts[n.name] ?? 0;
            const beingDragged = drag?.name === n.name;
            const classes = [
              'node',
              n.state.initial ? 'initial' : '',
              n.state.final ? 'final' : '',
              live ? 'live' : '',
              !live && visits > 0 ? 'visited' : '',
              selected === n.name ? 'selected' : '',
              askingState === n.name ? 'asking' : '',
              beingDragged ? 'grabbed' : '',
            ]
              .filter(Boolean)
              .join(' ');

            const subtitle = n.state.final
              ? 'final'
              : n.state.writes.length
                ? `writes ${n.state.writes.join(', ')}`
                : 'no writes';

            return (
              <g key={n.name} className={classes} data-state={n.name} transform={`translate(${n.x} ${n.y})`}>
                {live && (
                  <rect
                    className="node-halo"
                    x={-4}
                    y={-4}
                    width={NODE_W + 8}
                    height={NODE_H + 8}
                    rx={12}
                    style={{ transformOrigin: `${NODE_W / 2}px ${NODE_H / 2}px` }}
                  />
                )}
                <rect className="node-box" width={NODE_W} height={NODE_H} rx={10} />
                {n.state.initial && <circle className="node-seed" cx={12} cy={NODE_H / 2} r={3.5} />}
                <text className="node-label" x={n.state.initial ? 26 : 14} y={24}>
                  {truncate(n.name, 18)}
                </text>
                <text className="node-sub" x={n.state.initial ? 26 : 14} y={40}>
                  {truncate(subtitle, 24)}
                </text>
                {visits > 0 && (
                  <text className="node-sub" x={NODE_W - 12} y={40} textAnchor="end">
                    ×{visits}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="canvas-hint">
        Drag a node to move it · drag the background to pan · use the mouse wheel to zoom
      </div>
      <div className="zoom-controls">
        {movedCount > 0 && (
          <button
            className="btn"
            title={`${movedCount} nodes moved manually: return to automatic layout`}
            onClick={() => onPositionsChange({})}
          >
            Reset layout
          </button>
        )}
        <button className="btn" onClick={() => setView((v) => ({ ...v, scale: v.scale / 1.2 }))}>
          −
        </button>
        <button className="btn" onClick={fit}>
          Fit
        </button>
        <button className="btn" onClick={() => setView((v) => ({ ...v, scale: v.scale * 1.2 }))}>
          +
        </button>
      </div>
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
