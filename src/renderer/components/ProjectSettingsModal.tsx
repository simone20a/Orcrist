// =====================================================================
// Impostazioni di un progetto gia' esistente.
//
// Tutto quello che si sceglie alla creazione resta modificabile: nome,
// cartella di lavoro, provider, modello, limiti, permessi. Il modello
// Orcrist ha la sua finestra a parte, perche' ha bisogno di spazio
// e di validazione dal vivo.
// =====================================================================

import { useEffect, useState } from 'react';
import type { Project, RuntimeConfig, SettingsView } from '../../shared/protocol.js';
import { RuntimeFields } from './RuntimeFields.js';

interface Props {
  project: Project;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

export function ProjectSettingsModal({ project, onClose, onSaved }: Props): JSX.Element {
  const [name, setName] = useState(project.name);
  const [workspace, setWorkspace] = useState(project.workspace);
  const [runtime, setRuntime] = useState<RuntimeConfig>(project.runtime);
  const [settings, setSettings] = useState<SettingsView | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void window.orcrist.settings.read().then(setSettings);
  }, []);

  const dirty =
    name.trim() !== project.name ||
    workspace !== project.workspace ||
    JSON.stringify(runtime) !== JSON.stringify(project.runtime);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(undefined);
    try {
      await window.orcrist.projects.update(project.id, {
        name: name.trim() || project.name,
        workspace,
        runtime,
      });
      // La stessa scelta viene riproposta al prossimo progetto.
      await window.orcrist.settings.writePreferences({
        lastProvider: runtime.provider,
        lastModel: runtime.model,
        lastWorkspace: workspace,
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <header>
          <h3>Settings · {project.name}</h3>
          <button className="btn ghost" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="body">
          <div className="field">
            <label htmlFor="ps-name">Name</label>
            <input id="ps-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="ps-ws">Workspace directory</label>
            <div className="row">
              <input id="ps-ws" value={workspace} readOnly />
              <button
                className="btn"
                onClick={async () => {
                  const picked = await window.orcrist.dialog.pickWorkspace();
                  if (picked) setWorkspace(picked);
                }}
              >
                Cambia
              </button>
            </div>
            {workspace !== project.workspace && (
              <span className="hint" style={{ color: 'var(--warn)' }}>
                Changing the directory moves future runs elsewhere. Anything the agent has already written
                remains where it is.
              </span>
            )}
          </div>

          <RuntimeFields
            value={runtime}
            settings={settings}
            showLimits
            onChange={(patch) => setRuntime((r) => ({ ...r, ...patch }))}
          />

          {error && <div className="banner error">{error}</div>}
        </div>

        <footer>
          <span className="faint" style={{ marginRight: 'auto', fontSize: 11.5 }}>
            Created on {new Date(project.createdAt).toLocaleDateString('en-US')}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}
