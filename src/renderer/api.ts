import type { Project, Run, RunEvent, Session, Settings } from '../core/types';
import type { Machine } from '../orcrist/ast';
import type { Diagnostic } from '../orcrist/parser';

export interface EnvInfo {
  orcristRoot?: string;
  hasGuide: boolean;
  exampleCount: number;
  platform: string;
  version: string;
}

export interface OrcristApi {
  env: {
    info(): Promise<EnvInfo>;
    reloadAssets(): Promise<{ orcristRoot?: string; exampleCount: number }>;
    openExternal(url: string): Promise<boolean>;
    revealPath(p: string): Promise<boolean>;
  };
  settings: {
    load(): Promise<Settings>;
    save(s: Settings): Promise<Settings>;
    ollamaModels(baseUrl?: string): Promise<string[]>;
  };
  projects: {
    list(): Promise<Project[]>;
    pickFolder(): Promise<string | undefined>;
    create(name: string, workspace: string): Promise<Project>;
    open(id: string): Promise<Project>;
    rename(id: string, name: string): Promise<Project>;
    forget(id: string): Promise<boolean>;
  };
  sessions: {
    list(projectId: string): Promise<Session[]>;
    create(projectId: string, title?: string): Promise<Session>;
    rename(projectId: string, sessionId: string, title: string): Promise<Session>;
    remove(projectId: string, sessionId: string): Promise<boolean>;
    onChanged(cb: (session: Session) => void): () => void;
  };
  runs: {
    list(projectId: string, sessionId: string): Promise<Run[]>;
    get(projectId: string, runId: string): Promise<Run | undefined>;
    start(projectId: string, sessionId: string, task: string): Promise<Run>;
    cancel(runId: string): Promise<boolean>;
    approve(runId: string, approved: boolean): Promise<boolean>;
    isActive(runId: string): Promise<boolean>;
    live(): Promise<{ runId: string; sessionId: string; state?: string }[]>;
    onEvent(cb: (p: { runId: string; event: RunEvent }) => void): () => void;
    onChanged(cb: (run: Run) => void): () => void;
  };
  orcrist: {
    check(source: string): Promise<{ machine?: Machine; errors: Diagnostic[]; warnings: Diagnostic[] }>;
    examples(): Promise<{ name: string; source: string }[]>;
  };
}

declare global {
  interface Window {
    orcrist: OrcristApi;
  }
}

export const api: OrcristApi = window.orcrist;
