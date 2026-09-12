// Renders a validated .orc to standalone SVG for use as a figure.
//
// The layout comes from the app's own engine, so the node placement here is the
// placement the app computes. The drawing is not the app's: the in-app diagram
// is a "where am I" indicator and draws every edge as a direct curve, which is
// fine at thumbnail size against a live highlight, and unreadable as a printed
// figure the moment an edge spans several ranks and cuts through the boxes in
// between. So edges that skip a rank are routed into a lane above the diagram,
// and boxes are widened to fit their own labels.
const fs = require('node:fs');
const {
  checkModel,
  layoutMachine,
  drawingBounds,
} = require('/home/claude/orcrist/agent/dist/main/src/orcrist');

const INK = '#0c1410';
const FIELD = '#b9d9c6';
const INK3 = 'rgba(12,20,16,0.72)';
const FONT = 'ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Bold 12.5px sans is about 0.60em per character for mixed-case names. */
const textWidth = (s) => s.length * 7.5;

function render(src) {
  const r = checkModel(src);
  if (r.errors.length) throw new Error('invalid model: ' + r.errors[0].message);
  const m = r.machine;

  const nodeW = Math.max(108, ...m.states.map((s) => textWidth(s.name) + 26));
  const nodeH = 34;
  const layout = layoutMachine(m, { col: nodeW + 66, row: 80, nodeW, nodeH, pad: 30 });
  const W = layout.nodeW;
  const H = layout.nodeH;
  const by = new Map(layout.nodes.map((n) => [n.name, n]));

  // how far above the tallest node the skip-lanes go
  const skips = layout.edges.filter((e) => {
    const f = by.get(e.from);
    const t = by.get(e.to);
    return f && t && !e.selfLoop && !e.backEdge && t.rank - f.rank > 1;
  });
  const laneOf = new Map();
  skips
    .slice()
    .sort((a, b) => {
      const sa = by.get(a.to).rank - by.get(a.from).rank;
      const sb = by.get(b.to).rank - by.get(b.from).rank;
      return sb - sa;
    })
    .forEach((e, i) => laneOf.set(e, i));
  const topY = Math.min(...layout.nodes.map((n) => n.y));
  const laneY = (e) => topY - 26 - laneOf.get(e) * 20;

  // drawingBounds reserves the back-edge room below the *lowest node*, which is
  // right for the app's thumbnail and wrong here: the dip hangs under the loop,
  // while the lowest node is usually a final state off to the side, so the
  // reservation lands under empty space and the figure gets a dead band. Measure
  // what is actually drawn instead.
  const b = drawingBounds(layout, { selfLoop: 34, backEdge: 0, below: 0, left: 34 });
  const bottoms = layout.nodes.map(
    (n) => n.y + H + (m.states.find((s) => s.name === n.name)?.limit ? 20 : 6),
  );
  for (const e of layout.edges) {
    if (!e.backEdge) continue;
    const f = by.get(e.from);
    const t = by.get(e.to);
    if (f && t) bottoms.push(Math.max(f.y, t.y) + H + 48 + 6);
  }
  b.h = Math.max(...bottoms) - b.y;
  if (skips.length) {
    const highest = Math.min(...skips.map(laneY));
    b.h += b.y - (highest - 12);
    b.y = highest - 12;
  }

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x.toFixed(1)} ${b.y.toFixed(1)} ` +
      `${b.w.toFixed(1)} ${b.h.toFixed(1)}" width="100%" ` +
      `style="max-width:${Math.round(b.w)}px;height:auto;display:block;margin:0 auto" ` +
      `role="img" aria-label="State machine ${esc(m.name)}">`,
  );
  const arw = `a-${m.name}`;
  parts.push(
    `<defs><marker id="${arw}" viewBox="0 0 7 7" refX="6.5" refY="3.5" markerWidth="4.2" ` +
      `markerHeight="4.2" markerUnits="userSpaceOnUse" orient="auto">` +
      `<path d="M0,0 L7,3.5 L0,7 z" fill="${INK}"/></marker></defs>`,
  );

  for (const e of layout.edges) {
    const from = by.get(e.from);
    const to = by.get(e.to);
    if (!from || !to) continue;

    let d;
    if (e.selfLoop) {
      const x = from.x + W / 2;
      const y = from.y;
      d = `M ${x - 18} ${y} C ${x - 26} ${y - 30}, ${x + 26} ${y - 30}, ${x + 16} ${y - 1}`;
    } else if (e.backEdge) {
      const x1 = from.x + W / 2;
      const y1 = from.y + H;
      const x2 = to.x + W / 2;
      const y2 = to.y + H;
      const dip = Math.max(y1, y2) + 48;
      d = `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2 + 1}`;
    } else if (laneOf.has(e)) {
      // Over the top and down the gutter to the left of the target, rather than
      // through everything in between. It leaves from right of centre so it
      // clears the state's own `limit` caption, and enters the target from the
      // side, because coming straight down would cross whatever else shares
      // that column.
      const x1 = from.x + W * 0.85;
      const ly = laneY(e);
      const gx = to.x - 24;
      const ty = to.y + H / 2;
      const c = 8;
      d =
        `M ${x1} ${from.y} L ${x1} ${ly + c} Q ${x1} ${ly} ${x1 + c} ${ly} ` +
        `L ${gx - c} ${ly} Q ${gx} ${ly} ${gx} ${ly + c} ` +
        `L ${gx} ${ty - c} Q ${gx} ${ty} ${gx + c} ${ty} L ${to.x - 2} ${ty}`;
    } else {
      const x1 = from.x + W;
      const y1 = from.y + H / 2;
      const x2 = to.x;
      const y2 = to.y + H / 2;
      const mid = (x1 + x2) / 2;
      d = `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 2} ${y2}`;
    }

    // The spine of the process is drawn at full weight; the `limit` escape
    // hatches are real edges but they are not what the reader is following, so
    // they recede rather than competing with it.
    const dash = e.kind === 'otherwise' ? ' stroke-dasharray="4 3"' : '';
    const limit = e.kind === 'limit';
    parts.push(
      `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${limit ? 0.9 : 1.4}"` +
        `${dash}${limit ? ' stroke-opacity="0.28"' : ''} marker-end="url(#${arw})"/>`,
    );
  }

  for (const n of layout.nodes) {
    const state = m.states.find((s) => s.name === n.name);
    if (n.initial) {
      parts.push(`<circle cx="${n.x - 15}" cy="${n.y + H / 2}" r="4.5" fill="${INK}"/>`);
      parts.push(
        `<path d="M ${n.x - 10} ${n.y + H / 2} L ${n.x - 1} ${n.y + H / 2}" stroke="${INK}" ` +
          `stroke-width="1.4" marker-end="url(#${arw})"/>`,
      );
    }
    parts.push(
      `<rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="${n.final ? 17 : 8}" ` +
        `fill="${n.final ? INK : FIELD}" stroke="${INK}" stroke-width="1.7"/>`,
    );
    parts.push(
      `<text x="${n.x + W / 2}" y="${n.y + H / 2 + 4.5}" text-anchor="middle" ` +
        `font-family="${FONT}" font-size="12.5" font-weight="700" ` +
        `fill="${n.final ? FIELD : INK}">${esc(n.name)}</text>`,
    );
    if (state && state.limit) {
      parts.push(
        // left-aligned under the node: a centred caption is wider than the box
        // and runs under whatever lane leaves from the top-right corner
        `<text x="${n.x}" y="${n.y + H + 14}" text-anchor="start" ` +
          `font-family="${MONO}" font-size="9" fill="${INK3}">` +
          `≤ ${state.limit.maxVisits} visits → ${esc(state.limit.onExceeded)}</text>`,
      );
    }
  }

  parts.push('</svg>');
  return { svg: parts.join('\n'), machine: m, warnings: r.warnings, layout };
}

module.exports = { render };

if (require.main === module) {
  const [, , inFile, outFile] = process.argv;
  const { svg, machine, layout } = render(fs.readFileSync(inFile, 'utf8'));
  fs.writeFileSync(outFile, svg);
  console.log(
    `${machine.name}: ${layout.nodes.length} nodes, ${layout.edges.length} edges -> ${outFile}`,
  );
}
