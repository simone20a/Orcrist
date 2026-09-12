import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * A right-click menu. It floats over whatever you were reading, so — like the
 * diagram tooltip and the toast — it is one of the few things allowed to carry
 * its own ground.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // keep it on screen when opened near an edge
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, window.innerWidth - r.width - 8),
      top: Math.min(y, window.innerHeight - r.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    // Capture phase runs from the window down, so it fires before the event
    // ever reaches the menu — stopPropagation on the item would be too late.
    // Without this guard the menu unmounts on mousedown and the click that
    // follows lands on nothing, which is why Rename and Delete did nothing.
    const close = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close, true);
    window.addEventListener('contextmenu', close, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('contextmenu', close, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      className="ctx"
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      role="menu"
    >
      {items.map((it) => (
        <button
          key={it.label}
          className={`ctx-item ${it.danger ? 'danger' : ''}`}
          role="menuitem"
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
