/**
 * Tests for connection settings resolution.
 *
 * The base URL previously lived in `globalState`, which silently shadowed the
 * `intelligentContext.baseUrl` setting: once the Configure Connection prompt had
 * been used, editing the setting in the Settings UI had no effect. These tests
 * pin the corrected precedence and the legacy-value migration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settingValue: undefined as string | undefined,
  update: vi.fn(),
  stateGet: vi.fn(),
  stateUpdate: vi.fn(),
  secrets: {
    get: vi.fn(),
    store: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => mocks.settingValue ?? fallback,
      update: mocks.update,
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
}));

import { ConnectionStore, normalizeBaseUrl } from '../../vscode-extension/src/connection';

/** Minimal ExtensionContext stub covering the slices ConnectionStore touches. */
function makeContext(): never {
  return {
    globalState: {
      get: mocks.stateGet,
      update: mocks.stateUpdate,
    },
    secrets: mocks.secrets,
  } as never;
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and a trailing /v1', () => {
    expect(normalizeBaseUrl('http://localhost:1234/')).toBe('http://localhost:1234');
    expect(normalizeBaseUrl('http://localhost:1234/v1')).toBe('http://localhost:1234');
    expect(normalizeBaseUrl('  http://host:1234/v1/  ')).toBe('http://host:1234');
  });

  it('preserves a non-localhost host', () => {
    expect(normalizeBaseUrl('https://context.example.com')).toBe('https://context.example.com');
    expect(normalizeBaseUrl('http://192.168.1.50:1234')).toBe('http://192.168.1.50:1234');
  });
});

describe('ConnectionStore.getBaseUrl', () => {
  beforeEach(() => {
    mocks.settingValue = undefined;
    mocks.stateGet.mockReset().mockReturnValue(undefined);
    mocks.update.mockReset().mockResolvedValue(undefined);
    mocks.stateUpdate.mockReset().mockResolvedValue(undefined);
  });

  it('uses the setting when one is configured', () => {
    mocks.settingValue = 'http://192.168.1.50:1234';

    expect(new ConnectionStore(makeContext()).getBaseUrl()).toBe('http://192.168.1.50:1234');
  });

  it('lets the setting win over a legacy stored override', () => {
    // The regression: a value saved by the old Configure Connection prompt used
    // to shadow the setting, so edits in the Settings UI were ignored.
    mocks.settingValue = 'http://from-settings:1234';
    mocks.stateGet.mockReturnValue('http://from-old-prompt:9999');

    expect(new ConnectionStore(makeContext()).getBaseUrl()).toBe('http://from-settings:1234');
  });

  it('falls back to a legacy stored value when the setting is unset', () => {
    mocks.stateGet.mockReturnValue('http://legacy-host:1234');

    expect(new ConnectionStore(makeContext()).getBaseUrl()).toBe('http://legacy-host:1234');
  });

  it('falls back to localhost when nothing is configured', () => {
    expect(new ConnectionStore(makeContext()).getBaseUrl()).toBe('http://localhost:1234');
  });

  it('ignores blank stored values', () => {
    mocks.settingValue = '   ';
    mocks.stateGet.mockReturnValue('');

    expect(new ConnectionStore(makeContext()).getBaseUrl()).toBe('http://localhost:1234');
  });

  it('normalises the resolved value', () => {
    mocks.settingValue = 'http://host:1234/v1/';

    expect(new ConnectionStore(makeContext()).getBaseUrl()).toBe('http://host:1234');
  });
});

describe('ConnectionStore.setBaseUrl', () => {
  beforeEach(() => {
    mocks.update.mockReset().mockResolvedValue(undefined);
    mocks.stateGet.mockReset().mockReturnValue(undefined);
    mocks.stateUpdate.mockReset().mockResolvedValue(undefined);
  });

  it('writes to the setting so it is visible in the Settings UI', async () => {
    await new ConnectionStore(makeContext()).setBaseUrl('http://remote:9000/');

    expect(mocks.update).toHaveBeenCalledWith('baseUrl', 'http://remote:9000', 1);
  });

  it('clears a legacy stored override so it cannot shadow the setting', async () => {
    mocks.stateGet.mockReturnValue('http://stale:1234');

    await new ConnectionStore(makeContext()).setBaseUrl('http://fresh:1234');

    expect(mocks.stateUpdate).toHaveBeenCalledWith('intelligentContext.baseUrl', undefined);
  });

  it('does not touch legacy state when nothing was stored there', async () => {
    mocks.stateGet.mockReturnValue(undefined);

    await new ConnectionStore(makeContext()).setBaseUrl('http://fresh:1234');

    expect(mocks.stateUpdate).not.toHaveBeenCalled();
  });
});
