import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectIde,
  getLastClientInfo,
  recordClientInfo,
  resetClientInfo,
} from '../../src/proxy/clientInfo';

function makeReq(headers: Record<string, unknown> = {}) {
  return { headers } as unknown as Parameters<typeof recordClientInfo>[0];
}

describe('detectIde', () => {
  it('recognises the VS Code and Cursor user agents', () => {
    expect(detectIde('Visual Studio Code 1.104.0')).toBe('VS Code');
    expect(detectIde('vscode/1.104.0')).toBe('VS Code');
    expect(detectIde('Cursor/0.42.0')).toBe('Cursor');
    expect(detectIde('Windsurf/1.0')).toBe('Windsurf');
  });

  it('returns null for unknown or missing user agents', () => {
    expect(detectIde('curl/8.0')).toBeNull();
    expect(detectIde(undefined)).toBeNull();
    expect(detectIde(null)).toBeNull();
  });
});

describe('recordClientInfo', () => {
  beforeEach(() => {
    resetClientInfo();
  });

  it('starts empty so the Overview tab can show a first-run hint', () => {
    expect(getLastClientInfo()).toBeNull();
  });

  it('captures the IDE, project, file, and branch reported by headers', () => {
    recordClientInfo(
      makeReq({
        'user-agent': 'Visual Studio Code 1.104.0',
        'x-project-root': 'C:\\src\\intelligent-context',
        'x-ic-project-name': 'intelligent-context',
        'x-ic-file': 'C:\\src\\intelligent-context\\src\\index.ts',
        'x-ic-branch': 'main',
      }),
      'intelligent-context',
    );

    const client = getLastClientInfo();
    expect(client).toMatchObject({
      ide: 'VS Code',
      projectName: 'intelligent-context',
      resolvedProjectName: 'intelligent-context',
      projectRoot: 'C:\\src\\intelligent-context',
      file: 'C:\\src\\intelligent-context\\src\\index.ts',
      branch: 'main',
    });
    expect(client?.lastSeenAt).toBeTruthy();
  });

  it('accepts the X-Workspace-Root alias and tolerates missing headers', () => {
    recordClientInfo(makeReq({ 'x-workspace-root': '/home/dev/repo' }), null);

    const client = getLastClientInfo();
    expect(client?.projectRoot).toBe('/home/dev/repo');
    expect(client?.ide).toBeNull();
    expect(client?.resolvedProjectName).toBeNull();
  });

  it('ignores blank header values so they do not mask real data', () => {
    recordClientInfo(makeReq({ 'x-ic-project-name': '   ' }), null);

    expect(getLastClientInfo()?.projectName).toBeNull();
  });

  it('returns a copy so callers cannot mutate the stored record', () => {
    recordClientInfo(makeReq({ 'x-ic-branch': 'main' }), null);

    const first = getLastClientInfo();
    if (first) first.branch = 'mutated';

    expect(getLastClientInfo()?.branch).toBe('main');
  });
});
