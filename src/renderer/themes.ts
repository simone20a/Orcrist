/**
 * The palettes.
 *
 * A theme is six values, one per role — see the block at the top of styles.css
 * for what each role means. Everything else in the stylesheet derives from
 * them, so a palette is swapped by writing six custom properties onto the root
 * element and nothing more.
 *
 * Mint, Wheat, Mist and Lilac come from a twelve-swatch board: four pale
 * fields, four near-black inks under them, four mid-tones under those. Field
 * and ink are the board's exactly, and they pair well — 8.9:1 at worst, 12:1
 * at best, which is what lets every mark in the app be ink rather than white.
 *
 * The mid-tones could not be used as they stand. They were drawn to sit on
 * white, and the app sets them as small text on a tinted field and on the
 * recessed surfaces derived from it, where they fell to 2.1–3.5:1. So each one
 * keeps its HUE and saturation and is moved along lightness until it clears
 * 4.5:1 on the recessed surface as well as on the field. The board's colour
 * relationships survive; what changes is that you can read a line of 13px
 * prose in them.
 *
 * The roles the mid-tones take are fixed across the four, because a colour
 * that means "this went well" in one palette cannot mean "attend to this" in
 * the next: the wine is always danger, the olive always warn, and the teal and
 * the periwinkle split accent between them.
 *
 * Marginalia is the exception, and it is allowed to be: the woodcut figures
 * carry no meaning, so each palette takes the mid-tone from its OWN column of
 * the board, at the board's value with no fitting at all. They sit between
 * 3.8:1 and 4.7:1 on their fields, which is more than a drawn line needs, and
 * it is what ties each palette back to the column it came from.
 *
 * Every value below was fitted by measurement rather than by eye, and the
 * contrast audit drives all eleven screens in each of them.
 */

export interface Theme {
  id: string;
  name: string;
  /** What the palette is built from — shown under the swatch. */
  note: string;
  brand: string;
  ink: string;
  accent: string;
  warn: string;
  danger: string;
  marginalia: string;
}

export const THEMES: Theme[] = [
  {
    id: 'sage',
    name: 'Sage',
    note: 'Near-black on pastel sage, at 12:1',
    brand: '#b9d9c6',
    ink: '#0c1410',
    accent: '#25533f',
    warn: '#63440e',
    danger: '#6d1f27',
    marginalia: '#52389c',
  },
  {
    id: 'mint',
    name: 'Mint',
    note: 'Pastel mint, near-black green ink at 12:1',
    brand: '#b8d7c7',
    ink: '#0a150f',
    accent: '#3d3761',
    warn: '#3a3f16',
    danger: '#5b2e39',
    marginalia: '#655ba0',
  },
  {
    id: 'wheat',
    name: 'Wheat',
    note: 'Wheat field, deepened brown ink',
    brand: '#d8cc98',
    ink: '#260e0c',
    accent: '#0e3e55',
    warn: '#373c15',
    danger: '#582d37',
    marginalia: '#535b20',
  },
  {
    id: 'mist',
    name: 'Mist',
    note: 'Pale blue field, violet-black ink',
    brand: '#b1c5cc',
    ink: '#171022',
    accent: '#0c374c',
    warn: '#313613',
    danger: '#4f2831',
    marginalia: '#763c4a',
  },
  {
    id: 'lilac',
    name: 'Lilac',
    note: 'Lilac field, navy-violet ink',
    brand: '#ccb2cd',
    ink: '#1d1635',
    accent: '#0c3447',
    warn: '#2e3212',
    danger: '#49252e',
    marginalia: '#135474',
  },
  {
    id: 'pine',
    name: 'Pine',
    note: 'The one that runs dark: yellow on forest',
    brand: '#00492c',
    ink: '#fde097',
    accent: '#b1d8b8',
    warn: '#fbba16',
    danger: '#e2b2b4',
    marginalia: '#e2b2b4',
  },
];

export const DEFAULT_THEME = THEMES[0].id;

const KEY = 'orcrist.theme';

export function themeById(id?: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** Writes a palette onto the root element. This is the whole mechanism. */
export function applyTheme(id?: string): void {
  const t = themeById(id);
  const root = document.documentElement.style;
  root.setProperty('--brand', t.brand);
  root.setProperty('--ink', t.ink);
  root.setProperty('--accent', t.accent);
  root.setProperty('--warn', t.warn);
  root.setProperty('--danger', t.danger);
  root.setProperty('--marginalia', t.marginalia);
  // Pine is a dark field; form controls and scrollbars take their cue from this.
  root.setProperty('color-scheme', t.id === 'pine' ? 'dark' : 'light');
}

/**
 * The saved choice lives in the settings file like every other preference, but
 * that arrives over IPC a moment after the window paints — long enough to see
 * the default flash past. So it is mirrored here and read synchronously at boot.
 */
export function rememberTheme(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* a missing mirror costs one frame, not correctness */
  }
}

export function bootTheme(): void {
  let id: string | null = null;
  try {
    id = window.localStorage.getItem(KEY);
  } catch {
    id = null;
  }
  applyTheme(id ?? DEFAULT_THEME);
}
