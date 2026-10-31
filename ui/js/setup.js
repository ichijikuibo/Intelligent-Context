// ── Initial setup wizard ──────────────────────────────────────────────────

function renderSetupScreen(message = '') {
  const el = document.getElementById('authScreen');
  const defaults = state.setupStatus?.defaults || {
    mode: 'local',
    database: {
      type: 'sqlite',
      sqlitePath: '',
      postgresUrl: '',
      backupRetention: 10,
    },
  };
  const setupError = state.setupStatus?.setupError || '';
  const activeMessage = message || setupError;
  const mode = defaults.mode === 'server' ? 'server' : 'local';
  const databaseType = defaults.database?.type === 'postgres' ? 'postgres' : 'sqlite';
  const storageFile = state.setupStatus?.storageFile || 'intelligent-context.setup.enc';
  const canAutoRestart = state.setupStatus?.canAutoRestart === true;

  el.innerHTML = `
    <div class="setup-shell">
      <div class="setup-hero">
        <span class="badge badge-blue">Initial setup</span>
        <h2 style="margin-top:12px">Choose how this installation should run</h2>
        <p>
          This setup replaces the external startup settings for run mode and database selection.
          The choices are stored in an encrypted <code>${esc(storageFile)}</code> file in the project root,
          and the service will use that file on the next startup.
        </p>
      </div>
      ${activeMessage ? `<div class="callout warn">${esc(activeMessage)}</div>` : ''}
      <div class="setup-grid">
        <div class="setup-stack">
          <div class="card">
            <h3>Run mode</h3>
            <div class="choice-grid" id="setupModeChoices">
              <label class="choice-card" data-choice-group="setupMode">
                <input type="radio" name="setupMode" value="local" ${mode === 'local' ? 'checked' : ''} onchange="syncSetupForm()" />
                <div>
                  <strong>Local only</strong>
                  <span>Bind the proxy and management UI to <code>127.0.0.1</code>. This is the default desktop / single-machine install path.</span>
                </div>
              </label>
              <label class="choice-card" data-choice-group="setupMode">
                <input type="radio" name="setupMode" value="server" ${mode === 'server' ? 'checked' : ''} onchange="syncSetupForm()" />
                <div>
                  <strong>Local network / self-hosted</strong>
                  <span>Bind services to <code>0.0.0.0</code> for LAN or container access. Only use this mode on a trusted network, and protect the management UI with a strong administrator password.</span>
                </div>
              </label>
            </div>
          </div>

          <div class="card">
            <h3>Database</h3>
            <div class="choice-grid" id="setupDatabaseChoices">
              <label class="choice-card" data-choice-group="setupDatabaseType">
                <input type="radio" name="setupDatabaseType" value="sqlite" ${databaseType === 'sqlite' ? 'checked' : ''} onchange="syncSetupForm()" />
                <div>
                  <strong>SQLite</strong>
                  <span>Good default for local installs and simple deployments. The path below can still be overridden before saving.</span>
                </div>
              </label>
              <label class="choice-card" data-choice-group="setupDatabaseType">
                <input type="radio" name="setupDatabaseType" value="postgres" ${databaseType === 'postgres' ? 'checked' : ''} onchange="syncSetupForm()" />
                <div>
                  <strong>PostgreSQL</strong>
                  <span>Use for multi-user or container-first deployments. Docker or environment defaults can be prefilled here and still edited.</span>
                </div>
              </label>
            </div>
            <div id="setupSqliteFields" class="setup-field-group mt-12">
              <div>
                <label>SQLite database path</label>
                <input id="setupSqlitePath" value="${esc(defaults.database?.sqlitePath || '')}" placeholder="~/.intelligent-context/data/db.sqlite" />
              </div>
              <div>
                <label>Backup retention</label>
                <input id="setupBackupRetention" type="number" min="0" step="1" value="${esc(defaults.database?.backupRetention ?? 10)}" />
              </div>
            </div>
            <div id="setupPostgresFields" class="setup-field-group mt-12">
              <div>
                <label>PostgreSQL connection string</label>
                <input id="setupPostgresUrl" value="${esc(defaults.database?.postgresUrl || '')}" placeholder="postgresql://user:password@db:5432/intelligent_context" />
              </div>
            </div>
          </div>

          <div class="card" id="setupLocalAdminFields">
            <h3>Local admin</h3>
            <div class="text-muted text-sm mb-12" style="line-height:1.7">
              Local-only installs create the first administrator during setup so the next restart lands on a normal sign-in screen.
            </div>
            <div class="form-row form-2">
              <div>
                <label>Login</label>
                <input id="setupAdminEmail" value="admin" placeholder="admin" />
              </div>
              <div>
                <label>Password</label>
                <input id="setupAdminPassword" type="password" placeholder="Choose a password" />
              </div>
            </div>
            <div class="form-row">
              <div>
                <label>Confirm password</label>
                <input id="setupAdminPasswordConfirm" type="password" placeholder="Repeat the password" />
              </div>
            </div>
          </div>

          <div class="flex" style="justify-content:flex-end">
            <button class="btn" data-submit-button onclick="submitSetup()">Save setup</button>
          </div>
        </div>

        <div class="setup-aside">
          <div class="card">
            <h3>What changes now</h3>
            <div class="setup-list">
              <div class="setup-list-item"><b>1.</b><span>The selected run mode and database are stored in the encrypted setup file.</span></div>
              <div class="setup-list-item"><b>2.</b><span>Docker or environment defaults are treated as starting values, not the final authority.</span></div>
              <div class="setup-list-item"><b>3.</b><span>After a restart the service will boot using the saved setup values instead of relying on external config for these choices.</span></div>
            </div>
            <div class="callout ${canAutoRestart ? '' : 'warn'} mt-12">
              ${canAutoRestart
                ? 'This installation can restart itself after setup is saved. The page will wait for the new process and reload automatically.'
                : 'This installation is not running in a supervised restart mode, so setup will still save immediately but you will need to restart the application yourself.'}
            </div>
          </div>
          <div class="card">
            <h3>Planned follow-up</h3>
            <div class="setup-placeholder">
              This sidebar is intentionally lightweight for now. It is a good place for a short video, screenshots,
              or environment-specific setup notes once the onboarding content is ready.
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  syncSetupForm();
}

function renderSetupCompleteScreen(payload) {
  const el = document.getElementById('authScreen');
  const setup = payload?.setup || {};
  const modeLabel = setup.mode === 'server' ? 'Local network / self-hosted' : 'Local only';
  const autoRestartTimedOut = payload?.autoRestartTimedOut === true;
  const restartNote = setup.mode === 'local'
    ? 'After restart, sign in with the local admin credentials you just entered.'
    : 'After restart, create the first administrator account on the sign-in screen.';
  const storageFile = payload?.storageFile || state.setupStatus?.storageFile || 'intelligent-context.setup.enc';
  const title = autoRestartTimedOut
    ? 'Automatic restart did not come back in time'
    : 'Restart Intelligent Context to apply the new runtime settings';
  const calloutText = autoRestartTimedOut
    ? 'The setup file was saved, but the process did not return within the expected window. Restart the application manually and then reload this page.'
    : 'The saved setup file is ready, but the running process still uses the old startup values until it is restarted.';

  el.innerHTML = `
    <div class="setup-shell">
      <div class="setup-hero">
        <span class="badge badge-green">Setup saved</span>
        <h2 style="margin-top:12px">${esc(title)}</h2>
        <p>
          Run mode: <strong>${esc(modeLabel)}</strong><br />
          Database: <strong>${esc(setup.databaseType || 'sqlite')}</strong><br />
          Storage file: <strong>${esc(storageFile)}</strong>
        </p>
      </div>

      <div class="card">
        <div class="callout warn">
          ${esc(calloutText)}
          ${esc(restartNote)}
        </div>
        <div class="flex" style="justify-content:flex-end">
          <button class="btn btn-ghost" onclick="window.location.reload()">Reload after restart</button>
        </div>
      </div>

      <div class="card">
        <h3>Next steps</h3>
        <div class="setup-next-grid">
          <div class="setup-placeholder">
            <strong>Add a provider</strong><br />
            Open the Providers tab and add at least one OpenAI-compatible or Anthropic-compatible provider.
            This is the first thing to do after you can sign in again.
          </div>
          <div class="setup-placeholder">
            <strong>Add a project</strong><br />
            Register the project roots you want the proxy to learn from so requests can be matched to a workspace.
          </div>
          <div class="setup-placeholder">
            <strong>Generate an API key</strong><br />
            Use the My API Keys screen after sign-in to create a personal key for your IDE or other clients.
          </div>
          <div class="setup-placeholder">
            <strong>Select models</strong><br />
            Visit Settings after providers are added to choose the summarizer, analyzer, and context selector models.
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Onboarding content placeholder</h3>
        <div class="setup-placeholder">
          Replace this block later with screenshots, short clips, or environment-specific walkthroughs.
          The structure is already here so the next iteration only needs content.
        </div>
      </div>
    </div>
  `;
}

function renderSetupRestartPendingScreen(payload, message = '') {
  const el = document.getElementById('authScreen');
  const setup = payload?.setup || {};
  const modeLabel = setup.mode === 'server' ? 'Local network / self-hosted' : 'Local only';
  const restartDelayMs = Number(payload?.restartDelayMs || 0);

  el.innerHTML = `
    <div class="setup-shell">
      <div class="setup-hero">
        <span class="badge badge-amber">Restarting</span>
        <h2 style="margin-top:12px">Applying the new startup settings</h2>
        <p>
          The setup file has been saved and this installation can restart itself.
          The page will reload as soon as the new process is available.
        </p>
      </div>
      <div class="card">
        <div class="callout">
          ${esc(message || `Waiting for the current process to stop and restart. Run mode: ${modeLabel}. Restart delay: ${restartDelayMs}ms.`)}
        </div>
      </div>
      <div class="card">
        <h3>Next steps after reload</h3>
        <div class="setup-list">
          <div class="setup-list-item"><b>1.</b><span>Sign in or create the first admin account, depending on the selected run mode.</span></div>
          <div class="setup-list-item"><b>2.</b><span>Add a provider, then a project, then generate an API key for your IDE.</span></div>
        </div>
      </div>
    </div>
  `;
}

async function monitorSetupRestart(payload) {
  renderSetupRestartPendingScreen(payload);

  const previousBootId = payload?.runtime?.bootId || state.setupStatus?.runtime?.bootId || '';
  const deadline = Date.now() + 90000;
  let sawUnavailable = false;

  while (Date.now() < deadline) {
    await wait(1000);

    try {
      const status = await loadSetupStatus();
      state.setupStatus = status;

      if (previousBootId && status?.runtime?.bootId && status.runtime.bootId !== previousBootId) {
        window.location.reload();
        return;
      }

      if (sawUnavailable) {
        window.location.reload();
        return;
      }

      renderSetupRestartPendingScreen(payload, 'Waiting for the supervised process to restart and report a new boot instance.');
    } catch {
      sawUnavailable = true;
      renderSetupRestartPendingScreen(payload, 'Restart in progress. Waiting for the management API to come back...');
    }
  }

  renderSetupCompleteScreen({
    ...payload,
    autoRestartTimedOut: true,
  });
}

function getSelectedRadioValue(name, fallbackValue) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || fallbackValue;
}

function syncSetupChoiceCards(name) {
  document.querySelectorAll(`[data-choice-group="${name}"]`).forEach((card) => {
    const input = card.querySelector(`input[name="${name}"]`);
    card.classList.toggle('is-selected', !!input?.checked);
  });
}

function syncSetupForm() {
  const mode = getSelectedRadioValue('setupMode', 'local');
  const databaseType = getSelectedRadioValue('setupDatabaseType', 'sqlite');

  const localAdminFields = document.getElementById('setupLocalAdminFields');
  const sqliteFields = document.getElementById('setupSqliteFields');
  const postgresFields = document.getElementById('setupPostgresFields');

  if (localAdminFields) {
    localAdminFields.style.display = mode === 'local' ? 'block' : 'none';
  }
  if (sqliteFields) {
    sqliteFields.style.display = databaseType === 'sqlite' ? 'grid' : 'none';
  }
  if (postgresFields) {
    postgresFields.style.display = databaseType === 'postgres' ? 'grid' : 'none';
  }

  syncSetupChoiceCards('setupMode');
  syncSetupChoiceCards('setupDatabaseType');
}

async function submitSetup() {
  const mode = getSelectedRadioValue('setupMode', 'local');
  const databaseType = getSelectedRadioValue('setupDatabaseType', 'sqlite');
  const sqlitePath = document.getElementById('setupSqlitePath')?.value?.trim() || '';
  const postgresUrl = document.getElementById('setupPostgresUrl')?.value?.trim() || '';
  const backupRetentionRaw = document.getElementById('setupBackupRetention')?.value?.trim() || '';
  const adminEmail = document.getElementById('setupAdminEmail')?.value?.trim() || '';
  const adminPassword = document.getElementById('setupAdminPassword')?.value || '';
  const adminPasswordConfirm = document.getElementById('setupAdminPasswordConfirm')?.value || '';
  const backupRetention = backupRetentionRaw === '' ? undefined : Number(backupRetentionRaw);

  if (databaseType === 'sqlite' && !sqlitePath) {
    toast('SQLite database path is required.', true);
    return;
  }

  if (databaseType === 'postgres' && !postgresUrl) {
    toast('PostgreSQL connection string is required.', true);
    return;
  }

  if (backupRetention !== undefined && (!Number.isInteger(backupRetention) || backupRetention < 0)) {
    toast('Backup retention must be a whole number greater than or equal to 0.', true);
    return;
  }

  if (mode === 'local') {
    if (!adminEmail || !adminPassword) {
      toast('Local admin login and password are required.', true);
      return;
    }
    if (adminPassword !== adminPasswordConfirm) {
      toast('Local admin passwords do not match.', true);
      return;
    }
  }

  const payload = {
    mode,
    database: {
      type: databaseType,
      sqlitePath,
      postgresUrl,
      backupRetention,
    },
    localAdmin: mode === 'local'
      ? {
          email: adminEmail,
          password: adminPassword,
        }
      : undefined,
  };

  try {
    const result = await api('/setup', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    state.needsSetup = false;
    state.setupCompletion = result;
    if (result?.restartScheduled) {
      await monitorSetupRestart(result);
      return;
    }
    renderSetupCompleteScreen(result);
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}
