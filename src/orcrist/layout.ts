/**
 * Auto-layout for the FSM thumbnail: a layered left-to-right placement, ranked
 * by distance from the initial state. Deliberately coarse — the thumbnail is a
 * "where am I in the machine" indicator, not a diagram editor.
 */

import type { Machine } from './ast';
import { findState, initialState, successors } from './ast';

export interface LayoutNode {
  name: string;
  x: number;
  y: number;
  rank: number;
  initial: boolean;
  final: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  kind: 'guard' | 'otherwise' | 'limit';
  label: string;
  selfLoop: boolean;
  backEdge: boolean;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  /** The node box size this layout was spaced for. */
  nodeW: number;
  nodeH: number;
}

export interface LayoutOptions {
  /** Horizontal distance between ranks. */
  col?: number;
  /** Vertical distance between siblings in a rank. */
  row?: number;
  pad?: number;
  nodeW?: number;
  nodeH?: number;
}

/** Thumbnail-sized defaults; the preview dialog passes larger ones. */
const DEFAULTS = { col: 92, row: 46, pad: 26, nodeW: 62, nodeH: 20 };

export function layoutMachine(machine: Machine, opts: LayoutOptions = {}): Layout {
  const { col: COL, row: ROW, pad: PAD, nodeW, nodeH } = { ...DEFAULTS, ...opts };
  const start = initialState(machine);
  const ranks = new Map<string, number>();

  if (start) {
    // longest-path ranking over forward edges only, so loops don't push a state
    // arbitrarily far right
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [start.name];
    ranks.set(start.name, 0);
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      order.push(n);
      const s = findState(machine, n);
      if (!s) continue;
      for (const t of successors(s)) {
        const r = (ranks.get(n) ?? 0) + 1;
        if (!ranks.has(t) || ranks.get(t)! < r) {
          if (!seen.has(t)) ranks.set(t, Math.max(ranks.get(t) ?? 0, r));
        }
        queue.push(t);
      }
    }
  }
  // any state the walk missed (unreachable, but a draft can be) goes last
  let maxRank = 0;
  for (const r of ranks.values()) maxRank = Math.max(maxRank, r);
  for (const s of machine.states) {
    if (!ranks.has(s.name)) ranks.set(s.name, ++maxRank);
  }
  // final states are pushed to the right edge so the machine reads as a flow
  const lastRank = Math.max(...[...ranks.values()], 0);
  for (const s of machine.states) {
    if (s.final) ranks.set(s.name, lastRank);
  }

  const byRank = new Map<number, string[]>();
  for (const s of machine.states) {
    const r = ranks.get(s.name)!;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(s.name);
  }

  const rankKeys = [...byRank.keys()].sort((a, b) => a - b);
  const maxCol = Math.max(...rankKeys.map((r) => byRank.get(r)!.length), 1);
  const height = PAD * 2 + (maxCol - 1) * ROW;

  const nodes: LayoutNode[] = [];
  rankKeys.forEach((r, ri) => {
    const names = byRank.get(r)!;
    names.forEach((name, i) => {
      const s = findState(machine, name)!;
      const colHeight = (names.length - 1) * ROW;
      nodes.push({
        name,
        x: PAD + ri * COL,
        y: height / 2 - colHeight / 2 + i * ROW,
        rank: r,
        initial: s.initial,
        final: s.final,
      });
    });
  });

  const edges: LayoutEdge[] = [];
  for (const s of machine.states) {
    const fromRank = ranks.get(s.name)!;
    const push = (to: string, kind: LayoutEdge['kind'], label: string) => {
      const toRank = ranks.get(to);
      edges.push({
        from: s.name,
        to,
        kind,
        label,
        selfLoop: to === s.name,
        backEdge: toRank !== undefined && toRank <= fromRank && to !== s.name,
      });
    };
    for (const t of s.transitions) push(t.target, 'guard', 'on');
    if (s.fallback) push(s.fallback.target, 'otherwise', 'otherwise');
    if (s.limit) push(s.limit.onExceeded, 'limit', `limit ${s.limit.maxVisits}`);
  }

  return {
    nodes,
    edges,
    width: PAD * 2 + (rankKeys.length - 1) * COL,
    height,
    nodeW,
    nodeH,
  };
}

/**
 * The box the drawing actually occupies, including the room the self-loop arcs
 * above and the back-edge arcs below need. Sizing the viewBox from the layout's
 * nominal width and height instead leaves a band of dead space under the
 * diagram, because ranks are centred and rarely all full.
 */
export function drawingBounds(
  layout: Layout,
  extra: { selfLoop: number; backEdge: number; below: number; left: number } = {
    selfLoop: 26,
    backEdge: 34,
    below: 0,
    left: 20,
  },
): { x: number; y: number; w: number; h: number } {
  if (!layout.nodes.length) return { x: 0, y: 0, w: 10, h: 10 };
  const hasSelfLoop = layout.edges.some((e) => e.selfLoop);
  const hasBackEdge = layout.edges.some((e) => e.backEdge);
  const xs = layout.nodes.map((n) => n.x);
  const ys = layout.nodes.map((n) => n.y);
  const margin = 6;

  const x = Math.min(...xs) - extra.left;
  const y = Math.min(...ys) - (hasSelfLoop ? extra.selfLoop : margin);
  const right = Math.max(...xs) + layout.nodeW + margin;
  const bottom =
    Math.max(...ys) + layout.nodeH + extra.below + (hasBackEdge ? extra.backEdge : margin);
  return { x, y, w: right - x, h: bottom - y };
}
