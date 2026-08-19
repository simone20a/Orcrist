// Adattatore Anthropic Messages API.

import type { ChatRequest, ChatResponse, LlmProvider, Message, ProviderCredentials, ToolCall } from './types.js';
import { LlmError, postJson } from './types.js';

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Parametri di campionamento che i modelli recenti hanno smesso di
 * accettare. Non basta metterli al valore predefinito: la richiesta
 * viene rifiutata per la sola presenza del campo.
 */
const SAMPLING_PARAMS = ['temperature', 'top_p', 'top_k'] as const;
type SamplingParam = (typeof SAMPLING_PARAMS)[number];

/**
 * Quali parametri un dato modello ha rifiutato, imparato mentre si
 * lavora. Preferito a un elenco di nomi di modello scritto a mano:
 * quell'elenco invecchia a ogni rilascio, questo no.
 */
const rejectedByModel = new Map<string, Set<SamplingParam>>();

export const anthropicProvider: LlmProvider = {
  async chat(req: ChatRequest, creds: ProviderCredentials): Promise<ChatResponse> {
    if (!creds.apiKey) throw new LlmError('Anthropic API key is missing.');

    const omit = rejectedByModel.get(req.model) ?? new Set<SamplingParam>();

    try {
      return await send(req, creds, omit);
    } catch (err) {
      const deprecated = detectDeprecated(err, omit);
      if (!deprecated.length) throw err;

      for (const p of deprecated) omit.add(p);
      rejectedByModel.set(req.model, omit);
      req.onNotice?.(
        `Il modello '${req.model}' non accetta ${deprecated.join(', ')}: la richiesta e' stata ripetuta senza. ` +
          'Le prossime partono gia\' corrette.',
      );
      return send(req, creds, omit);
    }
  },
};

async function send(
  req: ChatRequest,
  creds: ProviderCredentials,
  omit: Set<SamplingParam>,
): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
  };
  // Il campo esiste solo se e' stato chiesto e il modello lo accetta.
  if (req.temperature !== undefined && !omit.has('temperature')) {
    body.temperature = req.temperature;
  }

  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
    body.tool_choice = req.forceTool ? { type: 'tool', name: req.forceTool } : { type: 'auto' };
  }

  const json = await postJson(
    `${creds.baseUrl.replace(/\/$/, '')}/v1/messages`,
    {
      'x-api-key': creds.apiKey!,
      'anthropic-version': '2023-06-01',
    },
    body,
    req.signal,
  );

  const blocks: AnthropicBlock[] = json.content ?? [];
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} }));

  if (text) req.onDelta?.(text);
  return { text, toolCalls, stopReason: json.stop_reason ?? 'end_turn' };
}

/**
 * I parametri che l'errore indica come non piu' accettati, esclusi
 * quelli che gia' non stiamo mandando — altrimenti si ritenterebbe
 * all'infinito su un 400 che parla d'altro.
 */
export function detectDeprecated(err: unknown, alreadyOmitted: Set<SamplingParam>): SamplingParam[] {
  if (!(err instanceof LlmError) || err.status !== 400) return [];
  const message = err.message.toLowerCase();
  if (!/deprecat|not support|unsupported|not permitted|no longer/.test(message)) return [];
  return SAMPLING_PARAMS.filter((p) => message.includes(p) && !alreadyOmitted.has(p));
}

/** Solo per i test: azzera quello che gli adattatori hanno imparato. */
export function resetLearnedRejections(): void {
  rejectedByModel.clear();
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: Array<{ role: string; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = [];
      if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // I risultati dei tool sono blocchi user; consecutivi vanno accorpati
    // nello stesso messaggio, altrimenti l'API rifiuta.
    const block = {
      type: 'tool_result',
      tool_use_id: m.callId,
      content: m.content,
      is_error: m.isError ?? false,
    };
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content) && isToolResultBatch(last.content)) {
      (last.content as unknown[]).push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

function isToolResultBatch(content: unknown[]): boolean {
  return content.every((b) => (b as { type?: string }).type === 'tool_result');
}
