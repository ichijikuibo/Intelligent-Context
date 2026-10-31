import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { vi } from 'vitest';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, '..', '..');
const UI_ROOT = path.join(REPO_ROOT, 'ui');
const INDEX_HTML_PATH = path.join(UI_ROOT, 'index.html');
const LOCAL_SCRIPT_PATTERN = /<script\s+src="(js\/[^"]+)"\s*><\/script>/g;
const INIT_SCRIPT_PATH = 'js/init.js';

export interface UiHarnessOptions {
  includeInit?: boolean;
  url?: string;
  fetchImpl?: typeof fetch;
}

export interface UiHarness {
  dom: JSDOM;
  window: JSDOM['window'];
  document: Document;
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  clipboardWriteTextMock: ReturnType<typeof vi.fn>;
  confirmMock: ReturnType<typeof vi.fn>;
  matchMediaMock: ReturnType<typeof vi.fn>;
  dataTableMock: ReturnType<typeof vi.fn>;
  loadedScripts: string[];
  evaluate<T = unknown>(expression: string): T;
  getGlobal<T = unknown>(name: string): T;
  call<T = unknown>(name: string, ...args: unknown[]): T;
  settle(cycles?: number): Promise<void>;
  cleanup(): void;
}

function readUiHtml(): string {
  return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
}

function stripScriptTags(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

function extractUiScriptPaths(html: string, includeInit: boolean): string[] {
  const matches = Array.from(html.matchAll(LOCAL_SCRIPT_PATTERN), (match) => match[1]).filter(Boolean) as string[];
  return includeInit ? matches : matches.filter((scriptPath) => scriptPath !== INIT_SCRIPT_PATH);
}

function defaultMatchMedia(query: string) {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  };
}

async function flushMicrotasks(cycles = 5): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

function runInUiContext<T = unknown>(dom: JSDOM, source: string, filename: string): T {
  const script = new vm.Script(source, { filename });
  return script.runInContext(dom.getInternalVMContext()) as T;
}

export async function createUiHarness(options: UiHarnessOptions = {}): Promise<UiHarness> {
  const includeInit = options.includeInit ?? false;
  const rawHtml = readUiHtml();
  const dom = new JSDOM(stripScriptTags(rawHtml), {
    runScripts: 'dangerously',
    url: options.url ?? 'http://localhost/',
  });

  const { window } = dom;
  const fetchMock = vi.fn(options.fetchImpl ?? (async () => {
    throw new Error('fetch was not mocked for this UI harness.');
  }));
  const clipboardWriteTextMock = vi.fn(async () => undefined);
  const confirmMock = vi.fn(() => true);
  const matchMediaMock = vi.fn(defaultMatchMedia);
  const dataTableMock = vi.fn();

  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: fetchMock,
    writable: true,
  });

  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWriteTextMock },
  });

  Object.defineProperty(window, 'confirm', {
    configurable: true,
    value: confirmMock,
    writable: true,
  });

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: matchMediaMock,
    writable: true,
  });

  Object.defineProperty(window, 'simpleDatatables', {
    configurable: true,
    value: { DataTable: dataTableMock },
    writable: true,
  });

  const loadedScripts = extractUiScriptPaths(rawHtml, includeInit);

  for (const scriptPath of loadedScripts) {
    const absolutePath = path.join(UI_ROOT, scriptPath);
    const scriptSource = fs.readFileSync(absolutePath, 'utf8');
    runInUiContext(dom, scriptSource, absolutePath);
  }

  return {
    dom,
    window,
    document: window.document,
    fetchMock,
    clipboardWriteTextMock,
    confirmMock,
    matchMediaMock,
    dataTableMock,
    loadedScripts,
    evaluate<T = unknown>(expression: string): T {
      return runInUiContext<T>(dom, expression, 'ui-harness-eval.js');
    },
    getGlobal<T = unknown>(name: string): T {
      return runInUiContext<T>(dom, name, 'ui-harness-global.js');
    },
    call<T = unknown>(name: string, ...args: unknown[]): T {
      const fn = runInUiContext<((...fnArgs: unknown[]) => T) | undefined>(dom, name, 'ui-harness-callable.js');
      if (typeof fn !== 'function') {
        throw new Error(`Global function ${name} was not found in the UI harness.`);
      }
      return fn(...args);
    },
    settle(cycles = 5): Promise<void> {
      return flushMicrotasks(cycles);
    },
    cleanup(): void {
      dom.window.close();
    },
  };
}