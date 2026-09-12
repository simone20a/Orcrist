/**
 * Decorative marginalia: small figures in an early-modern woodcut idiom that
 * stand in the empty parts of the layout and face the part of the interface
 * that matters near them. They carry no message, take no clicks, and are not
 * announced to a screen reader.
 *
 * They are drawn as silhouettes filled with a hatch pattern rather than as
 * bundles of individual strokes, because at the size they are used — about a
 * tenth of the window — what reads is the outline and the texture, not the
 * detail. Anything finer would be wasted on the pixel grid.
 */

import { useId } from 'react';

/**
 * Three, always the same three: they are the app's mascots, not a pool to draw
 * from. A cast that changes screen to screen reads as decoration that has not
 * been thought about.
 */
export type FigureName = 'elder' | 'cloaked' | 'grotesque';

/**
 * Kept as a no-op so callers need not care: the patterns used to live here, but
 * a pattern shared across separate <svg> elements resolves `currentColor`
 * against the element that *defines* it, not the one that uses it, so every
 * figure came out unfilled. Each figure now carries its own defs.
 */
export function FigureDefs() {
  return null;
}

function Defs({ uid }: { uid: string }) {
  return (
    <defs>
      {/* The figures render at about half the viewBox, so every line here is
          drawn at roughly twice the weight it should finally appear at. */}
      <pattern id={`${uid}-h`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
        <line x1="0" y1="0" x2="0" y2="9" stroke="currentColor" strokeWidth="2.6" />
      </pattern>
      <pattern id={`${uid}-hd`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(38)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2.4" />
      </pattern>
      <pattern id={`${uid}-hc`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(20)">
        <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="2.2" />
        <line x1="0" y1="0" x2="8" y2="0" stroke="currentColor" strokeWidth="2.2" />
      </pattern>
    </defs>
  );
}

interface Ink {
  uid: string;
}

const fills = (uid: string) => ({
  H: `url(#${uid}-h)`,
  HD: `url(#${uid}-hd)`,
  HC: `url(#${uid}-hc)`,
});

/** The scrap of ground every figure stands on, with a few weeds. */
function Ground({ w }: { w: number }) {
  const c = w / 2;
  return (
    <g>
      <path
        d={`M ${c - 40},190 C ${c - 22},183 ${c + 20},183 ${c + 40},190 C ${c + 20},194 ${c - 22},194 ${c - 40},190 Z`}
        fill="none"
      />
      <path d={`M ${c - 44},190 C ${c - 22},182 ${c + 22},182 ${c + 44},190`} fill="none" />
      <path d={`M ${c - 36},190 C ${c - 38},180 ${c - 34},174 ${c - 31},170`} fill="none" />
      <path d={`M ${c - 33},190 C ${c - 31},181 ${c - 27},177 ${c - 24},174`} fill="none" />
      <path d={`M ${c + 32},190 C ${c + 35},180 ${c + 33},174 ${c + 30},169`} fill="none" />
      <path d={`M ${c + 36},190 C ${c + 38},182 ${c + 42},178 ${c + 44},176`} fill="none" />
      <path d={`M ${c + 27},189 C ${c + 26},183 ${c + 22},180 ${c + 19},178`} fill="none" />
    </g>
  );
}

function Elder({ uid }: Ink) {
  const { H, HD } = fills(uid);
  return (
    <g>
      <Ground w={100} />
      {/* staff */}
      <path d="M 83,50 C 82,96 80,146 78,188" fill="none" strokeWidth="2.6" />
      <path d="M 79,50 C 83,46 87,48 87,52 C 87,55 84,57 81,55" fill="none" />
      {/* robe */}
      <path d="M 41,66 C 31,96 25,142 23,187 L 67,187 C 67,142 62,96 56,66 Z" fill={H} />
      {/* hem shadow */}
      <path d="M 24,178 C 38,173 54,173 66,178" fill="none" />
      {/* cloak over the shoulders */}
      <path
        d="M 36,60 C 41,49 59,49 64,60 C 71,72 73,90 71,104 C 61,94 41,94 33,104 C 31,88 31,70 36,60 Z"
        fill={HD}
      />
      {/* arm reaching the staff */}
      <path d="M 68,92 C 77,85 81,68 82,55" fill="none" strokeWidth="2.2" />
      {/* head, cap, beard */}
      <path d="M 41,38 C 41,27 59,27 59,38 C 59,49 53,55 50,55 C 47,55 41,49 41,38 Z" fill="none" />
      <path d="M 38,36 C 38,22 63,21 62,35 C 55,29 45,29 38,36 Z" fill={HD} />
      <path d="M 42,45 C 43,63 57,63 58,45 C 55,56 45,56 42,45 Z" fill={H} />
      <path d="M 46,38 l 2,0" fill="none" />
      <path d="M 53,38 l 2,0" fill="none" />
    </g>
  );
}

function Cloaked({ uid }: Ink) {
  const { HD } = fills(uid);
  return (
    <g>
      <Ground w={100} />
      <path
        d="M 50,16 C 35,20 29,33 30,46 C 23,82 18,142 16,178 L 84,178 C 82,142 77,82 70,46 C 71,33 65,20 50,16 Z"
        fill={HD}
      />
      {/* the hem, ruled the other way */}
      <path d="M 16,178 L 84,178 L 83,188 L 17,188 Z" fill="none" />
      <path d="M 25,178 L 25,188 M 34,178 L 34,188 M 43,178 L 43,188 M 52,178 L 52,188 M 61,178 L 61,188 M 70,178 L 70,188" fill="none" />
      {/* the sliver of a face */}
      <path d="M 44,33 C 48,28 57,29 60,36 C 55,41 47,40 44,33 Z" fill="none" strokeWidth="2.2" />
      <path d="M 47,34 C 50,32 54,33 56,36" fill="none" />
    </g>
  );
}

function Grotesque({ uid }: Ink) {
  const { H, HD } = fills(uid);
  return (
    <g>
      <Ground w={130} />
      {/* the two great drooping lobes, well clear of the body on each side */}
      <path
        d="M 54,70 C 34,60 12,74 8,104 C 4,136 18,166 40,172 C 44,140 48,102 54,70 Z"
        fill={H}
      />
      <path d="M 30,92 C 26,116 28,144 36,164" fill="none" strokeWidth="2" />
      <path
        d="M 76,70 C 96,60 118,74 122,104 C 126,136 112,166 90,172 C 86,140 82,102 76,70 Z"
        fill={H}
      />
      <path d="M 100,92 C 104,116 102,144 94,164" fill="none" strokeWidth="2" />
      {/* the narrow body between them */}
      <path
        d="M 56,64 C 50,92 52,132 58,166 C 61,180 69,180 72,166 C 78,132 80,92 74,64 Z"
        fill={HD}
      />
      {/* the shaggy crest */}
      <path
        d="M 65,10 C 44,20 34,42 38,64 C 48,54 82,54 92,64 C 96,42 86,20 65,10 Z"
        fill={HD}
      />
      <path d="M 44,26 l -7,-9 M 56,17 l -4,-11 M 74,17 l 4,-11 M 86,26 l 7,-9" fill="none" strokeWidth="2" />
      {/* the single eye */}
      <path d="M 46,42 C 54,30 76,30 84,42 C 76,54 54,54 46,42 Z" fill="none" strokeWidth="2.6" />
      <circle cx="65" cy="42" r="6.5" fill="currentColor" stroke="none" />
      {/* the mouth, under the crest */}
      <path d="M 52,68 C 60,62 70,62 78,68 C 70,76 60,76 52,68 Z" fill="none" strokeWidth="2.4" />
      <path d="M 58,65 L 58,72 M 65,63 L 65,73 M 72,65 L 72,72" fill="none" strokeWidth="2" />
      {/* stubby legs */}
      <path d="M 60,172 L 58,188 M 70,172 L 72,188" fill="none" strokeWidth="2.6" />
      <path d="M 52,188 L 64,188 M 66,188 L 78,188" fill="none" strokeWidth="2.6" />
    </g>
  );
}

const FIGURES: Record<FigureName, { Body: (p: Ink) => JSX.Element; w: number }> = {
  elder: { Body: Elder, w: 100 },
  cloaked: { Body: Cloaked, w: 100 },
  grotesque: { Body: Grotesque, w: 130 },
};

/** The cast, in the order they always stand. */
export const MASCOTS: FigureName[] = ['elder', 'cloaked', 'grotesque'];

interface Props {
  name: FigureName;
  /** Mirror it, so it faces the other way. */
  flip?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function Figure({ name, flip, className, style }: Props) {
  const f = FIGURES[name];
  // one set of pattern ids per instance, so two figures on a screen cannot
  // collide over the same id
  const uid = useId().replace(/:/g, '');
  return (
    <svg
      className={`deco ${className ?? ''}`}
      style={{ ...style, transform: flip ? 'scaleX(-1)' : undefined }}
      viewBox={`0 0 ${f.w} 200`}
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Defs uid={uid} />
      <f.Body uid={uid} />
    </svg>
  );
}
