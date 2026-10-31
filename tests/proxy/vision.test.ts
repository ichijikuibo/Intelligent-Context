import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosPost: vi.fn(),
  axiosIsAxiosError: vi.fn((error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('axios', () => ({
  default: {
    post: mocks.axiosPost,
    isAxiosError: mocks.axiosIsAxiosError,
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import { anthropicAdapter } from '../../src/proxy/adapters/anthropic';
import { openaiAdapter } from '../../src/proxy/adapters/openai';
import type { ChatMessage } from '../../src/proxy/adapters/adapter';
import {
  buildImageDescriptionText,
  buildUnavailableImageText,
  containsImages,
  describeImageWithVisionModel,
  extractImagePart,
  normalizeImagePartsForAnthropic,
  normalizeImagePartsForOpenAi,
  replaceImagesWithDescriptions,
  resetVisionDescriptionCache,
  toAnthropicImagePart,
  toOpenAiImagePart,
} from '../../src/proxy/vision';

const DATA_URL = 'data:image/png;base64,QUJD';
const OPENAI_IMAGE = { type: 'image_url', image_url: { url: DATA_URL } };
const ANTHROPIC_IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
};

describe('proxy/vision image extraction', () => {
  it('extracts an OpenAI data-URL image into its base64 form', () => {
    expect(extractImagePart(OPENAI_IMAGE)).toEqual({
      kind: 'base64',
      mediaType: 'image/png',
      data: 'QUJD',
    });
  });

  it('extracts an OpenAI remote URL image', () => {
    expect(extractImagePart({ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }))
      .toEqual({ kind: 'url', url: 'https://example.test/a.png' });
  });

  it('extracts an Anthropic base64 image', () => {
    expect(extractImagePart(ANTHROPIC_IMAGE)).toEqual({
      kind: 'base64',
      mediaType: 'image/png',
      data: 'QUJD',
    });
  });

  it('extracts an Anthropic URL image', () => {
    expect(
      extractImagePart({ type: 'image', source: { type: 'url', url: 'https://example.test/b.png' } })
    ).toEqual({ kind: 'url', url: 'https://example.test/b.png' });
  });

  it('ignores non-image content', () => {
    expect(extractImagePart({ type: 'text', text: 'hello' })).toBeUndefined();
    expect(extractImagePart('hello')).toBeUndefined();
    expect(extractImagePart(null)).toBeUndefined();
    expect(extractImagePart({ type: 'image' })).toBeUndefined();
  });

  it('renders canonical images back into both wire formats', () => {
    expect(toOpenAiImagePart({ kind: 'base64', mediaType: 'image/png', data: 'QUJD' }))
      .toEqual(OPENAI_IMAGE);
    expect(toOpenAiImagePart({ kind: 'url', url: 'https://example.test/a.png' }))
      .toEqual({ type: 'image_url', image_url: { url: 'https://example.test/a.png' } });
    expect(toAnthropicImagePart({ kind: 'base64', mediaType: 'image/png', data: 'QUJD' }))
      .toEqual(ANTHROPIC_IMAGE);
    expect(toAnthropicImagePart({ kind: 'url', url: 'https://example.test/a.png' }))
      .toEqual({ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } });
  });

  it('normalizes image blocks between wire formats and leaves text untouched', () => {
    expect(normalizeImagePartsForOpenAi([ANTHROPIC_IMAGE, { type: 'text', text: 'hi' }]))
      .toEqual([OPENAI_IMAGE, { type: 'text', text: 'hi' }]);
    expect(normalizeImagePartsForAnthropic([OPENAI_IMAGE, { type: 'text', text: 'hi' }]))
      .toEqual([ANTHROPIC_IMAGE, { type: 'text', text: 'hi' }]);
    expect(normalizeImagePartsForOpenAi('plain')).toBe('plain');
  });

  it('detects images anywhere in the conversation', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, OPENAI_IMAGE] },
    ];

    expect(containsImages(messages)).toBe(true);
    expect(containsImages([{ role: 'user', content: 'no images' }])).toBe(false);
    expect(containsImages(undefined)).toBe(false);
  });
});

describe('proxy/vision description replacement', () => {
  it('replaces every image with the produced text and counts them', async () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'before' }, OPENAI_IMAGE, ANTHROPIC_IMAGE] },
      { role: 'assistant', content: 'unchanged' },
    ];

    const replaced = await replaceImagesWithDescriptions(messages, async () => 'described');

    expect(replaced).toBe(2);
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'described' },
      { type: 'text', text: 'described' },
    ]);
    expect(messages[1]!.content).toBe('unchanged');
  });

  it('wraps descriptions so the text model knows their origin', () => {
    expect(buildImageDescriptionText('  a red dialog  '))
      .toBe('<image_description>\na red dialog\n</image_description>');
    expect(buildUnavailableImageText('nope'))
      .toBe('<image_description unavailable="true">nope</image_description>');
  });
});

describe('proxy/vision adapter normalization', () => {
  it('keeps an Anthropic image when the request is routed to an OpenAI provider', () => {
    const payload = openaiAdapter.buildRequest({
      model: 'gpt-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, ANTHROPIC_IMAGE] }],
    });

    expect(JSON.stringify(payload)).toContain('data:image/png;base64,QUJD');
    expect(JSON.stringify(payload)).not.toContain('"source"');
  });

  it('keeps an OpenAI image when the request is routed to an Anthropic provider', () => {
    const payload = anthropicAdapter.buildRequest({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, OPENAI_IMAGE] }],
    });

    const messages = payload.messages as Array<{ content: unknown[] }>;
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'look' },
      ANTHROPIC_IMAGE,
    ]);
  });
});

describe('proxy/vision model call', () => {
  const execution = {
    adapter: openaiAdapter,
    baseUrl: 'https://vision.test/v1',
    apiKey: 'vision-key',
    model: 'vision-model',
    providerName: 'Vision',
    providerType: 'openai',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetVisionDescriptionCache();
    mocks.axiosPost.mockResolvedValue({
      data: { choices: [{ message: { content: '  A screenshot of a stack trace.  ' } }] },
    });
  });

  afterEach(() => {
    resetVisionDescriptionCache();
  });

  it('posts the image to the vision model and returns its text', async () => {
    const text = await describeImageWithVisionModel(
      execution,
      extractImagePart(OPENAI_IMAGE)!,
      { requestId: 'req-1' }
    );

    expect(text).toBe('A screenshot of a stack trace.');
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);

    const [url, payload] = mocks.axiosPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://vision.test/v1/chat/completions');
    expect(payload.model).toBe('vision-model');
    expect(payload.max_tokens).toBe(1500);
    expect(JSON.stringify(payload)).toContain('data:image/png;base64,QUJD');
  });

  it('reuses a cached description for the same image and model', async () => {
    await describeImageWithVisionModel(execution, extractImagePart(OPENAI_IMAGE)!, { requestId: 'req-1' });
    const second = await describeImageWithVisionModel(execution, extractImagePart(OPENAI_IMAGE)!, { requestId: 'req-2' });

    expect(second).toBe('A screenshot of a stack trace.');
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a description across different vision models', async () => {
    await describeImageWithVisionModel(execution, extractImagePart(OPENAI_IMAGE)!, { requestId: 'req-1' });
    await describeImageWithVisionModel(
      { ...execution, model: 'other-vision-model' },
      extractImagePart(OPENAI_IMAGE)!,
      { requestId: 'req-2' }
    );

    expect(mocks.axiosPost).toHaveBeenCalledTimes(2);
  });

  it('throws when the vision model returns no text', async () => {
    mocks.axiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '' } }] } });

    await expect(
      describeImageWithVisionModel(execution, extractImagePart(OPENAI_IMAGE)!, { requestId: 'req-1' })
    ).rejects.toThrow('empty description');
  });

  it('applies the upstream request middleware so OpenCode Go gets its session header', async () => {
    const opencodeExecution = {
      ...execution,
      baseUrl: 'https://opencode.ai/zen/go/v1',
      providerName: 'opencode Go (OpenAI)',
      model: 'deepseek-v4.1-flash',
    };

    await describeImageWithVisionModel(opencodeExecution, extractImagePart(OPENAI_IMAGE)!, {
      requestId: 'req-1',
      sessionId: 'vsc-abc123',
      projectId: 'project-1',
    });

    const [, , config] = mocks.axiosPost.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];

    // Without this the upstream rejects the call with a 400.
    expect(config.headers['x-opencode-session']).toBe('vsc-abc123');
  });

  it('falls back to a stable synthetic session when the request has none', async () => {
    const opencodeExecution = {
      ...execution,
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'deepseek-v4.1-flash',
    };

    await describeImageWithVisionModel(opencodeExecution, extractImagePart(OPENAI_IMAGE)!, {
      requestId: 'req-1',
    });

    const [, , config] = mocks.axiosPost.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];

    expect(config.headers['x-opencode-session']).toBe('ic-vision:deepseek-v4.1-flash');
  });

  it('does not add the OpenCode header for other providers', async () => {
    await describeImageWithVisionModel(execution, extractImagePart(OPENAI_IMAGE)!, {
      requestId: 'req-1',
      sessionId: 'vsc-abc123',
    });

    const [, , config] = mocks.axiosPost.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];

    expect(config.headers['x-opencode-session']).toBeUndefined();
    expect(config.headers.Authorization).toBe('Bearer vision-key');
  });

  it('surfaces the upstream error body instead of a bare status code', async () => {
    mocks.axiosPost.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 400',
      response: {
        status: 400,
        data: { error: { message: 'missing x-opencode-session header' } },
      },
    });

    await expect(
      describeImageWithVisionModel(
        { ...execution, providerName: 'opencode Go (OpenAI)' },
        extractImagePart(OPENAI_IMAGE)!,
        { requestId: 'req-1' }
      )
    ).rejects.toThrow('missing x-opencode-session header');
  });
});
