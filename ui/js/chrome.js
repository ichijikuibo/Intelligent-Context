// ── Responsive chrome, header controls and auth shell visibility ──────────

const COMPACT_VIEWPORT_QUERY = '(max-width: 960px)';

function isCompactViewport() {
  return window.matchMedia(COMPACT_VIEWPORT_QUERY).matches;
}

function isTextInputTarget(target) {
  if (!(target instanceof HTMLInputElement)) return false;
  const type = (target.type || 'text').toLowerCase();
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file'].includes(type);
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape') {
    if (document.getElementById('modelAccessDialogBackdrop')) {
      closeModelAccessDialog();
      return;
    }
    if (document.getElementById('modelsDialogBackdrop')) {
      closeModelDialog();
      return;
    }
    if (document.getElementById('fileDetailsDialogBackdrop')) {
      closeFileDetailsDialog();
      return;
    }
    if (document.getElementById('summaryDialogBackdrop')) {
      closeSummaryDialog();
      return;
    }
    if (document.getElementById('codeExtractDialogBackdrop')) {
      closeCodeExtractDialog();
      return;
    }
    closeResponsiveChrome();
    return;
  }

  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
    return;
  }

  if (!isTextInputTarget(event.target)) {
    return;
  }

  const container = event.target.closest('[data-enter-submit]');
  if (!container) {
    return;
  }

  const button = container.querySelector('[data-submit-button]');
  if (!(button instanceof HTMLElement) || button.hasAttribute('disabled')) {
    return;
  }

  event.preventDefault();
  button.click();
}

function syncResponsiveChrome() {
  if (!isCompactViewport()) {
    document.body.classList.remove('nav-open', 'header-menu-open');
  }

  const navToggle = document.getElementById('mobileNavToggle');
  const headerToggle = document.getElementById('mobileHeaderToggle');
  const navOpen = document.body.classList.contains('nav-open');
  const headerMenuOpen = document.body.classList.contains('header-menu-open');

  if (navToggle) navToggle.setAttribute('aria-expanded', String(navOpen));
  if (headerToggle) headerToggle.setAttribute('aria-expanded', String(headerMenuOpen));
}

function closeResponsiveChrome() {
  document.body.classList.remove('nav-open', 'header-menu-open');
  syncResponsiveChrome();
}

function toggleSidebar() {
  if (!isCompactViewport()) return;
  const willOpen = !document.body.classList.contains('nav-open');
  document.body.classList.toggle('nav-open', willOpen);
  document.body.classList.remove('header-menu-open');
  syncResponsiveChrome();
}

function toggleHeaderMenu() {
  if (!isCompactViewport()) return;
  const willOpen = !document.body.classList.contains('header-menu-open');
  document.body.classList.toggle('header-menu-open', willOpen);
  document.body.classList.remove('nav-open');
  syncResponsiveChrome();
}

function getSelectedProjectName() {
  return state.projects.find((project) => project.id === state.selectedProject)?.name || '';
}

function renderSelectedProjectIndicator() {
  const el = document.getElementById('headerProjectName');
  if (!el) return;

  const projectName = getSelectedProjectName();
  if (projectName) {
    el.textContent = projectName;
    el.style.display = 'inline';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function setShellAuthenticated(isAuthenticated) {
  // `ic-shell` pins the document to the viewport (see app.css) so the header
  // and nav stay put while only the main panel scrolls. It is only applied to
  // the authenticated shell — the setup and sign-in screens scroll normally.
  document.body.classList.toggle('ic-shell', isAuthenticated);
  if (!isAuthenticated) {
    closeResponsiveChrome();
  }
  document.getElementById('authScreen').style.display = isAuthenticated ? 'none' : 'block';
  document.getElementById('appHeader').style.display = isAuthenticated ? 'flex' : 'none';
  document.getElementById('appLayout').style.display = isAuthenticated ? 'grid' : 'none';
  if (isAuthenticated) {
    syncResponsiveChrome();
  }
}

function updateAuthChrome() {
  const headerUser = document.getElementById('headerUser');
  const headerLogout = document.getElementById('headerLogout');
  const navUsers = document.getElementById('nav-users');
  const navApiKeys = document.getElementById('nav-api-keys');
  const navProviders = document.getElementById('nav-providers');
  const navExternalProviders = document.getElementById('nav-external-providers');
  const navSettings = document.getElementById('nav-settings');

  if (!state.currentUser) {
    headerUser.style.display = 'none';
    headerLogout.style.display = 'none';
    navUsers.style.display = 'none';
    navApiKeys.style.display = 'none';
    navProviders.style.display = 'none';
    navExternalProviders.style.display = 'none';
    navSettings.style.display = 'none';
    return;
  }

  headerUser.textContent = `${state.currentUser.email} (${state.currentUser.role})`;
  headerUser.style.display = 'inline';
  headerLogout.style.display = 'inline-flex';
  navApiKeys.style.display = 'block';
  navUsers.style.display = state.currentUser.role === 'admin' ? 'block' : 'none';
  navProviders.style.display = state.currentUser.role === 'admin' || state.currentUser.role === 'power_user' ? 'block' : 'none';
  navExternalProviders.style.display = state.currentUser.role === 'admin' || state.currentUser.role === 'power_user' ? 'block' : 'none';
  navSettings.style.display = state.currentUser.role === 'admin' ? 'block' : 'none';
  document.getElementById('nav-task-runs').style.display = state.currentUser.role === 'admin' ? 'block' : 'none';
  document.getElementById('headerNotifications').style.display = state.currentUser.role === 'admin' ? 'inline-flex' : 'none';
  if (state.currentUser.role === 'admin') pollUnreadNotifications();
}

function syncProjectHeaderSelect(projects = state.projects) {
  state.projects = projects;
  const storedProjectId = getStoredSelectedProject();
  if ((!state.selectedProject || !projects.some((project) => project.id === state.selectedProject)) && storedProjectId && projects.some((project) => project.id === storedProjectId)) {
    state.selectedProject = storedProjectId;
  }
  if (!projects.some((project) => project.id === state.selectedProject)) {
    state.selectedProject = projects[0]?.id ?? null;
  }

  const sel = document.getElementById('headerProjectSelect');
  sel.innerHTML = projects.length === 0
    ? `<option value="">${esc(t('ui.header.noProjects'))}</option>`
    : projects.map((project) =>
        `<option value="${project.id}" ${project.id === state.selectedProject ? 'selected' : ''}>${esc(project.name)}</option>`
      ).join('');

  if (state.selectedProject) {
    sel.value = state.selectedProject;
  }
  storeSelectedProject(state.selectedProject);
  renderSelectedProjectIndicator();
}

function onHeaderProjectChange() {
  const id = document.getElementById('headerProjectSelect').value;
  if (id) {
    state.selectedProject = id;
    storeSelectedProject(id);
    renderSelectedProjectIndicator();
    closeResponsiveChrome();
    renderTab(getActiveTab());
  }
}
