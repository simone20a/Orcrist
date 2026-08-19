import { useState } from 'react';
import type { Project } from '../../shared/protocol.js';
import { DWARF_PALETTE, DWARF_WALK } from '../pixel/dwarf.js';
import { PixelSprite } from '../pixel/PixelSprite.js';
import { NewProjectModal } from './NewProjectModal.js';
import { SettingsModal } from './SettingsModal.js';
import { Titlebar } from './Titlebar.js';

interface Props {
  projects: Project[];
  onRefresh: () => Promise<void>;
  onOpen: (id: string) => void;
}

export function Home({ projects, onRefresh, onOpen }: Props): JSX.Element {
  const [creating, setCreating] = useState(false);
  const [settings, setSettings] = useState(false);

  return (
    <div className="app-shell">
      <Titlebar title="Orcrist">
        <button className="btn ghost" onClick={() => setSettings(true)}>
          API Keys
        </button>
      </Titlebar>

      <div className="home">
        <div className="home-inner">
          <div className="home-head">
            <h2>Projects</h2>
            <button className="btn primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </div>

          {projects.length === 0 ? (
            <div className="empty">
              <div className="empty-walker">
                <PixelSprite
                  frames={DWARF_WALK}
                  palette={DWARF_PALETTE}
                  scale={2}
                  fps={6}
                  title="A dwarf on the move"
                />
              </div>
              No projects yet—the road is still ahead.
              <br />
              <span className="faint">
                A project has a name, a workspace directory, and an Orcrist model.
              </span>
            </div>
          ) : (
            <div className="project-list">
              {projects.map((p) => (
                <ProjectRow key={p.id} project={p} onOpen={() => onOpen(p.id)} onChanged={onRefresh} />
              ))}
            </div>
          )}
        </div>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await onRefresh();
            onOpen(id);
          }}
        />
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
    </div>
  );
}

function ProjectRow({
  project,
  onOpen,
  onChanged,
}: {
  project: Project;
  onOpen: () => void;
  onChanged: () => Promise<void>;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="project-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="meta">
        <div className="name">{project.name}</div>
        <div className="path" title={project.workspace}>
          {project.workspace}
        </div>
      </div>
      <span className="tag">{project.runtime.provider}</span>
      {confirming ? (
        <span className="row" onClick={(e) => e.stopPropagation()}>
          <button
            className="btn danger"
            onClick={async () => {
              await window.orcrist.projects.remove(project.id);
              await onChanged();
            }}
          >
            Elimina
          </button>
          <button className="btn ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          className="btn ghost"
          title="Removes the project from Orcrist. The workspace directory is left untouched."
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
