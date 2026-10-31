import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
  },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: mocks.logger,
}));

import {
  ANALYZE_PROJECT_COMMAND,
  analyzeProjectCommandMiddleware,
  buildAnalyzeProjectPrompt,
} from '../../src/proxy/middleware/analyzeProjectCommand';
import type { ChatMessage } from '../../src/proxy/adapters/adapter';

function makeReq(messages: ChatMessage[]) {
  return {
    projectId: 'project-1',
    projectName: 'Project One',
    projectRoot: 'D:\\Source\\project-one',
    headers: {},
    body: { model: 'gpt-4o-mini', messages },
  } as unknown as Parameters<typeof analyzeProjectCommandMiddleware>[0];
}

function makeRes() {
  return {} as unknown as Parameters<typeof analyzeProjectCommandMiddleware>[1];
}

function next() {
  return vi.fn();
}

describe('analyzeProjectCommandMiddleware', () => {
  beforeEach(() => {
    mocks.logger.info.mockReset();
  });

  it('replaces a plain analyze-project command with a bootstrap analysis prompt', () => {
    const req = makeReq([{ role: 'user', content: ANALYZE_PROJECT_COMMAND }]);

    analyzeProjectCommandMiddleware(req, makeRes(), next());

    expect(req.body.messages).toHaveLength(1);
    expect(req.body.messages[0].role).toBe('user');
    expect(req.body.messages[0].content).toBe(buildAnalyzeProjectPrompt({
      projectName: 'Project One',
      projectRoot: 'D:\\Source\\project-one',
    }));
    expect(mocks.logger.info).toHaveBeenCalledWith(
      'Expanded analyze-project command — last user message replaced with analysis prompt',
      expect.objectContaining({
        projectId: 'project-1',
        hasProjectRoot: true,
        hasScopeHint: false,
        projectName: 'Project One',
      })
    );
  });

  it('passes along an optional focus hint from the command text', () => {
    const req = makeReq([{ role: 'user', content: '/analyze-project src/proxy src/context' }]);

    analyzeProjectCommandMiddleware(req, makeRes(), next());

    expect(req.body.messages[0].content).toBe(buildAnalyzeProjectPrompt({
      projectName: 'Project One',
      projectRoot: 'D:\\Source\\project-one',
      scopeHint: 'src/proxy src/context',
    }));
  });

  it('replaces array-based text content with a single text block prompt', () => {
    const req = makeReq([{ role: 'user', content: [{ type: 'text', text: ANALYZE_PROJECT_COMMAND }] }]);

    analyzeProjectCommandMiddleware(req, makeRes(), next());

    expect(req.body.messages[0].content).toEqual([
      {
        type: 'text',
        text: buildAnalyzeProjectPrompt({
          projectName: 'Project One',
          projectRoot: 'D:\\Source\\project-one',
        }),
      },
    ]);
  });

  it('does not rewrite ordinary user requests', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Please analyze the auth flow' }];
    const req = makeReq(messages);

    analyzeProjectCommandMiddleware(req, makeRes(), next());

    expect(req.body.messages).toEqual(messages);
    expect(mocks.logger.info).not.toHaveBeenCalled();
  });
});