/**
 * Image handling for the proxy.
 *
 * Two concerns live here:
 *
 *  1. **Wire-format normalisation.** Clients send images either as OpenAI
 *     `image_url` blocks (chat completions) or Anthropic `image` blocks
 *     (messages). The adapters call into this module so an image survives a
 *     protocol switch in either direction instead of being dropped or
 *     forwarded in a shape the upstream rejects.
 *
 *  2. **Vision delegation.** When a request carrying images targets a model the
 *     user has not marked as vision-capable, the images are sent to the
 *     configured *vision model*, and the returned description replaces the
 *     image part as text before the request is forwarded. A small TTL cache
 *     keeps the same image from being re-described on every tool continuation
 *     in a conversation.
 */
import axios from 'axios';
import type { Adapter, ChatMessage, ProxyRequest } from './adapters/adapter';
import { withParamFallback } from '../utils/paramFallback';
import { contentToText } from '../utils/messageContent';
import { sha256 } from '../utils/hashing';
import { applyUpstreamRequestMiddleware } from './requestMiddleware';
import { formatUpstreamErrorMessage } from './errorMessage';

/** Instructions sent to the vision model alongside every image. */
const VISION_SYSTEM_PROMPT = [
  'You are an image interpreter for a software engineering assistant.',
  'Describe the image precisely and completely so a text-only model can reason about it.',
  'Transcribe all visible text verbatim, including code, error messages, logs, terminal output and UI labels.',
  'Describe the layout, diagrams, charts and any relevant visual detail.',
  'Do not add commentary, opinions or follow-up questions. Respond with the description only.',
].join('\n');

const VISION_USER_PROMPT = 'Describe this image.';

/** Tokens reserved for the description returned by the vision model. */
const VISION_MAX_OUTPUT_TOKENS = 1500;

/** The vision call is a side channel, so keep it from stalling the request. */
const VISION_TIMEOUT_MS = 60_000;

/** How long a description is reused before the image is re-interpreted. */
const DESCRIPTION_TTL_MS = 30 * 60 * 1000;

/** Upper bound on cached descriptions so a long session cannot grow unbounded. */
const MAX_CACHED_DESCRIPTIONS = 100;

/** An image extracted from a message, normalised across wire formats. */
export interface ExtractedImage {
  kind: 'url' | 'base64';
  /** Set when `kind === 'url'`. */
  url?: string;
  /** Set when `kind === 'base64'` (e.g. `image/png`). */
  mediaType?: string;
  /** Base64 payload, set when `kind === 'base64'`. */
  data?: string;
}

/** The provider-side execution details a vision description needs. */
export interface VisionExecution {
  adapter: Adapter;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
  providerType: string;
}

export interface VisionCallContext {
  projectId?: string;
  sessionId?: string;
  requestId: string;
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/s;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBase64Image(url: string): ExtractedImage | undefined {
  const match = url.match(DATA_URL_PATTERN);
  if (!match) return undefined;
  return {
    kind: 'base64',
    mediaType: match[1]!.trim(),
    data: match[2]!.replace(/\s/g, ''),
  };
}

/**
 * Recognise an image part in either wire format and return its canonical form.
 * Returns `undefined` for any other content block.
 */
export function extractImagePart(part: unknown): ExtractedImage | undefined {
  if (!isRecord(part)) return undefined;

  // OpenAI chat completions: { type: 'image_url', image_url: { url } }
  if (part.type === 'image_url') {
    const imageUrl = part.image_url;
    const url =
      typeof imageUrl === 'string'
        ? imageUrl
        : isRecord(imageUrl) && typeof imageUrl.url === 'string'
          ? imageUrl.url
          : undefined;
    if (!url) return undefined;

    return toBase64Image(url) ?? { kind: 'url', url };
  }

  // Anthropic messages: { type: 'image', source: { type: 'base64' | 'url', ... } }
  if (part.type === 'image') {
    const source = part.source;
    if (!isRecord(source)) return undefined;

    if (source.type === 'base64' && typeof source.data === 'string') {
      return {
        kind: 'base64',
        mediaType: typeof source.media_type === 'string' ? source.media_type : 'image/png',
        data: source.data.replace(/\s/g, ''),
      };
    }

    if (source.type === 'url' && typeof source.url === 'string') {
      return toBase64Image(source.url) ?? { kind: 'url', url: source.url };
    }
  }

  return undefined;
}

/** True when a content block is an image in either wire format. */
export function isImagePart(part: unknown): boolean {
  return extractImagePart(part) !== undefined;
}

/** Render a canonical image as an OpenAI `image_url` block. */
export function toOpenAiImagePart(image: ExtractedImage): Record<string, unknown> {
  if (image.kind === 'base64') {
    return {
      type: 'image_url',
      image_url: {
        url: `data:${image.mediaType ?? 'image/png'};base64,${image.data ?? ''}`,
      },
    };
  }

  return { type: 'image_url', image_url: { url: image.url ?? '' } };
}

/** Render a canonical image as an Anthropic `image` block. */
export function toAnthropicImagePart(image: ExtractedImage): Record<string, unknown> {
  if (image.kind === 'base64') {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType ?? 'image/png',
        data: image.data ?? '',
      },
    };
  }

  return { type: 'image', source: { type: 'url', url: image.url ?? '' } };
}

/**
 * Convert any Anthropic-shaped image blocks in a content payload to OpenAI
 * `image_url` blocks. Non-image content is returned untouched.
 */
export function normalizeImagePartsForOpenAi(content: unknown): unknown {
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (isRecord(part) && part.type === 'image') {
      const image = extractImagePart(part);
      if (image) return toOpenAiImagePart(image);
    }
    return part;
  });
}

/**
 * Convert any OpenAI-shaped image blocks in a content payload to Anthropic
 * `image` blocks. Non-image content is returned untouched.
 */
export function normalizeImagePartsForAnthropic(content: unknown): unknown {
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (isRecord(part) && part.type === 'image_url') {
      const image = extractImagePart(part);
      if (image) return toAnthropicImagePart(image);
    }
    return part;
  });
}

/** True when any message in the conversation carries an image. */
export function containsImages(messages: ChatMessage[] | undefined): boolean {
  if (!Array.isArray(messages)) return false;

  return messages.some(
    (message) => Array.isArray(message?.content) && message.content.some((part) => isImagePart(part))
  );
}

/** Wrap a vision model's description so the text model knows where it came from. */
export function buildImageDescriptionText(description: string): string {
  return `<image_description>\n${description.trim()}\n</image_description>`;
}

/** Placeholder used when an image cannot be interpreted. */
export function buildUnavailableImageText(reason: string): string {
  return `<image_description unavailable="true">${reason}</image_description>`;
}

/**
 * Replace every image block in the conversation with a text block produced by
 * `describe`. Returns the number of images replaced.
 */
export async function replaceImagesWithDescriptions(
  messages: ChatMessage[],
  describe: (image: ExtractedImage) => Promise<string>
): Promise<number> {
  let replaced = 0;

  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;

    const nextContent: unknown[] = [];
    for (const part of message.content) {
      const image = extractImagePart(part);
      if (!image) {
        nextContent.push(part);
        continue;
      }

      nextContent.push({ type: 'text', text: await describe(image) });
      replaced += 1;
    }

    message.content = nextContent;
  }

  return replaced;
}

// ── Description cache ──────────────────────────────────────────────────────

interface CachedDescription {
  text: string;
  expiresAt: number;
}

const descriptionCache = new Map<string, CachedDescription>();

function descriptionCacheKey(image: ExtractedImage, visionModel: string): string {
  const payload = image.kind === 'base64' ? (image.data ?? '') : (image.url ?? '');
  return `${visionModel}::${sha256(payload)}`;
}

function readCachedDescription(image: ExtractedImage, visionModel: string): string | undefined {
  const key = descriptionCacheKey(image, visionModel);
  const entry = descriptionCache.get(key);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    descriptionCache.delete(key);
    return undefined;
  }

  // Refresh recency so frequently used images survive the size cap.
  descriptionCache.delete(key);
  descriptionCache.set(key, entry);
  return entry.text;
}

function writeCachedDescription(image: ExtractedImage, visionModel: string, text: string): void {
  const key = descriptionCacheKey(image, visionModel);
  descriptionCache.set(key, { text, expiresAt: Date.now() + DESCRIPTION_TTL_MS });

  while (descriptionCache.size > MAX_CACHED_DESCRIPTIONS) {
    const oldest = descriptionCache.keys().next().value;
    if (oldest === undefined) break;
    descriptionCache.delete(oldest);
  }
}

/** Reset the description cache (tests, or a full reload). */
export function resetVisionDescriptionCache(): void {
  descriptionCache.clear();
}

/**
 * Ask the vision model to describe one image.
 *
 * Throws when the upstream call fails or returns no usable text; callers decide
 * whether that should degrade to a placeholder or fail the request.
 */
export async function describeImageWithVisionModel(
  execution: VisionExecution,
  image: ExtractedImage,
  ctx: VisionCallContext
): Promise<string> {
  const cached = readCachedDescription(image, execution.model);
  if (cached !== undefined) return cached;

  const request: ProxyRequest = {
    model: execution.model,
    messages: [
      { role: 'system', content: VISION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_USER_PROMPT },
          toOpenAiImagePart(image),
        ],
      },
    ],
    stream: false,
    temperature: 0,
    max_tokens: VISION_MAX_OUTPUT_TOKENS,
  };

  const url = execution.adapter.endpoint(execution.baseUrl);
  // Vision calls are proxy-generated, but some upstreams still require their
  // own transport headers (OpenCode Go needs a stable session id), so they have
  // to go through the same middleware as every other upstream call.
  const headers = applyUpstreamRequestMiddleware(
    url,
    execution.adapter.headers(execution.apiKey),
    {
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      jobKey: `vision:${execution.model}`,
    }
  );

  let result: { data: unknown };
  try {
    ({ result } = await withParamFallback(
      request,
      execution.adapter,
      {
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        requestId: `${ctx.requestId}-vision`,
        model: execution.model,
        providerName: execution.providerName,
        providerType: execution.providerType,
        url,
        requestHeaders: headers,
      },
      (payload) => axios.post(url, payload, { headers, timeout: VISION_TIMEOUT_MS })
    ));
  } catch (err) {
    // The upstream body carries the real reason (missing header, unsupported
    // parameter, …); axios's own message only says "status code 400".
    throw new Error(`Vision request to ${execution.providerName} failed: ${formatUpstreamErrorMessage(err)}`);
  }

  const parsed = execution.adapter.parseResponse(result.data);
  const text = contentToText(parsed.choices?.[0]?.message?.content).trim();
  if (!text) {
    throw new Error('The vision model returned an empty description.');
  }

  writeCachedDescription(image, execution.model, text);
  return text;
}
