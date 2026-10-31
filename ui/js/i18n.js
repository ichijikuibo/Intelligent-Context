// ── Localization ──────────────────────────────────────────────────────────

function getPreferredLocale() {
  return localStorage.getItem('ic.locale') || navigator.language || DEFAULT_LOCALE;
}

function getLocaleLabel(code) {
  return state.locales.find((locale) => locale.code === code)?.label || code;
}

async function loadLocale(requestedLocale = getPreferredLocale()) {
  const res = await fetch(API + '/api/i18n?lang=' + encodeURIComponent(requestedLocale));
  if (!res.ok) {
    throw new Error(res.statusText || 'Failed to load locale');
  }

  const payload = await res.json();
  state.locale = payload.locale || DEFAULT_LOCALE;
  state.defaultLocale = payload.defaultLocale || DEFAULT_LOCALE;
  state.locales = Array.isArray(payload.locales) ? payload.locales : [];
  state.messages = payload.messages || {};
  localStorage.setItem('ic.locale', state.locale);
  document.documentElement.lang = state.locale;
  document.title = t('ui.header.documentTitle');
}

function t(key, vars = {}) {
  const template = state.messages[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name];
    return value == null ? `{${name}}` : String(value);
  });
}

function translateOr(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

function getActiveTab() {
  return document.querySelector('#nav button.active')?.dataset.tab || 'overview';
}

function renderHeaderStatus() {
  const statusEl = document.getElementById('headerStatus');
  if (!state.health) {
    statusEl.textContent = t('ui.header.loading');
    return;
  }

  const numProviders = state.health.providers?.length ?? 0;
  const statusLabel = numProviders ? t('ui.status.running') : t('ui.status.setupNeeded');
  statusEl.innerHTML =
    `<span class="status-dot ${numProviders ? 'status-ok' : 'status-err'}"></span>` +
    esc(t('ui.header.statusSummary', { status: statusLabel, mode: state.health.mode }));
}

function applyLocaleChrome() {
  document.title = t('ui.header.documentTitle');
  document.getElementById('headerTitle').textContent = t('ui.header.title');
  document.getElementById('headerProjectLabel').textContent = t('ui.header.project');
  document.getElementById('headerLocaleLabel').textContent = t('ui.header.language');
  renderSelectedProjectIndicator();

  const localeSelect = document.getElementById('headerLocaleSelect');
  localeSelect.innerHTML = (state.locales.length > 0 ? state.locales : [{ code: DEFAULT_LOCALE, label: 'English' }])
    .map((locale) => `<option value="${esc(locale.code)}">${esc(locale.label)}</option>`)
    .join('');
  localeSelect.value = state.locale;

  const navLabels = {
    overview: 'ui.nav.overview',
    providers: 'ui.nav.providers',
    'external-providers': 'ui.externalProviders.title',
    models: 'ui.models.title',
    projects: 'ui.nav.projects',
    users: 'ui.nav.users',
    'api-keys': 'ui.nav.apiKeys',
    chat: 'ui.nav.chat',
    chunks: 'ui.nav.chunks',
    'code-extracts': 'ui.nav.codeExtracts',
    files: 'ui.nav.files',
    summaries: 'ui.nav.summaries',
    findings: 'ui.nav.findings',
    stats: 'ui.nav.stats',
    settings: 'ui.nav.settings',
    'task-runs': 'ui.nav.taskRuns',
  };
  for (const [tab, key] of Object.entries(navLabels)) {
    const button = document.getElementById('nav-' + tab);
    if (!button) continue;
    if (key) button.textContent = t(key);
  }
  // Caption for the shaded project-scoped group.
  const projectGroupLabel = document.getElementById('navProjectGroupLabel');
  if (projectGroupLabel) projectGroupLabel.textContent = t('ui.nav.projectGroup');

  const projectSelect = document.getElementById('headerProjectSelect');
  if (state.projects.length === 0) {
    const label = state.health ? t('ui.header.noProjects') : t('ui.header.loading');
    projectSelect.innerHTML = `<option value="">${esc(label)}</option>`;
  }

  renderHeaderStatus();
  updateAuthChrome();
}

async function onLocaleChange() {
  const requested = document.getElementById('headerLocaleSelect').value || DEFAULT_LOCALE;
  try {
    await loadLocale(requested);
    applyLocaleChrome();
    if (state.currentUser) {
      await renderTab(getActiveTab());
    } else if (state.setupCompletion) {
      renderSetupCompleteScreen(state.setupCompletion);
    } else if (state.needsSetup) {
      renderSetupScreen();
    } else {
      renderAuthScreen(state.needsBootstrap);
    }
    closeResponsiveChrome();
    toast(t('ui.header.localeUpdated', { label: getLocaleLabel(state.locale) }));
  } catch (err) {
    toast(String(err?.message || err), true);
  }
}
