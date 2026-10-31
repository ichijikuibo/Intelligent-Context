import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  statsRepo: { insert: vi.fn().mockResolvedValue({}) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  estimateTokens: vi.fn(() => 42),
}));

vi.mock('../../src/db/repositories/stats', () => ({ statsRepo: mocks.statsRepo }));
vi.mock('../../src/utils/logger', () => ({ logger: mocks.logger }));
vi.mock('../../src/utils/tokens', () => ({ estimateTokens: mocks.estimateTokens }));

import {
  ALWAYS_RECORDED_STAT_TYPES,
  isAlwaysRecordedStatType,
  recordStat,
} from '../../src/utils/stats';

describe('recordStat gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.IC_STATS_ENABLED;
  });

  afterEach(() => {
    delete process.env.IC_STATS_ENABLED;
  });

  it('exposes the always-recorded stat types', () => {
    for (const type of ['context_injection', 'learning', 'ic_retrieval', 'ic_record_learning', 'ic_write', 'ic_tool']) {
      expect(ALWAYS_RECORDED_STAT_TYPES.has(type)).toBe(true);
      expect(isAlwaysRecordedStatType(type)).toBe(true);
    }

    expect(isAlwaysRecordedStatType('gatherer')).toBe(false);
  });

  it('skips verbose types when IC_STATS_ENABLED is not set', () => {
    recordStat({ projectId: 'p1', model: 'm', runId: 'r', type: 'gatherer', direction: 'input' });

    expect(mocks.statsRepo.insert).not.toHaveBeenCalled();
  });

  it('always records the always-on types even without the env var', () => {
    recordStat({ projectId: 'p1', model: 'm', runId: 'r', type: 'context_injection', direction: 'output' });

    expect(mocks.statsRepo.insert).toHaveBeenCalledTimes(1);
    expect(mocks.statsRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', type: 'context_injection', direction: 'output' })
    );
  });

  it('records any type when IC_STATS_ENABLED is true', () => {
    process.env.IC_STATS_ENABLED = 'true';

    recordStat({ projectId: 'p1', model: 'm', runId: 'r', type: 'gatherer', direction: 'input' });

    expect(mocks.statsRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('estimates tokens from the body when no explicit count is provided', () => {
    recordStat({ projectId: 'p1', model: 'm', runId: 'r', type: 'learning', direction: 'output', body: 'hello world' });

    expect(mocks.estimateTokens).toHaveBeenCalledWith('hello world');
    expect(mocks.statsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 42 }));
  });

  it('prefers an explicit token count over estimation', () => {
    recordStat({ projectId: 'p1', model: 'm', runId: 'r', type: 'learning', direction: 'output', body: 'hello world', tokens: 7 });

    expect(mocks.estimateTokens).not.toHaveBeenCalled();
    expect(mocks.statsRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ tokens: 7 }));
  });

  it('never throws when the insert rejects', async () => {
    mocks.statsRepo.insert.mockRejectedValueOnce(new Error('db down'));

    expect(() => recordStat({ projectId: 'p1', model: 'm', runId: 'r', type: 'learning', direction: 'output' })).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
