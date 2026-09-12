import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Project } from '../../core/types';
import { Modal } from '../components/Modal';
import { PlusIcon, TrashIcon } from '../components/Icons';
import { Figure, MASCOTS } from '../components/Figures';

interface Props {
  onOpen: (p: Project) => void;
  onError: (msg: string) => void;
}

/** The landing screen: the user's projects, and the way to make a new one. */
export function ProjectsView({ onOpen, onError }: Props) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    api.projects
      .list()
      .then(setProjects)
      .catch((e: Error) => onError(e.message));
  };

  useEffect(refresh, []);

  const pick = async () => {
    try {
      const dir = await api.projects.pickFolder();
      if (dir) {
        setWorkspace(dir);
        if (!name.trim()) setName(dir.split('/').filter(Boolean).pop() ?? '');
      }
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const create = async () => {
    if (!name.trim() || !workspace) return;
    setBusy(true);
    try {
      const p = await api.projects.create(name.trim(), workspace);
      setCreating(false);
      setName('');
      setWorkspace('');
      onOpen(p);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = async (p: Project) => {
    try {
      onOpen(await api.projects.open(p.id));
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="projects">
      <div className="projects-inner">
        <div className="projects-head">
          <h1>
            Your
            <br />
            Projects
          </h1>
          <div className="frieze projects-frieze">
            {MASCOTS.map((m) => (
              <Figure key={m} name={m} />
            ))}
          </div>
        </div>

        <div className="project-grid">
          <button className="project-card new" onClick={() => setCreating(true)}>
            <span className="disc" aria-hidden="true">
              <PlusIcon />
            </span>
            <span>New project</span>
          </button>

          {projects.map((p, i) => (
            <div
              key={p.id}
              className="project-card"
              onClick={() => void open(p)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && void open(p)}
            >
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                {String(i + 1).padStart(2, '0')}
              </div>
              <div className="name">{p.name}</div>
              <div className="path">{p.workspace}</div>
              <div className="meta">
                <span>
                  {p.lastOpenedAt
                    ? `opened ${new Date(p.lastOpenedAt).toLocaleDateString()}`
                    : `created ${new Date(p.createdAt).toLocaleDateString()}`}
                </span>
                <span className="spacer" />
                <button
                  className="icon tiny"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.projects.forget(p.id).then(refresh);
                  }}
                  title="Remove from this list — the folder itself is untouched"
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {creating && (
        <Modal
          title="New project"
          onClose={() => setCreating(false)}
          footer={
            <>
              <button onClick={() => setCreating(false)}>Cancel</button>
              <button
                className="primary"
                disabled={!name.trim() || !workspace || busy}
                onClick={() => void create()}
              >
                {busy ? 'Creating…' : 'Create project'}
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor="pname">Project name</label>
            <input
              id="pname"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Orcrist compiler"
            />
          </div>
          <div className="field">
            <label htmlFor="pws">Workspace folder</label>
            <div className="row">
              <input
                id="pws"
                value={workspace}
                readOnly
                placeholder="No folder chosen"
                style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
              />
              <button style={{ flex: '0 0 auto' }} onClick={() => void pick()}>
                Choose…
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
