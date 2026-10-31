import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';
import { getConfig } from '../config/config';

const PASSWORD_VERSION = 's1';
const PASSWORD_KEYLEN = 64;
const API_KEY_PREFIX = 'icu';
const SESSION_VERSION = 'v1';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

export interface SessionUserPayload {
  userId: string;
  role: string;
}

export interface SessionTokenPayload extends SessionUserPayload {
  issuedAt: number;
  expiresAt: number;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, PASSWORD_KEYLEN).toString('hex');
  return `${PASSWORD_VERSION}$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [version, salt, expectedHash] = storedHash.split('$');
  if (version !== PASSWORD_VERSION || !salt || !expectedHash) {
    return false;
  }

  const actualHash = scryptSync(password, salt, PASSWORD_KEYLEN).toString('hex');
  return safeEqualHex(actualHash, expectedHash);
}

export function generateApiKey(): string {
  return `${API_KEY_PREFIX}_${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function createSessionToken(
  payload: SessionUserPayload,
  secret: string,
  ttlMs = SESSION_TTL_MS
): string {
  const issuedAt = Date.now();
  const body: SessionTokenPayload = {
    ...payload,
    issuedAt,
    expiresAt: issuedAt + ttlMs,
  };
  const encoded = encodeBase64Url(JSON.stringify({ v: SESSION_VERSION, ...body }));
  const signature = sign(encoded, secret);
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string, secret: string): SessionTokenPayload | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) {
    return null;
  }

  const expectedSignature = sign(encoded, secret);
  if (!safeEqualText(signature, expectedSignature)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(encoded)) as {
      v?: string;
      userId?: string;
      role?: string;
      issuedAt?: number;
      expiresAt?: number;
    };

    if (
      parsed.v !== SESSION_VERSION ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.role !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }

    if (parsed.expiresAt <= Date.now()) {
      return null;
    }

    return {
      userId: parsed.userId,
      role: parsed.role,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function getSessionSecret(): string {
  return process.env.IC_SESSION_SECRET || getConfig().proxy.apiKey || '';
}

export function extractBearerToken(header?: string): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function sign(text: string, secret: string): string {
  return createHmac('sha256', secret).update(text, 'utf8').digest('base64url');
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function decodeBase64Url(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

function safeEqualHex(left: string, right: string): boolean {
  return safeEqualText(left, right);
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}