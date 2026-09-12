/**
 * The toolset the executing model gets in every state: a shell and a small
 * filesystem API, both sandboxed to the project's workspace folder, plus web
 * fetch and search.
 *
 * `report_state_writes` is not here — it is built per state from the machine's
 * `writes` clause by the executor, since its schema depends on the model.
 */

import { origin, transportReason } from '../net';
import { exec } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LlmToolDef } from '../llm/types';
import type { Settings } from '../types';

export interface ToolContext {
  workspace: string;
  settings: Settings;
}

export interface AgentTool {
  def: LlmToolDef;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolError extends Error {}

const MAX_OUTPUT = 30_000;

function clip(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return `${s.slice(0, MAX_OUTPUT)}\n… [truncated, ${s.length - MAX_OUTPUT} more characters]`;
}

/** Every path the tools touch has to resolve inside the workspace. */
export function safePath(ctx: ToolContext, p: unknown): string {
  if (typeof p !== 'string' || !p.length) throw new ToolError('path must be a non-empty string');
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.workspace, p);
  const rel = relative(resolve(ctx.workspace), abs);
  if (rel.startsWith('..') || (isAbsolute(rel) && rel !== '')) {
    throw new ToolError(
      `'${p}' is outside the project workspace; tools may only touch files under ${ctx.workspace}`,
    );
  }
  return abs;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`missing required argument '${key}'`);
    return '';
  }
  return String(v);
}

// --- filesystem --------------------------------------------------------

const listDirectory: AgentTool = {
  def: {
    name: 'list_directory',
    description:
      'List the entries of a directory inside the project workspace. Returns one entry per line, directories marked with a trailing slash and files with their size.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Directory path relative to the workspace root. Use '.' for the root.",
        },
        recursive: { type: 'boolean', description: 'Walk subdirectories (max depth 4).' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const root = safePath(ctx, str(args, 'path'));
    const recursive = args.recursive === true;
    const out: string[] = [];
    const skip = new Set(['.git', 'node_modules', '.DS_Store', 'dist', '.orcrist-agent']);

    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (skip.has(e.name)) continue;
        const abs = join(dir, e.name);
        const rel = relative(ctx.workspace, abs) || '.';
        if (e.isDirectory()) {
          out.push(`${rel}${sep}`);
          if (recursive && depth < 4) await walk(abs, depth + 1);
        } else {
          const s = await stat(abs).catch(() => undefined);
          out.push(`${rel}${s ? `  (${s.size} bytes)` : ''}`);
        }
        if (out.length > 2000) return;
      }
    };

    await walk(root, 0);
    return out.length ? clip(out.join('\n')) : '(empty directory)';
  },
};

const readFileTool: AgentTool = {
  def: {
    name: 'read_file',
    description:
      'Read a UTF-8 text file from the project workspace. Output is prefixed with line numbers so you can refer to them in edit_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        start_line: { type: 'integer', description: '1-based first line to return.' },
        end_line: { type: 'integer', description: '1-based last line to return.' },
      },
      required: ['path'],
    },
  },
  async run(args, ctx) {
    const p = safePath(ctx, str(args, 'path'));
    const content = await readFile(p, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, Number(args.start_line ?? 1));
    const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
    const width = String(end).length;
    const body = lines
      .slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width)}\t${l}`)
      .join('\n');
    return clip(body || '(empty file)');
  },
};

const writeFileTool: AgentTool = {
  def: {
    name: 'write_file',
    description:
      'Create a file in the project workspace, or overwrite it completely. Parent directories are created as needed. To change part of an existing file, prefer edit_file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The full new contents of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  async run(args, ctx) {
    const p = safePath(ctx, str(args, 'path'));
    const content = str(args, 'content', false);
    await mkdir(resolve(p, '..'), { recursive: true });
    await writeFile(p, content, 'utf8');
    return `Wrote ${content.length} characters to ${relative(ctx.workspace, p)}`;
  },
};

const editFileTool: AgentTool = {
  def: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file in the project workspace. old_string must appear exactly once unless replace_all is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_string: { type: 'string', description: 'Exact text to replace, including indentation.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  async run(args, ctx) {
    const p = safePath(ctx, str(args, 'path'));
    const oldStr = str(args, 'old_string');
    const newStr = str(args, 'new_string', false);
    const content = await readFile(p, 'utf8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new ToolError('old_string does not appear in the file');
    if (count > 1 && args.replace_all !== true) {
      throw new ToolError(
        `old_string appears ${count} times; make it unique or pass replace_all: true`,
      );
    }
    const updated =
      args.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    await writeFile(p, updated, 'utf8');
    return `Replaced ${args.replace_all === true ? count : 1} occurrence(s) in ${relative(ctx.workspace, p)}`;
  },
};

// --- shell -------------------------------------------------------------

const runCommand: AgentTool = {
  def: {
    name: 'run_command',
    description:
      'Run a shell command with the project workspace as the working directory. Returns stdout, stderr and the exit code. Use it for builds, tests, git and any other command-line work.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        timeout_seconds: {
          type: 'integer',
          description: 'How long to allow before killing it (default 120, max 600).',
        },
      },
      required: ['command'],
    },
  },
  async run(args, ctx) {
    if (!ctx.settings.enableShell) {
      throw new ToolError('The shell tool is disabled in Settings.');
    }
    const command = str(args, 'command');
    const blocked = ctx.settings.blockedCommands
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const hit = blocked.find((b) => command.includes(b));
    if (hit) throw new ToolError(`refused: the command matches the blocked pattern '${hit}'`);

    const timeout = Math.min(600, Math.max(1, Number(args.timeout_seconds ?? 120))) * 1000;
    return await new Promise<string>((resolveP) => {
      exec(
        command,
        { cwd: ctx.workspace, timeout, maxBuffer: 8 * 1024 * 1024, shell: '/bin/bash' },
        (error, stdout, stderr) => {
          const code = error && typeof (error as { code?: number }).code === 'number'
            ? (error as { code?: number }).code
            : error
              ? 1
              : 0;
          const parts: string[] = [`exit code: ${code}`];
          if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
          if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
          if (error && (error as { killed?: boolean }).killed) {
            parts.push(`(killed after ${timeout / 1000}s)`);
          }
          resolveP(clip(parts.join('\n\n')));
        },
      );
    });
  },
};

// --- web ---------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const webFetch: AgentTool = {
  def: {
    name: 'web_fetch',
    description:
      'Fetch a URL over HTTP(S) and return its content as readable text (HTML is stripped to text; JSON and plain text come back as-is).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http:// or https:// URL.' },
      },
      required: ['url'],
    },
  },
  async run(args, ctx) {
    if (!ctx.settings.enableWeb) throw new ToolError('Web tools are disabled in Settings.');
    const url = str(args, 'url');
    if (!/^https?:\/\//i.test(url)) throw new ToolError('url must start with http:// or https://');
    // A request that never left the machine arrives as the bare string "fetch
    // failed", and this one is read by the model: it has to be able to tell an
    // unreachable host from a page that answered badly.
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; OrcristAgent/0.1)' },
      redirect: 'follow',
    }).catch((e: unknown) => {
      const reason = transportReason(e);
      throw new ToolError(
        reason ? `Could not reach ${origin(url)}: ${reason}` : `${(e as Error).message}`,
      );
    });
    const ct = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = ct.includes('html') ? htmlToText(body) : body;
    return clip(`HTTP ${res.status} ${ct}\n\n${text}`);
  },
};

const webSearch: AgentTool = {
  def: {
    name: 'web_search',
    description:
      'Search the web and return the top results as title / URL / snippet. Follow up with web_fetch to read a result in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'integer', description: 'How many results to return (default 8).' },
      },
      required: ['query'],
    },
  },
  async run(args, ctx) {
    if (!ctx.settings.enableWeb) throw new ToolError('Web tools are disabled in Settings.');
    const query = str(args, 'query');
    const count = Math.min(20, Math.max(1, Number(args.count ?? 8)));
    const res = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (compatible; OrcristAgent/0.1)',
      },
      body: new URLSearchParams({ q: query }),
    }).catch((e: unknown) => {
      const reason = transportReason(e);
      throw new ToolError(
        reason
          ? `Could not reach the search backend at html.duckduckgo.com: ${reason}`
          : `${(e as Error).message}`,
      );
    });
    if (!res.ok) throw new ToolError(`search backend returned HTTP ${res.status}`);
    const html = await res.text();

    const results: string[] = [];
    const re =
      /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && results.length < count) {
      let href = m[1];
      const dd = /uddg=([^&]+)/.exec(href);
      if (dd) href = decodeURIComponent(dd[1]);
      const title = htmlToText(m[2]);
      const snippet = m[3] ? htmlToText(m[3]) : '';
      if (!title) continue;
      results.push(`${results.length + 1}. ${title}\n   ${href}${snippet ? `\n   ${snippet}` : ''}`);
    }
    if (!results.length) {
      return 'No results parsed. The search backend may have changed its markup — try web_fetch on a specific URL instead.';
    }
    return clip(results.join('\n\n'));
  },
};

// --- assembly ----------------------------------------------------------

export function buildTools(settings: Settings): AgentTool[] {
  const tools: AgentTool[] = [listDirectory, readFileTool, writeFileTool, editFileTool];
  if (settings.enableShell) tools.push(runCommand);
  if (settings.enableWeb) tools.push(webFetch, webSearch);
  return tools;
}

export async function ensureWorkspace(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await access(dir, constants.W_OK);
}
