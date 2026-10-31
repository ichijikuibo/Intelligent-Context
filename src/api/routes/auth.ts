import { Router } from 'express';
import { getConfig } from '../../config/config';
import { createSessionToken, generateApiKey, getSessionSecret, hashApiKey, hashPassword, verifyPassword } from '../../auth/credentials';
import {
  attachAuthContext,
  clearSessionCookieHeader,
  createSessionCookieHeader,
  requireAuthenticated,
} from '../../auth/context';
import { usersRepo } from '../../db/repositories/users';
import { projectsRepo } from '../../db/repositories/projects';
import { createRateLimiter } from '../../utils/rateLimit';

const loginLimiter = createRateLimiter(10, 60_000);

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/bootstrap-status', async (_req, res) => {
    const userCount = await usersRepo.count();
    res.json({
      needsBootstrap: userCount === 0,
      mode: getConfig().mode,
      defaultAdminLogin: getConfig().mode === 'local' ? 'admin' : '',
    });
  });

  router.post('/bootstrap', loginLimiter, async (req, res) => {
    if ((await usersRepo.count()) > 0) {
      res.status(409).json({ error: 'Bootstrap has already been completed.' });
      return;
    }

    const rawEmail = String(req.body?.email || '').trim() || (getConfig().mode === 'local' ? 'admin' : '');
    const password = String(req.body?.password || '');
    if (!rawEmail || !password) {
      res.status(400).json({ error: 'Login and password are required.' });
      return;
    }

    const user = await usersRepo.create({
      email: rawEmail,
      passwordHash: hashPassword(password),
      role: 'admin',
      isApproved: true,
      isDisabled: false,
      accessAllProjects: true,
      accessAllModels: true,
      allowedModels: [],
    });

    const publicUser = usersRepo.toPublicUser(user);
    const token = createSessionToken({ userId: publicUser.id, role: publicUser.role }, getSessionSecret());
    res.setHeader('Set-Cookie', createSessionCookieHeader(token));

    res.status(201).json({
      user: publicUser,
      projects: await projectsRepo.findAllForUser(publicUser),
    });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      res.status(400).json({ error: 'Login and password are required.' });
      return;
    }

    const user = await usersRepo.findByEmail(email);
    // Always verify a password hash to prevent timing-based user enumeration.
    // When the user doesn't exist we use a dummy hash so the scrypt cost is
    // always paid, making response times indistinguishable.
    const passwordHash = user?.passwordHash ?? hashPassword('constant-time-guard');
    if (!user || !verifyPassword(password, passwordHash)) {
      res.status(401).json({ error: 'Invalid login or password.' });
      return;
    }

    if (user.isDisabled) {
      res.status(403).json({ error: 'This account has been disabled.' });
      return;
    }

    if (!user.isApproved) {
      res.status(403).json({ error: 'This account is awaiting approval.' });
      return;
    }

    await usersRepo.touchLastLogin(user.id);
    const publicUser = usersRepo.toPublicUser((await usersRepo.findById(user.id)) ?? user);
    const token = createSessionToken({ userId: publicUser.id, role: publicUser.role }, getSessionSecret());
    res.setHeader('Set-Cookie', createSessionCookieHeader(token));

    res.json({
      user: publicUser,
      projects: await projectsRepo.findAllForUser(publicUser),
    });
  });

  router.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    res.status(204).end();
  });

  router.get('/me', requireAuthenticated(), async (req, res) => {
    await attachAuthContext(req);
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    res.json({
      user: req.user,
      projects: await projectsRepo.findAllForUser(req.user),
    });
  });

  router.get('/api-keys', requireAuthenticated(), async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const keys = await usersRepo.listApiKeys(req.userId);
    res.json(
      keys.map((key) => ({
        id: key.id,
        name: key.name,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
        revokedAt: key.revokedAt,
      }))
    );
  });

  router.post('/api-keys', requireAuthenticated(), async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const name = String(req.body?.name || '').trim() || 'Default key';
    const plainTextKey = generateApiKey();
    const record = await usersRepo.createApiKey({
      userId: req.userId,
      name,
      keyHash: hashApiKey(plainTextKey),
    });

    res.status(201).json({
      apiKey: plainTextKey,
      record: {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
        revokedAt: record.revokedAt,
      },
    });
  });

  router.delete('/api-keys/:id', requireAuthenticated(), async (req, res) => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    const apiKeyId = req.params['id'] as string;
    const key = await usersRepo.findApiKeyById(apiKeyId);
    if (!key || key.userId !== req.userId) {
      res.status(404).json({ error: 'API key not found.' });
      return;
    }

    await usersRepo.revokeApiKey(apiKeyId);
    res.status(204).end();
  });

  return router;
}