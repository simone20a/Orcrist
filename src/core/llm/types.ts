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
