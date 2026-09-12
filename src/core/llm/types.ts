import { isAbort, origin, transportReason } from '../net';
/** Provider-neutral chat + tool-calling interface. */

export type ProviderId = 'anthropic' | 'openai' | 'ollama';

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface TextMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
}

export type LlmMessage = TextMessage | ToolResultMessage;

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Forces the model to answer with prose only (used by the authoring step). */
  disableTools?: boolean;
  /**
   * Aborts the HTTP request itself. Without this, cancelling a run only takes
   * effect at the next checkpoint in the executor — which is *after* the reply
   * the model is composing right now, and a tool-using turn against a real
   * model can easily take a minute. Stop has to mean stop.
   */
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  toolCalls: ToolCall[];
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

export interface LlmProvider {
  id: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public status?: number,
    public provider?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * A transport failure, rethrown as something a user can act on: which provider,
 * which address, and what actually went wrong. See ../net.ts for the unwrapping
 * — the web tools need the same explanation, so it lives in one place.
 *
 * Cancelling a run comes through here too and must pass untouched: an
 * AbortError is the user pressing Stop, not a network fault.
 */
export function transportError(e: unknown, provider: string, url: string): never {
  if (isAbort(e)) throw e;
  if (e instanceof LlmError) throw e;
  const reason = transportReason(e) ?? (e instanceof Error ? e.message : String(e));
  throw new LlmError(`Could not reach ${provider} at ${origin(url)}: ${reason}`, undefined, provider);
}
