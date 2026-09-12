import { useCallback, useEffect, useState } from 'react';
import { api, type EnvInfo } from './api';
import type { Project, Settings } from '../core/types';
import { BackIcon, PanelRightIcon, SettingsIcon } from './components/Icons';
import { FigureDefs } from './components/Figures';
import { ProjectsView } from './views/ProjectsView';
import { SessionView } from './views/SessionView';
import { SettingsView } from './views/SettingsView';
import { installScrollbarAutoHide } from './scrollbars';
import { applyTheme, rememberTheme } from './themes';

const DRAWER_KEY = 'orcrist.drawerOpen';

function loadDrawerPref(): boolean {
  try {
    return window.localStorage.getItem(DRAWER_KEY) === '1';
  } catch {
    return false;
  }
}

export function App() {
  const [project, setProject] = useState<Project>();
  // The drawer toggle lives in the title bar next to Settings, so that the two
  // icon buttons sit on one line instead of on two bars a few pixels apart.
  const [drawer, setDrawer] = useState(loadDrawerPref);
  const [settings, setSettings] = useState<Settings>();
  const [env, setEnv] = useState<EnvInfo>();
  const [showSettings, setShowSettings] = useState(false);
  const [liveState, setLiveState] = useState<string>();
  const [toast, setToast] = useState<{ msg: string; err?: boolean }>();

  // These are passed down and land in dependency arrays, so their identity has
  // to be stable. It did not matter while nothing in App changed during a run;
  // the moment App holds the executing state's name, every update to it would
  // otherwise hand SessionView new callbacks, and SessionView would reload its
  // runs from disk — dropping the streamed events the name comes from.
  const notify = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(undefined), err ? 7000 : 3000);
  }, []);

  const fail = useCallback((msg: string) => notify(msg, true), [notify]);

  useEffect(() => {
    api.settings
      .load()
      .then((s) => {
        setSettings(s);
        // the settings file is the source of truth; the boot mirror was a guess
        applyTheme(s.theme);
        rememberTheme(s.theme ?? 'sage');
      })
      .catch((e: Error) => notify(e.message, true));
    api.env.info().then(setEnv).catch(() => undefined);
    return installScrollbarAutoHide();
  }, []);

  const toggleDrawer = useCallback(
    () =>
      setDrawer((d) => {
        try {
          window.localStorage.setItem(DRAWER_KEY, d ? '0' : '1');
        } catch {
          /* a missing preference is not worth failing over */
        }
        return !d;
      }),
    [],
  );

  const configured =
    settings &&
    (settings.execution.provider === 'ollama' ||
      Boolean(settings.providers[settings.execution.provider].apiKey));

  return (
    <div className="app">
      <FigureDefs />
      <div className="titlebar">
        {project && (
          <button className="icon" onClick={() => setProject(undefined)} title="Back to projects">
            <BackIcon />
          </button>
        )}
        <span className="crumb">
          <strong>Orcrist</strong>
          {project && <> &nbsp;/&nbsp; {project.name}</>}
        </span>

        <span className="spacer" />

        {/* Only what you cannot work without: the two faults, and the two
            controls. The model in use is in Settings, one click away. */}
        {env && !env.orcristRoot && (
          <span
            className="badge err"
            title="The app could not find metamodel/orcrist.langium in this folder or any folder above it. It belongs beside the app, with examples/ next to it."
          >
            language files not found
          </span>
        )}
        {settings && !configured && (
          <span className="badge warn">no API key for {settings.execution.provider}</span>
        )}
        {/* Immediately left of the control that opens the machine — the state
            is a fact about the machine, so the two belong together. */}
        {project && liveState && (
          <button
            className="state-pill"
            onClick={() => !drawer && toggleDrawer()}
            title="Currently executing state — click to open the machine panel"
          >
            <span className="spin" />
            <span className="mono">{liveState}</span>
          </button>
        )}
        {project && (
          <button
            className={`icon ${drawer ? 'on' : ''}`}
            onClick={toggleDrawer}
            title={drawer ? 'Hide the machine panel' : 'Show the machine panel'}
            aria-pressed={drawer}
          >
            <PanelRightIcon />
          </button>
        )}
        <button className="icon" onClick={() => setShowSettings(true)} title="Settings">
          <SettingsIcon />
        </button>
      </div>

      {project ? (
        <SessionView
          project={project}
          drawer={drawer}
          onToggleDrawer={toggleDrawer}
          onLiveState={setLiveState}
          onError={fail}
        />
      ) : (
        <ProjectsView onOpen={setProject} onError={fail} />
      )}

      {showSettings && settings && (
        <SettingsView
          settings={settings}
          onSave={(s) => {
            setSettings(s);
            notify('Settings saved');
          }}
          onClose={() => setShowSettings(false)}
          onError={fail}
        />
      )}

      {toast && <div className={`toast ${toast.err ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}
