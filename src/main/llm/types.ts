// =====================================================================
// Forma neutra delle conversazioni. Ogni provider adatta da e verso
// questi tipi, cosi' il motore non sa con chi sta parlando.
// =====================================================================

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string; isError?: boolean };

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  /** obbliga il modello a chiamare proprio questo tool */
  forceTool?: string;
  model: string;
  /** assente = predefinita del provider */
  temperature?: number;
  maxTokens: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** per raccontare all'utente un aggiustamento fatto dall'adattatore */
  onNotice?: (message: string) => void;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl: string;
}

export interface LlmProvider {
  chat(req: ChatRequest, creds: ProviderCredentials): Promise<ChatResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new LlmError(`Rete non raggiungibile: ${(err as Error).message}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 600);
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message ?? parsed?.message ?? detail;
    } catch {
      /* corpo non JSON */
    }
    throw new LlmError(`HTTP ${res.status}: ${detail}`, res.status);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new LlmError(`Risposta non JSON: ${raw.slice(0, 300)}`);
  }
}

let counter = 0;
export function newCallId(prefix = 'call'): string {
  return `${prefix}_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}
