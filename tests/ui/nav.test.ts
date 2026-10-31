import { afterEach, describe, expect, it } from 'vitest';
import { createUiHarness, type UiHarness } from './harness';

const harnesses: UiHarness[] = [];

afterEach(() => {
  while (harnesses.length > 0) {
    harnesses.pop()?.cleanup();
  }
});

async function loadHarness() {
  const harness = await createUiHarness();
  harnesses.push(harness);
  return harness;
}

/** Tabs whose contents are scoped to the project selected in the header. */
const PROJECT_TABS = ['chat', 'chunks', 'code-extracts', 'files', 'summaries', 'findings', 'stats'];
/** Tabs that are the same whatever project is selected. */
const GLOBAL_TABS_BEFORE = ['overview', 'providers', 'external-providers', 'models', 'projects'];
const GLOBAL_TABS_AFTER = ['users', 'api-keys', 'settings', 'task-runs'];

describe('ui nav structure', () => {
  it('groups the project-scoped tabs into a shaded container', async () => {
    const harness = await loadHarness();
    const group = harness.document.getElementById('nav-project-group');

    expect(group).not.toBeNull();
    expect(group?.classList.contains('nav-group')).toBe(true);
    expect(group?.closest('#nav')).not.toBeNull();

    const tabsInside = Array.from(group?.querySelectorAll('button') ?? []).map((button) => button.dataset.tab);
    expect(tabsInside).toEqual(PROJECT_TABS);
  });

  it('places the project group directly after Projects', async () => {
    const harness = await loadHarness();
    const projectsButton = harness.document.getElementById('nav-projects');

    expect(projectsButton?.nextElementSibling?.id).toBe('nav-project-group');
  });

  it('keeps global tabs outside the group', async () => {
    const harness = await loadHarness();
    const group = harness.document.getElementById('nav-project-group');
    const navChildren = Array.from(harness.document.getElementById('nav')?.children ?? []);

    const groupIndex = navChildren.indexOf(group as Element);
    const tabsBefore = navChildren
      .slice(0, groupIndex)
      .map((node) => node instanceof harness.window.HTMLButtonElement ? node.dataset.tab : null);
    const tabsAfter = navChildren
      .slice(groupIndex + 1)
      .map((node) => node instanceof harness.window.HTMLButtonElement ? node.dataset.tab : null);

    expect(tabsBefore).toEqual(GLOBAL_TABS_BEFORE);
    expect(tabsAfter).toEqual(GLOBAL_TABS_AFTER);
  });

  it('renders a localized caption for the group', async () => {
    const harness = await loadHarness();
    const caption = harness.document.getElementById('navProjectGroupLabel');

    expect(caption).not.toBeNull();
    expect(caption?.classList.contains('nav-group-label')).toBe(true);

    harness.evaluate("state.messages = { 'ui.nav.projectGroup': 'Project Data' }");
    harness.call('applyLocaleChrome');

    expect(caption?.textContent).toBe('Project Data');
  });

  it('still exposes every project tab as a top level nav target', async () => {
    const harness = await loadHarness();

    for (const tab of [...PROJECT_TABS, ...GLOBAL_TABS_BEFORE, ...GLOBAL_TABS_AFTER]) {
      const button = harness.document.getElementById('nav-' + tab);
      expect(button, `nav-${tab} should exist`).not.toBeNull();
      expect(button?.getAttribute('onclick')).toBe(`showTab('${tab}')`);
    }
  });

  it('reports the active tab even when it sits inside the group', async () => {
    const harness = await loadHarness();
    harness.evaluate(
      "document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));" +
      "document.getElementById('nav-chunks').classList.add('active')",
    );

    expect(harness.call('getActiveTab')).toBe('chunks');
  });
});
