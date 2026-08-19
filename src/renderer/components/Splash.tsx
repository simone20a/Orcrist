// =====================================================================
// Schermata d'apertura: un nano parte per il viaggio.
//
// Cammina da sinistra verso destra su un sentiero, con lo zaino in
// spalla e la spada al fianco. Il marchio compare quando lui e' quasi
// al centro, cosi' l'occhio segue il movimento e trova la scritta
// dove il movimento si ferma.
//
// Lo sprite e' generato da scripts/make-sprites.py: si modifica li',
// non qui.
// =====================================================================

import { useEffect, useState } from 'react';
import { DWARF_PALETTE, DWARF_WALK } from '../pixel/dwarf.js';
import { PixelSprite } from '../pixel/PixelSprite.js';
import { PixelText } from '../pixel/PixelText.js';

const DURATION_MS = 3000;

export function Splash({ onDone }: { onDone: () => void }): JSX.Element {
  const [phase, setPhase] = useState<'walk' | 'settled'>('walk');

  useEffect(() => {
    const settle = setTimeout(() => setPhase('settled'), 1500);
    const done = setTimeout(onDone, DURATION_MS);
    return () => {
      clearTimeout(settle);
      clearTimeout(done);
    };
  }, [onDone]);

  return (
    <div className="splash" onClick={onDone} title="Click to skip">
      <div className="splash-scene">
        <div className="splash-sky" />
        <div className="splash-walker">
          <PixelSprite
            frames={DWARF_WALK}
            palette={DWARF_PALETTE}
            scale={5}
            fps={7}
            title="A dwarf on the move, with a backpack and sword"
          />
        </div>
        <div className="splash-path" />
      </div>

      <div className={`splash-mark${phase === 'settled' ? ' in' : ''}`}>
        <PixelText scale={6} color="#e8c06a" shadow="#6b4a13">
          Orcrist
        </PixelText>
        <span className="splash-tagline">State machines for coding agents</span>
      </div>
    </div>
  );
}
