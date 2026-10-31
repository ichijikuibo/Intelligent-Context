import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getConfig } from '../config/config';
import { usersRepo, type PublicUser, type UserRole } from '../db/repositories/users';
import { normalizeRequestedModelSelection } from '../proxy/modelSelection';
import {
  extractBearerToken,
  getSessionSecret,
  hashApiKey,
  verifySessionToken,
} from './credentials';

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
      userId?: string;
      userRole?: UserRole;
      authKind?: 'session' | 'api_key' | 'legacy_proxy_key';
    }
  }
}

export const SESSION_COOKIE_NAME = 'ic_session';

const ROLE_RANK: Record<UserRole, number> = {
  user: 1,
  power_user: 2,
  admin: 3,
};

const LEGACY_ADMIN: PublicUser = {
  id: 'legacy-admin',
  email: 'legacy-admin',
  role: 'admin',
  isApproved: true,
  isDisabled: false,
  accessAllProjects: true,
  accessAllModels: true,
  allowedModels: [],
  hiddenModels: [],
  createdAt: new Date(0),
  lastLoginAt: null,
};

export interface ResolveAuthOptions {
  allowLegacyProxyKey?: boolean;
  allowSessionCookie?: boolean;
}

export async function attachAuthContext(req: Request, options: ResolveAuthOptions = {}): Promise<PublicUser | null> {
  const resolved = await resolveAuthenticatedUser(req, options);
  if (!resolved) {
    delete req.user;
    delete req.userId;
    delete req.userRole;
    delete req.authKind;
    return null;
  }

  req.user = resolved.user;
  req.userId = resolved.user.id;
  req.userRole = resolved.user.role;
  req.authKind = resolved.kind;
  return resolved.user;
}

export async function resolveAuthenticatedUser(
  req: Request,
  options: ResolveAuthOptions = {}
): Promise<{ user: PublicUser; kind: 'session' | 'api_key' | 'legacy_proxy_key' } | null> {
  const allowLegacyProxyKey = options.allowLegacyProxyKey ?? false;
  const allowSessionCookie = options.allowSessionCookie ?? true;

  if (allowSessionCookie) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE_NAME];
    const sessionUser = await resolveUserFromSessionToken(sessionToken);
    if (sessionUser) {
      return { user: sessionUser, kind: 'session' };
    }
  }

  const headerToken = extractHeaderToken(req);
  if (headerToken) {
    const sessionUser = await resolveUserFromSessionToken(headerToken);
    if (sessionUser) {
      return { user: sessionUser, kind: 'session' };
    }

    const apiKeyUser = await resolveUserFromApiKey(headerToken);
    if (apiKeyUser) {
      return { user: apiKeyUser, kind: 'api_key' };
    }

    if (allowLegacyProxyKey && isLegacyProxyKey(headerToken)) {
      return { user: LEGACY_ADMIN, kind: 'legacy_proxy_key' };
    }
  }

  return null;
}

export function requireAuthenticated(options: ResolveAuthOptions = {}): RequestHandler {
  return async (req, res, next) => {
    const user = await attachAuthContext(req, options);
    if (!user) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    next();
  };
}

export function requireRole(minRole: UserRole): RequestHandler {
  return (req, res, next) => {
    const currentRole = req.userRole;
    if (!currentRole || ROLE_RANK[currentRole] < ROLE_RANK[minRole]) {
      res.status(403).json({ error: 'You do not have access to this action.' });
      return;
    }
    next();
  };
}

/**
 * True when the user is not restricted at all: admins always have full access,
 * and `accessAllModels` is the explicit per-user switch for it.
 */
export function hasUnrestrictedModelAccess(user: PublicUser): boolean {
  return user.role === 'admin' || user.accessAllModels;
}

/**
 * Glob match for a single model grant.
 *
 * Grants are provider-scoped model IDs (`OCA-deepseek-v4`) that may contain `*`
 * as a wildcard, so admins and power users can hand out whole providers or
 * every model at once:
 *
 *   `*-*`          every model on every provider
 *   `OCA-*`        every model from provider OCA
 *   `*-deepseek-v4` that model wherever it is offered
 *   `OCA-deepseek-*` models whose ID starts with `deepseek-` on OCA
 *
 * Matching is case-insensitive because model IDs are not case-normalised by
 * every provider.
 */
export function modelGrantMatches(grant: string, candidate: string): boolean {
  const pattern = String(grant ?? '').trim();
  if (!pattern || !candidate) return false;

  // The two "everything" forms are spelled out so a bare `*` or `*-*` never
  // depends on the candidate containing a hyphen.
  if (pattern === '*' || pattern === '*-*') return true;

  if (!pattern.includes('*')) return pattern.toLowerCase() === candidate.toLowerCase();

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(candidate);
}

/**
 * Tidy a stored grant list: trim, drop blanks, de-duplicate case-insensitively
 * and remove entries already covered by a broader grant (`OCA-*` makes
 * `OCA-deepseek-v4` redundant; `*-*` makes everything redundant).
 */
export function normalizeModelGrants(grants: readonly unknown[]): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (const raw of grants) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;

    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }

  return cleaned.filter(
    (grant) =>
      !cleaned.some(
        (other) => other !== grant && other.includes('*') && modelGrantMatches(other, grant)
      )
  );
}

export function hasModelAccess(user: PublicUser, modelId: string): boolean {
  if (hasUnrestrictedModelAccess(user)) {
    return true;
  }

  if (!modelId) {
    return user.allowedModels.length > 0;
  }

  const requested = normalizeRequestedModelSelection(modelId);
  const requestedModel = requested.model || modelId;

  // A grant can be written against the provider-scoped ID, so give the matcher
  // every form of the request we can reconstruct.
  const candidates = new Set<string>([modelId]);
  if (requested.providerIdHint && requestedModel) {
    candidates.add(`${requested.providerIdHint}-${requestedModel}`);
  }
  if (requestedModel) {
    candidates.add(requestedModel);
  }

  return user.allowedModels.some((allowed) => {
    if (!allowed) {
      return false;
    }

    if (allowed === modelId) {
      return true;
    }

    if (allowed.includes('*')) {
      return [...candidates].some((candidate) => modelGrantMatches(allowed, candidate));
    }

    const normalizedAllowed = normalizeRequestedModelSelection(allowed);
    const allowedModel = normalizedAllowed.model || allowed;

    if (normalizedAllowed.providerIdHint) {
      return normalizedAllowed.providerIdHint === requested.providerIdHint && allowedModel === requestedModel;
    }

    return allowedModel === requestedModel;
  });
}

export function createSessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function resolveUserFromSessionToken(token: string | undefined): Promise<PublicUser | null> {
  if (!token) return null;

  const payload = verifySessionToken(token, getSessionSecret());
  if (!payload) return null;

  const user = await usersRepo.findById(payload.userId);
  if (!user || user.isDisabled || !user.isApproved) {
    return null;
  }

  return usersRepo.toPublicUser(user);
}

async function resolveUserFromApiKey(token: string): Promise<PublicUser | null> {
  const resolved = await usersRepo.resolveByApiKeyHash(hashApiKey(token));
  if (!resolved) {
    return null;
  }

  await usersRepo.touchApiKeyLastUsed(resolved.apiKey.id);
  return usersRepo.toPublicUser(resolved.user);
}

function extractHeaderToken(req: Request): string | null {
  const bearer = extractBearerToken(req.headers.authorization);
  const apiKey = req.headers['x-api-key'];
  return bearer ?? (typeof apiKey === 'string' ? apiKey : null);
}

function parseCookies(header?: string): Record<string, string> {
  if (!header) return {};

  return header.split(';').reduce<Record<string, string>>((acc, segment) => {
    const [name, ...rest] = segment.trim().split('=');
    if (!name || rest.length === 0) return acc;
    acc[name] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function isLegacyProxyKey(token: string): boolean {
  const configured = getConfig().proxy.apiKey;
  return !!configured && token === configured;
}