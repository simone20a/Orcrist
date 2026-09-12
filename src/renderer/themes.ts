/**
 * The palettes.
 *
 * A theme is six values, one per role — see the block at the top of styles.css
 * for what each role means. Everything else in the stylesheet derives from
 * them, so a palette is swapped by writing six custom properties onto the root
 * element and nothing more.
 *
 * The four Flavour palettes take their fields straight from a brand board of
 * complementary pairs. The pairs themselves could not be used as-is: that board
 * sets a huge display logotype in the partner colour, where 3:1 is enough, and
 * red on that teal is 2.67:1 — fine for a wordmark, unreadable for a 13px line
 * of prose. So each field keeps the board colour exactly and the ink keeps the
 * partner's HUE, moved along lightness until the muted forms the app derives
 * from it still clear 4.5:1. The pairing still reads as teal-and-red; it is
 * just a red you can read a paragraph in.
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
    id: 'marigold',
    name: 'Marigold',
    note: 'Yellow field, deepened green ink',
    brand: '#fbba16',
    ink: '#002617',
    accent: '#00492c',
    warn: '#932d10',
    danger: '#a0151b',
    marginalia: '#1e4380',
  },
  {
    id: 'seafoam',
    name: 'Seafoam',
    note: 'Pale blue field, deepened red ink',
    brand: '#9bccd0',
    ink: '#500a0d',
    accent: '#00492c',
    warn: '#922c10',
    danger: '#9e151a',
    marginalia: '#1e4380',
  },
  {
    id: 'blush',
    name: 'Blush',
    note: 'Pink field, deepened navy ink',
    brand: '#e2b2b4',
    ink: '#0c1a32',
    accent: '#00492c',
    warn: '#8b2a0f',
    danger: '#971419',
    marginalia: '#1e4380',
  },
  {
    id: 'meadow',
    name: 'Meadow',
    note: 'Pale green field, deepened orange ink',
    brand: '#b1d8b8',
    ink: '#481608',
    accent: '#00492c',
    warn: '#9f3011',
    danger: '#ad161d',
    marginalia: '#1e4380',
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
