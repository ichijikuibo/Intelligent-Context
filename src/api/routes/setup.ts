import * as path from 'path';
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword } from '../../auth/credentials';
import { getConfig } from '../../config/config';
import { formatZodError } from '../../i18n';
import { type SetupState, readSetupState, writeSetupState } from '../../config/setupState';
import { canAutoRestart, getRuntimeInstanceInfo, scheduleAutoRestart } from '../../utils/autoRestart';

const SetupRequestSchema = z.object({
  mode: z.enum(['local', 'server']),
  database: z.object({
    type: z.enum(['sqlite', 'postgres']),
    sqlitePath: z.string().optional(),
    postgresUrl: z.string().optional(),
    backupRetention: z.number().int().min(0).max(1000).optional(),
  }),
  localAdmin: z.object({
    email: z.string().optional(),
    password: z.string().optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  const sqlitePath = value.database.sqlitePath?.trim() || '';
  const postgresUrl = value.database.postgresUrl?.trim() || '';
  const localAdminEmail = value.localAdmin?.email?.trim() || '';
  const localAdminPassword = value.localAdmin?.password || '';

  if (value.database.type === 'sqlite' && !sqlitePath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['database', 'sqlitePath'],
      message: 'SQLite path is required.',
    });
  }

  if (value.database.type === 'postgres' && !postgresUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['database', 'postgresUrl'],
      message: 'PostgreSQL connection string is required.',
    });
  }

  if (value.mode === 'local') {
    if (!localAdminEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localAdmin', 'email'],
        message: 'Local admin login is required.',
      });
    }
    if (!localAdminPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['localAdmin', 'password'],
        message: 'Local admin password is required.',
      });
    }
  }
});

export function createSetupRouter(): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    const config = getConfig();
    const setupResult = readSetupState();
    const setupState = setupResult.state;

    res.json({
      needsSetup: !setupState,
      setupError: setupResult.error ?? null,
      storageFile: path.basename(setupResult.filePath),
      canAutoRestart: canAutoRestart(),
      runtime: getRuntimeInstanceInfo(),
      defaults: {
        mode: setupState?.mode ?? config.mode,
        database: {
          type: setupState?.database.type ?? config.database.type,
          sqlitePath: setupState?.database.sqlitePath ?? config.database.sqlitePath ?? '',
          postgresUrl: setupState?.database.postgresUrl ?? config.database.postgresUrl ?? '',
          backupRetention: setupState?.database.backupRetention ?? config.database.backupRetention ?? 10,
        },
      },
      setup: setupState
        ? {
            completedAt: setupState.completedAt,
            mode: setupState.mode,
            databaseType: setupState.database.type,
            hasLocalAdmin: !!setupState.localAdmin,
          }
        : null,
    });
  });

  router.post('/', (req, res) => {
    const existing = readSetupState();
    if (existing.state) {
      res.status(409).json({ error: 'Initial setup has already been completed.' });
      return;
    }

    const parsed = SetupRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: formatZodError(req, parsed.error) });
      return;
    }

    const setupState = buildSetupState(parsed.data);
    const filePath = writeSetupState(setupState);
    const restartInfo = canAutoRestart()
      ? {
          canAutoRestart: true,
          restartScheduled: true,
          restartDelayMs: 750,
        }
      : {
          canAutoRestart: false,
          restartScheduled: false,
          restartDelayMs: 0,
        };

    res.status(201).json({
      ok: true,
      requiresRestart: true,
      ...restartInfo,
      storageFile: path.basename(filePath),
      runtime: getRuntimeInstanceInfo(),
      setup: {
        mode: setupState.mode,
        databaseType: setupState.database.type,
        hasLocalAdmin: !!setupState.localAdmin,
      },
    });

    if (restartInfo.restartScheduled) {
      res.once('finish', () => {
        scheduleAutoRestart(restartInfo.restartDelayMs);
      });
    }
  });

  return router;
}

function buildSetupState(payload: z.infer<typeof SetupRequestSchema>): SetupState {
  const sqlitePath = payload.database.sqlitePath?.trim();
  const postgresUrl = payload.database.postgresUrl?.trim();
  const setupState: SetupState = {
    version: 1,
    completedAt: new Date().toISOString(),
    mode: payload.mode,
    database: {
      type: payload.database.type,
      backupRetention: payload.database.backupRetention,
      sqlitePath: payload.database.type === 'sqlite' ? sqlitePath : undefined,
      postgresUrl: payload.database.type === 'postgres' ? postgresUrl : undefined,
    },
  };

  if (payload.mode === 'local') {
    setupState.localAdmin = {
      email: payload.localAdmin?.email?.trim() || 'admin',
      passwordHash: hashPassword(payload.localAdmin?.password || ''),
    };
  }

  return setupState;
}