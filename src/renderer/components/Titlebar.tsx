import type { ReactNode } from 'react';
import { PixelText } from '../pixel/PixelText.js';

interface Props {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  children?: ReactNode;
}

export function Titlebar({ title, subtitle, left, children }: Props): JSX.Element {
  const isMac = window.platform?.os === 'darwin';
  return (
    <div className={`titlebar${isMac ? ' mac' : ''}`}>
      {left}
      {subtitle && <span className="sub">{subtitle}</span>}
      <div className="spacer" />
      {children}

      {/* Fuori dal flusso e centrato sulla barra: in mezzo agli altri
          elementi finirebbe dove capita, perche' a sinistra e a destra
          non c'e' lo stesso ingombro. Non intercetta il puntatore, cosi'
          la zona di trascinamento della finestra passa attraverso. */}
      <span className="brand" aria-hidden="true">
        <PixelText scale={2} color="#e8c06a" shadow="#5c3f10">
          {title}
        </PixelText>
      </span>
    </div>
  );
}
