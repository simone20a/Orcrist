// =====================================================================
// I tool che l'agente puo' usare dentro uno stato.
//
// Quelli sui file passano tutti dal Sandbox, quindi nessuno puo' uscire
// dal workspace. Quelli sul web passano da Tavily: l'agente non apre
// mai una connessione verso un indirizzo che sceglie lui, la richiesta
// la fa Tavily e a Orcrist torna solo testo.
// =====================================================================

import type { IRLocation, IRType, IRValue } from '../../shared/ir.js';
import type { AskAnswer, AskRequest } from '../../shared/protocol.js';
import type { JsonSchema, ToolSpec } from '../llm/types.js';
import type { TavilyClient } from '../web/tavily.js';
import type { Sandbox } from './sandbox.js';

/**
 * Quello che un tool ha a disposizione: il workspace, lo stato globale
 * in sola lettura e, se configurato, il web.
 */
export interface ToolContext {
  sandbox: Sandbox;
  web?: TavilyClient;
  signal?: AbortSignal;
  /** lettura dello store; la scrittura non passa mai da un tool */
  readLocation?(name: string, path: string[]): IRValue | undefined;
  /** sospende l'esecuzione finche' la persona non risponde */
  askUser?(request: Omit<AskRequest, 'id' | 'state'>): Promise<AskAnswer>;
}

export interface ToolImpl {
  spec: ToolSpec;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const str = (description: string): JsonSchema => ({ type: 'string', description });

export const REPORT_TOOL = 'report';

export function buildFileTools(allowCommands: boolean): ToolImpl[] {
  const tools: ToolImpl[] = [
    {
      spec: {
        name: 'list_dir',
        description: 'Elenca i file e le cartelle di una directory del workspace.',
        schema: {
          type: 'object',
          properties: { path: str("Percorso relativo alla radice del workspace. Default '.'.") },
          required: [],
          additionalProperties: false,
        },
      },
      run: (i, { sandbox: s }) => s.listDir(typeof i.path === 'string' ? i.path : '.'),
    },
    {
      spec: {
        name: 'read_file',
        description:
          'Legge un file di testo del workspace. Per i file grandi indica start_line ed end_line: la risposta arriva numerata.',
        schema: {
          type: 'object',
          properties: {
            path: str('Percorso relativo alla radice del workspace.'),
            start_line: { type: 'integer', description: 'Prima riga, 1-based.' },
            end_line: { type: 'integer', description: 'Ultima riga inclusa.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      run: (i, { sandbox: s }) =>
        s.readFile(
          String(i.path),
          typeof i.start_line === 'number' ? i.start_line : undefined,
          typeof i.end_line === 'number' ? i.end_line : undefined,
        ),
    },
    {
      spec: {
        name: 'write_file',
        description: 'Scrive un file, creando le cartelle mancanti. Sovrascrive il contenuto esistente.',
        schema: {
          type: 'object',
          properties: {
            path: str('Percorso relativo alla radice del workspace.'),
            content: str('Contenuto completo del file.'),
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      run: async (i, { sandbox: s }) => {
        const r = await s.writeFile(String(i.path), String(i.content ?? ''));
        return `${r.created ? 'Creato' : 'Aggiornato'} ${r.path} (${r.bytes} byte)`;
      },
    },
    {
      spec: {
        name: 'edit_file',
        description:
          'Sostituisce una porzione esatta di testo dentro un file. Se il testo compare piu' +
          " di una volta serve replace_all, altrimenti l'operazione viene rifiutata.",
        schema: {
          type: 'object',
          properties: {
            path: str('Percorso relativo alla radice del workspace.'),
            old_string: str('Testo da sostituire, riprodotto esattamente.'),
            new_string: str('Testo nuovo.'),
            replace_all: { type: 'boolean', description: 'Sostituisce tutte le occorrenze.' },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
      },
      run: (i, { sandbox: s }) =>
        s.editFile(String(i.path), String(i.old_string), String(i.new_string ?? ''), i.replace_all === true),
    },
    {
      spec: {
        name: 'search',
        description: 'Cerca un pattern (espressione regolare) nei file di testo del workspace.',
        schema: {
          type: 'object',
          properties: {
            pattern: str('Espressione regolare.'),
            path: str("Sottocartella da cui partire. Default '.'."),
          },
          required: ['pattern'],
          additionalProperties: false,
        },
      },
      run: (i, { sandbox: s }) => s.search(String(i.pattern), typeof i.path === 'string' ? i.path : '.'),
    },
    {
      spec: {
        name: 'delete_file',
        description: 'Cancella un file del workspace. Non funziona sulle directory.',
        schema: {
          type: 'object',
          properties: { path: str('Percorso relativo alla radice del workspace.') },
          required: ['path'],
          additionalProperties: false,
        },
      },
      run: (i, { sandbox: s }) => s.deleteFile(String(i.path)),
    },
  ];

  if (allowCommands) {
    tools.push({
      spec: {
        name: 'run_command',
        description:
          'Esegue un comando di shell con working directory nella radice del workspace. ' +
          'Restituisce stdout e stderr. Timeout di due minuti.',
        schema: {
          type: 'object',
          properties: { command: str('Comando da eseguire.') },
          required: ['command'],
          additionalProperties: false,
        },
      },
      run: (i, { sandbox: s }) => s.runCommand(String(i.command)),
    });
  }

  return tools;
}

/** Tetto sul testo di una pagina: oltre, il contesto si riempie di rumore. */
const MAX_PAGE_CHARS = 24_000;

/** Tetto sul valore di una locazione restituito per intero. */
const MAX_LOCATION_CHARS = 60_000;

/**
 * Lettura dello stato globale.
 *
 * Il prompt di sistema elenca gia' tutte le locazioni con il loro
 * valore, ma abbreviato: un Text lungo ci finisce troncato e su una
 * riga sola. Questo tool restituisce il valore intero, cosi' il
 * modello puo' leggere davvero qualunque locazione — comprese quelle
 * che non potra' mai scrivere.
 *
 * E' l'unico tool sullo store, e va in una sola direzione: si legge.
 * Per scrivere esiste 'report', e solo sulle locazioni 'agent'
 * dichiarate in 'writes'.
 */
export function buildStoreTools(locations: IRLocation[]): ToolImpl[] {
  if (!locations.length) return [];

  const writable = locations.filter((l) => l.agentOwned).map((l) => l.name);
  const readOnly = locations.filter((l) => !l.agentOwned).map((l) => l.name);

  return [
    {
      spec: {
        name: 'read_location',
        description:
          "Legge per intero il valore corrente di una locazione dello stato globale. Puoi leggere " +
          'qualunque locazione della macchina, senza eccezioni' +
          (readOnly.length
            ? ` — anche quelle che non puoi scrivere (${readOnly.join(', ')}).`
            : '.') +
          (writable.length ? ` Scrivibili solo tramite 'report': ${writable.join(', ')}.` : '') +
          " Usalo quando il valore che vedi nel prompt di sistema e' troncato, o quando ti serve un" +
          ' campo preciso di un record.',
        schema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'Nome della locazione.',
              enum: locations.map((l) => l.name),
            },
            path: str(
              "Facoltativo: campo dentro un record, con i punti. Per esempio 'body' oppure 'autore.nome'.",
            ),
          },
          required: ['location'],
          additionalProperties: false,
        },
      },
      run: async (i, ctx) => {
        if (!ctx.readLocation) throw new Error('Stato globale non disponibile in questo contesto.');
        const name = String(i.location);
        const loc = locations.find((l) => l.name === name);
        if (!loc) {
          throw new Error(`'${name}' non e' una locazione di questa macchina. Disponibili: ${locations.map((l) => l.name).join(', ')}.`);
        }

        const path = typeof i.path === 'string' && i.path.trim() ? i.path.trim().split('.') : [];
        const value = ctx.readLocation(name, path);
        if (value === undefined) {
          throw new Error(`'${[name, ...path].join('.')}' non esiste: '${name}' non ha quel campo.`);
        }

        const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        const label = `${[name, ...path].join('.')} (${loc.agentOwned ? "agent, scrivibile con 'report'" : 'sola lettura'})`;
        const body =
          rendered.length > MAX_LOCATION_CHARS
            ? `${rendered.slice(0, MAX_LOCATION_CHARS)}\n[…troncata: il valore supera ${MAX_LOCATION_CHARS} caratteri]`
            : rendered;
        return `${label}\n${body || '(vuota)'}`;
      },
    },
  ];
}

/**
 * I tool web. Vengono offerti solo se c'e' una chiave Tavily
 * configurata e il progetto li ha abilitati: senza, l'agente non sa
 * nemmeno che esistono.
 */
export function buildWebTools(): ToolImpl[] {
  return [
    {
      spec: {
        name: 'web_search',
        description:
          'Cerca sul web e restituisce i risultati piu' +
          " rilevanti con titolo, URL e un estratto. Usalo quando ti serve qualcosa che non e' nel workspace: " +
          'documentazione, messaggi di errore, versioni di librerie, fatti recenti. ' +
          "Per leggere davvero una pagina trovata, chiama poi 'fetch_url'.",
        schema: {
          type: 'object',
          properties: {
            query: str('La ricerca, in linguaggio naturale.'),
            max_results: {
              type: 'integer',
              description: 'Quanti risultati restituire, da 1 a 20. Default 5.',
              minimum: 1,
              maximum: 20,
            },
            topic: {
              type: 'string',
              description: "Categoria: 'general' di default, 'news' per l'attualita', 'finance' per i mercati.",
              enum: ['general', 'news', 'finance'],
            },
            time_range: {
              type: 'string',
              description: 'Limita ai contenuti pubblicati o aggiornati nell\'ultimo periodo indicato.',
              enum: ['day', 'week', 'month', 'year'],
            },
            include_domains: {
              type: 'array',
              description: 'Restringe la ricerca a questi domini, per esempio ["docs.python.org"].',
              items: { type: 'string' },
            },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      run: async (i, ctx) => {
        if (!ctx.web) throw new Error('Ricerca web non configurata per questo progetto.');
        const res = await ctx.web.search(
          String(i.query),
          {
            maxResults: typeof i.max_results === 'number' ? i.max_results : undefined,
            topic: i.topic as 'general' | 'news' | 'finance' | undefined,
            timeRange: i.time_range as 'day' | 'week' | 'month' | 'year' | undefined,
            includeDomains: Array.isArray(i.include_domains) ? i.include_domains.map(String) : undefined,
          },
          ctx.signal,
        );

        if (!res.hits.length) return 'Nessun risultato.';
        const parts: string[] = [];
        if (res.answer) parts.push(`Sintesi: ${res.answer}`, '');
        res.hits.forEach((h, k) => {
          parts.push(`${k + 1}. ${h.title}`, `   ${h.url}`, `   ${h.content.replace(/\s+/g, ' ').slice(0, 500)}`, '');
        });
        return parts.join('\n').trim();
      },
    },
    {
      spec: {
        name: 'fetch_url',
        description:
          'Scarica una pagina web e la restituisce come testo markdown ripulito. ' +
          "Usalo dopo 'web_search' per leggere per intero un risultato promettente, " +
          'oppure quando conosci gia\' l\'indirizzo esatto di una pagina di documentazione.',
        schema: {
          type: 'object',
          properties: {
            url: str('URL completo, comprensivo di https://'),
            query: str(
              'Facoltativo: se lo indichi, la pagina viene filtrata tenendo le parti pertinenti a questa domanda.',
            ),
          },
          required: ['url'],
          additionalProperties: false,
        },
      },
      run: async (i, ctx) => {
        if (!ctx.web) throw new Error('Lettura di pagine web non configurata per questo progetto.');
        const url = String(i.url);
        if (!/^https?:\/\//i.test(url)) throw new Error(`URL non valido: '${url}'. Serve http:// o https://`);
        const res = await ctx.web.extract(url, typeof i.query === 'string' ? i.query : undefined, ctx.signal);
        const text = res.content.trim();
        if (!text) return `Pagina vuota o non estraibile: ${res.url}`;
        return text.length > MAX_PAGE_CHARS
          ? `${text.slice(0, MAX_PAGE_CHARS)}\n\n[…troncata: la pagina supera ${MAX_PAGE_CHARS} caratteri]`
          : text;
      },
    },
  ];
}

/**
 * Chiedere qualcosa alla persona davanti allo schermo.
 *
 * E' l'unico tool che ferma la macchina: l'esecuzione resta sospesa
 * finche' non arriva una risposta, oppure finche' non si preme Stop.
 * Proprio per questo la descrizione insiste sul quando usarlo — un
 * agente che chiede conferma a ogni passo e' peggio di uno che non
 * chiede mai.
 */
export function buildAskTool(): ToolImpl {
  return {
    spec: {
      name: 'ask_user',
      description:
        "Fa una domanda alla persona che sta guardando l'esecuzione e ne aspetta la risposta. " +
        "L'esecuzione della macchina resta ferma nel frattempo, quindi usalo solo quando la risposta " +
        'cambia davvero quello che farai: una decisione che non puoi prendere al posto suo, ' +
        "un'informazione che non e' nel workspace ne' sul web, una conferma prima di un'azione " +
        'difficile da annullare. Non usarlo per chiedere il permesso di continuare, ne\' per far ' +
        'confermare qualcosa che puoi verificare da solo. ' +
        "Scegli tu la forma: 'single' o 'multi' quando le alternative sono note — sono piu' rapide " +
        "da rispondere e non lasciano ambiguita' — 'open' quando serve testo libero.",
      schema: {
        type: 'object',
        properties: {
          question: str('La domanda, formulata in modo che si capisca senza altro contesto.'),
          kind: {
            type: 'string',
            description:
              "'open' per una risposta testuale, 'single' per una scelta fra alternative, " +
              "'multi' quando se ne possono scegliere piu' d'una.",
            enum: ['open', 'single', 'multi'],
          },
          options: {
            type: 'array',
            description: "Le alternative. Obbligatorie per 'single' e 'multi', ignorate per 'open'.",
            items: { type: 'string' },
          },
          placeholder: str("Suggerimento nel campo di testo, per le domande aperte."),
          allow_free_text: {
            type: 'boolean',
            description: "Per le domande chiuse: consente anche una risposta fuori elenco.",
          },
          detail: str('Contesto facoltativo: perche\' stai chiedendo, cosa comporta ciascuna scelta.'),
        },
        required: ['question', 'kind'],
        additionalProperties: false,
      },
    },
    run: async (i, ctx) => {
      if (!ctx.askUser) throw new Error("Non c'e' nessuno a cui rivolgere la domanda in questo contesto.");

      const question = String(i.question ?? '').trim();
      if (!question) throw new Error('La domanda e\' vuota.');

      const kind = i.kind === 'single' || i.kind === 'multi' ? i.kind : 'open';
      const options = Array.isArray(i.options)
        ? i.options.map((o) => String(o).trim()).filter(Boolean)
        : [];

      if ((kind === 'single' || kind === 'multi') && options.length < 2) {
        throw new Error(
          `Una domanda '${kind}' ha bisogno di almeno due alternative in 'options'. ` +
            "Se le alternative non le conosci, usa kind 'open'.",
        );
      }

      const answer = await ctx.askUser({
        question,
        kind,
        options: options.length ? options.slice(0, 12) : undefined,
        placeholder: typeof i.placeholder === 'string' ? i.placeholder : undefined,
        allowFreeText: i.allow_free_text === true,
        detail: typeof i.detail === 'string' ? i.detail : undefined,
      });

      return describeAnswer(answer);
    },
  };
}

/** La risposta come la vede il modello. */
export function describeAnswer(answer: AskAnswer): string {
  if (answer.skipped) {
    return (
      "La persona ha scelto di non rispondere. Prosegui con quello che sai, prendendo tu la decisione, " +
      'e dichiara nel resoconto che hai deciso senza conferma.'
    );
  }
  const parts: string[] = [];
  if (answer.selected?.length) {
    parts.push(
      answer.selected.length === 1
        ? `Ha scelto: ${answer.selected[0]}`
        : `Ha scelto: ${answer.selected.join(', ')}`,
    );
  }
  if (answer.text?.trim()) parts.push(`Ha scritto: ${answer.text.trim()}`);
  return parts.length ? parts.join('\n') : 'Ha risposto senza indicare niente.';
}

/**
 * Il tool di chiusura: raccoglie i valori delle locazioni dichiarate in
 * 'writes'. Lo schema deriva dai tipi del modello, cosi' il provider
 * valida gia' lui la forma e il runtime riceve dati sensati.
 */
export function buildReportTool(writes: IRLocation[]): ToolSpec {
  const properties: Record<string, JsonSchema> = {};
  for (const loc of writes) {
    properties[loc.name] = typeToSchema(loc.type, loc.name);
  }
  return {
    name: REPORT_TOOL,
    description:
      'Scrive nello stato globale della macchina. E\' l\'unico modo che hai per modificare una locazione, ' +
      `e puoi modificare solo queste: ${writes.map((w) => w.name).join(', ')}. ` +
      'Sono le locazioni marcate \'agent\' che questo stato dichiara in \'writes\'; ogni altro campo viene ' +
      'rifiutato, e le locazioni in sola lettura restano fuori dalla tua portata in ogni caso. ' +
      'Chiamalo una volta sola, alla fine: dopo, lo stato termina e la macchina valuta le guardie.',
    schema: {
      type: 'object',
      properties,
      required: writes.map((w) => w.name),
      additionalProperties: false,
    },
  };
}

export function typeToSchema(t: IRType, name: string): JsonSchema {
  switch (t.kind) {
    case 'Bool':
      return { type: 'boolean', description: `Valore di '${name}'.` };
    case 'Nat':
    case 'Int': {
      const s: JsonSchema = { type: 'integer', description: `Valore di '${name}'.` };
      if (t.lower !== undefined) s.minimum = t.lower;
      if (t.upper !== undefined) s.maximum = t.upper;
      if (t.kind === 'Nat' && s.minimum === undefined) s.minimum = 0;
      return s;
    }
    case 'Text':
      return { type: 'string', description: `Valore di '${name}'.` };
    case 'File':
      return { type: 'string', description: `Percorso di file relativo al workspace per '${name}'.` };
    case 'Enum':
      return {
        type: 'string',
        description: `Uno fra: ${t.literals.join(', ')}.`,
        enum: [...t.literals],
      };
    case 'Record': {
      const properties: Record<string, JsonSchema> = {};
      for (const f of t.fields) properties[f.name] = typeToSchema(f.type, `${name}.${f.name}`);
      return {
        type: 'object',
        description: `Valore di '${name}'.`,
        properties,
        required: t.fields.map((f) => f.name),
        additionalProperties: false,
      };
    }
  }
}
