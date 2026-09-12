/**
 * Persistence.
 *
 * Settings and the project registry live in Electron's userData directory.
 * Sessions and run history live inside each project's own workspace, under
 * `.orcrist-agent/`, so a project's history travels with the project — copy the
 * folder to another machine and the sessions come with it.
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Project, type Run, type Session, type Settings } from './types';

const PROJECT_DIR = '.orcrist-agent';

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write via a temp file + rename, so a crash can't leave a half-written file. */
function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

export class Storage {
  constructor(private userDataDir: string) {
    mkdirSync(userDataDir, { recursive: true });
  }

  // --- settings -------------------------------------------------------

  private get settingsPath(): string {
    return join(this.userDataDir, 'settings.json');
  }

  loadSettings(): Settings {
    const raw = readJson<Partial<Settings>>(this.settingsPath, {});
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      providers: {
        ...DEFAULT_SETTINGS.providers,
        ...(raw.providers ?? {}),
      },
      authoring: { ...DEFAULT_SETTINGS.authoring, ...(raw.authoring ?? {}) },
      execution: { ...DEFAULT_SETTINGS.execution, ...(raw.execution ?? {}) },
    };
  }

  saveSettings(s: Settings): Settings {
    writeJson(this.settingsPath, s);
    return s;
  }

  // --- projects -------------------------------------------------------

  private get projectsPath(): string {
    return join(this.userDataDir, 'projects.json');
  }

  listProjects(): Project[] {
    return readJson<Project[]>(this.projectsPath, []).sort((a, b) =>
      (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt),
    );
  }

  createProject(name: string, workspace: string): Project {
    const projects = readJson<Project[]>(this.projectsPath, []);
    if (projects.some((p) => p.workspace === workspace)) {
      throw new Error('A project already uses that folder as its workspace.');
    }
    const project: Project = {
      id: randomUUID(),
      name: name.trim() || 'Untitled project',
      workspace,
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    writeJson(this.projectsPath, projects);
    mkdirSync(join(workspace, PROJECT_DIR, 'runs'), { recursive: true });
    return project;
  }

  updateProject(id: string, patch: Partial<Project>): Project {
    const projects = readJson<Project[]>(this.projectsPath, []);
    const i = projects.findIndex((p) => p.id === id);
    if (i < 0) throw new Error('No such project.');
    projects[i] = { ...projects[i], ...patch, id: projects[i].id };
    writeJson(this.projectsPath, projects);
    return projects[i];
  }

  /** Removes the project from the list. Files in the workspace are left alone. */
  forgetProject(id: string): void {
    const projects = readJson<Project[]>(this.projectsPath, []).filter((p) => p.id !== id);
    writeJson(this.projectsPath, projects);
  }

  getProject(id: string): Project {
    const p = this.listProjects().find((x) => x.id === id);
    if (!p) throw new Error('No such project.');
    return p;
  }

  // --- sessions -------------------------------------------------------

  private sessionsPath(project: Project): string {
    return join(project.workspace, PROJECT_DIR, 'sessions.json');
  }

  listSessions(projectId: string): Session[] {
    const project = this.getProject(projectId);
    return readJson<Session[]>(this.sessionsPath(project), []).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  createSession(projectId: string, title = 'New session'): Session {
    const project = this.getProject(projectId);
    const sessions = readJson<Session[]>(this.sessionsPath(project), []);
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      projectId,
      title,
      createdAt: now,
      updatedAt: now,
      runIds: [],
    };
    sessions.push(session);
    writeJson(this.sessionsPath(project), sessions);
    return session;
  }

  updateSession(projectId: string, sessionId: string, patch: Partial<Session>): Session {
    const project = this.getProject(projectId);
    const sessions = readJson<Session[]>(this.sessionsPath(project), []);
    const i = sessions.findIndex((s) => s.id === sessionId);
    if (i < 0) throw new Error('No such session.');
    sessions[i] = { ...sessions[i], ...patch, id: sessions[i].id, updatedAt: new Date().toISOString() };
    writeJson(this.sessionsPath(project), sessions);
    return sessions[i];
  }

  deleteSession(projectId: string, sessionId: string): void {
    const project = this.getProject(projectId);
    const sessions = readJson<Session[]>(this.sessionsPath(project), []);
    const session = sessions.find((s) => s.id === sessionId);
    writeJson(
      this.sessionsPath(project),
      sessions.filter((s) => s.id !== sessionId),
    );
    for (const runId of session?.runIds ?? []) {
      rmSync(this.runPath(project, runId), { force: true });
    }
  }

  // --- runs -----------------------------------------------------------

  private runPath(project: Project, runId: string): string {
    return join(project.workspace, PROJECT_DIR, 'runs', `${runId}.json`);
  }

  saveRun(projectId: string, run: Run): void {
    const project = this.getProject(projectId);
    writeJson(this.runPath(project, run.id), run);
    const sessions = readJson<Session[]>(this.sessionsPath(project), []);
    const s = sessions.find((x) => x.id === run.sessionId);
    if (s && !s.runIds.includes(run.id)) {
      s.runIds.push(run.id);
      s.updatedAt = new Date().toISOString();
      if (s.title === 'New session') s.title = run.task.slice(0, 60);
      writeJson(this.sessionsPath(project), sessions);
    }
  }

  loadRun(projectId: string, runId: string): Run | undefined {
    const project = this.getProject(projectId);
    const p = this.runPath(project, runId);
    return existsSync(p) ? readJson<Run | undefined>(p, undefined) : undefined;
  }

  listRuns(projectId: string, sessionId: string): Run[] {
    const project = this.getProject(projectId);
    const dir = join(project.workspace, PROJECT_DIR, 'runs');
    if (!existsSync(dir)) return [];
    const runs: Run[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const r = readJson<Run | undefined>(join(dir, f), undefined);
      if (r && r.sessionId === sessionId) runs.push(r);
    }
    return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
