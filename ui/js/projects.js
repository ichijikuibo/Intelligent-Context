// ── Projects, users & API keys tabs ───────────────────────────────────────

async function renderProjects() {
  const el = document.getElementById('tab-projects');
  const projects = await api('/projects');
  syncProjectHeaderSelect(projects);
  const canManageProjects = state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.role === 'power_user');

  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.projects.title'))}</h2>
      ${canManageProjects ? `<button class="btn btn-sm" onclick="showAddProjectForm()">${esc(t('ui.projects.addButton'))}</button>` : ''}
    </div>
    <div id="addProjectForm" style="display:${canManageProjects ? 'none' : 'none'}" class="card mb-16">
      <h3>${esc(t('ui.projects.registerProject'))}</h3>
      <div class="edit-panel mt-8" data-enter-submit>
        <div class="form-row form-2">
          <div><label>${esc(t('ui.projects.name'))}</label><input id="newProjName" placeholder="${esc(t('ui.projects.namePlaceholder'))}" /></div>
          <div><label>${esc(t('ui.projects.rootPath'))}</label><input id="newProjPath" placeholder="${esc(t('ui.projects.rootPathPlaceholder'))}" /></div>
        </div>
        <div class="form-row">
          <div>
            <label>${esc(t('ui.projects.pathPattern'))}</label>
            <input id="newProjPattern" placeholder="${esc(t('ui.projects.pathPatternPlaceholder'))}" />
            <div class="text-muted text-sm mt-8">${esc(t('ui.projects.pathPatternHint'))}</div>
          </div>
        </div>
        <button class="btn btn-sm" data-submit-button onclick="addProject()">${esc(t('ui.projects.create'))}</button>
      </div>
    </div>
    ${projects.length === 0
      ? `<div class="empty">${esc(t('ui.projects.empty'))} ${esc(t('ui.projects.emptyHint'))}</div>`
      : projects.map(p => `
        <div class="pcard ${state.selectedProject===p.id?'is-default':''}" onclick="selectProject('${p.id}')" style="cursor:pointer">
          <div class="flex">
            <div style="flex:1">
              <strong>${esc(p.name)}</strong>
              <div class="mono text-muted text-sm mt-8">${esc(p.rootPath)}</div>
              ${p.pathPattern ? `<div class="text-muted text-sm mt-8">${esc(t('ui.projects.patternLabel'))}: <span class="mono">${esc(p.pathPattern)}</span></div>` : ''}
            </div>
            ${canManageProjects ? `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deleteProject('${p.id}')">${esc(t('ui.actions.delete'))}</button>` : ''}
          </div>
        </div>`).join('')}
  `;
}

function showAddProjectForm() {
  document.getElementById('addProjectForm').style.display = 'block';
}

async function addProject() {
  const name = document.getElementById('newProjName').value.trim();
  const rootPath = document.getElementById('newProjPath').value.trim();
  const pathPattern = document.getElementById('newProjPattern').value.trim();
  if (!name || !rootPath) { toast(t('ui.projects.validationNameAndPath'), true); return; }
  try {
    await api('/projects', {
      method: 'POST',
      body: JSON.stringify({ name, rootPath, pathPattern: pathPattern || null })
    });
    toast(t('ui.projects.created'));
    await renderProjects();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}

async function deleteProject(id) {
  if (!confirm(t('ui.projects.confirmDelete'))) return;
  try {
    await api('/projects/' + id, { method: 'DELETE' });
    state.projects = state.projects.filter((project) => project.id !== id);
    syncProjectHeaderSelect(state.projects);
    toast(t('ui.projects.deleted'));
    await renderProjects();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}

function selectProject(id) {
  state.selectedProject = id;
  storeSelectedProject(id);
  renderSelectedProjectIndicator();
  document.getElementById('headerProjectSelect').value = id;
  renderProjects();
}

// ── Users & API keys ───────────────────────────────────────────────────────

function roleOptions(selected) {
  return ['admin', 'power_user', 'user']
    .map((role) => `<option value="${role}" ${role === selected ? 'selected' : ''}>${role}</option>`)
    .join('');
}

function renderProjectCheckboxes(group, projects, selectedIds = []) {
  if (projects.length === 0) {
    return `<div class="text-muted text-sm">No projects available.</div>`;
  }

  return `
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${projects.map((project) => `
        <label class="flex" style="gap:6px;background:var(--bg);padding:6px 10px;border-radius:6px;border:1px solid var(--border)">
          <input type="checkbox" data-project-group="${group}" value="${project.id}" ${selectedIds.includes(project.id) ? 'checked' : ''} style="width:auto" />
          <span class="text-sm">${esc(project.name)}</span>
        </label>
      `).join('')}
    </div>
  `;
}

function collectCheckedProjects(group) {
  return Array.from(document.querySelectorAll(`input[data-project-group="${group}"]:checked`)).map((el) => el.value);
}

/** Grants stashed by the access dialog for an existing user. */
function readUserGrants(userId) {
  const field = document.getElementById(`user_grants_${userId}`);
  if (!field) return [];
  try {
    const parsed = JSON.parse(field.value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Admins always hold `*-*`, so the per-model access controls are meaningless
 * for them — hide them rather than showing a list that cannot apply.
 */
function syncUserModelAccessVisibility(userId, role) {
  const isAdmin = role === 'admin';
  const accessRow = document.getElementById(`user_model_access_row_${userId}`);
  const allModelsRow = document.getElementById(`user_all_models_row_${userId}`);
  if (accessRow) accessRow.style.display = isAdmin ? 'none' : '';
  if (allModelsRow) allModelsRow.style.display = isAdmin ? 'none' : '';
}

function onUserRoleChange(userId) {
  const role = document.getElementById(`user_role_${userId}`).value;
  syncUserModelAccessVisibility(userId, role);
}

function onNewUserRoleChange() {
  const role = document.getElementById('newUserRole').value;
  const isAdmin = role === 'admin';
  const accessRow = document.getElementById('newUserModelAccessRow');
  const allModelsRow = document.getElementById('newUserAllModelsRow');
  if (accessRow) accessRow.style.display = isAdmin ? 'none' : '';
  if (allModelsRow) allModelsRow.style.display = isAdmin ? 'none' : '';
}

async function renderUsers() {
  const el = document.getElementById('tab-users');
  if (!state.currentUser || state.currentUser.role !== 'admin') {
    el.innerHTML = `<div class="empty">Admin access is required.</div>`;
    return;
  }

  const [users, projects] = await Promise.all([api('/users'), api('/projects')]);
  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">Users</h2>
    </div>
    <div class="card mb-16">
      <h3>Create User</h3>
      <div class="edit-panel mt-8" data-enter-submit>
        <div class="form-row form-2">
          <div><label>Login</label><input id="newUserEmail" placeholder="user@example.com" /></div>
          <div><label>Password</label><input id="newUserPassword" type="password" placeholder="Password" /></div>
        </div>
        <div class="form-row form-2">
          <div>
            <label>Role</label>
            <select id="newUserRole" onchange="onNewUserRoleChange()">${roleOptions('user')}</select>
          </div>
        </div>
        <div class="form-row" id="newUserModelAccessRow">
          <div>
            <label>Model Access</label>
            <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-sm btn-ghost" type="button" onclick="openModelAccessDialog(null, 'new user', draftUserGrants)">
                ${esc(t('ui.models.accessDialogOpen'))}
              </button>
              <span id="newUserGrantsLabel"></span>
            </div>
            <div class="text-muted text-sm mt-8">${esc(t('ui.models.accessDialogIntro'))}</div>
          </div>
        </div>
        <div class="form-row form-2">
          <label class="flex" style="gap:8px"><input id="newUserApproved" type="checkbox" checked style="width:auto" /> Approved</label>
          <label class="flex" style="gap:8px"><input id="newUserDisabled" type="checkbox" style="width:auto" /> Disabled</label>
        </div>
        <div class="form-row form-2">
          <label class="flex" style="gap:8px"><input id="newUserAllProjects" type="checkbox" style="width:auto" /> Access all projects</label>
          <label class="flex" style="gap:8px" id="newUserAllModelsRow"><input id="newUserAllModels" type="checkbox" style="width:auto" /> Access all models (<code>*-*</code>)</label>
        </div>
        <div class="form-row">
          <div>
            <label>Project Access</label>
            ${renderProjectCheckboxes('new-user', projects, [])}
          </div>
        </div>
        <button class="btn" data-submit-button onclick="createUser()">Create User</button>
      </div>
    </div>
    ${users.length === 0 ? `<div class="empty">No users found.</div>` : users.map((user) => `
      <div class="pcard" data-enter-submit>
        <div class="flex mb-12">
          <div style="flex:1">
            <strong>${esc(user.email)}</strong>
            <div class="text-muted text-sm mt-8">Created ${fmtDate(user.createdAt)}${user.lastLoginAt ? ` · Last login ${fmtDate(user.lastLoginAt)}` : ''}</div>
          </div>
          <span class="badge ${user.isDisabled ? 'badge-red' : user.isApproved ? 'badge-green' : 'badge-amber'}">${user.isDisabled ? 'disabled' : user.isApproved ? 'approved' : 'pending'}</span>
        </div>
        <div class="form-row form-2">
          <div>
            <label>Role</label>
            <select id="user_role_${user.id}" onchange="onUserRoleChange('${user.id}')">${roleOptions(user.role)}</select>
          </div>
          <div id="user_model_access_row_${user.id}">
            <label>Model Access</label>
            <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
              <button class="btn btn-sm btn-ghost" type="button"
                      onclick="openModelAccessDialog('${modelJsArg(user.id)}', '${modelJsArg(user.email)}', readUserGrants('${modelJsArg(user.id)}'))">
                ${esc(t('ui.models.accessDialogOpen'))}
              </button>
              <span id="user_grants_label_${user.id}">${renderGrantsSummary(user.role === 'admin' ? ['*-*'] : (user.allowedModels || []))}</span>
            </div>
            <!-- Grants live here until Save Changes is pressed. -->
            <input type="hidden" id="user_grants_${user.id}" value='${esc(JSON.stringify(user.role === 'admin' ? ['*-*'] : (user.allowedModels || [])))}' />
          </div>
        </div>
        <div class="form-row form-2">
          <label class="flex" style="gap:8px"><input id="user_approved_${user.id}" type="checkbox" ${user.isApproved ? 'checked' : ''} style="width:auto" /> Approved</label>
          <label class="flex" style="gap:8px"><input id="user_disabled_${user.id}" type="checkbox" ${user.isDisabled ? 'checked' : ''} style="width:auto" /> Disabled</label>
        </div>
        <div class="form-row form-2">
          <label class="flex" style="gap:8px"><input id="user_all_projects_${user.id}" type="checkbox" ${user.accessAllProjects ? 'checked' : ''} style="width:auto" /> Access all projects</label>
          <label class="flex" style="gap:8px" id="user_all_models_row_${user.id}" ${user.role === 'admin' ? 'style="display:none"' : ''}><input id="user_all_models_${user.id}" type="checkbox" ${user.accessAllModels ? 'checked' : ''} style="width:auto" /> Access all models (<code>*-*</code>)</label>
        </div>
        <div class="form-row form-2">
          <div>
            <label>Reset Password</label>
            <input id="user_password_${user.id}" type="password" placeholder="Leave blank to keep current password" />
          </div>
          <div>
            <label>Project Access</label>
            ${renderProjectCheckboxes(`user-${user.id}`, projects, user.projectIds || [])}
          </div>
        </div>
        <div class="flex" style="justify-content:flex-end">
          <button class="btn btn-sm" data-submit-button onclick="saveUser('${user.id}')">Save Changes</button>
        </div>
      </div>
    `).join('')}
  `;

  // Admin accounts never carry model restrictions, so their access controls
  // are hidden rather than shown with values that cannot apply.
  users.forEach((user) => syncUserModelAccessVisibility(user.id, user.role));
  renderDraftUserGrantsLabel();
}

async function createUser() {
  const email = document.getElementById('newUserEmail').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  const allowedModels = draftUserGrants;
  const isApproved = document.getElementById('newUserApproved').checked;
  const isDisabled = document.getElementById('newUserDisabled').checked;
  const accessAllProjects = document.getElementById('newUserAllProjects').checked;
  const accessAllModels = document.getElementById('newUserAllModels').checked;
  const projectIds = collectCheckedProjects('new-user');

  if (!email || !password) {
    toast('Login and password are required.', true);
    return;
  }

  try {
    await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        role,
        allowedModels,
        isApproved,
        isDisabled,
        accessAllProjects,
        accessAllModels,
        projectIds,
      }),
    });
    toast('User created.');
    await renderUsers();
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}

async function saveUser(id) {
  const role = document.getElementById(`user_role_${id}`).value;
  const allowedModels = readUserGrants(id);
  const isApproved = document.getElementById(`user_approved_${id}`).checked;
  const isDisabled = document.getElementById(`user_disabled_${id}`).checked;
  const accessAllProjects = document.getElementById(`user_all_projects_${id}`).checked;
  const accessAllModels = document.getElementById(`user_all_models_${id}`).checked;
  const password = document.getElementById(`user_password_${id}`).value;
  const projectIds = collectCheckedProjects(`user-${id}`);

  try {
    await api('/users/' + id, {
      method: 'PUT',
      body: JSON.stringify({
        role,
        allowedModels,
        isApproved,
        isDisabled,
        accessAllProjects,
        accessAllModels,
        password,
        projectIds,
      }),
    });
    toast('User updated.');
    await renderUsers();
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}

async function renderApiKeys() {
  const el = document.getElementById('tab-api-keys');
  const keys = await api('/auth/api-keys');
  const placeholderKey = t('ui.apiKeys.placeholderKey');
  const mcpKey = state.generatedApiKey || placeholderKey;
  const mcpConfig = JSON.stringify({
    mcpServers: {
      'intelligent-context': {
        url: mcpUrl(),
        headers: { Authorization: `Bearer ${mcpKey}` },
      },
    },
  }, null, 2);
  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.apiKeys.title'))}</h2>
    </div>
    <div class="card mb-16">
      <h3>${esc(t('ui.apiKeys.createTitle'))}</h3>
      <div class="edit-panel mt-8" data-enter-submit>
        <div class="form-row form-2">
          <div><label>${esc(t('ui.apiKeys.name'))}</label><input id="newApiKeyName" placeholder="${esc(t('ui.apiKeys.namePlaceholder'))}" /></div>
          <div class="flex" style="align-items:flex-end;justify-content:flex-end"><button class="btn" data-submit-button onclick="createMyApiKey()">${esc(t('ui.apiKeys.generate'))}</button></div>
        </div>
        ${state.generatedApiKey ? `
          <div class="callout warn">
            ${esc(t('ui.apiKeys.saveNow'))}<br/>
            <code>${esc(state.generatedApiKey)}</code>
          </div>
        ` : ''}
      </div>
    </div>
    <div class="card mb-16">
      <h3>${esc(t('ui.apiKeys.mcpTitle'))}</h3>
      <div class="callout">
        ${esc(t('ui.apiKeys.mcpIntro', {
          search: t('ui.apiKeys.mcpIntroSearch'),
          record: t('ui.apiKeys.mcpIntroRecord'),
        }))}
        <br/><br/>
        ${esc(t('ui.apiKeys.mcpEndpoint'))} <code>${esc(mcpUrl())}</code>
        ${state.generatedApiKey
          ? `<br/>${esc(t('ui.apiKeys.mcpUsesGeneratedKey'))}`
          : `<br/>${esc(t('ui.apiKeys.mcpReplaceKey', { placeholder: placeholderKey }))}`}
      </div>
      <div class="flex" style="justify-content:space-between;align-items:center">
        <label style="margin:0">${esc(t('ui.apiKeys.mcpClientConfig'))}</label>
        <button class="btn btn-sm" onclick="copyMcpConfig(this)">${esc(t('ui.apiKeys.copy'))}</button>
      </div>
      <pre class="mcp-config" id="mcpConfigSnippet">${esc(mcpConfig)}</pre>
    </div>
    <div class="card mb-16">
      <h3>${esc(t('ui.apiKeys.proxyTitle'))}</h3>
      <div class="callout">
        ${esc(t('ui.apiKeys.proxyIntro'))}
      </div>
      <div class="flex" style="justify-content:space-between;align-items:center">
        <label style="margin:0">${esc(t('ui.apiKeys.proxyBaseUrl'))}</label>
        <button class="btn btn-sm" onclick="copyApiKeyValue(this, 'apiKeysProxyUrl')">${esc(t('ui.apiKeys.proxyCopy'))}</button>
      </div>
      <pre class="mcp-config" id="apiKeysProxyUrl">${esc(proxyUrl())}</pre>
      <div class="flex" style="justify-content:space-between;align-items:center">
        <label style="margin:0">${esc(t('ui.apiKeys.proxyMessagesUrl'))}</label>
        <button class="btn btn-sm" onclick="copyApiKeyValue(this, 'apiKeysProxyMessagesUrl')">${esc(t('ui.apiKeys.proxyCopy'))}</button>
      </div>
      <pre class="mcp-config" id="apiKeysProxyMessagesUrl">${esc(proxyUrl('/v1/messages'))}</pre>
      <div class="text-muted text-sm mt-8">
        ${esc(t('ui.apiKeys.proxyModelHint'))}<br/>
        ${esc(t('ui.apiKeys.proxyProjectHint'))}
      </div>
    </div>
    <div class="card mb-16">
      <h3>${esc(t('ui.apiKeys.vscodeTitle'))}</h3>
      <div class="callout">
        ${esc(t('ui.apiKeys.vscodeNote'))}
        <br/><br/>
        ${esc(t('ui.apiKeys.vscodeHint'))}
      </div>
    </div>
    ${keys.length === 0
      ? `<div class="empty">${esc(t('ui.apiKeys.empty'))}</div>`
      : keys.map((key) => `
        <div class="pcard">
          <div class="flex">
            <div style="flex:1">
              <strong>${esc(key.name)}</strong>
              <div class="text-muted text-sm mt-8">${esc(t('ui.apiKeys.created'))} ${fmtDate(key.createdAt)}${key.lastUsedAt ? ` · ${esc(t('ui.apiKeys.lastUsed'))} ${fmtDate(key.lastUsedAt)}` : ''}</div>
              ${key.revokedAt ? `<div class="text-muted text-sm mt-8">${esc(t('ui.apiKeys.revoked'))} ${fmtDate(key.revokedAt)}</div>` : ''}
            </div>
            ${key.revokedAt ? `<span class="badge badge-gray">${esc(t('ui.apiKeys.revokedBadge'))}</span>` : `<button class="btn btn-sm btn-danger" onclick="revokeMyApiKey('${key.id}')">${esc(t('ui.apiKeys.revoke'))}</button>`}
          </div>
        </div>
      `).join('')}
  `;
}

function copyMcpConfig(btn) {
  const snippet = document.getElementById('mcpConfigSnippet');
  const text = snippet ? snippet.textContent : '';
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = t('ui.apiKeys.copied');
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    toast(t('ui.apiKeys.copyFailed'), true);
  });
}

function copyApiKeyValue(btn, elementId) {
  const snippet = document.getElementById(elementId);
  const text = snippet ? snippet.textContent : '';
  navigator.clipboard.writeText(text).then(() => {
    const original = btn.textContent;
    btn.textContent = t('ui.apiKeys.proxyCopied');
    setTimeout(() => { btn.textContent = original; }, 1500);
  }).catch(() => {
    toast(t('ui.apiKeys.copyFailed'), true);
  });
}

async function createMyApiKey() {
  const name = document.getElementById('newApiKeyName').value.trim() || t('ui.apiKeys.defaultKeyName');
  try {
    const result = await api('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    state.generatedApiKey = result.apiKey;
    toast(t('ui.apiKeys.keyCreated'));
    await renderApiKeys();
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}

async function revokeMyApiKey(id) {
  if (!confirm(t('ui.apiKeys.confirmRevoke'))) return;
  try {
    await api('/auth/api-keys/' + id, { method: 'DELETE' });
    toast(t('ui.apiKeys.keyRevoked'));
    await renderApiKeys();
  } catch (err) {
    toast(getErrorMessage(err), true);
  }
}
