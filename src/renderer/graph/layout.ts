// =====================================================================
// Disposizione del grafo della macchina.
//
// Due fasi separate:
//
//   1. POSIZIONI — layout a livelli automatico (rango = distanza minima
//      dallo stato iniziale, ordine affinato a baricentro), poi
//      sovrascritto dalle posizioni che l'utente ha trascinato a mano.
//   2. ARCHI — instradati sulla geometria effettiva, non sui ranghi:
//      dopo un trascinamento il rango non descrive piu' dove stanno i
//      nodi, mentre le coordinate si'.
// =====================================================================

import type { IRMachine, IRState } from '../../shared/ir.js';

export const NODE_W = 168;
export const NODE_H = 56;
const COL_GAP = 40;
const ROW_GAP = 92;
const PADDING = 56;

/** Sotto questa distanza verticale due nodi sono considerati affiancati. */
const BAND = 20;

export type EdgeKind = 'guard' | 'otherwise' | 'limit';

export interface NodePosition {
  x: number;
  y: number;
}

export type PositionOverrides = Record<string, NodePosition>;

export interface LaidOutNode {
  name: string;
  state: IRState;
  x: number;
  y: number;
  rank: number;
  /** vero se la posizione viene da un trascinamento, non dal layout */
  moved: boolean;
}

export interface LaidOutEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
  path: string;
  labelX: number;
  labelY: number;
  selfLoop: boolean;
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

interface RawEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
}

export function layoutMachine(machine: IRMachine, overrides: PositionOverrides = {}): Layout {
  const states = machine.states;
  if (!states.length) return { nodes: [], edges: [], width: 0, height: 0 };

  const byName = new Map(states.map((s) => [s.name, s]));
  const raw = collectEdges(states);
  const auto = autoPositions(machine, raw);

  // --- posizioni finali: automatiche, poi le sovrascritture manuali ---
  const nodes: LaidOutNode[] = states.map((s) => {
    const base = auto.positions.get(s.name) ?? { x: PADDING, y: PADDING };
    const manual = overrides[s.name];
    return {
      name: s.name,
      state: s,
      x: manual ? manual.x : base.x,
      y: manual ? manual.y : base.y,
      rank: auto.ranks.get(s.name) ?? 0,
      moved: !!manual,
    };
  });

  // La tela cresce con i nodi: trascinandone uno oltre il bordo non
  // si finisce fuori dall'area disegnabile.
  const width = Math.max(auto.width, ...nodes.map((n) => n.x + NODE_W)) + PADDING;
  const height = Math.max(auto.height, ...nodes.map((n) => n.y + NODE_H)) + PADDING;

  const nodeByName = new Map(nodes.map((n) => [n.name, n]));
  const laneByPair = new Map<string, number>();

  const edges: LaidOutEdge[] = raw.map((e, i) => {
    const a = nodeByName.get(e.from);
    const b = nodeByName.get(e.to);
    const pairKey = `${e.from}->${e.to}`;
    const lane = laneByPair.get(pairKey) ?? 0;
    laneByPair.set(pairKey, lane + 1);

    if (!a || !b) {
      return { id: `e${i}`, ...e, path: '', labelX: 0, labelY: 0, selfLoop: false };
    }
    return route(`e${i}`, e, a, b, lane, width);
  });

  return { nodes, edges, width, height };
}

// =====================================================================
// Fase 1 — posizioni automatiche
// =====================================================================

interface AutoLayout {
  positions: Map<string, NodePosition>;
  ranks: Map<string, number>;
  width: number;
  height: number;
}

function autoPositions(machine: IRMachine, raw: RawEdge[]): AutoLayout {
  const states = machine.states;
  const initial = states.find((s) => s.initial) ?? states[0];

  const rank = new Map<string, number>([[initial.name, 0]]);
  const queue = [initial.name];
  while (queue.length) {
    const cur = queue.shift()!;
    const r = rank.get(cur)!;
    for (const e of raw) {
      if (e.from !== cur || e.to === cur) continue;
      if (!rank.has(e.to)) {
        rank.set(e.to, r + 1);
        queue.push(e.to);
      }
    }
  }
  let maxRank = Math.max(0, ...rank.values());
  for (const s of states) {
    if (!rank.has(s.name)) rank.set(s.name, ++maxRank);
  }
  // gli stati finali si allineano in fondo: rende leggibile la chiusura
  const finalRank = Math.max(...states.filter((s) => s.final).map((s) => rank.get(s.name) ?? 0), 0);
  for (const s of states) {
    if (s.final) rank.set(s.name, Math.max(finalRank, rank.get(s.name) ?? 0));
  }
  maxRank = Math.max(...rank.values());

  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const s of states) layers[rank.get(s.name)!].push(s.name);

  const forward = raw.filter((e) => (rank.get(e.to) ?? 0) > (rank.get(e.from) ?? 0));
  for (let pass = 0; pass < 4; pass++) {
    const downward = pass % 2 === 0;
    for (let i = 1; i < layers.length; i++) {
      const layerIndex = downward ? i : layers.length - 1 - i;
      const reference = layers[downward ? layerIndex - 1 : layerIndex + 1];
      if (!reference) continue;
      const pos = new Map(reference.map((n, k) => [n, k]));
      const bary = new Map<string, number>();
      layers[layerIndex].forEach((n, k) => {
        const neighbours = forward
          .filter((e) => (downward ? e.to === n : e.from === n))
          .map((e) => pos.get(downward ? e.from : e.to))
          .filter((v): v is number => v !== undefined);
        bary.set(n, neighbours.length ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length : k);
      });
      layers[layerIndex] = [...layers[layerIndex]].sort((a, b) => bary.get(a)! - bary.get(b)!);
    }
  }

  const widest = Math.max(...layers.map((l) => l.length));
  const width = PADDING * 2 + widest * NODE_W + (widest - 1) * COL_GAP;
  const height = PADDING * 2 + (maxRank + 1) * NODE_H + maxRank * ROW_GAP;

  const positions = new Map<string, NodePosition>();
  layers.forEach((layer, r) => {
    const rowW = layer.length * NODE_W + (layer.length - 1) * COL_GAP;
    const startX = (width - rowW) / 2;
    layer.forEach((name, i) => {
      positions.set(name, { x: startX + i * (NODE_W + COL_GAP), y: PADDING + r * (NODE_H + ROW_GAP) });
    });
  });

  return { positions, ranks: rank, width, height };
}

function collectEdges(states: IRState[]): RawEdge[] {
  const out: RawEdge[] = [];
  for (const s of states) {
    for (const t of s.transitions) out.push({ from: s.name, to: t.target, kind: 'guard', label: t.source });
    if (s.limit) {
      out.push({
        from: s.name,
        to: s.limit.onExceeded,
        kind: 'limit',
        label: `> ${s.limit.maxVisits} visits`,
      });
    }
    if (s.fallback) out.push({ from: s.name, to: s.fallback, kind: 'otherwise', label: 'otherwise' });
  }
  return out;
}

// =====================================================================
// Fase 2 — instradamento geometrico
// =====================================================================

function route(
  id: string,
  e: RawEdge,
  a: LaidOutNode,
  b: LaidOutNode,
  lane: number,
  canvasW: number,
): LaidOutEdge {
  if (a.name === b.name) return selfLoop(id, e, a, lane);

  const below = b.y - (a.y + NODE_H); // spazio libero sotto a, prima di b
  const above = a.y - (b.y + NODE_H); // spazio libero sopra a, dopo b

  if (below >= BAND) return downward(id, e, a, b, lane);
  if (above >= BAND) return upward(id, e, a, b, lane, canvasW);
  return sideways(id, e, a, b, lane);
}

/** Bersaglio piu' in basso: si esce dal fondo e si entra dall'alto. */
function downward(id: string, e: RawEdge, a: LaidOutNode, b: LaidOutNode, lane: number): LaidOutEdge {
  const offset = lane * 26;
  const x1 = a.x + NODE_W / 2 + offset;
  const y1 = a.y + NODE_H;
  const x2 = b.x + NODE_W / 2 + offset;
  const y2 = b.y;
  const dy = Math.max(24, (y2 - y1) / 2);
  return {
    id,
    ...e,
    path: `M ${r(x1)} ${r(y1)} C ${r(x1)} ${r(y1 + dy)}, ${r(x2)} ${r(y2 - dy)}, ${r(x2)} ${r(y2)}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2,
    selfLoop: false,
  };
}

/**
 * Bersaglio piu' in alto: e' un arco all'indietro. Si esce dal fianco
 * verso il bordo piu' vicino e si risale di lato, cosi' un ciclo si
 * legge come un ciclo invece di passare sopra ai nodi in mezzo.
 */
function upward(
  id: string,
  e: RawEdge,
  a: LaidOutNode,
  b: LaidOutNode,
  lane: number,
  canvasW: number,
): LaidOutEdge {
  const goRight = a.x + NODE_W / 2 > canvasW / 2;
  const side = goRight ? 1 : -1;
  const x1 = goRight ? a.x + NODE_W : a.x;
  const y1 = a.y + NODE_H / 2;
  const x2 = goRight ? b.x + NODE_W : b.x;
  const y2 = b.y + NODE_H / 2;
  const bulge = side * (48 + lane * 26);
  const cx1 = x1 + bulge;
  const cx2 = x2 + bulge;
  return {
    id,
    ...e,
    path: `M ${r(x1)} ${r(y1)} C ${r(cx1)} ${r(y1)}, ${r(cx2)} ${r(y2)}, ${r(x2)} ${r(y2)}`,
    labelX: (cx1 + cx2) / 2 + side * 4,
    labelY: (y1 + y2) / 2,
    selfLoop: false,
  };
}

/** Nodi affiancati: si esce dal fianco rivolto al bersaglio. */
function sideways(id: string, e: RawEdge, a: LaidOutNode, b: LaidOutNode, lane: number): LaidOutEdge {
  const toRight = b.x + NODE_W / 2 >= a.x + NODE_W / 2;
  const x1 = toRight ? a.x + NODE_W : a.x;
  const x2 = toRight ? b.x : b.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  const bulge = lane * 30;
  const mid = (x1 + x2) / 2;
  return {
    id,
    ...e,
    path: `M ${r(x1)} ${r(y1)} C ${r(mid)} ${r(y1 + bulge)}, ${r(mid)} ${r(y2 + bulge)}, ${r(x2)} ${r(y2)}`,
    labelX: mid,
    labelY: (y1 + y2) / 2 + bulge * 0.75,
    selfLoop: false,
  };
}

function selfLoop(id: string, e: RawEdge, a: LaidOutNode, lane: number): LaidOutEdge {
  const x = a.x + NODE_W;
  const y = a.y + NODE_H / 2;
  const radius = 30 + lane * 12;
  return {
    id,
    ...e,
    path: `M ${r(x)} ${r(y - 12)} C ${r(x + radius)} ${r(y - radius)}, ${r(x + radius)} ${r(y + radius)}, ${r(x)} ${r(y + 12)}`,
    labelX: x + radius + 6,
    labelY: y,
    selfLoop: true,
  };
}

/** Coordinate arrotondate: path piu' corti e nessun jitter subpixel. */
function r(n: number): number {
  return Math.round(n * 10) / 10;
}
