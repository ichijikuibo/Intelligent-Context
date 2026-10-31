/**
 * The `languageModelChatProvider` implementation.
 *
 * VS Code asks this provider for the available models (which it reads from the
 * Intelligent Context proxy, so nothing is hand-typed) and then hands it each
 * chat turn to fulfil. Every request carries the workspace/project headers so
 * the proxy can inject the right project context automatically.
 */
import * as vscode from 'vscode';
import type { ConnectionStore } from './connection';
import { ModelRegistry, describeProvider, findModelEntry, resolveTokenLimits, resolveWireModel } from './modelRegistry';
import { streamChat } from './proxyClient';
import { buildProxyHeaders, collectWorkspaceSnapshot } from './workspaceContext';
import type {
  CancellationTokenLike,
  ChatContentPart,
  ChatRequest,
  ChatRequestMessage,
  ChatToolDefinition,
  ProxyExtraHeaders,
  ProxyModelEntry,
  StreamChunk,
} from './types';

const VENDOR = 'intelligent-context';

type ThinkingPartCtor = new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart;

/**
 * `LanguageModelThinkingPart` is declared behind the
 * `languageModelThinkingPart` proposed API, so it is not present in the stable
 * `@types/vscode` surface. Resolve it dynamically: when VS Code exposes it the
 * reasoning is reported in its own collapsible section, and when it does not we
 * drop the reasoning rather than rendering it as the assistant's reply.
 */
function resolveThinkingPartCtor(): ThinkingPartCtor | undefined {
  const candidate = (vscode as unknown as { LanguageModelThinkingPart?: unknown })
    .LanguageModelThinkingPart;
  return typeof candidate === 'function' ? (candidate as ThinkingPartCtor) : undefined;
}

export class IntelligentContextChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly connections: ConnectionStore,
    private readonly registry: ModelRegistry,
  ) {
    // Re-notify VS Code whenever the catalog is refreshed.
    this.registry.onDidChangeModels(() => this.changeEmitter.fire());
  }

  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  /**
   * Report the models currently offered by the proxy.
   *
   * When `options.silent` is true (e.g. a quick pick preview) no credentials are
   * requested and an unconfigured extension simply reports no models.
   */
  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasKey = await this.connections.hasApiKey();

    if (!hasKey) {
      if (options.silent) return [];

      const provided = await this.promptForApiKey();
      if (!provided) return [];
    }

    try {
      const models = await this.registry.refresh(options.silent);
      return models.map(toChatInformation);
    } catch (error) {
      if (!options.silent) {
        void vscode.window.showErrorMessage(
          `Intelligent Context: ${ModelRegistry.describeError(error)}`,
        );
      }
      // Fall back to the last known good list so the picker is not empty.
      return (this.registry.getCached()?.models ?? []).map(toChatInformation);
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const entry = this.findEntry(model.id);
    if (!entry) {
      throw new Error(
        `Intelligent Context no longer offers the model "${model.id}". Run "Intelligent Context: Refresh Model List" and pick it again.`,
      );
    }

    const { baseUrl, apiKey } = await this.connections.resolve();
    const headers = await this.resolveHeaders(entry);
    const converted = convertMessages(messages);

    const request: ChatRequest = {
      // Send the provider-scoped catalog ID (e.g. "CCO-gpt-6-astra"), not the
      // display label. The proxy parses the prefix back into a provider hint, so
      // two providers offering the same model resolve to the one the user picked.
      model: resolveWireModel(entry),
      apiFormat: entry.api_format === 'anthropic' ? 'anthropic' : 'openai',
      messages: converted.messages,
      tools: convertTools(options.tools),
      toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
      headers,
      timeoutMs: vscode.workspace
        .getConfiguration('intelligentContext')
        .get<number>('requestTimeoutMs', 600_000),
    };

    await streamChat(
      baseUrl,
      apiKey,
      request,
      (chunk) => this.report(chunk, progress),
      token as unknown as CancellationTokenLike,
    );
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const raw = typeof text === 'string' ? text : contentToText(text.content);
    return estimateTokens(raw);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private report(
    chunk: StreamChunk,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  ): void {
    switch (chunk.type) {
      case 'text':
        if (chunk.value.length > 0) {
          progress.report(new vscode.LanguageModelTextPart(chunk.value));
        }
        break;
      case 'reasoning': {
        if (chunk.value.length === 0) break;
        const ThinkingPart = resolveThinkingPartCtor();
        if (ThinkingPart) {
          progress.report(new ThinkingPart(chunk.value));
        }
        break;
      }
      case 'toolCall':
        progress.report(
          new vscode.LanguageModelToolCallPart(chunk.id, chunk.name, safeParseJson(chunk.arguments)),
        );
        break;
      case 'usage':
        // VS Code derives its own usage accounting; nothing to report here.
        break;
    }
  }

  /** Locate a catalog entry by its advertised ID. */
  private findEntry(id: string): ProxyModelEntry | undefined {
    return findModelEntry(this.registry.getCached()?.models ?? [], id);
  }

  private async resolveHeaders(entry: ProxyModelEntry): Promise<ProxyExtraHeaders> {
    const includeWorkspace = vscode.workspace
      .getConfiguration('intelligentContext')
      .get<boolean>('sendWorkspaceContext', true);

    const headers: ProxyExtraHeaders = includeWorkspace
      ? buildProxyHeaders(await collectWorkspaceSnapshot())
      : {};

    // Tell the proxy which wire protocol the client expects so it can enforce
    // a matching provider on the /v1/messages route.
    if (entry.api_format === 'anthropic') {
      headers['X-Provider-Type'] = 'anthropic';
    } else {
      headers['X-Provider-Type'] = 'openai';
    }

    return headers;
  }

  /** Prompt for the proxy API key and persist it in secret storage. */
  private async promptForApiKey(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: 'Intelligent Context — API Key',
      prompt: 'Enter the API key shown in the Intelligent Context management UI (My API Keys).',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Leave blank if your proxy does not require a key',
    });

    if (value === undefined) return false;

    await this.connections.setApiKey(value);
    return true;
  }
}

// ── Model → LanguageModelChatInformation ───────────────────────────────────

function toChatInformation(entry: ProxyModelEntry): vscode.LanguageModelChatInformation {
  const { maxInputTokens, maxOutputTokens } = resolveTokenLimits(entry);
  // The proxy already prefixes the provider, so the name is disambiguated.
  const label = entry.display_name ?? entry.model_id ?? entry.id;
  const reasoningLine = entry.supports_reasoning ? '\nReasoning levels: supported' : '';
  const visionLine = entry.supports_vision ? '\nImages: supported' : '';

  return {
    id: entry.id,
    name: label,
    family: VENDOR,
    detail: describeProvider(entry),
    tooltip: `${label}\n${describeProvider(entry)}\nModel: ${entry.model_id ?? entry.id}\nContext window: ${entry.context_window?.toLocaleString() ?? 'unknown'} tokens${reasoningLine}${visionLine}`,
    version: '1',
    maxInputTokens,
    maxOutputTokens,
    capabilities: {
      imageInput: entry.supports_vision === true,
      // The proxy injects its own learning tools, so tool calling is available.
      toolCalling: true,
    },
  };
}

// ── Message conversion ─────────────────────────────────────────────────────

interface ConvertedMessages {
  messages: ChatRequestMessage[];
}

/**
 * Convert VS Code chat messages into the extension's wire-neutral form.
 * Text parts are concatenated; tool calls and tool results are preserved so the
 * proxy can detect tool continuations and skip redundant context injection.
 */
function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ConvertedMessages {
  const converted: ChatRequestMessage[] = [];
  const DataPartCtor = resolveDataPartCtor();

  for (const message of messages) {
    const role = roleToString(message.role);
    const textParts: string[] = [];
    const imageUrls: string[] = [];
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    const toolResults: Array<{ id: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
      } else if (DataPartCtor && part instanceof (DataPartCtor as any)) {
        const imageUrl = imageDataUrl(part as unknown as DataPartLike);
        if (imageUrl) imageUrls.push(imageUrl);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push({
          id: part.callId,
          content: toolResultToText(part.content),
        });
      }
    }

    // Tool results are emitted as separate tool-role turns.
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        converted.push({
          role: 'tool',
          content: result.content,
          toolCallId: result.id,
        });
      }
      continue;
    }

    if (role === 'assistant' && toolCalls.length > 0) {
      converted.push({
        role: 'assistant',
        content: textParts.join('\n'),
        toolCalls,
      });
      continue;
    }

    if (textParts.length === 0 && imageUrls.length === 0) continue;

    converted.push({ role, content: buildMessageContent(textParts.join('\n'), imageUrls) });
  }

  return { messages: converted };
}

/**
 * Text-only turns stay a plain string; turns carrying images become content
 * blocks. The proxy accepts OpenAI-style `image_url` blocks on both routes and
 * normalises them for whichever provider serves the model.
 */
function buildMessageContent(text: string, imageUrls: readonly string[]): string | ChatContentPart[] {
  if (imageUrls.length === 0) return text;

  const parts: ChatContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

interface DataPartLike {
  mimeType?: string;
  data?: Uint8Array;
}

/**
 * `LanguageModelDataPart` is only present on newer VS Code builds, so resolve
 * it dynamically and degrade to text-only handling when it is missing.
 */
function resolveDataPartCtor(): (new (...args: unknown[]) => unknown) | undefined {
  const candidate = (vscode as unknown as { LanguageModelDataPart?: unknown }).LanguageModelDataPart;
  return typeof candidate === 'function'
    ? (candidate as new (...args: unknown[]) => unknown)
    : undefined;
}

/** Convert an image data part into an OpenAI-style data URL, or undefined. */
function imageDataUrl(part: DataPartLike): string | undefined {
  const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
  if (!mimeType.startsWith('image/') || !part.data) return undefined;

  return `data:${mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
}

function roleToString(role: vscode.LanguageModelChatMessageRole): ChatRequestMessage['role'] {
  // VS Code's chat API only distinguishes user and assistant turns; system
  // instructions are carried inside the user message content.
  return role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
}

function toolResultToText(content: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item === undefined || item === null) continue;

    if (item instanceof vscode.LanguageModelTextPart) {
      parts.push(item.value);
      continue;
    }

    try {
      parts.push(typeof item === 'string' ? item : JSON.stringify(item));
    } catch {
      parts.push(String(item));
    }
  }
  return parts.join('\n');
}

function convertTools(tools: ReadonlyArray<vscode.LanguageModelChatTool> | undefined): ChatToolDefinition[] {
  if (!tools) return [];
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

/** Extract the plain-text portion of a message's content array. */
function contentToText(content: ReadonlyArray<unknown>): string {
  return content
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('\n');
}

function safeParseJson(value: string): object {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return typeof parsed === 'object' && parsed !== null ? (parsed as object) : {};
  } catch {
    return {};
  }
}

/**
 * Local token estimate mirroring the proxy's heuristic: ~4 alpha characters per
 * token plus one token per punctuation cluster. Good enough for budgeting.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  for (const word of text.split(/\s+/)) {
    if (!word) continue;

    let alphaLength = 0;
    let symbolRuns = 0;
    let inSymbolRun = false;

    for (const character of word) {
      if (/[a-zA-Z0-9]/.test(character)) {
        alphaLength++;
        inSymbolRun = false;
      } else if (!inSymbolRun) {
        symbolRuns++;
        inSymbolRun = true;
      }
    }

    count += Math.max(1, Math.ceil(alphaLength / 4)) + symbolRuns;
  }

  // Add a small per-message priming allowance, matching the proxy's overhead.
  return Math.max(1, count + 4);
}
