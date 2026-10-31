import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from './config';

export interface SetupDatabaseState {
  type: AppConfig['database']['type'];
  sqlitePath?: string;
  postgresUrl?: string;
  backupRetention?: number;
}

export interface SetupLocalAdminState {
  email: string;
  passwordHash: string;
}

export interface SetupState {
  version: 1;
  completedAt: string;
  mode: AppConfig['mode'];
  database: SetupDatabaseState;
  localAdmin?: SetupLocalAdminState;
}

export interface SetupStateReadResult {
  state: SetupState | null;
  filePath: string;
  error?: string;
}

interface SetupEnvelope {
  version: number;
  iv: string;
  tag: string;
  data: string;
}

const SETUP_FILE_VERSION = 1;
const SETUP_FILE_NAME = 'intelligent-context.setup.enc';
const SETUP_FILE_SALT = 'intelligent-context.setup.v1';

export function getSetupStateFilePath(rootDir: string = process.cwd()): string {
  const configuredPath = process.env.IC_SETUP_PATH?.trim();
  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(rootDir, configuredPath);
  }
  return path.resolve(rootDir, SETUP_FILE_NAME);
}

export function readSetupState(rootDir: string = process.cwd()): SetupStateReadResult {
  const filePath = getSetupStateFilePath(rootDir);
  if (!fs.existsSync(filePath)) {
    return { state: null, filePath };
  }

  try {
    const envelope = parseEnvelope(fs.readFileSync(filePath, 'utf8'));
    const decrypted = decryptEnvelope(envelope, rootDir);
    const parsed = JSON.parse(decrypted) as unknown;
    if (!isSetupState(parsed)) {
      throw new Error('Setup state has an invalid shape.');
    }

    return {
      state: parsed,
      filePath,
    };
  } catch (error) {
    return {
      state: null,
      filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function writeSetupState(state: SetupState, rootDir: string = process.cwd()): string {
  const filePath = getSetupStateFilePath(rootDir);
  const normalizedState: SetupState = {
    ...state,
    version: SETUP_FILE_VERSION,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, encryptText(JSON.stringify(normalizedState, null, 2), rootDir), 'utf8');
  return filePath;
}

export function setupStateToConfigOverride(state: SetupState): Pick<AppConfig, 'mode' | 'database'> {
  return {
    mode: state.mode,
    database: {
      type: state.database.type,
      sqlitePath: state.database.sqlitePath,
      postgresUrl: state.database.postgresUrl,
      backupRetention: state.database.backupRetention,
    },
  };
}

function encryptText(clearText: string, rootDir: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(rootDir), iv);
  const encrypted = Buffer.concat([cipher.update(clearText, 'utf8'), cipher.final()]);
  const envelope: SetupEnvelope = {
    version: SETUP_FILE_VERSION,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  };
  return JSON.stringify(envelope, null, 2);
}

function decryptEnvelope(envelope: SetupEnvelope, rootDir: string): string {
  if (envelope.version !== SETUP_FILE_VERSION) {
    throw new Error(`Unsupported setup state version: ${envelope.version}`);
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(rootDir),
    Buffer.from(envelope.iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function deriveKey(rootDir: string): Buffer {
  const configuredSecret = process.env.IC_SETUP_SECRET?.trim();
  const baseSecret = configuredSecret || `${path.resolve(rootDir)}::intelligent-context::setup`;
  return crypto.scryptSync(baseSecret, SETUP_FILE_SALT, 32);
}

function parseEnvelope(raw: string): SetupEnvelope {
  const parsed = JSON.parse(raw) as Partial<SetupEnvelope>;
  if (
    typeof parsed.version !== 'number' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.tag !== 'string' ||
    typeof parsed.data !== 'string'
  ) {
    throw new Error('Setup state file is not a valid encrypted payload.');
  }

  return {
    version: parsed.version,
    iv: parsed.iv,
    tag: parsed.tag,
    data: parsed.data,
  };
}

function isSetupState(value: unknown): value is SetupState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const setupState = value as Partial<SetupState>;
  if (
    setupState.version !== SETUP_FILE_VERSION ||
    typeof setupState.completedAt !== 'string' ||
    (setupState.mode !== 'local' && setupState.mode !== 'server')
  ) {
    return false;
  }

  const database = setupState.database;
  if (
    !database ||
    (database.type !== 'sqlite' && database.type !== 'postgres')
  ) {
    return false;
  }

  if (database.type === 'sqlite' && typeof database.sqlitePath !== 'string') {
    return false;
  }

  if (database.type === 'postgres' && typeof database.postgresUrl !== 'string') {
    return false;
  }

  if (
    database.backupRetention !== undefined &&
    (typeof database.backupRetention !== 'number' || !Number.isFinite(database.backupRetention))
  ) {
    return false;
  }

  if (setupState.localAdmin === undefined) {
    return true;
  }

  return (
    typeof setupState.localAdmin.email === 'string' &&
    typeof setupState.localAdmin.passwordHash === 'string'
  );
}