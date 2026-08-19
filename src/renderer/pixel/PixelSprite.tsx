// =====================================================================
// Disegno di uno sprite su canvas.
//
// Canvas e non SVG: uno sprite di trenta per trentaquattro sono
// centinaia di rettangoli, e ridisegnarli come nodi del DOM a sei
// fotogrammi al secondo fa lavorare il browser per niente. Qui ogni
// fotogramma e' un ciclo di fillRect su una superficie sola.
//
// La canvas viene allocata alla risoluzione fisica dello schermo e
// scalata via CSS: senza, su un display a densita' doppia i pixel
// dello sprite vengono interpolati e l'effetto si perde.
// =====================================================================

import { useEffect, useRef } from 'react';

interface Props {
  /** fotogrammi, ciascuno un elenco di righe di caratteri */
  frames: string[][];
  palette: Record<string, string>;
  /** quanti pixel a schermo per ogni pixel dello sprite */
  scale?: number;
  fps?: number;
  /** fermo sul primo fotogramma quando falso */
  playing?: boolean;
  /** ribalta orizzontalmente: il nano guarda a sinistra */
  flip?: boolean;
  className?: string;
  title?: string;
}

export function PixelSprite({
  frames,
  palette,
  scale = 4,
  fps = 6,
  playing = true,
  flip = false,
  className,
  title,
}: Props): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const frameIndex = useRef(0);

  const rows = frames[0]?.length ?? 0;
  const cols = frames[0]?.[0]?.length ?? 0;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !rows || !cols) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const px = scale * dpr;
    canvas.width = cols * px;
    canvas.height = rows * px;

    const draw = (index: number): void => {
      const frame = frames[index % frames.length];
      if (!frame) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let y = 0; y < frame.length; y++) {
        const line = frame[y];
        for (let x = 0; x < line.length; x++) {
          const colour = palette[line[x]];
          if (!colour) continue;
          const dx = flip ? cols - 1 - x : x;
          ctx.fillStyle = colour;
          ctx.fillRect(dx * px, y * px, px, px);
        }
      }
    };

    draw(frameIndex.current);
    if (!playing || frames.length < 2) return;

    const timer = setInterval(() => {
      frameIndex.current = (frameIndex.current + 1) % frames.length;
      draw(frameIndex.current);
    }, Math.max(60, 1000 / fps));
    return () => clearInterval(timer);
  }, [frames, palette, scale, fps, playing, flip, rows, cols]);

  return (
    <canvas
      ref={ref}
      className={className}
      role="img"
      aria-label={title}
      style={{
        width: cols * scale,
        height: rows * scale,
        imageRendering: 'pixelated',
        display: 'block',
      }}
    />
  );
}
