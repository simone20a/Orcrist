// =====================================================================
// Creazione di un progetto: nome, cartella di lavoro, modello.
//
// Il modello viene parsato e validato mentre lo si scrive; senza un
// modello che compila il bottone di creazione resta disabilitato,
// perche' un progetto con un modello rotto non si potrebbe aprire.
//
// Provider e modello LLM arrivano dalle preferenze: chi ha gia'
// configurato una chiave se la ritrova selezionata, senza doverla
// ricercare ogni volta.
// =====================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CompileResult, RuntimeConfig, SettingsView } from '../../shared/protocol.js';
import { DEFAULT_RUNTIME } from '../../shared/protocol.js';
import { Diagnostics } from './Diagnostics.js';
import { RuntimeFields } from './RuntimeFields.js';

const STARTER = `machine Esempio {

    locations {
        agent nota: Text;
        passi: Nat[0..5] = 0;
    }

    initial state Osserva {
        writes nota;
        prompt: "Inspect the workspace and summarize its contents in one line.";
        set passi = passi + 1;
        limit visits <= 3 else -> Fine;
        on nota != "" -> Fine;
        otherwise     -> Osserva;
    }

    final state Fine {}
}
`;

interface Props {
  onClose: () => void;
  onCreated: (projectId: string) => Promise<void>;
}

export function NewProjectModal({ onClose, onCreated }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [model, setModel] = useState(STARTER);
  const [modelPath, setModelPath] = useState<string | undefined>();
  const [runtime, setRuntime] = useState<RuntimeConfig>(DEFAULT_RUNTIME);
  const [result, setResult] = useState<CompileResult | undefined>();
  const [settings, setSettings] = useState<SettingsView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    void window.orcrist.settings.read().then(setSettings);
    void window.orcrist.settings.readPreferences().then((prefs) => {
      setRuntime((r) => ({
        ...r,
        provider: prefs.lastProvider ?? r.provider,
        model: prefs.lastModel ?? r.model,
      }));
    });
  }, []);

  // compilazione a ogni pausa nella digitazione
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void window.orcrist.model.compile(model).then(setResult);
    }, 220);
    return () => clearTimeout(debounce.current);
  }, [model]);

  const suggestedName = useMemo(() => result?.machine?.name ?? '', [result]);
  const canCreate = !!result?.ok && !!workspace && (!!name.trim() || !!suggestedName) && !busy;

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const project = await window.orcrist.projects.create({
        name: name.trim() || suggestedName,
        workspace,
        model,
        modelPath,
        runtime,
      });
      // Le stesse scelte tornano preselezionate al prossimo progetto.
      await window.orcrist.settings.writePreferences({
        lastProvider: runtime.provider,
        lastModel: runtime.model,
        lastWorkspace: workspace,
      });
      await onCreated(project.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <header>
          <h3>New project</h3>
          <button className="btn ghost" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="body">
          <div className="grid-2">
            <div className="field">
              <label htmlFor="np-name">Name</label>
              <input
                id="np-name"
                value={name}
                placeholder={suggestedName || 'What is this project called?'}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="np-ws">Workspace directory</label>
              <div className="row">
                <input id="np-ws" value={workspace} readOnly placeholder="No directory selected" />
                <button
                  className="btn"
                  onClick={async () => {
                    const picked = await window.orcrist.dialog.pickWorkspace();
                    if (picked) setWorkspace(picked);
                  }}
                >
                  Choose
                </button>
              </div>
              <span className="hint">
                The agent cannot read or write anything outside this directory.
              </span>
            </div>
          </div>

          <RuntimeFields
            value={runtime}
            settings={settings}
            onChange={(patch) => setRuntime((r) => ({ ...r, ...patch }))}
          />

          <div className="field">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label htmlFor="np-src">Orcrist model</label>
              <button
                className="btn ghost"
                onClick={async () => {
                  const picked = await window.orcrist.dialog.pickModelFile();
                  if (picked) {
                    setModel(picked.text);
                    setModelPath(picked.path);
                  }
                }}
              >
                Importa da file…
              </button>
            </div>
            <textarea
              id="np-src"
              className="code"
              spellCheck={false}
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setModelPath(undefined);
              }}
            />
            {modelPath && <span className="hint mono">{modelPath}</span>}
          </div>

          {result && <Diagnostics result={result} />}
          {error && <div className="banner error">{error}</div>}
        </div>

        <footer>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 12 }}>
            {result?.machine
              ? `${result.machine.states.length} stati · ${result.machine.locations.length} locazioni`
              : ' '}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canCreate} onClick={create}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </footer>
      </div>
    </div>
  );
}
