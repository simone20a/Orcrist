import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Project, Run, Session } from '../../core/types';
import { FsmColumn } from '../components/FsmColumn';
import { SessionLog } from '../components/LogView';
import { Modal } from '../components/Modal';
import { PlusIcon, SendIcon, StopIcon } from '../components/Icons';
import { ContextMenu } from '../components/ContextMenu';
import { Figure, MASCOTS } from '../components/Figures';
import { ApprovalDialog } from '../components/ApprovalDialog';
import { foldRun, isLive } from '../runView';

interface Props {
  project: Project;
  /** The machine drawer is toggled from the title bar, so App owns its state. */
  drawer: boolean;
  onToggleDrawer: () => void;
  /**
   * The executing state's name, or undefined when nothing is running. The
   * indicator for it sits in the title bar beside the drawer toggle, which App
   * owns — so the name has to travel up rather than be rendered here.
   */
  onLiveState: (state?: string) => void;
  onError: (msg: string) => void;
}

export function SessionView({ project, drawer, onToggleDrawer, onLiveState, onError }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [task, setTask] = useState('');
  const [starting, setStarting] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Session>();
  const [menu, setMenu] = useState<{ x: number; y: number; session: Session }>();
  const [renaming, setRenaming] = useState<{ id: string; text: string }>();
  // Which sessions have a run going, and which state each is executing.
  // Switching away from a working session keeps its transcript, but it would
  // still leave no sign anything was happening — and a session you cannot see
  // working looks like one that died. Keyed by session, because that is what
  // the list is a list of.
  const [busy, setBusy] = useState<Record<string, { runId: string; state?: string }>>({});
  const taRef = useRef<HTMLTextAreaElement>(null);
  // The stream subscriptions are set up once and outlive any one session, so
  // they read which session is open from here rather than from a closure.
  const openSession = useRef<string>();
  openSession.current = sessionId;

  const session = sessions.find((s) => s.id === sessionId);
  // The drawer tracks the most recent run — that is what "now" means here.
  const latest = runs[runs.length - 1];
  const view = useMemo(() => foldRun(latest), [latest]);
  const live = isLive(latest);

  const currentState = live ? view.currentState : undefined;
  useEffect(() => {
    onLiveState(currentState);
    // and leave the title bar clean when this view goes away
    return () => onLiveState(undefined);
  }, [currentState, onLiveState]);

  const commitRename = async () => {
    const r = renaming;
    setRenaming(undefined);
    if (!r) return;
    const title = r.text.trim();
    const before = sessions.find((s) => s.id === r.id);
    if (!title || !before || title === before.title) return;
    try {
      const updated = await api.sessions.rename(project.id, r.id, title);
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  // --- session list ----------------------------------------------------
  const loadSessions = useCallback(async () => {
    try {
      const list = await api.sessions.list(project.id);
      if (!list.length) {
        const s = await api.sessions.create(project.id);
        setSessions([s]);
        setSessionId(s.id);
        return;
      }
      setSessions(list);
      setSessionId((cur) => cur ?? list[0].id);
    } catch (e) {
      onError((e as Error).message);
    }
  }, [project.id, onError]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // --- the session's transcript ----------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    api.runs
      .list(project.id, sessionId)
      .then((loaded) =>
        setRuns((prev) => {
          // A run is only written to disk at a few points — when it starts,
          // when it is approved, when it ends — so the persisted copy of a run
          // still going holds none of the reasoning or tool calls we have
          // streamed in. Loading over it would blank the transcript of a live
          // run, so the longer event list wins.
          const streamed = new Map(prev.map((r) => [r.id, r]));
          return loaded.map((r) => {
            const have = streamed.get(r.id);
            return have && have.events.length > r.events.length ? { ...r, events: have.events } : r;
          });
        }),
      )
      .catch((e: Error) => onError(e.message));
  }, [project.id, sessionId, onError]);

  // Runs already going when this view mounts — after a trip back to the project
  // list, say — are not announced by the stream, so they are asked for once.
  useEffect(() => {
    api.runs
      .live()
      .then((live) =>
        setBusy(Object.fromEntries(live.map((l) => [l.sessionId, { runId: l.runId, state: l.state }]))),
      )
      .catch(() => undefined);
  }, [project.id]);

  // --- live streams ------------------------------------------------------
  useEffect(() => {
    const offEvent = api.runs.onEvent(({ runId, event }) => {
      setRuns((prev) => prev.map((r) => (r.id === runId ? { ...r, events: [...r.events, event] } : r)));
      // The event carries a run, not a session, so the row it belongs to is
      // found by the run it is already showing.
      if (event.kind !== 'state-enter' && event.kind !== 'transition') return;
      const name = event.kind === 'state-enter' ? event.state : event.to;
      setBusy((prev) => {
        const found = Object.entries(prev).find(([, v]) => v.runId === runId);
        if (!found || found[1].state === name) return prev;
        return { ...prev, [found[0]]: { ...found[1], state: name } };
      });
    });
    const offRun = api.runs.onChanged((updated: Run) => {
      setBusy((prev) => {
        const here = prev[updated.sessionId];
        if (isLive(updated)) {
          if (here?.runId === updated.id) return prev;
          return { ...prev, [updated.sessionId]: { runId: updated.id } };
        }
        if (!here || here.runId !== updated.id) return prev;
        const next = { ...prev };
        delete next[updated.sessionId];
        return next;
      });
      setRuns((prev) => {
        // Runs are broadcast for the whole project, so one belonging to a
        // session working away in the background must not land in the
        // transcript of the session you happen to be looking at.
        if (updated.sessionId !== openSession.current) return prev;
        const i = prev.findIndex((r) => r.id === updated.id);
        if (i < 0) return [...prev, updated];
        // keep the events we streamed in — the persisted copy can lag behind
        const events = prev[i].events.length >= updated.events.length ? prev[i].events : updated.events;
        const next = [...prev];
        next[i] = { ...updated, events };
        return next;
      });
    });
    const offSession = api.sessions.onChanged((updated: Session) => {
      setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    });
    return () => {
      offEvent();
      offRun();
      offSession();
    };
  }, []);

  // --- actions ----------------------------------------------------------
  const send = async () => {
    const text = task.trim();
    if (!text || !sessionId || starting || live) return;
    setStarting(true);
    try {
      const created = await api.runs.start(project.id, sessionId, text);
      setRuns((prev) => (prev.some((r) => r.id === created.id) ? prev : [...prev, created]));
      setTask('');
      if (taRef.current) taRef.current.style.height = 'auto';
      void api.sessions.list(project.id).then(setSessions);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const newSession = async () => {
    try {
      const s = await api.sessions.create(project.id);
      setSessions((prev) => [s, ...prev]);
      setSessionId(s.id);
      setRuns([]);
      taRef.current?.focus();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const removeSession = async (id: string) => {
    setConfirmDelete(undefined);
    try {
      await api.sessions.remove(project.id, id);
      let rest = sessions.filter((s) => s.id !== id);
      // A project always has somewhere to type, so deleting the last session
      // leaves a fresh empty one rather than an empty screen.
      if (!rest.length) rest = [await api.sessions.create(project.id)];
      setSessions(rest);
      if (sessionId === id) {
        setSessionId(rest[0].id);
        setRuns([]);
      }
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="workspace">
      <nav className="rail">
        <div className="rail-head">
          <span className="label">Sessions</span>
          <button className="icon" title="New session" onClick={() => void newSession()}>
            <PlusIcon />
          </button>
        </div>
        <div className="rail-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`session-item ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => setSessionId(s.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSessionId(s.id);
                setMenu({ x: e.clientX, y: e.clientY, session: s });
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setSessionId(s.id)}
              title="Right-click to rename or delete"
            >
              <div className="si-text">
                {renaming?.id === s.id ? (
                  <input
                    className="rename"
                    autoFocus
                    value={renaming.text}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ id: s.id, text: e.target.value })}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') void commitRename();
                      if (e.key === 'Escape') setRenaming(undefined);
                    }}
                  />
                ) : (
                  <div className="t">{s.title}</div>
                )}
                <div className="d">
                  {busy[s.id] && <span className="spin" />}
                  {busy[s.id]?.state ? (
                    // While it is working, the state it is in says more than
                    // the machine's name — which the title above already implies.
                    <span className="mono running">{busy[s.id].state}</span>
                  ) : busy[s.id] ? (
                    'starting…'
                  ) : s.machine ? (
                    <span className="mono">{s.machine.name}</span>
                  ) : (
                    `${s.runIds.length} message${s.runIds.length === 1 ? '' : 's'}`
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="frieze rail-deco">
          {MASCOTS.map((m) => (
            <Figure key={m} name={m} />
          ))}
        </div>
      </nav>

      <main className="main">
        {/* No strip above the transcript any more: the one thing it carried —
            which state is executing — now sits in the title bar, beside the
            control that opens the machine it belongs to. */}
        <SessionLog runs={runs} onShowModel={() => setShowModel(true)} />

        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={taRef}
              rows={1}
              value={task}
              placeholder={
                live ? 'Running…' : 'Message'
              }
              onChange={(e) => {
                setTask(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            {/* One button, two jobs. While a run is going the only thing you
                can do here is stop it, so stop is what the button becomes —
                in the same place your hand is already going. */}
            {live ? (
              <button
                className="glyph stop"
                onClick={() => void api.runs.cancel(latest!.id)}
                title="Stop the run"
                aria-label="Stop the run"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                className="glyph send"
                disabled={!task.trim() || starting}
                onClick={() => void send()}
                title="Send (⌘↵)"
                aria-label="Send"
              >
                <SendIcon />
              </button>
            )}
          </div>
          <div className="hint">
            <span>⌘↵ to send</span>
            <span>{project.workspace}</span>
          </div>
        </div>
      </main>

      {drawer && (
        <FsmColumn
          session={session}
          run={latest}
          view={view}
          onShowModel={() => setShowModel(true)}
          onClose={onToggleDrawer}
        />
      )}

      {latest?.status === 'awaiting-approval' && latest.machine && (
        <ApprovalDialog
          run={latest}
          revised={latest.events.some((e) => e.kind === 'approval-request' && e.revised)}
          onDecide={(approved) => {
            void api.runs.approve(latest.id, approved).catch((e: Error) => onError(e.message));
          }}
        />
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          items={[
            {
              label: 'Rename',
              onClick: () => setRenaming({ id: menu.session.id, text: menu.session.title }),
            },
            { label: 'Delete', danger: true, onClick: () => setConfirmDelete(menu.session) },
          ]}
        />
      )}

      {confirmDelete && (
        <Modal
          title="Delete this session?"
          onClose={() => setConfirmDelete(undefined)}
          footer={
            <>
              <button onClick={() => setConfirmDelete(undefined)}>Cancel</button>
              <button className="danger" onClick={() => void removeSession(confirmDelete.id)}>
                Delete session
              </button>
            </>
          }
        >
          <p style={{ margin: '0 0 10px' }}>
            <strong>{confirmDelete.title}</strong>
          </p>
          <p className="help" style={{ margin: 0 }}>
            {confirmDelete.runIds.length
              ? `Its ${confirmDelete.runIds.length} message${confirmDelete.runIds.length === 1 ? '' : 's'} and their run history are removed`
              : 'It has no messages yet'}
            {confirmDelete.machine ? `, along with its machine ${confirmDelete.machine.name}` : ''}.
          </p>
        </Modal>
      )}

      {showModel && (
        <Modal
          title={
            (latest?.machine ?? session?.machine)
              ? `${(latest?.machine ?? session!.machine)!.name}.orc`
              : 'Model'
          }
          wide
          onClose={() => setShowModel(false)}
        >
          {(latest?.modelSource ?? session?.machineSource) ? (
            <div className="model-src">
              <pre>{latest?.modelSource ?? session?.machineSource}</pre>
            </div>
          ) : (
            <p style={{ color: 'var(--fg-3)' }}>
              {latest?.authoringNotes || 'This session has no machine yet.'}
            </p>
          )}
          {latest?.authoringNotes && latest.modelSource && (
            <>
              <div className="section-title">Plan</div>
              <p style={{ color: 'var(--fg-2)', whiteSpace: 'pre-wrap' }}>{latest.authoringNotes}</p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
