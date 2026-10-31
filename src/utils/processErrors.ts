import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';
import { serializeError } from './appErrors';

let registered = false;

/** Set to true when the app exits through a normal path (signal, drained loop). */
let cleanExit = false;

/** Most recent activity label, so crash reports say what was happening. */
let lastActivity: { at: string; label: string } | undefined;

const DATA_DIR = path.join(os.homedir(), '.intelligent-context');
const CRASH_REPORT_DIR = process.env.IC_CRASH_REPORT_DIR
  ? path.resolve(process.env.IC_CRASH_REPORT_DIR)
  : path.join(DATA_DIR, 'crash-reports');
const CRASH_MARKER_FILE = path.join(DATA_DIR, '.crash-marker');

export function setLastActivity(label: string): void {
  lastActivity = { at: new Date().toISOString(), label };
}

export function getLastActivity(): { at: string; label: string } | undefined {
  return lastActivity;
}

function lastActivityMeta(): Record<string, unknown> {
  return lastActivity
    ? { lastActivityAt: lastActivity.at, lastActivity: lastActivity.label }
    : { lastActivity: 'none' };
}

function ensureReportDir(): void {
  fs.mkdirSync(CRASH_REPORT_DIR, { recursive: true });
  process.report.directory = CRASH_REPORT_DIR;
}

/**
 * Write a Node.js diagnostic report (JS heap, native stack, resource usage)
 * plus a small human-readable sidecar. Returns the report filename, if any.
 */
function writeCrashReport(reason: string, error?: unknown): string | undefined {
  try {
    ensureReportDir();
    const reportFile = process.report.writeReport();
    const sidecar = path.join(CRASH_REPORT_DIR, `crash-${process.pid}-${Date.now()}.log`);
    const lines = [
      `time=${new Date().toISOString()}`,
      `reason=${reason}`,
      `pid=${process.pid}`,
      `node=${process.version}`,
      `report=${reportFile}`,
      `lastActivity=${lastActivity ? `${lastActivity.at} ${lastActivity.label}` : 'none'}`,
      `error=${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    ];
    fs.writeFileSync(sidecar, lines.join('\n') + '\n', 'utf8');
    return reportFile;
  } catch {
    return undefined;
  }
}

function writeCrashMarker(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      CRASH_MARKER_FILE,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      'utf8',
    );
  } catch {
    // best effort
  }
}

function clearCrashMarker(): void {
  try {
    fs.unlinkSync(CRASH_MARKER_FILE);
  } catch {
    // best effort
  }
}

export function registerProcessErrorHandlers(): void {
  if (registered) return;
  registered = true;

  // If a marker from a previous run is still present, that process died without
  // a clean exit — hard kill, native crash, OOM, or an error-path process.exit.
  if (fs.existsSync(CRASH_MARKER_FILE)) {
    let previous: unknown;
    try {
      previous = JSON.parse(fs.readFileSync(CRASH_MARKER_FILE, 'utf8'));
    } catch {
      previous = undefined;
    }
    logger.error('Previous run did not shut down cleanly — crash detected', {
      previousRun: previous,
      ...lastActivityMeta(),
    });
  }
  writeCrashMarker();

  // Observe uncaught exceptions without terminating them. Fires before the
  // uncaughtException handler below, so it also covers exceptions that other
  // handlers deal with.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    logger.error('Uncaught exception (monitor)', {
      origin,
      ...serializeError(error),
      ...lastActivityMeta(),
    });
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      ...serializeError(reason),
      ...lastActivityMeta(),
    });
    writeCrashReport('unhandledRejection', reason);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
      ...serializeError(error),
      ...lastActivityMeta(),
    });
    writeCrashReport('uncaughtException', error);
    process.exit(1);
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });

  process.on('beforeExit', (code) => {
    cleanExit = true;
    logger.info('Node event loop drained, process exiting', { code });
  });

  process.on('exit', (code) => {
    try {
      if (cleanExit) {
        clearCrashMarker();
        return;
      }
      // Not a clean exit — keep the marker so the next start reports it, and
      // write a minimal sidecar (the exit handler can only do sync work).
      try {
        fs.mkdirSync(CRASH_REPORT_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(CRASH_REPORT_DIR, `exit-${process.pid}-${Date.now()}.log`),
          [
            `time=${new Date().toISOString()}`,
            `exitCode=${code}`,
            `cleanExit=false`,
            `lastActivity=${lastActivity ? `${lastActivity.at} ${lastActivity.label}` : 'none'}`,
          ].join('\n') + '\n',
          'utf8',
        );
      } catch {
        // best effort
      }
    } catch {
      // Never throw inside the exit handler.
    }
  });

  const markClean = (signal: string): void => {
    cleanExit = true;
    logger.info('Received signal', { signal });
  };
  process.on('SIGTERM', () => markClean('SIGTERM'));
  process.on('SIGINT', () => markClean('SIGINT'));
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => markClean('SIGHUP'));
    process.on('SIGUSR1', () => markClean('SIGUSR1'));
    process.on('SIGUSR2', () => markClean('SIGUSR2'));
  }
}