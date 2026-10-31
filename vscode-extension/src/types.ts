/**
 * Shared types for the Intelligent Context VS Code extension.
 *
 * The proxy's `/v1/models` response is deliberately richer than the bare
 * OpenAI model object so this extension can populate the model picker without
 * the user typing any model IDs manually.
 */

/** One entry from the proxy's `/v1/models` catalog. */
export interface ProxyModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  provider_type?: string;
  provider_name?: string;
  provider_id?: string;
  base_url?: string;
  /** Wire protocol the model expects: OpenAI chat completions or Anthropic messages. */
  api_format?: 'openai' | 'anthropic';
  /** Raw model context window, in tokens. */
  context_window?: number;
  /**
   * Whether the model accepts reasoning-effort levels. Configured per model in
   * the proxy's management UI.
   */
  supports_reasoning?: boolean;
  /**
   * Whether the model can be sent images. The proxy marks every model as
   * vision-capable once a vision model is configured, because it then
   * interprets images on the model's behalf.
   */
  supports_vision?: boolean;
  /** Prompt budget the client should use (context window minus reserved tokens). */
  max_input_tokens?: number;
  /** Tokens reserved for the model's own reply. */
  max_output_tokens?: number;
  /**
   * Raw upstream model ID. Informational — the `id` field is the value to send
   * when requesting the model, since it carries the provider scope.
   */
  model_id?: string;
  /** Human-readable label for pickers; already prefixed with the provider name. */
  display_name?: string;
}

/** A resolved connection to the Intelligent Context proxy. */
export interface ResolvedConnection {
  baseUrl: string;
  apiKey: string | undefined;
}

/** Headers the extension attaches to proxy requests. */
export interface ProxyExtraHeaders {
  'X-Project-Root'?: string;
  'X-IC-Project-Name'?: string;
  'X-IC-File'?: string;
  'X-IC-Branch'?: string;
  'X-Session-Id'?: string;
  'X-Provider-Type'?: string;
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ChatRequest {
  model: string;
  apiFormat: 'openai' | 'anthropic';
  messages: ChatRequestMessage[];
  tools: ChatToolDefinition[];
  toolMode: 'auto' | 'required' | 'none';
  headers: ProxyExtraHeaders;
  timeoutMs: number;
}

/** One part of a message's content when the message is not plain text. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /**
   * Plain text content, or a content-block array when the turn carries images.
   * Empty when the message carries only tool calls/results.
   */
  content: string | ChatContentPart[];
  /** Present on assistant messages that called tools. */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /** Present on tool-result messages. */
  toolCallId?: string;
}

/** Incremental output emitted while a chat response streams back. */
export type StreamChunk =
  | { type: 'text'; value: string }
  // Chain-of-thought / reasoning tokens. Kept distinct from `text` so callers
  // can render them in the collapsible thinking section rather than the answer.
  | { type: 'reasoning'; value: string }
  | { type: 'toolCall'; id: string; name: string; arguments: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number };

/** Minimal cancellation surface, mirroring VS Code's CancellationToken. */
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}
