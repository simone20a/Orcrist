#!/usr/bin/env python3
"""
Builds every brand asset from one description of the mark.

Run it from anywhere:  python3 agent/brand/build.py

The wordmark's letters are emitted as outlines rather than as <text>, so the
logo renders the same everywhere and needs no font installed. The face is
Liberation Sans Bold, chosen by measurement rather than taste: its stem is
0.209 of its cap height and the mark's ring stroke is 0.219 of the ring's
height, so the letters and the O carry the same weight without adjustment.
"""

import subprocess
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent

# --- the mark -----------------------------------------------------------

# One vivid colour per palette, back to front. Violet leads because it is the
# one colour no theme uses as its field, so the front O reads on all six.
RINGS = [
    ("#fbba16", "marigold · yellow"),
    ("#9f3011", "meadow · burnt orange"),
    ("#a0151b", "seafoam · red"),
    ("#1e4380", "blush · blue"),
    ("#00492c", "pine · forest"),
    ("#52389c", "sage · violet"),
]
D, W_STROKE, STEP, ANGLE = 250, 70, 0.11, 200  # diameter, stroke, set-back, direction
VIOLET, INK, SAGE, WHITE = "#52389c", "#0c1410", "#b9d9c6", "#ffffff"


def ring_elements() -> str:
    import math

    rad = math.radians(ANGLE)
    s = STEP * D
    dx, dy = math.cos(rad) * s, math.sin(rad) * s
    n = len(RINGS)
    ox, oy = -dx * (n - 1) / 2, -dy * (n - 1) / 2
    out = []
    for i, (colour, name) in enumerate(RINGS):
        back = n - 1 - i
        cx, cy = 256 + ox + dx * back, 256 + oy + dy * back
        out.append(
            f'  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{D / 2:.1f}" fill="none" '
            f'stroke="{colour}" stroke-width="{W_STROKE}"/><!-- {name} -->'
        )
    return "\n".join(out)


# Measured off the rendered mark rather than assumed.
CLUSTER = dict(x0=31.0, y0=72.5, x1=481.0, y1=439.5)   # all six rings
FRONT = dict(x0=160.6, y0=119.5, x1=480.6, y1=439.5)   # the violet one alone

# --- the letters --------------------------------------------------------

FONT_FILE = subprocess.check_output(
    ["fc-match", "-f", "%{file}", "Liberation Sans:style=Bold"]
).decode()
FONT = TTFont(FONT_FILE)
GLYPHS = FONT.getGlyphSet()
CMAP = FONT.getBestCmap()
CAP = FONT["OS/2"].sCapHeight


def glyph(ch: str):
    gn = CMAP[ord(ch)]
    pen = SVGPathPen(GLYPHS)
    GLYPHS[gn].draw(pen)
    bounds = BoundsPen(GLYPHS)
    GLYPHS[gn].draw(bounds)
    return pen.getCommands(), FONT["hmtx"][gn][0], bounds.bounds


O_ADV, O_BB = glyph("O")[1], glyph("O")[2]


def wordmark(cap_px=200, letters=VIOLET, bg=None, tracking=0.0, bolden=0.035) -> str:
    """
    The mark standing in for the O of ORCRIST, the rest set as outlines.

    `bolden` thickens the letters past the weight the face ships with, as a
    share of the cap height, so they read a touch heavier than the ring that
    stands in for the O. It is done by stroking the outlines and shrinking
    them by the same amount first, so the letters gain weight without gaining
    height: a stroke grows a glyph in every direction, and an O next to
    letters a hair taller than itself is the one place that would show.
    """
    k = cap_px / CAP
    o_w, o_h = (O_BB[2] - O_BB[0]) * k, (O_BB[3] - O_BB[1]) * k
    s = o_h / (FRONT["y1"] - FRONT["y0"])
    ring_w = (FRONT["x1"] - FRONT["x0"]) * s
    # A ring is a circle and the font's O is slightly narrower: split the
    # difference rather than distorting either.
    x_o = O_BB[0] * k - (ring_w - o_w) / 2
    y_o = cap_px - O_BB[3] * k

    tail = (FRONT["x0"] - CLUSTER["x0"]) * s   # how far the echoes reach left
    top = (FRONT["y0"] - CLUSTER["y0"]) * s    # and above the cap line
    pad = cap_px * 0.30
    ox, oy = pad + tail, pad + top

    paths, pen, last_right = [], O_ADV + tracking * CAP, 0
    for ch in "RCRIST":
        d, adv, bb = glyph(ch)
        paths.append(f'<path d="{d}" transform="translate({pen:.1f} 0)"/>')
        last_right = pen + bb[2]
        pen += adv + tracking * CAP

    # the faux-bold: shrink by delta, then stroke by delta, so the outer
    # dimensions come back to where they were and only the stems grow
    delta = bolden * cap_px
    kb = k * (cap_px - delta) / cap_px
    stroke = f' stroke="{letters}" stroke-width="{delta / kb:.1f}" stroke-linejoin="round"' if delta else ""

    word_x = ox + x_o - O_BB[0] * k
    width = round(word_x + last_right * kb + pad)
    height = round(oy + cap_px + pad * 0.55)
    joined = ("\n    ").join(paths)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img" aria-label="Orcrist">
  <title>Orcrist</title>
{f'  <rect width="{width}" height="{height}" fill="{bg}"/>' if bg else ''}
  <g transform="translate({ox + x_o - FRONT['x0'] * s:.2f} {oy + y_o - FRONT['y0'] * s:.2f}) scale({s:.4f})">
{ring_elements()}
  </g>
  <g fill="{letters}"{stroke} transform="translate({word_x:.2f} {oy + cap_px - delta / 2:.2f}) scale({kb:.5f} -{kb:.5f})">
    {joined}
  </g>
</svg>
"""


# --- the marks and icons ------------------------------------------------

def mark(size=512) -> str:
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="Orcrist">
  <title>Orcrist</title>
{ring_elements()}
</svg>
"""


def icon(size=512, bg=SAGE, radius=0.225, fill=0.72, body=824 / 1024) -> str:
    """
    The app icon, on macOS's own grid: the coloured body is 824 of a 1024
    canvas with the rest transparent, which is what makes it the same size as
    every other icon in the dock and leaves the system room for its shadow. A
    full-bleed tile looks oversized next to them.

    `radius` is a share of the body, `fill` the share of the body's width the
    mark's ink occupies.
    """
    body_px = size * body
    off = (size - body_px) / 2
    ink_w = CLUSTER["x1"] - CLUSTER["x0"]
    s = fill * body_px / ink_w
    c = size / 2
    rx = f' rx="{body_px * radius:.1f}"' if radius else ""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}" role="img" aria-label="Orcrist">
  <title>Orcrist</title>
  <rect x="{off:.1f}" y="{off:.1f}" width="{body_px:.1f}" height="{body_px:.1f}"{rx} fill="{bg}"/>
  <g transform="translate({c:.1f} {c:.1f}) scale({s:.4f}) translate(-256 -256)">
{ring_elements()}
  </g>
</svg>
"""


if __name__ == "__main__":
    (ROOT / "orcrist-mark.svg").write_text(mark())
    (ROOT / "orcrist-icon.svg").write_text(icon())
    (ROOT / "orcrist-icon-square.svg").write_text(icon(radius=0))
    # The logo carries a white ground: it is read against documents and slides
    # more often than against the app, and white is the one field that belongs
    # to none of the six palettes, so it favours no theme over the others.
    (ROOT / "orcrist-logo.svg").write_text(wordmark(bg=WHITE))
    (ROOT / "orcrist-logo-sage.svg").write_text(wordmark(bg=SAGE))
    (ROOT / "orcrist-lockup.svg").write_text(wordmark(bg=None))
    print("wrote the SVGs; the PNGs are rendered from them")
