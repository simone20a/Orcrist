// =====================================================================
// Stato globale: tutte le locazioni, il loro tipo e il valore corrente.
//
// Le locazioni si dividono per proprieta' — 'agent' le scrive il
// modello, le altre solo i 'set'. La distinzione conta perche' dice
// quanto ci si puo' fidare di una guardia che le legge.
// =====================================================================

import { useEffect, useRef, useState } from 'react';
import type { IRMachine, IRValue, Store } from '../../shared/ir.js';
import { typeToString } from '../../shared/ir.js';
import type { RunSnapshot } from '../../shared/protocol.js';
import { defaultValue } from '../../shared/ir.js';

interface Props {
  machine: IRMachine;
  snapshot: RunSnapshot;
  onClose: () => void;
}

export function StorePanel({ machine, snapshot, onClose }: Props): JSX.Element {
  const store: Store = Object.keys(snapshot.store).length
    ? snapshot.store
    : Object.fromEntries(machine.locations.map((l) => [l.name, defaultValue(l.type)]));

  const changed = useChangedKeys(store);
  const agent = machine.locations.filter((l) => l.agentOwned);
  const assignable = machine.locations.filter((l) => !l.agentOwned);

  return (
    <div className="panel left">
      <header>
        <h3>Global state</h3>
        <button className="btn ghost" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="content">
        {machine.locations.length === 0 && (
          <div className="block empty-note">This machine declares no locations.</div>
        )}

        {!!agent.length && (
          <div className="section">
            <h4>Written by the agent</h4>
            {agent.map((l) => (
              <LocationRow
                key={l.name}
                name={l.name}
                type={typeToString(l.type)}
                value={store[l.name]}
                kind="agent"
                changed={changed.has(l.name)}
              />
            ))}
          </div>
        )}

        {!!assignable.length && (
          <div className="section">
            <h4>Assignable</h4>
            {assignable.map((l) => (
              <LocationRow
                key={l.name}
                name={l.name}
                type={typeToString(l.type)}
                value={store[l.name]}
                kind="set"
                changed={changed.has(l.name)}
              />
            ))}
          </div>
        )}

        {!!machine.invariants.length && (
          <div className="section">
            <h4>Invariants</h4>
            <div className="kv">
              {machine.invariants.map((inv, i) => {
                const broken = snapshot.violations.some((v) => v.source === inv.source);
                return (
                  <div key={i} style={{ display: 'contents' }}>
                    <span className="k">{inv.name ?? `#${i + 1}`}</span>
                    <span className="v" style={{ color: broken ? 'var(--danger)' : undefined }}>
                      {broken ? 'violata' : '—'}
                    </span>
                    <span className="k faint" style={{ gridColumn: '1 / -1' }}>
                      {inv.source}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!!snapshot.violations.length && (
          <div className="section">
            <h4>Violations ({snapshot.violations.length})</h4>
            {snapshot.violations
              .slice(-12)
              .reverse()
              .map((v, i) => (
                <div key={i} className="violation">
                  {v.name} · in {v.state}
                  <br />
                  <span className="faint">{v.source}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LocationRow({
  name,
  type,
  value,
  kind,
  changed,
}: {
  name: string;
  type: string;
  value: IRValue | undefined;
  kind: 'agent' | 'set';
  changed: boolean;
}): JSX.Element {
  return (
    <div className="loc-row">
      <span className={`tag ${kind}`}>{kind}</span>
      <div className="loc-main">
        <div className="loc-name">{name}</div>
        <div className="loc-type">{type}</div>
        <div className={`loc-value${changed ? ' changed' : ''}`}>{render(value)}</div>
      </div>
    </div>
  );
}

function render(v: IRValue | undefined): string {
  if (v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

/** Le locazioni cambiate all'ultimo aggiornamento, per il lampeggio. */
function useChangedKeys(store: Store): Set<string> {
  const previous = useRef<Store>({});
  const [changed, setChanged] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next = new Set<string>();
    for (const [k, v] of Object.entries(store)) {
      if (JSON.stringify(previous.current[k]) !== JSON.stringify(v)) next.add(k);
    }
    previous.current = JSON.parse(JSON.stringify(store));
    if (next.size) {
      setChanged(next);
      const t = setTimeout(() => setChanged(new Set()), 900);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [store]);

  return changed;
}
