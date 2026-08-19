import { useCallback, useEffect, useState } from 'react';
import type { Project } from '../shared/protocol.js';
import { Home } from './components/Home.js';
import { ProjectView } from './components/ProjectView.js';
import { Splash } from './components/Splash.js';

type Screen = { kind: 'splash' } | { kind: 'home' } | { kind: 'project'; id: string };

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>({ kind: 'splash' });
  const [projects, setProjects] = useState<Project[]>([]);

  const refresh = useCallback(async () => {
    setProjects(await window.orcrist.projects.list());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Il click sulla notifica di fine corsa riporta sul progetto giusto.
  useEffect(
    () =>
      window.orcrist.run.onFocusProject((id) => {
        void refresh();
        setScreen({ kind: 'project', id });
      }),
    [refresh],
  );

  if (screen.kind === 'splash') {
    return <Splash onDone={() => setScreen({ kind: 'home' })} />;
  }

  if (screen.kind === 'project') {
    const project = projects.find((p) => p.id === screen.id);
    if (!project) {
      return <Home projects={projects} onRefresh={refresh} onOpen={(id) => setScreen({ kind: 'project', id })} />;
    }
    return (
      <ProjectView
        project={project}
        onBack={() => {
          void refresh();
          setScreen({ kind: 'home' });
        }}
        onProjectChanged={refresh}
      />
    );
  }

  return <Home projects={projects} onRefresh={refresh} onOpen={(id) => setScreen({ kind: 'project', id })} />;
}
