// =====================================================================
// Persistenza dei progetti in un unico JSON dentro userData.
// =====================================================================

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { NewProjectInput, Project } from '../../shared/protocol.js';
import { DEFAULT_RUNTIME } from '../../shared/protocol.js';

interface ProjectFile {
  version: 1;
  projects: Project[];
}

let cache: ProjectFile | undefined;

function filePath(): string {
  return path.join(app.getPath('userData'), 'projects.json');
}

async function load(): Promise<ProjectFile> {
  if (cache) return cache;
  const p = filePath();
  if (!existsSync(p)) {
    cache = { version: 1, projects: [] };
    return cache;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(p, 'utf8')) as ProjectFile;
    cache = { version: 1, projects: parsed.projects ?? [] };
  } catch {
    // Un file corrotto non deve impedire l'avvio: lo si mette da parte.
    await fs.rename(p, `${p}.broken-${Date.now()}`).catch(() => undefined);
    cache = { version: 1, projects: [] };
  }
  return cache;
}

async function save(): Promise<void> {
  if (!cache) return;
  const p = filePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

export async function listProjects(): Promise<Project[]> {
  const f = await load();
  return [...f.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const f = await load();
  return f.projects.find((p) => p.id === id);
}

export async function createProject(input: NewProjectInput): Promise<Project> {
  const f = await load();
  const nowIso = new Date().toISOString();
  const project: Project = {
    id: randomUUID(),
    name: input.name.trim(),
    workspace: input.workspace,
    model: input.model,
    modelPath: input.modelPath,
    createdAt: nowIso,
    updatedAt: nowIso,
    runtime: { ...DEFAULT_RUNTIME, ...(input.runtime ?? {}) },
  };
  f.projects.push(project);
  await save();
  return project;
}

export async function updateProject(id: string, patch: Partial<Omit<Project, 'id'>>): Promise<Project> {
  const f = await load();
  const i = f.projects.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`Project '${id}' does not exist.`);
  const next: Project = {
    ...f.projects[i],
    ...patch,
    runtime: { ...f.projects[i].runtime, ...(patch.runtime ?? {}) },
    id,
    updatedAt: new Date().toISOString(),
  };
  f.projects[i] = next;
  await save();
  return next;
}

export async function removeProject(id: string): Promise<void> {
  const f = await load();
  f.projects = f.projects.filter((p) => p.id !== id);
  await save();
}
