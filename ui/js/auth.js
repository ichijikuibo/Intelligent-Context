// ── Auth screens & session handling ───────────────────────────────────────

function renderAuthScreen(needsBootstrap, message = '') {
  const el = document.getElementById('authScreen');
  const title = needsBootstrap ? 'Create Admin Account' : 'Sign In';
  const action = needsBootstrap ? 'bootstrapAccount()' : 'login()';
  const button = needsBootstrap ? 'Create Admin' : 'Sign In';
  const loginValue = needsBootstrap && !state.currentUser ? 'admin' : '';
  el.innerHTML = `
    <div style="max-width:460px;margin:48px auto">
      <div class="card" data-enter-submit>
        <h2>${esc(title)}</h2>
        ${message ? `<div class="callout warn mt-12">${esc(message)}</div>` : ''}
        <div class="text-muted text-sm mt-12" style="line-height:1.7">
          ${needsBootstrap
            ? 'Multi-user mode is not initialized yet. Create the first administrator account to continue.'
            : 'Sign in to access the management interface.'}
        </div>
        <div class="form-row mt-12">
          <div>
            <label>Login</label>
            <input id="authEmail" value="${esc(loginValue)}" placeholder="admin or you@example.com" />
          </div>
        </div>
        <div class="form-row">
          <div>
            <label>Password</label>
            <input id="authPassword" type="password" placeholder="Password" />
          </div>
        </div>
        <div class="flex" style="justify-content:flex-end">
          <button class="btn" data-submit-button onclick="${action}">${esc(button)}</button>
        </div>
      </div>
    </div>
  `;
}

async function bootstrapAccount() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email || !password) {
    toast('Login and password are required.', true);
    return;
  }

  try {
    const session = await api('/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    state.needsBootstrap = false;
    applySession(session);
    setShellAuthenticated(true);
    showTab('overview');
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}

async function login() {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email || !password) {
    toast('Login and password are required.', true);
    return;
  }

  try {
    const session = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    applySession(session);
    setShellAuthenticated(true);
    showTab('overview');
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}

async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout API failures and clear the shell anyway.
  }

  state.currentUser = null;
  state.projects = [];
  state.selectedProject = null;
  state.generatedApiKey = null;
  updateAuthChrome();
  setShellAuthenticated(false);
  renderAuthScreen(false);
}

function applySession(session) {
  state.currentUser = session.user;
  state.projects = Array.isArray(session.projects) ? session.projects : [];
  const storedProjectId = getStoredSelectedProject();
  if (storedProjectId && state.projects.some((project) => project.id === storedProjectId)) {
    state.selectedProject = storedProjectId;
  }
  syncProjectHeaderSelect(state.projects);
  updateAuthChrome();
}
