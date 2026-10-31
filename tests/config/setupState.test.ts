import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfig } from '../../src/config/config';
import { readSetupState, writeSetupState, type SetupState } from '../../src/config/setupState';

const originalSetupPath = process.env.IC_SETUP_PATH;
const originalSetupSecret = process.env.IC_SETUP_SECRET;
const originalMode = process.env.IC_MODE;
const originalDatabaseUrl = process.env.DATABASE_URL;

let tempDir: string | null = null;

afterEach(() => {
  resetConfig();

  if (originalSetupPath === undefined) {
    delete process.env.IC_SETUP_PATH;
  } else {
    process.env.IC_SETUP_PATH = originalSetupPath;
  }

  if (originalSetupSecret === undefined) {
    delete process.env.IC_SETUP_SECRET;
  } else {
    process.env.IC_SETUP_SECRET = originalSetupSecret;
  }

  if (originalMode === undefined) {
    delete process.env.IC_MODE;
  } else {
    process.env.IC_MODE = originalMode;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('setup state', () => {
  it('writes and reads the encrypted setup payload', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-setup-'));
    const setupFile = path.join(tempDir, 'setup.enc');
    const state: SetupState = {
      version: 1,
      completedAt: '2026-06-30T00:00:00.000Z',
      mode: 'server',
      database: {
        type: 'postgres',
        postgresUrl: 'postgresql://user:pass@localhost:5432/intelligent_context',
      },
    };

    process.env.IC_SETUP_PATH = setupFile;
    process.env.IC_SETUP_SECRET = 'test-secret';

    writeSetupState(state);

    const rawFile = fs.readFileSync(setupFile, 'utf8');
    expect(rawFile).not.toContain(state.database.postgresUrl || '');

    const loaded = readSetupState();
    expect(loaded.error).toBeUndefined();
    expect(loaded.state).toEqual(state);
  });

  it('overrides env mode and database with the setup state', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-setup-'));
    const setupFile = path.join(tempDir, 'setup.enc');
    const sqlitePath = path.join(tempDir, 'local.sqlite');

    process.env.IC_SETUP_PATH = setupFile;
    process.env.IC_SETUP_SECRET = 'test-secret';
    process.env.IC_MODE = 'server';
    process.env.DATABASE_URL = 'postgresql://env:env@localhost:5432/from_env';

    writeSetupState({
      version: 1,
      completedAt: '2026-06-30T00:00:00.000Z',
      mode: 'local',
      database: {
        type: 'sqlite',
        sqlitePath,
        backupRetention: 5,
      },
      localAdmin: {
        email: 'admin',
        passwordHash: 'hashed-password',
      },
    });

    const config = loadConfig();
    expect(config.mode).toBe('local');
    expect(config.database.type).toBe('sqlite');
    expect(config.database.sqlitePath).toBe(sqlitePath);
    expect(config.proxy.host).toBe('127.0.0.1');
    expect(config.management.host).toBe('127.0.0.1');
  });
});