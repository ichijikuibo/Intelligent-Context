import { Router, type Request } from 'express';
import { z } from 'zod';
import { runChatTurn, runChatTurnStream, type ChatTurnMessage, type ChatStreamEvent } from '../../chat/chatService';
import { projectsRepo } from '../../db/repositories/projects';
import { summariesRepo } from '../../db/repositories/summaries';
import { findingsRepo } from '../../db/repositories/findings';
import { filesRepo } from '../../db/repositories/files';
import { getSystemModelConfig } from '../../config/systemModels';
import { buildChatModelOptions, resolveChatModelOption } from '../../chat/chatModels';
import { formatZodError } from '../../i18n';

type ProjectReq = Request<{ id: string }>;

const AttachmentSchema = z.object({
  name: z.string().min(1).max(500),
  mimeType: z.string().max(200).optional(),
  text: z.string().max(2_000_000).optional(),
  data: z.string().max(20_000_000).optional(),
});

const KnowledgeRefSchema = z.object({
  type: z.enum(['summary', 'finding', 'file']),
  id: z.string().min(1).max(200),
});

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(200_000).default(''),
  attachments: z.array(AttachmentSchema).max(20).optional(),
  knowledge: z.array(KnowledgeRefSchema).max(20).optional(),
});

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(100),
  model: z.string().max(500).optional(),
  sessionId: z.string().max(200).optional(),
});

function toTurnMessages(messages: z.infer<typeof ChatMessageSchema>[]): ChatTurnMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    attachments: message.attachments,
    knowledge: message.knowledge,
  }));
}

/**
 * Project-scoped chat endpoint.
 *
 * Mounted under the project sub-router, so the project access middleware has
 * already verified the caller and `req.params.id` is the selected project. The
 * chat agent is always scoped to that project.
 */
export function createChatRouter(): Router {
  const router = Router({ mergeParams: true });

  // Lightweight status so the UI can warn before the user types when no chat
  // model is configured.
  router.get('/status', async (_req: ProjectReq, res) => {
    const models = getSystemModelConfig();
    const configured = Boolean(models.chat.trim() || models.icTools.trim());
    res.json({ configured, model: models.chat });
  });

  // Models the caller may use for chat. Reuses the same access rules as
  // `/v1/models`, so a restricted user only sees their own grants.
  router.get('/models', async (req: ProjectReq, res) => {
    const options = await buildChatModelOptions(req.user);
    const defaultModel = resolveChatModelOption(options, getSystemModelConfig().chat);
    res.json({ models: options, defaultModel });
  });

  // Knowledge entities available to attach to a message, for the picker.
  router.get('/context-options', async (req: ProjectReq, res) => {
    const projectId = req.params.id;
    const [summaries, findings, files] = await Promise.all([
      summariesRepo.findByProject(projectId),
      findingsRepo.findByProject(projectId),
      filesRepo.findByProject(projectId, { limit: 200 }),
    ]);

    res.json({
      summaries: summaries.map((summary) => ({
        id: summary.id,
        title: summary.title,
        oneLineSummary: summary.oneLineSummary,
        updatedAt: summary.updatedAt,
      })),
      findings: findings.map((finding) => ({
        id: finding.id,
        title: finding.title,
        type: finding.type,
        severity: finding.severity,
        status: finding.status,
      })),
      files: files.map((file) => ({
        id: file.id,
        fileName: file.fileName,
        purpose: file.purpose,
        chunkCount: file.chunkCount,
        summaryCount: file.summaryCount,
      })),
    });
  });

  router.post('/', async (req: ProjectReq, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const projectId = req.params.id;
    const project = await projectsRepo.findById(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const result = await runChatTurn({
      projectId,
      messages: toTurnMessages(parsed.data.messages),
      model: parsed.data.model,
      sessionId: parsed.data.sessionId,
      requestId: `chat-${projectId}-${Date.now()}`,
      user: req.user,
    });

    res.json(result);
  });

  // Server-sent-events streaming variant. Each event is `data: {json}`.
  router.post('/stream', async (req: ProjectReq, res) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const projectId = req.params.id;
    const project = await projectsRepo.findById(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    req.on('close', () => { closed = true; });

    const emit = (event: ChatStreamEvent) => {
      if (closed || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    };

    try {
      await runChatTurnStream(
        {
          projectId,
          messages: toTurnMessages(parsed.data.messages),
          model: parsed.data.model,
          sessionId: parsed.data.sessionId,
          requestId: `chat-${projectId}-${Date.now()}`,
          user: req.user,
        },
        emit,
      );
    } finally {
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });

  return router;
}
