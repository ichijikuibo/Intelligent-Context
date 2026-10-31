import type { Request, Response, NextFunction } from 'express';
import { attachAuthContext } from '../../auth/context';
import { extractBearerToken } from '../../auth/credentials';
import { getConfig } from '../../config/config';
import { usersRepo } from '../../db/repositories/users';
import { t } from '../../i18n';

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const config = getConfig();
  const hasUsers = (await usersRepo.count()) > 0;

  const authenticated = await attachAuthContext(req, {
    allowLegacyProxyKey: true,
    allowSessionCookie: true,
  });
  if (authenticated) {
    next();
    return;
  }

  const provided = extractBearerToken(req.headers.authorization) ?? (req.headers['x-api-key'] as string | undefined);

  if (!provided) {
    res.status(401).json({ error: { message: t(req, 'api.error.missingAuthorizationHeader'), type: 'auth_error' } });
    return;
  }

  res.status(401).json({ error: { message: t(req, 'api.error.invalidApiKey'), type: 'auth_error' } });
}
