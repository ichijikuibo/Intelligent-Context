import * as fs from 'fs';
import { randomUUID } from 'crypto';

const DEFAULT_RESTART_DELAY_MS = 750;
const PROCESS_BOOT_ID = randomUUID();
const PROCESS_STARTED_AT = new Date().toISOString();

let restartScheduled = false;

export interface RuntimeInstanceInfo {
  bootId: string;
  pid: number;
  startedAt: string;
}

export interface AutoRestartResult {
  canAutoRestart: boolean;
  restartScheduled: boolean;
  restartDelayMs: number;
}

export function getRuntimeInstanceInfo(): RuntimeInstanceInfo {
  return {
    bootId: PROCESS_BOOT_ID,
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
  };
}

export function canAutoRestart(): boolean {
  if (parseBoolean(process.env.IC_AUTO_RESTART)) {
    return true;
  }

  return fs.existsSync('/.dockerenv');
}

export function scheduleAutoRestart(delayMs: number = DEFAULT_RESTART_DELAY_MS): AutoRestartResult {
  const supported = canAutoRestart();
  if (!supported) {
    return {
      canAutoRestart: false,
      restartScheduled: false,
      restartDelayMs: 0,
    };
  }

  if (!restartScheduled) {
    restartScheduled = true;
    const timer = setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGTERM');
      } catch {
        process.exit(0);
      }
    }, delayMs);
    timer.unref?.();
  }

  return {
    canAutoRestart: true,
    restartScheduled: true,
    restartDelayMs: delayMs,
  };
}

export function resetAutoRestartStateForTests(): void {
  restartScheduled = false;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  switch (value.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}