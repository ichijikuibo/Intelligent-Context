import type { NextFunction, Request, Response } from 'express';
import type { ZodError, ZodIssue } from 'zod';
import { DEFAULT_LOCALE, MESSAGES, SUPPORTED_LOCALES, type Locale } from './messages';
import type { MessageCatalog } from './locales/en';

declare global {
  namespace Express {
    interface Request {
      locale?: Locale;
    }
  }
}

type MessageVars = Record<string, string | number | boolean | null | undefined>;

const FIELD_LABELS: Record<string, string> = {
  name: 'field.name',
  rootPath: 'field.rootPath',
  pathPattern: 'field.pathPattern',
  baseUrl: 'field.baseUrl',
  apiKey: 'field.apiKey',
  models: 'field.models',
  type: 'field.type',
  status: 'field.status',
  contextSelectorModel: 'field.contextSelectorModel',
  summarizerModel: 'field.summarizerModel',
  analyzerModel: 'field.analyzerModel',
  learningModel: 'field.learningModel',
  defaultProvider: 'field.defaultProvider',
  visionModel: 'field.visionModel',
  modelId: 'field.modelId',
  displayName: 'field.displayName',
  contextLength: 'field.contextLength',
  apiFormat: 'field.apiFormat',
  supportsReasoning: 'field.supportsReasoning',
};

function normalizeLocaleCode(input: string): Locale | undefined {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;

  for (const part of trimmed.split(',')) {
    const token = part.split(';')[0]?.trim();
    if (!token) continue;

    if (token in MESSAGES) {
      return token as Locale;
    }

    const base = token.split('-')[0]?.trim();
    if (base && base in MESSAGES) {
      return base as Locale;
    }
  }

  return undefined;
}

function interpolate(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? `{${key}}` : String(value);
  });
}

export function resolveLocale(req: Request): Locale {
  if (req.locale) return req.locale;

  const headerLocale = req.headers['x-ic-locale'];
  const requestedHeader = Array.isArray(headerLocale) ? headerLocale[0] : headerLocale;
  const queryLocale = typeof req.query.lang === 'string' ? req.query.lang : undefined;
  const accepted = typeof req.headers['accept-language'] === 'string'
    ? req.headers['accept-language']
    : undefined;

  return (
    (requestedHeader ? normalizeLocaleCode(requestedHeader) : undefined) ??
    (queryLocale ? normalizeLocaleCode(queryLocale) : undefined) ??
    (accepted ? normalizeLocaleCode(accepted) : undefined) ??
    DEFAULT_LOCALE
  );
}

export function localeMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.locale = resolveLocale(req);
  res.setHeader('Content-Language', req.locale);
  next();
}

export function t(localeOrReq: Locale | Request, key: string, vars?: MessageVars): string {
  const locale = typeof localeOrReq === 'string' ? localeOrReq : resolveLocale(localeOrReq);
  const localizedCatalog = MESSAGES[locale] as Record<string, string>;
  const fallbackCatalog = MESSAGES[DEFAULT_LOCALE] as Record<string, string>;
  const template = localizedCatalog[key] ?? fallbackCatalog[key] ?? key;
  return interpolate(template, vars);
}

function fieldLabel(locale: Locale, fieldName?: string): string {
  if (!fieldName) return t(locale, 'field.request');
  return t(locale, FIELD_LABELS[fieldName] ?? 'field.request');
}

function formatIssue(locale: Locale, issue: ZodIssue): string {
  const field = fieldLabel(locale, String(issue.path[0] ?? ''));

  // Zod 4 renamed/dropped several issue properties.
  // invalid_type no longer carries `received`, so we can't distinguish
  // "required" from "wrong type" at the issue level.
  if (issue.code === 'invalid_type') {
    return t(locale, 'validation.invalidValue', { field });
  }

  if (issue.code === 'too_small') {
    return t(locale, 'validation.required', { field });
  }

  // Zod 4: was invalid_string with validation==='url', now invalid_format
  if (issue.code === 'invalid_format') {
    return t(locale, issue.format === 'url' ? 'validation.invalidUrl' : 'validation.invalidValue', {
      field,
    });
  }

  // Zod 4: was invalid_enum_value, now invalid_value
  if (issue.code === 'invalid_value') {
    return t(locale, 'validation.invalidChoice', { field });
  }

  return t(locale, 'api.error.invalidRequest');
}

export function formatZodError(req: Request, error: ZodError): string {
  const locale = resolveLocale(req);
  return error.issues.length > 0 ? formatIssue(locale, error.issues[0]) : t(locale, 'api.error.invalidRequest');
}

export function getLocalePayload(req: Request): {
  locale: Locale;
  defaultLocale: Locale;
  locales: typeof SUPPORTED_LOCALES;
  messages: MessageCatalog;
} {
  const locale = resolveLocale(req);
  return {
    locale,
    defaultLocale: DEFAULT_LOCALE,
    locales: SUPPORTED_LOCALES,
    messages: {
      ...MESSAGES[DEFAULT_LOCALE],
      ...MESSAGES[locale],
    },
  };
}