// =====================================================================
// Dettaglio di uno stato.
//
// Fuori esecuzione mostra il modello: prompt, writes, set, guardie.
// Durante e dopo l'esecuzione si aggiunge il registro di cosa e'
// successo in ciascuna visita — i tool usati e le locazioni scritte,
// in ordine cronologico.
//
// Il testo libero dell'LLM non viene mostrato di proposito: quello che
// conta per capire dove va la macchina sono le azioni e i valori, non
// il commento che il modello ci mette attorno.
// =====================================================================

import { useEffect, useState } from 'react';
import type { IRMachine, IRState, IRValue } from '../../shared/ir.js';
import type { ActivityItem, RunSnapshot, VisitRecord } from '../../shared/protocol.js';

interface Props {
  machine: IRMachine;
  state: IRState;
  snapshot: RunSnapshot;
  isLive: boolean;
  onClose: () => void;
  onSelect: (name: string) => void;
}

export function StateDetail({ machine, state, snapshot, isLive, onClose, onSelect }: Props): JSX.Element {
  const visits = snapshot.traces[state.name]?.visits ?? [];
  const [visitIndex, setVisitIndex] = useState(visits.length - 1);

  // Restando aperti su uno stato che viene rivisitato si segue l'ultima
  // visita, invece di restare fermi su quella vecchia.
  useEffect(() => {
    setVisitIndex(visits.length - 1);
  }, [state.name, visits.length]);

  const visit: VisitRecord | undefined = visits[visitIndex];

  return (
    <div className="panel">
      <header>
        <h3>
          {state.name}
          {isLive && <span className="tag live">running</span>}
          {state.initial && <span className="tag">initial</span>}
          {state.final && <span className="tag">final</span>}
        </h3>
        <button className="btn ghost" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="content">
        {state.final ? (
          <div className="block empty-note">
            Final state: no prompt and no exit. Reaching it completes the run.
          </div>
        ) : (
          <>
            {visits.length > 1 && (
              <div className="section">
                <h4>Visits</h4>
                <div className="visit-tabs">
                  {visits.map((v, i) => (
                    <button
                      key={i}
                      className={`visit-tab${i === visitIndex ? ' active' : ''}`}
                      onClick={() => setVisitIndex(i)}
                    >
                      #{v.index}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="section">
              <h4>Prompt {visit?.prompt ? '(interpolated)' : '(model)'}</h4>
              <div className="block">{visit?.prompt || renderPromptTemplate(state)}</div>
            </div>

            <ActivityLog machine={machine} visit={visit} isLive={isLive} />

            {!!state.writes.length && (
              <div className="section">
                <h4>Declared writes</h4>
                <div className="kv">
                  {state.writes.map((w) => {
                    const loc = machine.locations.find((l) => l.name === w);
                    const value = visit?.writes[w];
                    return (
                      <div key={w} style={{ display: 'contents' }}>
                        <span className="k">
                          {w}
                          {loc && <span className="faint"> · {loc.agentOwned ? 'agent' : 'set'}</span>}
                        </span>
                        <span className="v">{value === undefined ? '—' : short(value)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="section">
              <h4>Exits</h4>
              <div className="kv">
                {state.transitions.map((t, i) => (
                  <div key={i} style={{ display: 'contents' }}>
                    <span className="k">
                      on {t.source}
                      {visit?.exit?.reason === 'guard' && visit.exit.guard === t.source && (
                        <span style={{ color: 'var(--live)' }}> ✓</span>
                      )}
                    </span>
                    <span className="v">
                      <LinkTo name={t.target} onSelect={onSelect} />
                    </span>
                  </div>
                ))}
                {state.limit && (
                  <div style={{ display: 'contents' }}>
                    <span className="k">
                      over {state.limit.maxVisits} visits
                      {visit?.exit?.reason === 'limit' && <span style={{ color: 'var(--live)' }}> ✓</span>}
                    </span>
                    <span className="v">
                      <LinkTo name={state.limit.onExceeded} onSelect={onSelect} />
                    </span>
                  </div>
                )}
                {state.fallback && (
                  <div style={{ display: 'contents' }}>
                    <span className="k">
                      otherwise
                      {visit?.exit?.reason === 'otherwise' && <span style={{ color: 'var(--live)' }}> ✓</span>}
                    </span>
                    <span className="v">
                      <LinkTo name={state.fallback} onSelect={onSelect} />
                    </span>
                  </div>
                )}
              </div>
            </div>

            {visit?.error && <div className="banner error">{visit.error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Tool e scritture in ordine. Le scritture sono la parte che interessa
 * di piu': dicono cosa e' cambiato nello stato globale e per mano di
 * chi — il modello LLM, oppure un 'set' del modello Orcrist.
 */
function ActivityLog({
  machine,
  visit,
  isLive,
}: {
  machine: IRMachine;
  visit: VisitRecord | undefined;
  isLive: boolean;
}): JSX.Element {
  const items = visit?.activity ?? [];
  const writeCount = items.filter((a) => a.kind === 'write').length;
  const toolCount = items.filter((a) => a.kind === 'tool').length;

  const summary = [
    toolCount ? `${toolCount} tool` : '',
    writeCount ? `${writeCount} writes` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="section">
      <h4>Activity {summary && <span className="faint">· {summary}</span>}</h4>

      {items.length === 0 ? (
        <div className="block empty-note">
          {isLive ? 'In progress: actions appear here as they happen.' : 'No actions recorded.'}
        </div>
      ) : (
        <div className="activity">
          {items.map((item, i) => (
            <ActivityRow key={i} item={item} machine={machine} />
          ))}
          {isLive && <div className="activity-live">in progress…</div>}
        </div>
      )}
    </div>
  );
}

function ActivityRow({ item, machine }: { item: ActivityItem; machine: IRMachine }): JSX.Element {
  if (item.kind === 'rejected') {
    return (
      <div className="activity-row rejected">
        <span className="dot fail" />
        <div className="body">
          <div className="head">
            <span className="what">write rejected</span>
            <span className="target">{item.location}</span>
          </div>
          <div className="detail">{item.reason}</div>
        </div>
      </div>
    );
  }

  if (item.kind === 'write') {
    const loc = machine.locations.find((l) => l.name === item.location);
    const type = loc ? typeLabel(loc.type.kind) : '';
    return (
      <div className={`activity-row write ${item.by}`}>
        <span className="dot write" />
        <div className="body">
          <div className="head">
            <span className={`tag ${item.by}`}>{item.by === 'agent' ? 'agent' : 'set'}</span>
            <span className="target">{item.location}</span>
            {type && <span className="faint">{type}</span>}
          </div>
          <div className="value">{short(item.value, 400)}</div>
          {item.by === 'set' && item.source && <div className="detail">{item.source}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="activity-row tool">
      <span className={`dot ${item.ok === undefined ? '' : item.ok ? 'ok' : 'fail'}`} />
      <div className="body">
        <div className="head">
          <span className="what">{item.tool}</span>
          <span className="target">{primaryArg(item.input)}</span>
        </div>
        {item.summary && <div className="detail">{item.summary}</div>}
      </div>
    </div>
  );
}

function LinkTo({ name, onSelect }: { name: string; onSelect: (n: string) => void }): JSX.Element {
  return (
    <button
      className="btn ghost"
      style={{ padding: '0 2px', fontFamily: 'var(--mono)', fontSize: 12 }}
      onClick={() => onSelect(name)}
    >
      {name}
    </button>
  );
}

function renderPromptTemplate(state: IRState): string {
  return state.prompt.map((p) => (p.t === 'text' ? p.value : `<${[p.location, ...p.path].join('.')}>`)).join('');
}

function typeLabel(kind: string): string {
  return kind === 'Record' ? 'record' : kind.toLowerCase();
}

function short(v: IRValue, max = 90): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * L'argomento che identifica la chiamata: il percorso per i tool sui
 * file, la query per la ricerca. Il resto sta nel riepilogo.
 */
function primaryArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const o = input as Record<string, unknown>;
  for (const key of ['path', 'url', 'query', 'pattern', 'command']) {
    if (typeof o[key] === 'string') return String(o[key]).slice(0, 90);
  }
  const first = Object.entries(o)[0];
  return first ? `${first[0]}=${String(first[1]).slice(0, 60)}` : '';
}
