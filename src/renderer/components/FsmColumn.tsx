import type { Run, Session } from '../../core/types';
import type { Machine } from '../../orcrist/ast';
import { exprToString, findState, refToString, typeToString } from '../../orcrist/ast';
import { formatValue } from '../../orcrist/evaluator';
import type { RunView } from '../runView';
import { isLive, statusLabel } from '../runView';
import { FsmThumbnail } from './FsmThumbnail';
import { ownerDot } from './MachinePreview';
import { CloseIcon } from './Icons';

interface Props {
  session?: Session;
  run?: Run;
  view: RunView;
  onShowModel: () => void;
  onClose: () => void;
}

/**
 * The machine drawer: the session's machine as a low-detail map with the
 * running state lit, the details of that state, and the live store. Hidden by
 * default — the transcript is the thing you read, this is the thing you check.
 */
export function FsmColumn({ session, run, view, onShowModel, onClose }: Props) {
  // Prefer the run's own machine when looking at a finished run, so the drawer
  // matches what you are reading rather than whatever the session has since
  // been revised to.
  const machine: Machine | undefined = run?.machine ?? session?.machine;
  const state = machine && view.currentState ? findState(machine, view.currentState) : undefined;
  const status = statusLabel(run);
  const revisedSince =
    Boolean(run?.machine && session?.machine && run.machine.name !== session.machine.name);

  return (
    <aside className="machine-drawer">
      <div className="drawer-head">
        <span className="label">Machine</span>
        <span className="spacer" />
        {isLive(run) && <span className="spin" />}
        {run && <span className={`badge ${status.cls}`}>{status.text}</span>}
        <button className="icon" onClick={onClose} title="Hide the machine panel">
          <CloseIcon />
        </button>
      </div>

      <div className="drawer-scroll">
        <div className="panel">
          <FsmThumbnail
            machine={machine}
            currentState={view.currentState}
            visited={view.visited}
            lastTransition={view.lastTransition}
          />

          {machine && (
            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="mono" style={{ color: 'var(--fg-2)' }}>
                {machine.name}
              </span>
              <span style={{ flex: 1 }} />
              <button className="ghost" onClick={onShowModel} style={{ fontSize: 11 }}>
                View .orc
              </button>
            </div>
          )}
          {revisedSince && (
            <p style={{ color: 'var(--warn)', fontSize: 11, margin: '8px 0 0' }}>
              The session has since moved to {session!.machine!.name}.
            </p>
          )}
          {!machine && (
            <p style={{ color: 'var(--fg-3)', fontSize: 11.5, margin: '9px 0 0' }}>
              {run?.authoringNotes ||
                'This session has no machine yet. Send a message describing a process and one will be authored for it.'}
            </p>
          )}
        </div>

        {state && (
          <div className="panel">
            <div className="panel-title">Current state</div>
            <div className="state-name">{state.name}</div>
            <div style={{ display: 'flex', gap: 5, margin: '7px 0 10px', flexWrap: 'wrap' }}>
              {state.initial && <span className="badge">initial</span>}
              {state.final && <span className="badge ok">final</span>}
              <span className="badge">
                visit {view.currentVisit}
                {state.limit ? ` / ${state.limit.maxVisits}` : ''}
              </span>
              {state.limit && view.currentVisit >= state.limit.maxVisits && !state.final && (
                <span className="badge warn">last allowed visit</span>
              )}
            </div>

            <dl className="kv">
              {state.writes.length > 0 && (
                <>
                  <dt>writes</dt>
                  <dd>{state.writes.join(', ')}</dd>
                </>
              )}
              {state.assignments.length > 0 && (
                <>
                  <dt>set</dt>
                  <dd>{state.assignments.map((a) => refToString(a.target)).join(', ')}</dd>
                </>
              )}
              {state.limit && (
                <>
                  <dt>limit</dt>
                  <dd>
                    ≤ {state.limit.maxVisits} else → {state.limit.onExceeded}
                  </dd>
                </>
              )}
              {state.transitions.length > 0 && (
                <>
                  <dt>on</dt>
                  <dd>
                    {state.transitions.map((t, i) => (
                      <div key={i}>
                        {exprToString(t.guard)} → {t.target}
                      </div>
                    ))}
                  </dd>
                </>
              )}
              {state.fallback && (
                <>
                  <dt>otherwise</dt>
                  <dd>→ {state.fallback.target}</dd>
                </>
              )}
            </dl>

            {view.currentPrompt && !state.final && (
              <>
                <div className="panel-title" style={{ marginTop: 12 }}>
                  Prompt
                </div>
                <p
                  style={{
                    margin: 0,
                    fontSize: 11.5,
                    color: 'var(--fg-2)',
                    whiteSpace: 'pre-wrap',
                    maxHeight: 180,
                    overflow: 'auto',
                  }}
                >
                  {view.currentPrompt}
                </p>
              </>
            )}
          </div>
        )}

        {machine && machine.locations.length > 0 && (
          <div className="panel">
            <div className="panel-title">
              Store
              <span className="spacer" />
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span className="dot-agent" /> agent
                {machine.locations.some((l) => l.ownership === 'observed') && (
                  <>
                    <span className="dot-observe" style={{ marginLeft: 6 }} /> observed
                  </>
                )}
                <span className="dot-assign" style={{ marginLeft: 6 }} /> set
              </span>
            </div>
            {machine.locations.map((l) => {
              const v = view.store[l.name];
              return (
                <div className="store-row" key={l.name} title={typeToString(l.type)}>
                  <span className={ownerDot(l.ownership)} />
                  <span className="n">{l.name}</span>
                  <span className={`v ${v === undefined ? 'unset' : ''}`}>{formatValue(v)}</span>
                </div>
              );
            })}
          </div>
        )}

        {machine && machine.invariants.length > 0 && (
          <div className="panel">
            <div className="panel-title">Invariants</div>
            {machine.invariants.map((inv, i) => (
              <div
                key={i}
                className="mono"
                style={{ color: 'var(--fg-2)', fontSize: 11, marginBottom: 3 }}
              >
                {inv.name ? `${inv.name}: ` : ''}
                {exprToString(inv.condition)}
              </div>
            ))}
          </div>
        )}

        {run?.warnings && run.warnings.length > 0 && (
          <div className="panel">
            <div className="panel-title">
              Validator warnings <span className="badge warn">{run.warnings.length}</span>
            </div>
            {run.warnings.map((w, i) => (
              <p key={i} style={{ fontSize: 11, color: 'var(--fg-3)', margin: '0 0 6px' }}>
                line {w.line}: {w.message}
              </p>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
