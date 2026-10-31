import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canAutoRestart,
  getRuntimeInstanceInfo,
  resetAutoRestartStateForTests,
  scheduleAutoRestart,
} from '../../src/utils/autoRestart';

const originalAutoRestart = process.env.IC_AUTO_RESTART;

afterEach(() => {
  resetAutoRestartStateForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();

  if (originalAutoRestart === undefined) {
    delete process.env.IC_AUTO_RESTART;
  } else {
    process.env.IC_AUTO_RESTART = originalAutoRestart;
  }
});

describe('auto restart', () => {
  it('reports restart support when the env flag is enabled', () => {
    process.env.IC_AUTO_RESTART = '1';

    expect(canAutoRestart()).toBe(true);
  });

  it('returns stable runtime instance info across calls', () => {
    const first = getRuntimeInstanceInfo();
    const second = getRuntimeInstanceInfo();

    expect(first.bootId).toBeTruthy();
    expect(first.bootId).toBe(second.bootId);
    expect(first.pid).toBe(process.pid);
    expect(first.startedAt).toBe(second.startedAt);
  });

  it('schedules a graceful self-signal when auto restart is enabled', () => {
    vi.useFakeTimers();
    process.env.IC_AUTO_RESTART = 'true';
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);

    const result = scheduleAutoRestart(250);
    expect(result.canAutoRestart).toBe(true);
    expect(result.restartScheduled).toBe(true);
    expect(result.restartDelayMs).toBe(250);

    vi.advanceTimersByTime(250);

    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('does not schedule a restart when support is disabled', () => {
    delete process.env.IC_AUTO_RESTART;
    const killSpy = vi.spyOn(process, 'kill');

    const result = scheduleAutoRestart(250);

    expect(result.canAutoRestart).toBe(false);
    expect(result.restartScheduled).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
  });
});