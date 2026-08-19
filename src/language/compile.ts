// =====================================================================
// Punto d'ingresso del livello linguistico: testo -> IR validato.
// =====================================================================

import { URI } from 'langium';
import type { LangiumDocument } from 'langium';
import type { CompileResult, Diagnostic } from '../shared/ir.js';

import { isMachine, type Machine } from './generated/ast.js';
import { lowerMachine } from './lower.js';
import { createOrcristServices } from './orcrist-module.js';

/** Forma minima di una diagnostica LSP: evita di dipendere dai tipi LSP. */
interface LspDiagnostic {
  severity?: number;
  /**
   * Da Langium 4 il messaggio puo' essere anche marcato invece che
   * testo semplice. Qui interessa solo la stringa da mostrare.
   */
  message: string | { kind?: string; value: string };
  code?: string | number;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

const { shared, Orcrist } = createOrcristServices();
let counter = 0;

/**
 * Parsa, linka e valida il testo di un modello.
 * Restituisce sempre le diagnostiche; l'IR solo se non ci sono errori.
 */
export async function compileModel(text: string): Promise<CompileResult> {
  const uri = URI.parse(`inmemory://model/${counter++}.orc`);
  const factory = shared.workspace.LangiumDocumentFactory;
  const doc: LangiumDocument = factory.fromString(text, uri);
  shared.workspace.LangiumDocuments.addDocument(doc);

  try {
    await shared.workspace.DocumentBuilder.build([doc], { validation: true });

    const diagnostics: Diagnostic[] = (doc.diagnostics ?? []).map((d) => toDiagnostic(d as LspDiagnostic));
    const parserErrors = doc.parseResult.parserErrors ?? [];
    for (const e of parserErrors) {
      const line = (e.token?.startLine ?? 1) - 1;
      const col = (e.token?.startColumn ?? 1) - 1;
      diagnostics.push({
        severity: 'error',
        message: e.message,
        line,
        column: col,
        endLine: (e.token?.endLine ?? e.token?.startLine ?? 1) - 1,
        endColumn: e.token?.endColumn ?? col + 1,
        code: 'parse-error',
      });
    }
    for (const e of doc.parseResult.lexerErrors ?? []) {
      diagnostics.push({
        severity: 'error',
        message: e.message,
        line: (e.line ?? 1) - 1,
        column: (e.column ?? 1) - 1,
        endLine: (e.line ?? 1) - 1,
        endColumn: (e.column ?? 1) - 1 + (e.length ?? 1),
        code: 'lexer-error',
      });
    }

    const hasErrors = diagnostics.some((d) => d.severity === 'error');
    const root = doc.parseResult.value;

    if (hasErrors || !isMachine(root)) {
      if (!hasErrors && !isMachine(root)) {
        diagnostics.push({
          severity: 'error',
          message: 'The file does not contain a machine.',
          line: 0,
          column: 0,
          endLine: 0,
          endColumn: 1,
          code: 'empty-model',
        });
      }
      return { ok: false, diagnostics };
    }

    return { ok: true, diagnostics, machine: lowerMachine(root as Machine) };
  } finally {
    await shared.workspace.DocumentBuilder.update([], [uri]);
    shared.workspace.LangiumDocuments.deleteDocument(uri);
  }
}

function toDiagnostic(d: LspDiagnostic): Diagnostic {
  const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
  return {
    severity: sev,
    message: typeof d.message === 'string' ? d.message : d.message.value,
    line: d.range.start.line,
    column: d.range.start.character,
    endLine: d.range.end.line,
    endColumn: d.range.end.character,
    code: typeof d.code === 'string' ? d.code : undefined,
  };
}
