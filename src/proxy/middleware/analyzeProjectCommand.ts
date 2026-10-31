import type { NextFunction, Request, Response } from 'express';
import { contentToText } from '../../utils/messageContent';
import { logger } from '../../utils/logger';
import type { ChatMessage, ProxyRequest } from '../adapters/adapter';
import { isToolContinuation } from '../toolContinuation';

export const ANALYZE_PROJECT_COMMAND = '/analyze-project';

interface AnalyzeProjectCommandInvocation {
  scopeHint?: string;
}

interface BuildAnalyzeProjectPromptOptions {
  projectName?: string;
  projectRoot?: string;
  scopeHint?: string;
}

export function analyzeProjectCommandMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const body = req.body as ProxyRequest | undefined;
  if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    next();
    return;
  }

  const messages = body.messages as ChatMessage[];
  if (isToolContinuation(messages)) {
    next();
    return;
  }

  const lastNonSystem = findLastNonSystemIndex(messages);
  if (lastNonSystem < 0 || messages[lastNonSystem].role !== 'user') {
    next();
    return;
  }

  const target = messages[lastNonSystem];
  const invocation = parseAnalyzeProjectCommand(target.content);
  if (!invocation) {
    next();
    return;
  }

  const prompt = buildAnalyzeProjectPrompt({
    projectName: req.projectName,
    projectRoot: req.projectRoot,
    scopeHint: invocation.scopeHint,
  });

  const previousContent = contentToText(target.content).slice(0, 200);
  messages[lastNonSystem] = {
    ...target,
    content: replaceContentWithPrompt(target.content, prompt),
  };

  body.messages = messages;
  req.body = body;

  logger.info('Expanded analyze-project command — last user message replaced with analysis prompt', {
    projectId: req.projectId,
    sessionId: req.headers['x-session-id'] ?? req.headers['x-interaction-id'],
    requestId: req.headers['x-ic-request-id'],
    projectName: req.projectName,
    hasProjectRoot: Boolean(req.projectRoot),
    hasScopeHint: Boolean(invocation.scopeHint),
    previousContentPreview: previousContent,
    newMessageLength: prompt.length,
  });

  next();
}

export function buildAnalyzeProjectPrompt(
  options: BuildAnalyzeProjectPromptOptions = {}
): string {
  const projectLabel = options.projectName ?? 'the current project';
  const lines = [
    'You are executing a one-time bootstrap project analysis command.',
    '',
    `Project: ${projectLabel}`,
  ];

  if (options.projectRoot) {
    lines.push(`Detected project root: ${options.projectRoot}`);
  }

  if (options.scopeHint) {
    lines.push(`Requested focus: ${options.scopeHint}`);
  }

  lines.push(
    '',
    'Your task is to inspect the project broadly enough to produce initial durable learnings about the codebase.',
    'Use any workspace summary, repository tree, project root hint, attached file paths, and file-reading or search tools already available in this client session.',
    'If tools are available, inspect representative files across entrypoints, configuration, API or server routes, middleware, storage, background jobs, tests, and docs before finalizing your learnings.',
    'If tools are not available, base learnings only on information actually present in this request and do not invent file contents or repository structure.',
    'Focus on durable project facts: architecture, conventions, behavior, important subsystems, storage, APIs, workers, testing patterns, and operational constraints.',
    'Do not write a task summary, implementation plan, or generic advice.',
    'If the repository is too large to inspect fully, sample the most central files first and prefer fewer high-confidence learnings over many weak ones.',
    'Outputing the analysis to the user is not important, the learning block is the primary focus',
    'Any memories or agent instructions in the project should also be converted to facts in the learning block too',
    '',
    'When you finish:',
    '1. Your visible response must be exactly: Analysis complete.',
    '2. Any required learning or extraction block must follow the separate request-level instructions already attached to this turn.',
    '3. Do not add extra prose before or after the visible response and required learning block.'
  );

  return lines.join('\n');
}

function parseAnalyzeProjectCommand(content: unknown): AnalyzeProjectCommandInvocation | null {
  const text = contentToText(content).trim();
  if (!text) return null;

  const match = text.match(/^\/analyze-project(?:\s+([\s\S]+))?$/mi);
  if (!match) return null;

  const scopeHint = match[1]?.trim();
  return scopeHint ? { scopeHint } : {};
}

function replaceContentWithPrompt(content: unknown, prompt: string): string | unknown {
  if (Array.isArray(content)) {
    return [{ type: 'text', text: prompt }];
  }

  return prompt;
}

function findLastNonSystemIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'system') return i;
  }
  return -1;
}