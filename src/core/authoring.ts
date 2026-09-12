/**
 * Turning a user prompt into an Orcrist model.
 *
 * The model is checked with the same parser and validator the rest of the app
 * uses, and on failure the diagnostics are fed straight back to the authoring
 * LLM — a repair loop rather than a single hopeful shot, because a model that
 * does not parse is worth nothing downstream.
 */

import type { Machine } from '../orcrist/ast';
import { checkModel, formatDiagnostics, type Diagnostic } from '../orcrist';
import type { LlmMessage, LlmProvider } from './llm/types';
import type { LanguageAssets } from './paths';
import { authoringSystemPrompt } from './prompts';
import type { RunEvent } from './types';

export interface AuthorOptions {
  provider: LlmProvider;
  model: string;
  task: string;
  assets: LanguageAssets;
  /** A short listing of the workspace, so the plan can mention real files. */
  workspaceSummary?: string;
  /**
   * The tools the executing agent will have, and the model that will be
   * given them. The author writes `tools` clauses against the first and
   * sizes its sub-tasks for the second, so both are part of the brief
   * rather than something it has to guess at.
   */
  tools?: string[];
  executionModel?: string;
  /** The machine the session is already working with, if any. */
  existing?: { source: string; name: string };
  /** Earlier messages in this session, oldest first, for follow-up context. */
  history?: string[];
  attempts?: number;
  emit: (e: RunEvent) => void;
  signal?: AbortSignal;
}

export interface AuthorResult {
  /** 'keep' means: re-run the session's existing machine unchanged. */
  kind: 'machine' | 'no-machine' | 'keep';
  source?: string;
  machine?: Machine;
  warnings: Diagnostic[];
  notes: string;
  /** True when this replaces a machine the session already had. */
  revised?: boolean;
}

const FENCE = /```(?:orcrist|orc)?\s*\n([\s\S]*?)```/;

export async function authorMachine(o: AuthorOptions): Promise<AuthorResult> {
  const attempts = o.attempts ?? 3;
  const system = authoringSystemPrompt(o.assets, Boolean(o.existing), {
    tools: o.tools,
    executionModel: o.executionModel,
  });

  const messages: LlmMessage[] = [
    {
      role: 'user',
      content:
        (o.history?.length
          ? `Earlier messages in this session, oldest first:\n\n${o.history
              .map((h, i) => `${i + 1}. ${h}`)
              .join('\n')}\n\n`
          : '') +
        `New message from the user:\n\n${o.task}\n\n` +
        (o.existing
          ? `The session's current machine \`${o.existing.name}\` is:\n\n\`\`\`orcrist\n${o.existing.source}\n\`\`\`\n\n`
          : '') +
        (o.workspaceSummary
          ? `For context, the top of the project workspace looks like this:\n\n${o.workspaceSummary}\n\n`
          : '') +
        'Answer in one of the required forms.',
    },
  ];

  let lastSource = '';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (o.signal?.aborted) throw new Error('cancelled');
    o.emit({
      t: Date.now(),
      kind: 'authoring',
      text:
        attempt > 1
          ? `Repairing the model (attempt ${attempt}/${attempts})…`
          : o.existing
            ? `Deciding whether ${o.existing.name} still fits, or needs changing…`
            : 'Deciding whether this task needs a machine…',
    });

    const res = await o.provider.complete({
      system,
      messages,
      tools: [],
      disableTools: true,
      model: o.model,
      maxTokens: 8000,
      temperature: 0.2,
      signal: o.signal,
    });

    const text = res.text.trim();

    const noMachine = /^NO_MACHINE:\s*(.+)$/im.exec(text);
    const keepMachine = /^KEEP_MACHINE:\s*(.+)$/im.exec(text);
    const fenced = FENCE.exec(text);

    if (noMachine && !fenced) {
      return { kind: 'no-machine', warnings: [], notes: noMachine[1].trim() };
    }
    if (keepMachine && !fenced && o.existing) {
      return { kind: 'keep', warnings: [], notes: keepMachine[1].trim() };
    }

    if (!fenced) {
      messages.push({ role: 'assistant', content: text });
      messages.push({
        role: 'user',
        content:
          'That was not one of the required forms. Answer with a line starting `NO_MACHINE:`' +
          (o.existing ? ' or `KEEP_MACHINE:`' : '') +
          ', or with a fenced ```orcrist block containing the machine.',
      });
      continue;
    }

    const source = fenced[1].trim();
    lastSource = source;
    const plan = /^PLAN:\s*([\s\S]*?)(?:\n```|$)/im.exec(text);
    const notes = plan ? plan[1].trim() : '';

    const checked = checkModel(source, { tools: o.tools });
    if (checked.errors.length === 0 && checked.machine) {
      const revised = Boolean(o.existing);
      o.emit({
        t: Date.now(),
        kind: 'model',
        source,
        warnings: checked.warnings,
        revised,
        name: checked.machine.name,
      });
      return {
        kind: 'machine',
        source,
        machine: checked.machine,
        warnings: checked.warnings,
        notes,
        revised,
      };
    }

    o.emit({
      t: Date.now(),
      kind: 'authoring',
      text:
        `The model did not validate (attempt ${attempt}/${attempts}):\n` +
        formatDiagnostics(checked.errors),
    });

    if (attempt === attempts) break;

    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content:
        'That model does not pass the Orcrist validator:\n\n' +
        formatDiagnostics(checked.errors) +
        '\n\nFix exactly these problems and answer again with the corrected machine in a fenced ```orcrist block. Do not change anything the errors did not ask you to change.',
    });
  }

  throw new AuthoringFailure(
    `Could not produce a valid Orcrist model in ${attempts} attempts.`,
    lastSource,
  );
}

export class AuthoringFailure extends Error {
  constructor(
    message: string,
    public lastSource: string,
  ) {
    super(message);
    this.name = 'AuthoringFailure';
  }
}
