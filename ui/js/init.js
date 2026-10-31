// ── Boot sequence ─────────────────────────────────────────────────────────

(async function init() {
  window.addEventListener('resize', syncResponsiveChrome);
  document.addEventListener('keydown', handleDocumentKeydown);
  syncResponsiveChrome();
  setShellAuthenticated(false);
  try {
    await loadLocale();
  } catch {
    state.messages = {};
  }
  applyLocaleChrome();

  try {
    const setup = await loadSetupStatus();
    state.setupStatus = setup;
    state.needsSetup = !!setup.needsSetup;
  } catch (err) {
    renderAuthScreen(false, String(err?.message || err));
    return;
  }

  if (state.needsSetup) {
    renderSetupScreen();
    return;
  }

  try {
    const bootstrap = await loadBootstrapStatus();
    state.needsBootstrap = !!bootstrap.needsBootstrap;
  } catch (err) {
    renderAuthScreen(false, String(err?.message || err));
    return;
  }

  if (state.needsBootstrap) {
    renderAuthScreen(true);
    return;
  }

  try {
    const session = await api('/auth/me');
    applySession(session);
    setShellAuthenticated(true);
    showTab('overview');
  } catch {
    renderAuthScreen(false);
  }
})();
