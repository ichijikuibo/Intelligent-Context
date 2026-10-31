import { AppError } from '../utils/appErrors';

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { code?: string | number }).code;
}

export function isDuplicateKeyError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const code = errorCode(error);

  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 19 ||
    message.includes('duplicate key value violates unique constraint') ||
    message.includes('unique constraint failed') ||
    message.includes('duplicate key') ||
    message.includes('unique violation')
  );
}

export function createProjectConflictError(rootPath: string, cause?: unknown): AppError {
  return new AppError(`Project already exists for root path: ${rootPath}`, {
    statusCode: 409,
    code: 'project_conflict',
    messageKey: 'api.error.projectAlreadyExists',
    messageVars: { rootPath },
    details: { rootPath },
    cause,
  });
}

export function createProviderConflictError(name: string, cause?: unknown): AppError {
  return new AppError(`Provider already exists: ${name}`, {
    statusCode: 409,
    code: 'provider_conflict',
    messageKey: 'api.error.providerAlreadyExists',
    messageVars: { name },
    details: { name },
    cause,
  });
}

export function createProviderShortPrefixConflictError(shortPrefix: string, cause?: unknown): AppError {
  return new AppError(`Provider short prefix already exists: ${shortPrefix}`, {
    statusCode: 409,
    code: 'provider_prefix_conflict',
    publicMessage: `Provider short prefix "${shortPrefix}" is already in use.`,
    details: { shortPrefix },
    cause,
  });
}

export function createUserConflictError(email: string, cause?: unknown): AppError {
  return new AppError(`User already exists: ${email}`, {
    statusCode: 409,
    code: 'user_conflict',
    publicMessage: `A user with login "${email}" already exists.`,
    details: { email },
    cause,
  });
}