// =====================================================================
// Workspace sandbox.
//
// Ogni percorso che l'LLM propone passa da qui. La regola e' una sola:
// dopo la risoluzione dei link simbolici il percorso deve stare dentro
// la radice del progetto. Un realpath fatto sul genitore esistente piu'
// vicino chiude anche il caso del file ancora da creare dentro una
// directory che e' un link verso l'esterno.
// =====================================================================

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export class SandboxViolation extends Error {
  constructor(requested: string, root: string) {
    super(`Accesso negato: '${requested}' e' fuori dal workspace (${root}).`);
    this.name = 'SandboxViolation';
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', 'target', '.venv', '__pycache__']);
const MAX_READ_BYTES = 400_000;
const MAX_MATCHES = 200;

export class Sandbox {
  private realRoot: string | undefined;

  constructor(readonly root: string) {}

  private async rootReal(): Promise<string> {
    if (!this.realRoot) this.realRoot = await fs.realpath(this.root);
    return this.realRoot;
  }

  /** Risolve un percorso relativo al workspace, rifiutando le evasioni. */
  async resolve(requested: string): Promise<string> {
    const root = await this.rootReal();
    const raw = path.isAbsolute(requested) ? requested : path.join(root, requested);
    const normalized = path.normalize(raw);

    // realpath del segmento esistente piu' vicino: cattura i symlink
    let probe = normalized;
    const tail: string[] = [];
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        const full = path.join(real, ...tail.reverse());
        if (full !== root && !full.startsWith(root + path.sep)) {
          throw new SandboxViolation(requested, this.root);
        }
        return full;
      } catch (err) {
        if (err instanceof SandboxViolation) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) throw new SandboxViolation(requested, this.root);
        tail.push(path.basename(probe));
        probe = parent;
      }
    }
  }

  relative(abs: string): string {
    return path.relative(this.realRoot ?? this.root, abs) || '.';
  }

  async readFile(p: string, startLine?: number, endLine?: number): Promise<string> {
    const abs = await this.resolve(p);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(`'${p}' e' una directory: usa list_dir.`);
    if (stat.size > MAX_READ_BYTES && startLine === undefined) {
      throw new Error(
        `'${p}' pesa ${Math.round(stat.size / 1024)} KB, oltre il limite. Leggi un intervallo di righe.`,
      );
    }
    const text = await fs.readFile(abs, 'utf8');
    if (startLine === undefined && endLine === undefined) return text;
    const lines = text.split('\n');
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(lines.length, endLine ?? from + 200);
    return lines
      .slice(from - 1, to)
      .map((l, i) => `${from + i}\t${l}`)
      .join('\n');
  }

  async writeFile(p: string, content: string): Promise<{ path: string; bytes: number; created: boolean }> {
    const abs = await this.resolve(p);
    let created = true;
    try {
      await fs.access(abs);
      created = false;
    } catch {
      /* nuovo file */
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { path: this.relative(abs), bytes: Buffer.byteLength(content), created };
  }

  async editFile(p: string, oldString: string, newString: string, replaceAll = false): Promise<string> {
    const abs = await this.resolve(p);
    const text = await fs.readFile(abs, 'utf8');
    const occurrences = text.split(oldString).length - 1;
    if (occurrences === 0) throw new Error(`Testo da sostituire non trovato in '${p}'.`);
    if (occurrences > 1 && !replaceAll) {
      throw new Error(`Il testo compare ${occurrences} volte in '${p}': allarga il contesto o usa replace_all.`);
    }
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
    await fs.writeFile(abs, next, 'utf8');
    return `${occurrences} sostituzione/i in ${this.relative(abs)}`;
  }

  async listDir(p = '.'): Promise<string> {
    const abs = await this.resolve(p);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return lines.length ? lines.join('\n') : '(vuota)';
  }

  async deleteFile(p: string): Promise<string> {
    const abs = await this.resolve(p);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) throw new Error(`'${p}' e' una directory: non viene cancellata.`);
    await fs.unlink(abs);
    return `Cancellato ${this.relative(abs)}`;
  }

  async search(pattern: string, subdir = '.'): Promise<string> {
    const abs = await this.resolve(subdir);
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      throw new Error(`Espressione regolare non valida: ${pattern}`);
    }
    const hits: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      if (hits.length >= MAX_MATCHES) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (hits.length >= MAX_MATCHES) return;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        if (stat.size > MAX_READ_BYTES) continue;
        let text: string;
        try {
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\0')) continue;
        text.split('\n').forEach((line, i) => {
          if (hits.length >= MAX_MATCHES) return;
          if (re.test(line)) hits.push(`${this.relative(full)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
    };

    await walk(abs);
    return hits.length ? hits.join('\n') : 'Nessuna corrispondenza.';
  }

  async tree(maxEntries = 200): Promise<string> {
    const root = await this.rootReal();
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (out.length >= maxEntries) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= maxEntries) return;
        if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
        out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
        if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}  `);
      }
    };
    await walk(root, '');
    return out.length ? out.join('\n') : '(workspace vuoto)';
  }

  /** Eseguito con cwd nel workspace; nessun tentativo di isolare la rete. */
  async runCommand(command: string, timeoutMs = 120_000): Promise<string> {
    const root = await this.rootReal();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 2_000_000,
        env: { ...process.env, ORCRIST_WORKSPACE: root },
      });
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      return out.slice(0, 20_000) || '(nessun output)';
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
      const out = [e.stdout?.trim(), e.stderr?.trim()].filter(Boolean).join('\n');
      return `Uscita ${e.code ?? '?'}\n${out || e.message || 'errore sconosciuto'}`.slice(0, 20_000);
    }
  }
}
