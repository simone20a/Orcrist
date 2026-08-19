// =====================================================================
// Specchio locale della corsa.
//
// La verita' sta nel main; qui si tiene una copia aggiornata dagli
// eventi. Aprendo un progetto si chiede prima lo snapshot, cosi' una
// corsa iniziata e poi lasciata riappare completa.
// =====================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunEvent, RunSnapshot } from '../../shared/protocol.js';
import { emptySnapshot } from '../../shared/protocol.js';
import { applySnapshotEvent } from '../runReducer.js';

export interface RunView {
  snapshot: RunSnapshot;
  lastTransition?: { from: string; to: string };
  notices: Array<{ at: number; level: string; message: string }>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  startError?: string;
  clearStartError: () => void;
}

export function useRun(projectId: string): RunView {
  const [snapshot, setSnapshot] = useState<RunSnapshot>(emptySnapshot());
  const [lastTransition, setLastTransition] = useState<{ from: string; to: string } | undefined>();
  const [notices, setNotices] = useState<Array<{ at: number; level: string; message: string }>>([]);
  const [startError, setStartError] = useState<string | undefined>();
  const current = useRef(snapshot);
  current.current = snapshot;

  useEffect(() => {
    let alive = true;
    void window.orcrist.run.snapshot(projectId).then((s) => {
      if (alive) setSnapshot(s);
    });
    return () => {
      alive = false;
    };
  }, [projectId]);

  useEffect(() => {
    return window.orcrist.run.onEvent((id, event: RunEvent) => {
      if (id !== projectId) return;

      if (event.type === 'run-started') {
        setLastTransition(undefined);
        setNotices([]);
      }
      if (event.type === 'transition') setLastTransition({ from: event.from, to: event.to });
      if (event.type === 'notice') {
        setNotices((n) => [...n.slice(-40), { at: event.at, level: event.level, message: event.message }]);
      }
      if (event.type === 'bounds-clamped') {
        setNotices((n) => [
          ...n.slice(-40),
          {
            at: event.at,
            level: 'warning',
            message: `${event.location}: ${event.from} riportato a ${event.to} dai bound del tipo.`,
          },
        ]);
      }

      setSnapshot((prev) => applySnapshotEvent(prev, event));
    });
  }, [projectId]);

  const start = useCallback(async () => {
    setStartError(undefined);
    const res = await window.orcrist.run.start(projectId);
    if (!res.ok) setStartError(res.message);
  }, [projectId]);

  const stop = useCallback(async () => {
    await window.orcrist.run.stop(projectId);
  }, [projectId]);

  return {
    snapshot,
    lastTransition,
    notices,
    start,
    stop,
    startError,
    clearStartError: () => setStartError(undefined),
  };
}
