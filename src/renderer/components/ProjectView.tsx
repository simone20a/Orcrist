// =====================================================================
// La schermata di un progetto.
//
// Al posto della casella del prompt c'e' il grafo della macchina. In
// alto a destra Run/Stop, in alto a sinistra lo stato globale.
// =====================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskAnswer, CompileResult, Project } from '../../shared/protocol.js';
import type { PositionOverrides } from '../graph/layout.js';
import { useRun } from '../hooks/useRun.js';
import { DWARF_PALETTE, DWARF_WALK_MINI } from '../pixel/dwarf.js';
import { PixelSprite } from '../pixel/PixelSprite.js';
import { AskPanel } from './AskPanel.js';
import { Diagnostics } from './Diagnostics.js';
import { MachineGraph } from './MachineGraph.js';
import { ProjectSettingsModal } from './ProjectSettingsModal.js';
import { StateDetail } from './StateDetail.js';
import { StorePanel } from './StorePanel.js';
import { Titlebar } from './Titlebar.js';

interface Props {
  project: Project;
  onBack: () => void;
  onProjectChanged: () => Promise<void>;
}

export function ProjectView({ project, onBack, onProjectChanged }: Props): JSX.Element {
  const [compiled, setCompiled] = useState<CompileResult | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [showStore, setShowStore] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const run = useRun(project.id);

  useEffect(() => {
    void window.orcrist.model.compile(project.model).then(setCompiled);
  }, [project.model]);

  // Le posizioni dei nodi si aggiornano subito nella vista e vengono
  // scritte su disco poco dopo: il trascinamento non deve aspettare
  // l'IPC, ma nemmeno perdersi se si chiude la finestra.
  const [positions, setPositions] = useState<PositionOverrides>(project.layout ?? {});
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setPositions(project.layout ?? {});
  }, [project.id, project.layout]);

  const movePositions = useCallback(
    (next: PositionOverrides) => {
      setPositions(next);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void window.orcrist.projects.update(project.id, { layout: next });
      }, 400);
    },
    [project.id],
  );

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const machine = compiled?.machine;
  const running = run.snapshot.status === 'running' || run.snapshot.status === 'stopping';
  const selectedState = useMemo(
    () => machine?.states.find((s) => s.name === selected),
    [machine, selected],
  );

  // Durante l'esecuzione il pannello segue lo stato attivo, se non si e'
  // scelto esplicitamente di guardare un altro stato.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (running && !pinned && run.snapshot.currentState) setSelected(run.snapshot.currentState);
  }, [running, pinned, run.snapshot.currentState]);

  const select = useCallback((name: string) => {
    setPinned(true);
    setSelected(name);
  }, []);

  const toggleRun = useCallback(async () => {
    if (running) {
      await run.stop();
    } else {
      setPinned(false);
      await run.start();
    }
  }, [running, run]);

  return (
    <div className="app-shell">
      <Titlebar
        title="Orcrist"
        subtitle={project.name}
        left={
          <button className="btn ghost" onClick={onBack}>
            ← Projects
          </button>
        }
      >
        {/* Etichetta fissa: cambiandola al click il gruppo di destra
            si allargava e il marchio centrato saltava di posizione. */}
        <button
          className={`btn ghost${showStore ? ' active' : ''}`}
          aria-pressed={showStore}
          onClick={() => setShowStore((v) => !v)}
        >
          Global state
        </button>
        <button className="btn ghost" onClick={() => setShowModel(true)}>
          Model
        </button>
        <button className="btn ghost" onClick={() => setShowSettings(true)}>
          Settings
        </button>
        <button
          className={`btn ${running ? 'live' : 'primary'}`}
          disabled={!machine || run.snapshot.status === 'stopping'}
          onClick={toggleRun}
        >
          {run.snapshot.status === 'stopping' ? 'Arresto…' : running ? '■ Stop' : '▶ Run'}
        </button>
      </Titlebar>

      <div className="project-view">
        {showStore && machine && (
          <StorePanel machine={machine} snapshot={run.snapshot} onClose={() => setShowStore(false)} />
        )}

        {machine ? (
          <MachineGraph
            machine={machine}
            currentState={run.snapshot.currentState}
            running={running}
            visitCounts={run.snapshot.visitCounts}
            lastTransition={run.lastTransition}
            selected={selected}
            askingState={run.snapshot.pendingAsk?.state}
            positions={positions}
            onSelect={select}
            onPositionsChange={movePositions}
          />
        ) : (
          <div className="canvas" style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
            {compiled ? (
              <div style={{ maxWidth: 620, width: '100%' }}>
                <Diagnostics result={compiled} />
              </div>
            ) : (
              <span className="faint">Compiling model…</span>
            )}
          </div>
        )}

        {machine && run.snapshot.pendingAsk && (
          <AskPanel
            request={run.snapshot.pendingAsk}
            onAnswer={(answer: AskAnswer) => void window.orcrist.run.answer(project.id, answer)}
            onFocusState={select}
          />
        )}

        {machine && selectedState && (
          <StateDetail
            machine={machine}
            state={selectedState}
            snapshot={run.snapshot}
            isLive={running && run.snapshot.currentState === selectedState.name}
            onClose={() => {
              setSelected(undefined);
              setPinned(false);
            }}
            onSelect={select}
          />
        )}
      </div>

      <StatusLine project={project} run={run} />

      {showSettings && (
        <ProjectSettingsModal
          project={project}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            setShowSettings(false);
            await onProjectChanged();
          }}
        />
      )}

      {showModel && (
        <ModelModal
          project={project}
          onClose={() => setShowModel(false)}
          onSaved={async () => {
            setShowModel(false);
            await onProjectChanged();
          }}
        />
      )}
    </div>
  );
}

function StatusLine({ project, run }: { project: Project; run: ReturnType<typeof useRun> }): JSX.Element {
  const s = run.snapshot;
  const lastNotice = run.notices[run.notices.length - 1];

  const label =
    s.pendingAsk
      ? `Waiting for an answer · ${s.pendingAsk.state}`
      : s.status === 'running'
        ? `Running · ${s.currentState ?? '—'} · step ${s.step}`
        : s.status === 'stopping'
          ? 'Stopping…'
          : s.status === 'finished'
            ? s.finishedReason === 'final'
              ? `Finished in final state ${s.currentState ?? ''}`
              : s.finishedReason === 'stopped'
                ? 'Interrotta'
                : (s.error ?? 'Conclusa')
            : s.status === 'error'
              ? (s.error ?? 'Error')
              : 'Ready';

  const walking = s.status === 'running' && !s.pendingAsk;

  return (
    <div className="status-line">
      {/* Cammina mentre la macchina avanza, si ferma quando aspetta una
          risposta o quando la corsa e' conclusa: dice a colpo d'occhio
          se sta succedendo qualcosa. */}
      <PixelSprite
        frames={DWARF_WALK_MINI}
        palette={DWARF_PALETTE}
        scale={1}
        fps={7}
        playing={walking}
        className={`walker${walking ? '' : ' idle'}`}
        title={walking ? 'In cammino' : 'Fermo'}
      />
      <span className={`pip ${s.status === 'running' ? 'running' : s.status === 'error' ? 'error' : ''}`} />
      <span>{label}</span>
      {!!s.violations.length && (
        <span style={{ color: 'var(--danger)' }}>
          {s.violations.length} violazione/i di invariante
        </span>
      )}
      {run.startError && <span style={{ color: 'var(--danger)' }}>{run.startError}</span>}
      {lastNotice && !run.startError && (
        <span style={{ color: lastNotice.level === 'warning' ? 'var(--warn)' : undefined }}>
          {lastNotice.message}
        </span>
      )}
      <span style={{ marginLeft: 'auto' }} className="mono faint">
        {project.runtime.provider}/{project.runtime.model}
      </span>
      <button className="btn ghost" onClick={() => void window.orcrist.shell.openWorkspace(project.workspace)}>
        Open workspace
      </button>
    </div>
  );
}

/** Editor del modello, con validazione dal vivo come in creazione. */
function ModelModal({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): JSX.Element {
  const [text, setText] = useState(project.model);
  const [result, setResult] = useState<CompileResult | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => void window.orcrist.model.compile(text).then(setResult), 220);
    return () => clearTimeout(t);
  }, [text]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <header>
          <h3>Model · {project.name}</h3>
          <button className="btn ghost" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="body">
          <textarea
            className="code"
            spellCheck={false}
            value={text}
            style={{ minHeight: 380 }}
            onChange={(e) => setText(e.target.value)}
          />
          {result && <Diagnostics result={result} />}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!result?.ok || saving || text === project.model}
            onClick={async () => {
              setSaving(true);
              await window.orcrist.projects.update(project.id, { model: text });
              await onSaved();
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
