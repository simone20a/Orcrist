// =====================================================================
// Scritte in pixel art, dal font bitmap.
//
// Il testo vero resta selezionabile e leggibile dai lettori di
// schermo: la canvas porta un aria-label con la stringa originale.
// =====================================================================

import { useEffect, useRef } from 'react';
import { FONT, GLYPH_H, GLYPH_W, measure } from './font.js';

interface Props {
  children: string;
  /** quanti pixel a schermo per ogni pixel del carattere */
  scale?: number;
  color?: string;
  /** seconda passata sfalsata di un pixel, per un rilievo inciso */
  shadow?: string;
  tracking?: number;
  className?: string;
}

export function PixelText({
  children,
  scale = 3,
  color = '#e8c06a',
  shadow,
  tracking = 1,
  className,
}: Props): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const text = children.toUpperCase();

  const cols = measure(text, tracking);
  const rows = GLYPH_H + (shadow ? 1 : 0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || cols === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const px = scale * dpr;
    canvas.width = cols * px;
    canvas.height = rows * px;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const paint = (fill: string, dx: number, dy: number): void => {
      ctx.fillStyle = fill;
      let cursor = 0;
      for (const ch of text) {
        const glyph = FONT[ch] ?? FONT[' '];
        for (let y = 0; y < glyph.length; y++) {
          const line = glyph[y];
          for (let x = 0; x < line.length; x++) {
            if (line[x] !== '#') continue;
            ctx.fillRect((cursor + x + dx) * px, (y + dy) * px, px, px);
          }
        }
        cursor += GLYPH_W + tracking;
      }
    };

    if (shadow) paint(shadow, 0, 1);
    paint(color, 0, 0);
  }, [text, scale, color, shadow, tracking, cols, rows]);

  return (
    <canvas
      ref={ref}
      className={className}
      role="img"
      aria-label={children}
      style={{
        width: cols * scale,
        height: rows * scale,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}
