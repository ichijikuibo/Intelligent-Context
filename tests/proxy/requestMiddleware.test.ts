import { describe, expect, it } from 'vitest';

import {
  applyUpstreamRequestMiddleware,
  registerUpstreamRequestMiddleware,
  resolveOpencodeSessionId,
} from '../../src/proxy/requestMiddleware';

const OPENCODE_CHAT_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';
const OTHER_URL = 'https://api.deepseek.com/v1/chat/completions';

describe('proxy/requestMiddleware', () => {
  it('adds the OpenCode session header from the client session id', () => {
    const headers = applyUpstreamRequestMiddleware(OPENCODE_CHAT_URL, { Authorization: 'Bearer k' }, {
      sessionId: 'chat-session-1',
      projectId: 'project-1',
    });

    expect(headers).toEqual({
      Authorization: 'Bearer k',
      'x-opencode-session': 'chat-session-1',
    });
  });

  it('matches every OpenCode Go endpoint, not only chat completions', () => {
    const headers = applyUpstreamRequestMiddleware(OPENCODE_MODELS_URL, {}, { sessionId: 'chat-session-1' });

    expect(headers['x-opencode-session']).toBe('chat-session-1');
  });

  it('derives a stable job-scoped id for background work', () => {
    const headers = applyUpstreamRequestMiddleware(OPENCODE_CHAT_URL, {}, {
      jobKey: 'summarizer:project-1',
      projectId: 'project-1',
    });

    expect(headers['x-opencode-session']).toBe('ic-summarizer:project-1');
  });

  it('falls back to the project id when no session or job key is available', () => {
    const headers = applyUpstreamRequestMiddleware(OPENCODE_CHAT_URL, {}, { projectId: 'project-1' });

    expect(headers['x-opencode-session']).toBe('ic-project-project-1');
  });

  it('always sends a value for OpenCode so required-header 400s cannot occur', () => {
    const headers = applyUpstreamRequestMiddleware(OPENCODE_CHAT_URL, {}, {});

    expect(headers['x-opencode-session']).toBe('ic-unscoped');
  });

  it('sanitizes values that are not safe header content', () => {
    const headers = applyUpstreamRequestMiddleware(OPENCODE_CHAT_URL, {}, { sessionId: ' chat session 1 ' });

    expect(headers['x-opencode-session']).toBe('chat-session-1');
  });

  it('leaves unrelated provider URLs unchanged and does not mutate the input headers', () => {
    const original = { Authorization: 'Bearer k' };
    const headers = applyUpstreamRequestMiddleware(OTHER_URL, original, { sessionId: 'chat-session-1' });

    expect(headers).toEqual({ Authorization: 'Bearer k' });
    expect(original).toEqual({ Authorization: 'Bearer k' });
  });

  it('supports registering and removing a custom url handler', () => {
    const unregister = registerUpstreamRequestMiddleware(
      /^https:\/\/custom\.test\//i,
      () => ({ 'x-custom-session': 'custom-1' }),
    );

    try {
      expect(applyUpstreamRequestMiddleware('https://custom.test/v1/chat', {}, {})).toEqual({
        'x-custom-session': 'custom-1',
      });
    } finally {
      unregister();
    }

    expect(applyUpstreamRequestMiddleware('https://custom.test/v1/chat', {}, {})).toEqual({});
  });

  describe('resolveOpencodeSessionId', () => {
    it('prefers the session id over the job key and project id', () => {
      expect(resolveOpencodeSessionId({
        sessionId: 'chat-session-1',
        jobKey: 'summarizer:project-1',
        projectId: 'project-1',
      })).toBe('chat-session-1');
    });
  });
});
