// ── Providers & external providers tabs ───────────────────────────────────

const TYPE_URLS = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };

async function renderProviders() {
  const el = document.getElementById('tab-providers');
  const providers = await api('/providers').catch(() => []);

  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.providers.title'))}</h2>
      <button class="btn" onclick="showAddForm()">${esc(t('ui.providers.addButton'))}</button>
    </div>

    <div class="callout mb-16">
      ${esc(t('ui.providers.calloutLead'))}
      ${esc(t('ui.providers.calloutAnthropicHint'))}
      ${esc(t('ui.providers.calloutOpenAiHint'))}
      ${esc(t('ui.providers.calloutOverride'))}
    </div>

    <!-- Add form (hidden by default) -->
    <div id="addForm" style="display:none" class="card mb-16">
      <h3>${esc(t('ui.providers.newProvider'))}</h3>
      <div class="edit-panel mt-8" data-enter-submit>
        <div class="form-row form-2">
          <div>
            <label>${esc(t('ui.providers.displayName'))}</label>
            <input id="f_name" placeholder="${esc(t('ui.providers.displayNamePlaceholder'))}" />
          </div>
          <div>
            <label>${esc(t('ui.providers.type'))}</label>
            <select id="f_type" onchange="onTypeChange()">
              <option value="openai">${esc(t('ui.type.openaiCompatible'))}</option>
              <option value="anthropic">${esc(t('ui.type.anthropic'))}</option>
            </select>
          </div>
        </div>
        <div class="form-row form-2">
          <div>
            <label>${esc(t('ui.providers.baseUrl'))}</label>
            <input id="f_url" placeholder="${esc(t('ui.providers.baseUrlPlaceholder'))}" />
          </div>
          <div>
            <label>${esc(t('ui.providers.apiKey'))}</label>
            <input id="f_key" type="password" placeholder="${esc(t('ui.providers.apiKeyPlaceholder'))}" />
          </div>
        </div>
        <div class="form-row form-2">
          <div>
            <label>${esc(t('ui.providers.shortPrefix'))}</label>
            <input id="f_shortPrefix" placeholder="${esc(t('ui.providers.shortPrefixPlaceholder'))}" />
            <div class="text-muted text-sm mt-8">${esc(t('ui.providers.shortPrefixHint'))}</div>
          </div>
          <div>
            <label>${esc(t('ui.providers.models'))} <span class="text-muted">${esc(t('ui.providers.modelsHint'))}</span></label>
            <input id="f_model" placeholder="${esc(t('ui.providers.modelsPlaceholder'))}" />
          </div>
        </div>
        <div class="flex" style="gap:8px">
          <button class="btn" data-submit-button onclick="addProvider()">${esc(t('ui.providers.save'))}</button>
          <button class="btn btn-ghost" onclick="testAddForm()">${esc(t('ui.providers.testConnection'))}</button>
          <button class="btn btn-ghost" onclick="hideAddForm()">${esc(t('ui.providers.cancel'))}</button>
        </div>
      </div>
    </div>

    <!-- Provider list (externally-managed providers are hidden — they appear under External Providers) -->
    <div id="providerList">
      ${providers.length === 0
        ? `<div class="empty">${esc(t('ui.providers.empty'))}<br/>${esc(t('ui.providers.emptyHint'))}</div>`
        : providers.filter(p => !p.externalProviderId).map(renderProviderCard).join('')}
    </div>

    <div class="callout mt-16">
      <strong>${esc(t('ui.overview.ideSetup'))}</strong><br/>
      ${esc(t('ui.overview.ideSetupIntro'))} <code>${proxyUrl()}</code><br/>
      <span class="text-muted text-sm mt-8" style="display:block">
        Model IDs above are prefixed (e.g. <code>OAI-gpt-4o</code>). Use the exact prefixed name in your IDE's model selector. For Anthropic providers, set the base URL to <code>${proxyUrl('/v1/messages')}</code>.
      </span>
    </div>
  `;

  onTypeChange(); // prime default URL
}

function renderProviderCard(p) {
  const eid = 'ep_' + p.id.replace(/-/g, '');
  const mid = 'models_' + eid;
  return `
    <div class="pcard ${p.isDefault ? 'is-default' : ''}">
      <div class="flex mb-12">
        <div style="flex:1;min-width:0">
          <div class="flex" style="gap:8px;margin-bottom:6px">
            <strong>${esc(p.name)}</strong>
            ${typeLabel(p.type)}
            ${p.isDefault ? `<span class="badge badge-green">${esc(t('ui.overview.default'))}</span>` : ''}
            ${!p.isEnabled ? `<span class="badge badge-gray">${esc(t('ui.providers.disabled'))}</span>` : ''}
          </div>
          <div class="mono text-muted">${esc(p.baseUrl)}</div>
          ${p.shortPrefix ? `<div class="mono text-muted text-sm mt-8">${esc(t('ui.providers.shortPrefix'))}: ${esc(p.shortPrefix)}-</div>` : ''}
          ${p.models ? `<div class="mono text-muted text-sm mt-8">${esc(t('ui.providers.models'))}: ${esc(p.models)}</div>` : ''}
          ${p.models && p.shortPrefix ? `
            <div class="mt-8">
              <button class="btn btn-sm btn-ghost" onclick="document.getElementById('${mid}').style.display=document.getElementById('${mid}').style.display==='none'?'block':'none'">
                ▸ Prefixed Model IDs (${p.models.split(',').filter(Boolean).length})
              </button>
              <div id="${mid}" style="display:none">
                ${renderModelIdList(p.models, p.shortPrefix)}
              </div>
            </div>
          ` : ''}
          <div class="mono text-muted text-sm mt-8">${esc(t('ui.providers.keyLabel'))}: ${esc(p.apiKey)}</div>
          <div class="text-muted text-sm mt-8">${esc(t('ui.providers.idLabel'))}: <code>${esc(p.id)}</code></div>
        </div>
        <div class="flex" style="align-self:flex-start;gap:6px;flex-shrink:0">
          ${!p.isDefault ? `<button class="btn btn-sm btn-ghost" onclick="setDefault('${p.id}')">${esc(t('ui.providers.setDefault'))}</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="toggleEditPanel('${eid}')">${esc(t('ui.providers.edit'))}</button>
          <button class="btn btn-sm btn-ghost" onclick="testProvider('${p.id}','${esc(p.name)}')" title="${esc(t('ui.providers.testConnection'))}">${esc(t('ui.providers.test'))}</button>
          <label class="toggle" title="${esc(t(p.isEnabled ? 'ui.providers.disableTitle' : 'ui.providers.enableTitle'))}">
            <input type="checkbox" ${p.isEnabled ? 'checked' : ''} onchange="toggleEnabled('${p.id}', this.checked)">
            <span class="slider"></span>
          </label>
          <button class="btn btn-sm btn-danger" onclick="deleteProvider('${p.id}', '${esc(p.name)}')">✕</button>
        </div>
      </div>

      <!-- Inline edit panel -->
      <div id="${eid}" style="display:none" class="edit-panel" data-enter-submit>
        <div class="form-row form-2">
          <div><label>${esc(t('ui.providers.displayName'))}</label><input id="${eid}_name" value="${esc(p.name)}" /></div>
          <div><label>${esc(t('ui.providers.baseUrl'))}</label><input id="${eid}_url" value="${esc(p.baseUrl)}" /></div>
        </div>
        <div class="form-row form-2">
          <div><label>${esc(t('ui.providers.shortPrefix'))}</label><input id="${eid}_shortPrefix" value="${esc(p.shortPrefix||'')}" placeholder="${esc(t('ui.providers.shortPrefixPlaceholder'))}" /></div>
          <div><label>${esc(t('ui.providers.models'))}</label><input id="${eid}_model" value="${esc(p.models||'')}" placeholder="${esc(t('ui.providers.modelsPlaceholder'))}" /></div>
        </div>
        <div class="form-row form-2">
          <div><label>${esc(t('ui.providers.newApiKey'))}</label>
            <input id="${eid}_key" type="password" placeholder="${esc(t('ui.providers.newApiKeyPlaceholder'))}" />
          </div>
        </div>
        <div class="flex" style="gap:8px">
          <button class="btn btn-sm" data-submit-button onclick="saveEdit('${p.id}','${eid}')">${esc(t('ui.providers.saveChanges'))}</button>
          <button class="btn btn-sm btn-ghost" onclick="toggleEditPanel('${eid}')">${esc(t('ui.providers.cancel'))}</button>
        </div>
      </div>
    </div>
  `;
}

function showAddForm() {
  document.getElementById('addForm').style.display = 'block';
  document.getElementById('f_name').focus();
  onTypeChange();
}

function hideAddForm() {
  document.getElementById('addForm').style.display = 'none';
}

function onTypeChange() {
  const type = document.getElementById('f_type')?.value || 'openai';
  const urlEl = document.getElementById('f_url');
  if (!urlEl) return;
  const cur = urlEl.value.trim();
  // Only auto-fill if the field is empty or holds the other type's default
  const isDefault = !cur || cur === TYPE_URLS.openai || cur === TYPE_URLS.anthropic;
  if (isDefault) urlEl.value = TYPE_URLS[type] || '';
}

function toggleEditPanel(eid) {
  const el = document.getElementById(eid);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function addProvider() {
  const name    = document.getElementById('f_name').value.trim();
  const type    = document.getElementById('f_type').value;
  const baseUrl = document.getElementById('f_url').value.trim();
  const apiKey  = document.getElementById('f_key').value.trim() || 'none';
  const shortPrefix = document.getElementById('f_shortPrefix').value.trim();
  const models  = document.getElementById('f_model').value.trim();

  if (!name)    { toast(t('ui.providers.validationDisplayName'), true); return; }
  if (!baseUrl) { toast(t('ui.providers.validationBaseUrl'), true); return; }

  try {
    await api('/providers', { method: 'POST', body: JSON.stringify({ name, type, baseUrl, apiKey, shortPrefix, models }) });
    toast(t('ui.providers.added'));
    await renderProviders();
  } catch (err) { toastRequestError(err, t('ui.errors.requestFailed')); }
}

async function testAddForm() {
  const type    = document.getElementById('f_type').value;
  const baseUrl = document.getElementById('f_url').value.trim();
  const apiKey  = document.getElementById('f_key').value.trim() || 'none';
  const models  = document.getElementById('f_model').value.trim();

  if (!baseUrl) { toast(t('ui.providers.validationBaseUrl'), true); return; }

  toast(t('ui.providers.testingConnection'));
  try {
    const result = await api('/providers/test-connection', {
      method: 'POST',
      body: JSON.stringify({ type, baseUrl, apiKey, models }),
    });
    if (result.ok) {
      toast(t('ui.providers.connectedMs', { latency: result.latencyMs }));
    } else {
      toast(result.error, true);
    }
  } catch (err) {
    toast(t('ui.providers.connectionError', { message: getErrorMessage(err) }), true);
  }
}

async function saveEdit(id, eid) {
  const name    = document.getElementById(eid + '_name').value.trim();
  const baseUrl = document.getElementById(eid + '_url').value.trim();
  const apiKey  = document.getElementById(eid + '_key').value.trim();
  const shortPrefix = document.getElementById(eid + '_shortPrefix').value.trim();
  const models  = document.getElementById(eid + '_model').value.trim();

  if (!name || !baseUrl) { toast(t('ui.providers.validationNameAndUrl'), true); return; }
  const body = { name, baseUrl, shortPrefix, models };
  if (apiKey) body.apiKey = apiKey;

  try {
    await api('/providers/' + id, { method: 'PUT', body: JSON.stringify(body) });
    toast(t('ui.providers.updated'));
    await renderProviders();
  } catch (err) { toastRequestError(err, t('ui.errors.requestFailed')); }
}

async function setDefault(id) {
  try {
    await api('/providers/' + id + '/set-default', { method: 'POST' });
    toast(t('ui.providers.defaultUpdated'));
    await renderProviders();
  } catch (err) { toastRequestError(err, t('ui.errors.requestFailed')); }
}

async function testProvider(id, name) {
  toast(t('ui.providers.testingNamed', { name }));
  try {
    const result = await api('/providers/' + id + '/test', { method: 'POST' });
    if (result.ok) {
      toast(t('ui.providers.namedConnectedMs', { name, latency: result.latencyMs }));
    } else {
      toast(t('ui.providers.namedError', { name, message: result.error }), true);
    }
  } catch (err) {
    toast(t('ui.providers.namedError', { name, message: getErrorMessage(err) }), true);
  }
}

async function toggleEnabled(id, enabled) {
  try {
    await api('/providers/' + id, { method: 'PUT', body: JSON.stringify({ isEnabled: enabled }) });
    toast(enabled ? t('ui.providers.enabled') : t('ui.providers.disabledToast'));
    await renderProviders();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
    await renderProviders();
  }
}

async function deleteProvider(id, name) {
  if (!confirm(t('ui.providers.confirmDelete', { name }))) return;
  try {
    await api('/providers/' + id, { method: 'DELETE' });
    toast(t('ui.providers.deleted'));
    await renderProviders();
  } catch (err) { toastRequestError(err, t('ui.errors.requestFailed')); }
}

// ── External providers ─────────────────────────────────────────────────────

async function renderExternalProviders() {
  const el = document.getElementById('tab-external-providers');
  try {
    const [providers, definitions] = await Promise.all([
      api('/external-providers'),
      api('/external-providers/definitions'),
    ]);

    window._externalProviderDefs = definitions;
    el.innerHTML = `
      <div class="flex mb-16">
        <h2 style="flex:1">${esc(t('ui.externalProviders.title'))}</h2>
        <button class="btn" onclick="showAddExternalForm()">${esc(t('ui.externalProviders.addButton'))}</button>
      </div>

      <div class="callout mb-16">
        ${esc(t('ui.externalProviders.description'))}
      </div>

      <!-- Add form (hidden by default) -->
      <div id="addExternalForm" style="display:none" class="card mb-16">
        <h3>${esc(t('ui.externalProviders.addExternalProvider'))}</h3>
        <div class="edit-panel mt-8" data-enter-submit>
          <div class="form-row form-2">
            <div>
              <label>${esc(t('ui.externalProviders.selectProvider'))}</label>
              <select id="f_ext_provider_key" onchange="updateExternalProviderDefInfo()">
                ${definitions.map((d) => `<option value="${esc(d.key)}">${esc(d.displayName)}</option>`).join('')}
              </select>
              <div id="extProviderDefInfo">
                ${definitions.length > 0 ? renderExternalProviderDefInfo(definitions[0]) : ''}
              </div>
            </div>
            <div>
              <label>${esc(t('ui.externalProviders.apiKey'))}</label>
              <input id="f_ext_api_key" type="password" placeholder="${esc(t('ui.externalProviders.apiKeyPlaceholder'))}" />
            </div>
          </div>
          <div class="flex" style="gap:8px">
            <button class="btn" data-submit-button onclick="addExternalProvider()">${esc(t('ui.externalProviders.save'))}</button>
            <button class="btn btn-ghost" onclick="hideAddExternalForm()">${esc(t('ui.externalProviders.cancel'))}</button>
          </div>
        </div>
      </div>

      <!-- Configured external providers list -->
      <div id="externalProviderList">
        ${providers.length === 0
          ? `<div class="empty">${esc(t('ui.externalProviders.empty'))}<br/>${esc(t('ui.externalProviders.emptyHint'))}</div>`
          : providers.map(renderExternalProviderCard).join('')}
      </div>
    `;

    // Load sub-provider details for each external provider
    for (const ep of providers) {
      loadExternalSubProviders(ep.id);
    }
  } catch (err) {
    el.innerHTML = `<div class="card"><span class="status-dot status-err"></span>${esc(t('ui.errors.cannotConnect', { message: getErrorMessage(err) }))}</div>`;
  }
}

function renderExternalProviderCard(ep) {
  const syncStatusClass = ep.syncStatus === 'success' ? 'badge-green' : ep.syncStatus === 'error' ? 'badge-red' : 'badge-gray';
  const syncStatusLabel = ep.syncStatus
    ? t('ui.externalProviders.' + ep.syncStatus)
    : t('ui.externalProviders.never');
  const eid = 'eep_' + ep.id.replace(/-/g, '');

  return `
    <div class="pcard">
      <div class="flex mb-12">
        <div style="flex:1;min-width:0">
          <div class="flex" style="gap:8px;margin-bottom:6px">
            <strong>${esc(ep.name)}</strong>
            <span class="badge badge-purple">${esc(ep.providerKey)}</span>
            <span class="badge ${syncStatusClass}">${esc(syncStatusLabel)}</span>
          </div>
          <div class="text-muted text-sm mt-8">${esc(t('ui.externalProviders.apiKey'))}: ${esc(ep.apiKey)}</div>
          <div class="text-muted text-sm mt-8">${esc(t('ui.externalProviders.lastSync'))}: ${ep.lastSyncAt ? fmtDate(ep.lastSyncAt) : esc(t('ui.externalProviders.never'))}</div>
          ${ep.syncError ? `<div class="text-muted text-sm mt-8" style="color:var(--red)">${esc(ep.syncError)}</div>` : ''}
          <div id="${eid}_subs" class="mt-12">
            <div class="text-muted text-sm">${esc(t('ui.externalProviders.subProviders'))}:</div>
            <div id="${eid}_subs_list" class="text-muted text-sm">Loading...</div>
          </div>
        </div>
        <div class="flex" style="align-self:flex-start;gap:6px;flex-shrink:0">
          <button class="btn btn-sm btn-ghost" onclick="syncExternalProvider('${ep.id}')">${esc(t('ui.externalProviders.syncNow'))}</button>
          <button class="btn btn-sm btn-ghost" onclick="testExternalProvider('${ep.id}')">${esc(t('ui.externalProviders.testConnection'))}</button>
          <button class="btn btn-sm btn-ghost" onclick="showEditExternalKey('${ep.id}')">Edit Key</button>
          <button class="btn btn-sm btn-danger" onclick="deleteExternalProvider('${ep.id}', '${esc(ep.name)}')">✕</button>
        </div>
      </div>

      <!-- Inline edit key panel -->
      <div id="${eid}_edit" style="display:none" class="edit-panel" data-enter-submit>
        <div class="form-row form-2">
          <div><label>New API Key</label><input id="${eid}_key" type="password" placeholder="Enter new API key" /></div>
        </div>
        <div class="flex" style="gap:8px">
          <button class="btn btn-sm" data-submit-button onclick="updateExternalKey('${ep.id}','${eid}')">Save Key</button>
          <button class="btn btn-sm btn-ghost" onclick="toggleEditPanel('${eid}_edit')">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

async function loadExternalSubProviders(epId) {
  const eid = 'eep_' + epId.replace(/-/g, '') + '_subs_list';
  const el = document.getElementById(eid);
  if (!el) return;

  try {
    const subs = await api('/external-providers/' + epId + '/sub-providers');
    if (subs.length === 0) {
      el.innerHTML = '<span class="text-muted">None yet — sync to create providers.</span>';
      return;
    }
    el.innerHTML = subs.map((s, idx) => {
      const mid = 'ext_models_' + epId.replace(/-/g, '') + '_' + idx;
      const modelCount = (s.models || '').split(',').filter(Boolean).length;
      return `
      <div class="mt-8">
        <div class="flex" style="gap:8px;align-items:center">
          ${s.type === 'anthropic'
            ? `<span class="badge badge-purple">${esc(t('ui.type.anthropic'))}</span>`
            : `<span class="badge badge-blue">${esc(t('ui.type.openaiCompatible'))}</span>`}
          <span class="mono text-sm">${esc(s.shortPrefix || '-')}</span>
          <span class="text-muted text-sm">${esc(t('ui.externalProviders.modelCount', { count: modelCount }))}</span>
          ${modelCount > 0 ? `<button class="btn btn-sm btn-ghost" style="font-size:0.75rem;padding:1px 6px" onclick="document.getElementById('${mid}').style.display=document.getElementById('${mid}').style.display==='none'?'block':'none'">▸ IDs</button>` : ''}
        </div>
        ${modelCount > 0 ? `<div id="${mid}" style="display:none">${renderModelIdList(s.models, s.shortPrefix, s.modelMetadata)}</div>` : ''}
      </div>
    `;}).join('');
  } catch {
    el.innerHTML = '<span class="text-muted">Could not load sub-providers.</span>';
  }
}

function renderExternalProviderDefInfo(d) {
  if (!d) return '';
  return `
    <div class="text-muted text-sm mt-8">${esc(d.description)}</div>
    <div class="text-muted text-sm mt-8">
      ${esc(t('ui.externalProviders.readyProviders', { count: d.subProviders.length }))}:
      ${d.subProviders.map((s) => `<span class="tag">${esc(s.prefix)} (${esc(s.type)})</span>`).join(' ')}
    </div>
  `;
}

function updateExternalProviderDefInfo() {
  const key = document.getElementById('f_ext_provider_key').value;
  const defs = window._externalProviderDefs || [];
  const d = defs.find((x) => x.key === key);
  document.getElementById('extProviderDefInfo').innerHTML = renderExternalProviderDefInfo(d);
}

function showAddExternalForm() {
  document.getElementById('addExternalForm').style.display = 'block';
}

function hideAddExternalForm() {
  document.getElementById('addExternalForm').style.display = 'none';
}

function showEditExternalKey(id) {
  const eid = 'eep_' + id.replace(/-/g, '') + '_edit';
  toggleEditPanel(eid);
}

async function addExternalProvider() {
  const providerKey = document.getElementById('f_ext_provider_key').value;
  const apiKey = document.getElementById('f_ext_api_key').value.trim();

  if (!apiKey) {
    toast('API key is required.', true);
    return;
  }

  try {
    await api('/external-providers', {
      method: 'POST',
      body: JSON.stringify({ providerKey, apiKey }),
    });
    toast(t('ui.externalProviders.added'));
    await renderExternalProviders();
    // Load sub-providers after render
    setTimeout(async () => {
      const providers = await api('/external-providers');
      for (const ep of providers) {
        await loadExternalSubProviders(ep.id);
      }
    }, 2000);
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}

async function updateExternalKey(id, eid) {
  const apiKey = document.getElementById(eid + '_key').value.trim();
  if (!apiKey) {
    toast('API key is required.', true);
    return;
  }

  try {
    await api('/external-providers/' + id, {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    });
    toast(t('ui.externalProviders.keyUpdated'));
    await renderExternalProviders();
    setTimeout(async () => {
      await loadExternalSubProviders(id);
    }, 500);
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}

async function syncExternalProvider(id) {
  toast('Syncing models...');
  try {
    const result = await api('/external-providers/' + id + '/sync', { method: 'POST' });
    if (result.ok) {
      toast(t('ui.externalProviders.synced', { count: result.syncedCount, providers: result.syncedCount > 0 ? '1+' : '0' }));
    } else {
      toast(t('ui.externalProviders.syncFailed', { message: result.error }), true);
    }
    await renderExternalProviders();
    setTimeout(async () => await loadExternalSubProviders(id), 1000);
  } catch (err) {
    toast(t('ui.externalProviders.syncFailed', { message: getErrorMessage(err) }), true);
  }
}

async function testExternalProvider(id) {
  toast(t('ui.externalProviders.testingConnection'));
  try {
    const result = await api('/external-providers/' + id + '/test', { method: 'POST' });
    if (result.ok) {
      toast(t('ui.externalProviders.connectedMs', { latency: result.latencyMs }));
    } else {
      toast(t('ui.externalProviders.connectionError', { message: result.error }), true);
    }
  } catch (err) {
    toast(t('ui.externalProviders.connectionError', { message: getErrorMessage(err) }), true);
  }
}

async function deleteExternalProvider(id, name) {
  if (!confirm(t('ui.externalProviders.confirmDelete', { name }))) return;
  try {
    await api('/external-providers/' + id, { method: 'DELETE' });
    toast(t('ui.externalProviders.deleted'));
    await renderExternalProviders();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}
