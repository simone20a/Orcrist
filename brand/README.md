# The Orcrist mark

Six bold O's, one for each palette, each set back from the one in front of it
along a single direction. The ones at the back run off the frame, because the
frame is a window onto the stack rather than a box the mark has to fit inside.

## Why these six colours

Each ring takes the most chromatic seed of one theme, so the mark carries the
whole palette set rather than any single one of them:

| ring | colour | from |
| --- | --- | --- |
| back | `#fbba16` | marigold's field |
| | `#9f3011` | meadow's warn |
| | `#a0151b` | seafoam's danger |
| | `#1e4380` | blush's marginalia |
| | `#00492c` | pine's field |
| front | `#52389c` | sage's marginalia — the violet of the woodcut figures |

Violet is in front on purpose: it is the one colour no theme uses as its
field, so the leading O reads on all six grounds, including pine, where a
forest-green O would disappear. Forest sits directly behind it for the same
reason — on the pine field it merges into the ground, and the ring it merges
into is the one whose loss shows least.

## The geometry

A bold O is a ring whose stroke is roughly three tenths of its diameter — the
weight of a grotesque Black. The mark is:

- diameter 250 in a 512 box, stroke 70 (0.28 of the diameter)
- each ring set back by 11% of a diameter, at 200° — up and to the left
- the run of six centred in the box, so the mass sits square while the tail
  bleeds

## The files

| file | what it is for |
| --- | --- |
| `orcrist-mark.svg` | the mark. Transparent, so it sits on whatever field the app is wearing |
| `orcrist-mark-small.svg` | three O's, a wider counter, a bigger step — for 24px and below, where six counters fill in and the mark turns into a dot |
| `orcrist-lockup.svg` | the logo with no field behind it, for a ground of its own |
| `orcrist-mark-*.png` | transparent rasters. 1024–64 are the full mark; 32 and 16 are the small one |

The mark's SVGs are six one-line `<circle>` elements: nothing to redraw if a
palette changes, just the hex in the ring that came from it.

## The primary logo

`orcrist-logo.svg` / `.png` — the logo on white. This is the one to reach for
first: the top of a README, a title slide, anywhere the logo is being shown
rather than used as a UI element. White is the one ground that belongs to none
of the six palettes, so it favours no theme over the others, and it is what the
logo is read against in documents. `orcrist-logo-sage.*` is the same on the
default palette's field, for when it sits inside the app's own world.

**The mark is the O.** It does not sit beside the word; it stands in for the
first letter, in the place and at the size that letter would have occupied —
the front ring's ink box is mapped onto the O's ink box, overshoot included, so
it sits on the baseline the way a round letter does. The echoes then fall into
the left margin, which is where the colour belongs: outside the reading.

The remaining letters are the violet of the front ring, `#52389c`, and sit a
touch heavier than the O: the ring's stroke is 0.219 of its height, and the
letters' stems are taken from the face's own 0.209 to 0.236 of their cap
height. The face has no weight between Bold and nothing, so the extra comes
from stroking the outlines — and the outlines are shrunk by exactly the stroke
first, so the letters gain weight without gaining height. A stroke grows a
glyph in every direction, and an O standing beside letters a hair taller than
itself is the one place that would show.

They are emitted as **outlines, not `<text>`** — a logo whose letterforms
depend on the fonts installed on the reader's machine is not a logo. The face
is Liberation Sans Bold, picked by that stem measurement rather than by taste;
it is metric-compatible with Arial and sits in the same grotesque family as the
app's own type.

`build.py` regenerates every SVG here from one description of the mark. Run it
from the repo root; it needs `fonttools` and Liberation Sans installed. The
PNGs are rendered from the SVGs.

## The app icon

`orcrist-icon.svg` and `orcrist-icon-*.png` put the mark on the sage field in a
rounded tile, on macOS's own icon grid: the coloured body is 824 of a 1024
canvas and the rest is transparent, which is what makes it the same size as
every other icon in the dock and leaves the system room for its shadow. A
full-bleed tile looks oversized beside them. The mark fills 72% of the body's
width. `orcrist-icon-square.*` is the same without the corner radius, for
platforms that apply their own mask.

One trap worth writing down: rendering these with `chrome --headless
--screenshot` and a window exactly the size of the image silently cuts the page
short — the first icons came out 1024 × 937, and macOS then stretched that into
the dock square, which is why they arrived oversized and flat-bottomed. Render
into a larger window and crop back.

`../build/icon.png` is a copy of the 1024 icon and is what the app loads:
the window icon on Windows and Linux, and the dock icon on macOS, which ignores
the window's icon and takes the bundle's — so a development run sets it on the
dock explicitly. `../src/renderer/public/icon.svg` is the same mark as the
renderer's favicon.
