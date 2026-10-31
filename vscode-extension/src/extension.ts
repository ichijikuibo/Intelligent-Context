/**
 * Extension entry point.
 *
 * This extension has no standalone functionality: it exists purely to connect
 * VS Code's chat model picker to a running Intelligent Context proxy. See the
 * README for what the proxy does.
 */
import * as vscode from 'vscode';
import { ConnectionStore, normalizeBaseUrl } from './connection';
import { ModelRegistry } from './modelRegistry';
import { IntelligentContextChatProvider } from './provider';

const VENDOR = 'intelligent-context';

let provider: IntelligentContextChatProvider | undefined;
let registry: ModelRegistry | undefined;
let store: ConnectionStore | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  store = new ConnectionStore(context);
  registry = new ModelRegistry(store);
  provider = new IntelligentContextChatProvider(store, registry);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),

    vscode.commands.registerCommand('intelligentContext.manage', () => manageConnection(context)),

    vscode.commands.registerCommand('intelligentContext.refreshModels', async () => {
      try {
        const models = await registry!.refresh(false, true);
        vscode.window.showInformationMessage(
          `Intelligent Context: ${models.length} model${models.length === 1 ? '' : 's'} available.`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(`Intelligent Context: ${ModelRegistry.describeError(error)}`);
      }
    }),

    vscode.commands.registerCommand('intelligentContext.showStatus', () => showStatus()),

    vscode.commands.registerCommand('intelligentContext.clearApiKey', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        'Remove the stored Intelligent Context API key from secret storage?',
        { modal: true },
        'Remove',
      );
      if (confirmed !== 'Remove') return;

      await store!.setApiKey(undefined);
      registry!.invalidate();
      vscode.window.showInformationMessage('Intelligent Context: stored API key removed.');
    }),

    // Refresh when the user edits connection settings.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('intelligentContext')) return;
      registry!.invalidate();
      scheduleRefresh();
    }),

    { dispose: () => stopRefreshTimer() },
    { dispose: () => provider?.dispose() },
    { dispose: () => registry?.dispose() },
  );

  // Warm the cache and validate credentials in the background.
  void warmUp(context);
}

export function deactivate(): void {
  stopRefreshTimer();
}

// ── Startup ────────────────────────────────────────────────────────────────

async function warmUp(context: vscode.ExtensionContext): Promise<void> {
  const hasKey = await store!.hasApiKey();
  const hintEnabled = vscode.workspace
    .getConfiguration('intelligentContext')
    .get<boolean>('apiKeyHint', true);

  if (!hasKey && hintEnabled) {
    // First run: ask for the key once, then never again unless cleared.
    const choice = await vscode.window.showInformationMessage(
      'Intelligent Context: enter your proxy API key to start using your configured models.',
      'Enter API Key',
      'Later',
    );

    if (choice === 'Enter API Key') {
      await manageConnection(context);
    }
  }

  try {
    await registry!.refresh(true);
  } catch {
    // Silent: the proxy may simply not be running yet.
  }

  scheduleRefresh();
}

// ── Commands ───────────────────────────────────────────────────────────────

/** Ask for the base URL and API key, then verify the connection. */
async function manageConnection(context: vscode.ExtensionContext): Promise<void> {
  const currentBaseUrl = store!.getBaseUrl();

  const baseUrl = await vscode.window.showInputBox({
    title: 'Intelligent Context — Proxy URL',
    prompt: 'Base URL of your Intelligent Context proxy. Saved to the "intelligentContext.baseUrl" setting.',
    value: currentBaseUrl,
    ignoreFocusOut: true,
    placeHolder: 'http://localhost:1234',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return 'A proxy URL is required.';
      if (!/^https?:\/\//i.test(trimmed)) return 'The URL must start with http:// or https://';
      return undefined;
    },
  });

  if (baseUrl === undefined) return;
  await store!.setBaseUrl(normalizeBaseUrl(baseUrl));

  const apiKey = await vscode.window.showInputBox({
    title: 'Intelligent Context — API Key',
    prompt: 'Enter the API key from the management UI (My API Keys). Leave blank to keep the existing key.',
    password: true,
    ignoreFocusOut: true,
  });

  if (apiKey !== undefined && apiKey.trim().length > 0) {
    await store!.setApiKey(apiKey);
  }

  registry!.invalidate();

  try {
    const models = await registry!.refresh(false, true);
    vscode.window.showInformationMessage(
      `Intelligent Context connected. ${models.length} model${models.length === 1 ? '' : 's'} available.`,
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Intelligent Context: ${ModelRegistry.describeError(error)}`);
  }

  scheduleRefresh();
}

async function showStatus(): Promise<void> {
  const baseUrl = store!.getBaseUrl();
  const hasKey = await store!.hasApiKey();
  const cached = registry!.getCached();
  const models = cached?.models ?? [];

  const lines = [
    `Proxy URL: ${baseUrl}`,
    `API key: ${hasKey ? 'stored' : 'not set'}`,
    `Models: ${models.length}`,
    `Last refreshed: ${cached ? new Date(cached.fetchedAt).toLocaleTimeString() : 'never'}`,
  ];

  if (models.length > 0) {
    lines.push('', 'Available models:');
    for (const model of models.slice(0, 25)) {
      // display_name already leads with the provider, so no separate suffix.
      lines.push(`  • ${model.display_name ?? model.model_id ?? model.id}`);
    }
    if (models.length > 25) lines.push(`  …and ${models.length - 25} more`);
  }

  const document = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'text',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

// ── Background polling ─────────────────────────────────────────────────────

function scheduleRefresh(): void {
  stopRefreshTimer();

  const minutes = vscode.workspace
    .getConfiguration('intelligentContext')
    .get<number>('modelRefreshIntervalMinutes', 0);

  if (!Number.isFinite(minutes) || minutes <= 0) return;

  refreshTimer = setInterval(() => {
    void registry!.refresh(true).catch(() => {
      // Silent polling never surfaces errors.
    });
  }, minutes * 60_000);
}

function stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}
