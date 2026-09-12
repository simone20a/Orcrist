/** Inline icons — no icon dependency, and they inherit the text colour. */

const base = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/** A panel with its right-hand column drawn out — "open the side drawer". */
export function PanelRightIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" />
      <path d="M10 2.6v10.8" />
    </svg>
  );
}

/** Two faders. Reads as "settings" at 16px in a way a wrench does not. */
export function SettingsIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M2.2 5.2h3.1M8.7 5.2h5.1M2.2 10.8h5.1M10.7 10.8h3.1" />
      <circle cx="7" cy="5.2" r="1.7" />
      <circle cx="9" cy="10.8" r="1.7" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M9.5 3.5L5 8l4.5 4.5" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M2.8 4.3h10.4M6.2 4.3V3a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.3M4.2 4.3l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2" />
    </svg>
  );
}

/**
 * The two composer marks: a triangle that plays and a square that stops.
 *
 * Both are solid, because at this size an outline reads as an empty box rather
 * than as a control, and both are drawn slightly inside the box so the triangle
 * — which has less area for the same bounding box — does not look smaller than
 * the square sitting in the same place a moment later.
 */
export function StopIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M3.6 2.6 L13.4 8 L3.6 13.4 Z" fill="currentColor" stroke="none" />
    </svg>
  );
}
