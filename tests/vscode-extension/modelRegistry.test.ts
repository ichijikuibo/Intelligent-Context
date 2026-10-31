/**
 * Tests for the VS Code extension's model registry.
 *
 * These pin the guard rails that stop the extension from hammering the proxy's
 * `/v1/models` endpoint: caching within a TTL, de-duplicating concurrent
 * fetches, firing change events only when the catalog changes, and backing off
 * after a failure. `modelRegistry` is imported with `vscode` and `listModels`
 * stubbed so it can be exercised without the extension host.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  EventEmitter: class {
    private readonly listeners = new Set<() => void>();
    event = (listener: () => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire = () => {
      for (const listener of this.listeners) listener();
    };
    dispose = () => this.listeners.clear();
  },
}));

vi.mock('../../vscode-extension/src/proxyClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../vscode-extension/src/proxyClient')>();
  return { ...actual, listModels: vi.fn() };
});

import { listModels } from '../../vscode-extension/src/proxyClient';
import { ModelRegistry } from '../../vscode-extension/src/modelRegistry';
import type { ConnectionStore } from '../../vscode-extension/src/connection';
import type { ProxyModelEntry } from '../../vscode-extension/src/types';

const mockedListModels = vi.mocked(listModels);

function fakeConnections(): ConnectionStore {
  return {
    resolve: async () => ({ baseUrl: 'http://localhost:1234', apiKey: 'test-key' }),
  } as unknown as ConnectionStore;
}

function model(id: string): ProxyModelEntry {
  return { id, model_id: id, display_name: id, api_format: 'openai' };
}

describe('ModelRegistry', () => {
  beforeEach(() => {
    mockedListModels.mockReset();
  });

  it('serves a fresh cache without a second network call', async () => {
    mockedListModels.mockResolvedValue([model('a')]);
    const registry = new ModelRegistry(fakeConnections());

    const first = await registry.refresh(false);
    const second = await registry.refresh(false);

    expect(first).toEqual([model('a')]);
    expect(second).toEqual([model('a')]);
    expect(mockedListModels).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent refreshes into a single request', async () => {
    let release!: (models: ProxyModelEntry[]) => void;
    mockedListModels.mockReturnValue(
      new Promise<ProxyModelEntry[]>((resolve) => {
        release = resolve;
      }),
    );
    const registry = new ModelRegistry(fakeConnections());

    const pending = [registry.refresh(false), registry.refresh(false), registry.refresh(true)];
    release([model('a')]);
    await Promise.all(pending);

    expect(mockedListModels).toHaveBeenCalledTimes(1);
  });

  it('fires onDidChangeModels only when the catalog actually changes', async () => {
    mockedListModels.mockResolvedValue([model('a')]);
    const registry = new ModelRegistry(fakeConnections());
    const onChange = vi.fn();
    registry.onDidChangeModels(onChange);

    await registry.refresh(false);
    // Force past the cache TTL; the list is identical so no extra event fires.
    await registry.refresh(false, true);
    await registry.refresh(false, true);

    expect(mockedListModels).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('fires onDidChangeModels again when the catalog changes', async () => {
    mockedListModels.mockResolvedValueOnce([model('a')]).mockResolvedValueOnce([model('b')]);
    const registry = new ModelRegistry(fakeConnections());
    const onChange = vi.fn();
    registry.onDidChangeModels(onChange);

    await registry.refresh(false, true);
    await registry.refresh(false, true);

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('force bypasses the cache TTL', async () => {
    mockedListModels.mockResolvedValue([model('a')]);
    const registry = new ModelRegistry(fakeConnections());

    await registry.refresh(false);
    await registry.refresh(false, true);

    expect(mockedListModels).toHaveBeenCalledTimes(2);
  });

  it('backs off after a failure instead of retrying on every call', async () => {
    mockedListModels.mockRejectedValue(new Error('boom'));
    const registry = new ModelRegistry(fakeConnections());

    await expect(registry.refresh(false)).rejects.toThrow('boom');
    await expect(registry.refresh(false)).rejects.toThrow(/could not be reached/i);

    expect(mockedListModels).toHaveBeenCalledTimes(1);
  });
});
