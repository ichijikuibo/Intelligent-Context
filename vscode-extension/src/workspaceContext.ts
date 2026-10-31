/**
 * Builds the Intelligent Context headers that let the proxy attribute a request
 * to the correct project without any manual configuration.
 *
 * Headers sent:
 *   - `X-Project-Root`    — absolute workspace root path
 *   - `X-IC-Project-Name` — workspace folder name (kept separate from the path)
 *   - `X-IC-File`         — the file the user is currently editing
 *   - `X-IC-Branch`       — active git branch
 *   - `X-Session-Id`      — stable per-workspace id so the proxy keeps
 *                           tool-continuation context across a conversation
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ProxyExtraHeaders } from './types';

export interface WorkspaceSnapshot {
  root?: string;
  name?: string;
  file?: string;
  branch?: string;
}

/** Collect the current workspace / editor / git state. */
export async function collectWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const folder = activeWorkspaceFolder();
  const snapshot: WorkspaceSnapshot = {};

  if (folder) {
    snapshot.root = folder.uri.fsPath;
    snapshot.name = folder.name || path.basename(folder.uri.fsPath);
  }

  const file = activeFilePath();
  if (file) snapshot.file = file;

  if (folder) {
    snapshot.branch = await readGitBranch(folder.uri.fsPath);
  }

  return snapshot;
}

function activeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const owning = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (owning) return owning;
  }

  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0] : undefined;
}

function activeFilePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  if (editor.document.uri.scheme !== 'file') return undefined;
  return editor.document.uri.fsPath;
}

/** Read the current branch from `.git/HEAD` without shelling out to git. */
async function readGitBranch(rootPath: string): Promise<string | undefined> {
  const headPath = path.join(rootPath, '.git', 'HEAD');

  try {
    const contents = await vscode.workspace.fs.readFile(vscode.Uri.file(headPath));
    const text = Buffer.from(contents).toString('utf8').trim();

    const match = text.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (match) return match[1];

    // Detached HEAD — report the short SHA.
    return text.length >= 7 ? text.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

/** Turn a workspace snapshot into the header set sent to the proxy. */
export function buildProxyHeaders(snapshot: WorkspaceSnapshot): ProxyExtraHeaders {
  const headers: ProxyExtraHeaders = {};

  if (snapshot.root) headers['X-Project-Root'] = snapshot.root;
  if (snapshot.name) headers['X-IC-Project-Name'] = snapshot.name;
  if (snapshot.file) headers['X-IC-File'] = snapshot.file;
  if (snapshot.branch) headers['X-IC-Branch'] = snapshot.branch;

  if (snapshot.root) {
    headers['X-Session-Id'] = stableSessionId(snapshot.root);
  }

  return headers;
}

/** Derive a stable, non-identifying session id from the workspace root. */
function stableSessionId(rootPath: string): string {
  let hash = 2166136261;
  for (let index = 0; index < rootPath.length; index++) {
    hash ^= rootPath.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `vsc-${(hash >>> 0).toString(16)}`;
}
