/**
 * Connection settings + secure API-key storage.
 *
 * The API key is kept in VS Code's encrypted `SecretStorage`, never in
 * `settings.json`, and is never written to logs or error messages.
 *
 * The base URL lives in the `intelligentContext.baseUrl` setting so it appears
 * in the Settings UI and is editable from either place. An older release stored
 * it in `globalState` instead, which silently shadowed the setting; a legacy
 * value is still honoured, but any explicit write migrates it away.
 */
import * as vscode from 'vscode';

const API_KEY_SECRET = 'intelligentContext.apiKey';
const DEFAULT_BASE_URL = 'http://localhost:1234';
/** Legacy location for the base URL, superseded by the setting. */
const LEGACY_BASE_URL_STATE_KEY = 'intelligentContext.baseUrl';

export interface ResolvedConnection {
  baseUrl: string;
  apiKey: string | undefined;
}

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Normalised base URL.
   *
   * Precedence: the setting (workspace/user, whichever VS Code resolves) wins.
   * A legacy `globalState` value is only consulted when the setting is unset,
   * so an old stored value cannot shadow what the user later put in Settings.
   */
  getBaseUrl(): string {
    const configured = vscode.workspace
      .getConfiguration('intelligentContext')
      .get<string>('baseUrl');

    if (configured && configured.trim().length > 0) {
      return normalizeBaseUrl(configured);
    }

    const legacy = this.context.globalState.get<string>(LEGACY_BASE_URL_STATE_KEY);
    if (legacy && legacy.trim().length > 0) {
      return normalizeBaseUrl(legacy);
    }

    return DEFAULT_BASE_URL;
  }

  /**
   * Persist the base URL to the setting and clear any legacy stored override,
   * so the two never disagree again.
   */
  async setBaseUrl(baseUrl: string): Promise<void> {
    const normalized = normalizeBaseUrl(baseUrl);

    await vscode.workspace
      .getConfiguration('intelligentContext')
      .update('baseUrl', normalized, vscode.ConfigurationTarget.Global);

    // Drop the stale override from older versions so it stops shadowing.
    if (this.context.globalState.get<string>(LEGACY_BASE_URL_STATE_KEY) !== undefined) {
      await this.context.globalState.update(LEGACY_BASE_URL_STATE_KEY, undefined);
    }
  }

  async getApiKey(): Promise<string | undefined> {
    const stored = await this.context.secrets.get(API_KEY_SECRET);
    return stored && stored.trim().length > 0 ? stored : undefined;
  }

  async setApiKey(apiKey: string | undefined): Promise<void> {
    if (apiKey && apiKey.trim().length > 0) {
      await this.context.secrets.store(API_KEY_SECRET, apiKey.trim());
    } else {
      await this.context.secrets.delete(API_KEY_SECRET);
    }
  }

  async hasApiKey(): Promise<boolean> {
    return (await this.getApiKey()) !== undefined;
  }

  async resolve(): Promise<ResolvedConnection> {
    return {
      baseUrl: this.getBaseUrl(),
      apiKey: await this.getApiKey(),
    };
  }
}

/** Strip trailing slashes and a trailing `/v1` so callers append their own path. */
export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}
