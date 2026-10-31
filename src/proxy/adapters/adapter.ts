/** Normalised request/response types used throughout the proxy */

export interface ChatToolCallFunction {
  name?: string;
  arguments?: string | Record<string, unknown>;
}

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: ChatToolCallFunction;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ProxyRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface ProxyResponse {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
}

export interface Adapter {
  /** Transform a normalised request into provider-specific payload */
  buildRequest(req: ProxyRequest): Record<string, unknown>;
  /** Transform a provider-specific response into normalised ProxyResponse */
  parseResponse(data: unknown): ProxyResponse;
  /** Headers required by the provider */
  headers(apiKey: string): Record<string, string>;
  /** Provider's chat completions endpoint */
  endpoint(baseUrl: string): string;
}
