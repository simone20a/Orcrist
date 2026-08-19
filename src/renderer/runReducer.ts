// =====================================================================
// Riduttore lato renderer: la stessa logica del main, ma immutabile
// perche' React possa accorgersi dei cambiamenti.
// =====================================================================

import type { RunEvent, RunSnapshot } from '../shared/protocol.js';
import { applyEvent } from '../shared/reduce.js';

export function applySnapshotEvent(prev: RunSnapshot, event: RunEvent): RunSnapshot {
  const next: RunSnapshot = {
    ...prev,
    store: { ...prev.store },
    visitCounts: { ...prev.visitCounts },
    traces: Object.fromEntries(
      Object.entries(prev.traces).map(([k, t]) => [
        k,
        // le voci del registro vengono mutate sul posto dal riduttore
        // (l'esito di un tool arriva dopo la chiamata), quindi vanno
        // copiate anche loro, non solo l'array che le contiene
        {
          visits: t.visits.map((v) => ({
            ...v,
            activity: v.activity.map((a) => ({ ...a })),
          })),
        },
      ]),
    ),
    violations: [...prev.violations],
    pendingAsk: prev.pendingAsk ? { ...prev.pendingAsk } : undefined,
  };
  applyEvent(next, event);
  return next;
}
