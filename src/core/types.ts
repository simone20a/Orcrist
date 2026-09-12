/** Application-level types shared between the main process and the renderer. */

import type { Machine } from '../orcrist/ast';
import type { Store } from '../orcrist/evaluator';
import type { Diagnostic } from '../orcrist/parser';
import type { ProviderId } from './llm/types';

export interface Project {
  id: string;
  name: string;
  /** Absolute path; every tool the agent runs is sandboxed to this folder. */
  workspace: string;
  createdAt: string;
  lastOpenedAt?: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  runIds: string[];
  /**
   * The machine the session is currently working with. It is authored by the
   * first message that needs one and survives across messages — a later message
   * can keep it, revise it or replace it outright.
   */
  machineSource?: string;
  machine?: Machine;
  machineUpdatedAt?: string;
}

export type RunStatus =
  | 'authoring'
  /** The machine is written and validated, waiting for the user to approve it. */
  | 'awaiting-approval'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Run {
  id: string;
  sessionId: string;
  task: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** Absent when the authoring step decided the task did not need a machine. */
  modelSource?: string;
  machine?: Machine;
  authoringNotes?: string;
  warnings?: Diagnostic[];
  finalState?: string;
  store?: Store;
  error?: string;
  events: RunEvent[];
}

export type RunEvent =
  | { t: number; kind: 'status'; text: string }
  | { t: number; kind: 'authoring'; text: string }
  | { t: number; kind: 'model'; source: string; warnings: Diagnostic[]; revised: boolean; name: string }
  | { t: number; kind: 'reuse-model'; name: string; reason: string }
  | { t: number; kind: 'approval-request'; name: string; revised: boolean }
  | { t: number; kind: 'approval'; name: string; approved: boolean }
  | { t: number; kind: 'no-model'; reason: string }
  | { t: number; kind: 'state-enter'; state: string; visit: number; prompt: string }
  | { t: number; kind: 'assistant'; state?: string; text: string }
  | { t: number; kind: 'tool-call'; state?: string; id: string; name: string; args: Record<string, unknown> }
  | { t: number; kind: 'tool-result'; state?: string; id: string; name: string; result: string; isError?: boolean }
  | {
      t: number;
      kind: 'observe';
      state: string;
      target: string;
      command: string;
      ok: boolean;
      detail: string;
    }
  | { t: number; kind: 'writes'; state: string; values: Record<string, unknown> }
  | { t: number; kind: 'assignment'; state: string; target: string; expr: string; value: string }
  | { t: number; kind: 'invariant'; name: string; holds: boolean }
  | { t: number; kind: 'transition'; from: string; to: string; via: 'guard' | 'otherwise' | 'limit'; label: string }
  | { t: number; kind: 'store'; store: Store }
  | { t: number; kind: 'final'; state: string }
  | { t: number; kind: 'error'; text: string };

export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
}

export interface ModelChoice {
  provider: ProviderId;
  model: string;
}

export interface Settings {
  providers: Record<ProviderId, ProviderSettings>;
  /** Model that turns a prompt into an Orcrist machine. */
  authoring: ModelChoice;
  /** Model that executes each state. */
  execution: ModelChoice;
  maxStateTransitions: number;
  maxToolRoundsPerState: number;
  enableShell: boolean;
  enableWeb: boolean;
  /** Show the authored machine and wait for approval before executing it. */
  requireModelApproval: boolean;
  /** Commands the shell tool refuses outright, one per line. */
  blockedCommands: string;
  /** Palette id; see renderer/themes.ts. Absent means the default. */
  theme?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  providers: {
    anthropic: { baseUrl: 'https://api.anthropic.com' },
    openai: { baseUrl: 'https://api.openai.com/v1' },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
  authoring: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  execution: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  maxStateTransitions: 150,
  maxToolRoundsPerState: 20,
  enableShell: true,
  enableWeb: true,
  requireModelApproval: true,
  blockedCommands: 'rm -rf /\nsudo\nshutdown\nmkfs',
  theme: 'sage',
};

export const KNOWN_MODELS: Record<ProviderId, string[]> = {
  anthropic: [
    'claude-opus-4-6',
    'claude-sonnet-4-5',
    'claude-haiku-4-5',
  ],
  openai: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4.1'],
  ollama: ['qwen2.5-coder:14b', 'llama3.1:8b', 'mistral-nemo'],
};
