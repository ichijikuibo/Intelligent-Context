// ── Models tab ────────────────────────────────────────────────────────────
//
// One place to see and edit every model the proxy offers, whether it was
// discovered by an external provider sync or typed into a manual provider.
// The dialog writes per-model overrides (display name, maximum context,
// endpoint type, reasoning support) that win over the provider's reported
// values and feed the IDE extension's context window.

let modelsTabData = { providers: [], models: [], canManage: false, allModels: false, grants: [] };
let modelDialogState = null;
/** Provider groups the user has collapsed, so a re-render keeps their state. */
const collapsedModelGroups = new Set();

// ── Model grant helpers ───────────────────────────────────────────────────
//
// A grant is a provider-scoped model ID that may contain `*`:
//   `*-*`            every model on every provider
//   `OCA-*`          every model from provider OCA
//   `OCA-deepseek-*` model IDs starting with `deepseek-` on OCA
// These mirror the proxy's own matcher so the checkbox lists agree with what
// the proxy will actually allow.

function modelGrantMatches(grant, candidate) {
  const pattern = String(grant ?? '').trim();
  const value = String(candidate ?? '').trim();
  if (!pattern || !value) return false;
  if (pattern === '*' || pattern === '*-*') return true;
  if (!pattern.includes('*')) return pattern.toLowerCase() === value.toLowerCase();

  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i').test(value);
}

function modelGrantsAll(grants) {
  return (grants || []).some((grant) => grant === '*' || grant === '*-*');
}

/**
 * The provider-wide grant string for a prefix, e.g. `OCA-` → `OCA-*`.
 *
 * Returns `null` for a provider with no short prefix: its scoped IDs are
 * `uuid:model`, which a wildcard grant cannot express, so those providers only
 * support per-model grants.
 */
function providerGrantPattern(prefix) {
  return prefix ? `${prefix}*` : null;
}

function modelGrantsProvider(grants, prefix) {
  if (!prefix) return false;
  if (modelGrantsAll(grants)) return true;
  const pattern = providerGrantPattern(prefix);
  return (grants || []).some((grant) => grant.toLowerCase() === pattern.toLowerCase());
}

function formatContextLength(value) {
  if (typeof value !== 'number' || value <= 0) return '-';
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M ctx`;
  }
  return `${Math.round(value / 1000)}K ctx`;
}

/**
 * Safely embed a value inside a single-quoted JS string in an inline onclick
 * attribute. Backslashes/quotes are escaped for the JS parser first, then the
 * result is HTML-escaped so the attribute itself stays valid.
 */
function modelJsArg(value) {
  const escaped = String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return esc(escaped);
}

async function renderModels() {
  const el = document.getElementById('tab-models');
  let data;
  try {
    data = await api('/models');
  } catch (err) {
    el.innerHTML = `<div class="card"><span class="status-dot status-err"></span>${esc(t('ui.errors.cannotConnect', { message: getErrorMessage(err) }))}</div>`;
    return;
  }

  const providers = Array.isArray(data?.providers) ? data.providers : [];
  const models = Array.isArray(data?.models) ? data.models : [];
  const canManage = data?.canManage === true;
  const allModels = data?.allModels === true;
  const grants = Array.isArray(data?.grants) ? data.grants : [];
  const hiddenModels = Array.isArray(data?.hiddenModels) ? data.hiddenModels : [];
  modelsTabData = { providers, models, canManage, allModels, grants, hiddenModels };
  // The Users tab's access dialog shares this payload; refresh it here so a
  // model added or removed in this tab shows up there too.
  modelCatalogueCache = { providers, models };

  const canAdd = canManage && providers.some((provider) => !provider.isExternal);
  const visibleCount = models.filter((model) => !model.hidden).length;

  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.models.title'))}</h2>
      ${canAdd ? `<button class="btn" onclick="showAddModelDialog()">${esc(t('ui.models.addButton'))}</button>` : ''}
    </div>

    <div class="callout mb-16">${esc(t(canManage ? 'ui.models.callout' : 'ui.models.calloutReadOnly'))}</div>

    ${renderModelAccessSummary(allModels, grants)}

    <div class="card mb-16">
      <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
        <strong>${esc(t('ui.models.visibilityTitle'))}</strong>
        <span class="text-muted text-sm">${esc(t('ui.models.visibilityCount', { shown: visibleCount, total: models.length }))}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn-sm btn-ghost" onclick="setAllModelVisibility(true)">${esc(t('ui.models.visibilityShowAll'))}</button>
          <button class="btn btn-sm btn-ghost" onclick="setAllModelVisibility(false)">${esc(t('ui.models.visibilityHideAll'))}</button>
        </span>
      </div>
      <div class="text-muted text-sm mt-8">${esc(t('ui.models.visibilityHint'))}</div>
    </div>

    ${providers.length === 0
      ? `<div class="empty">${esc(t('ui.models.empty'))}<br/>${esc(t('ui.models.emptyHint'))}</div>`
      : renderModelList({
          idPrefix: 'models-tab',
          providers,
          models,
          showActions: canManage,
          isProviderChecked: (provider) => models
            .filter((model) => model.providerId === provider.id)
            .every((model) => !model.hidden),
          isModelChecked: (model) => !model.hidden,
        })}
  `;
}

/**
 * The access banner above the list: which models the current user may use.
 * It is a display of the proxy's grants, not an editor — admins change a
 * user's access from the Users tab.
 */
function renderModelAccessSummary(allModels, grants) {
  const label = allModels || modelGrantsAll(grants)
    ? t('ui.models.accessAll')
    : grants.length > 0
      ? t('ui.models.accessSome', { count: grants.length })
      : t('ui.models.accessNone');

  const badges = allModels
    ? `<span class="tag mono">*-*</span>`
    : grants.map((grant) => `<span class="tag mono">${esc(grant)}</span>`).join(' ');

  return `
    <div class="card mb-16">
      <div class="flex" style="gap:8px;align-items:center;flex-wrap:wrap">
        <strong>${esc(t('ui.models.accessTitle'))}</strong>
        <span class="text-muted text-sm">${esc(label)}</span>
        <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">${badges}</span>
      </div>
      <div class="text-muted text-sm mt-8">${esc(t('ui.models.accessHint'))}</div>
    </div>
  `;
}

// ── Reusable model list ───────────────────────────────────────────────────
//
// One component renders the provider-grouped model list for both places it is
// needed:
//   - the Models tab, where the checkboxes are the *current user's* IDE
//     visibility preference (voluntary, never a restriction);
//   - the Users tab's access dialog, where they are another user's grants.
//
// It is deliberately layout-simple: every row is a three-column grid
// (checkbox | label | meta) so nothing can float or right-align unexpectedly.
//
// options:
//   idPrefix          unique DOM id prefix for this instance
//   providers         provider summaries
//   models            model rows (already filtered for the viewer)
//   showActions       render Edit/Remove buttons (Models tab, managers only)
//   isProviderChecked (prefix) => boolean
//   isModelChecked    (model) => boolean

function renderModelList(options) {
  const { idPrefix, providers, models } = options;
  const groups = providers.map((provider) => ({
    provider,
    models: models.filter((model) => model.providerId === provider.id),
  }));

  return `
    <div class="model-list" data-model-list="${esc(idPrefix)}">
      ${groups.map((group) => renderModelListGroup(group, options)).join('')}
    </div>
  `;
}

function renderModelListGroup(group, options) {
  const { idPrefix } = options;
  const p = group.provider;
  const prefix = p.shortPrefix ? `${p.shortPrefix}-` : '';
  const providerPattern = providerGrantPattern(prefix);
  const collapsed = collapsedModelGroups.has(`${idPrefix}:${p.id}`);
  const providerChecked = group.models.length > 0 && options.isProviderChecked(p);

  return `
    <div class="pcard" data-provider-prefix="${esc(prefix)}">
      <div class="model-list-row model-list-head">
        <input type="checkbox" data-list-provider ${providerChecked ? 'checked' : ''}
               ${providerPattern ? '' : 'disabled'}
               title="${esc(providerPattern ? t('ui.models.providerAccessTitle') : t('ui.models.providerNoPrefix'))}"
               onchange="onModelListProviderToggle(this)" />
        <div class="model-list-label">
          <button class="model-list-toggle" type="button"
                  onclick="toggleModelGroup('${modelJsArg(`${idPrefix}:${p.id}`)}')"
                  aria-expanded="${collapsed ? 'false' : 'true'}">${collapsed ? '▸' : '▾'}</button>
          <strong>${esc(p.name)}</strong>
          ${typeLabel(p.type)}
          ${p.isExternal ? `<span class="badge badge-gray">${esc(t('ui.models.externalBadge'))}</span>` : ''}
          ${!p.isEnabled ? `<span class="badge badge-red">${esc(t('ui.models.disabledBadge'))}</span>` : ''}
        </div>
        <div class="model-list-meta">
          ${providerPattern ? `<span class="tag mono">${esc(providerPattern)}</span>` : ''}
          <span class="text-muted text-sm">${esc(t('ui.models.groupModels', { count: group.models.length }))}</span>
        </div>
      </div>
      <div class="model-list-body" style="display:${collapsed ? 'none' : 'block'}">
        ${group.models.length === 0
          ? `<div class="text-muted text-sm model-list-empty">${esc(t('ui.models.empty'))}</div>`
          : group.models.map((model) => renderModelListRow(model, prefix, options)).join('')}
      </div>
    </div>
  `;
}

function renderModelListRow(m, prefix, options) {
  const meta = [];
  meta.push(m.apiFormat === 'anthropic' ? t('ui.type.anthropic') : t('ui.type.openaiCompatible'));
  meta.push(formatContextLength(m.contextLength));
  if (m.supportsReasoning) meta.push(t('ui.models.reasoningBadge'));
  if (m.supportsVision) meta.push(t('ui.models.visionBadge'));
  if (m.override) meta.push(t('ui.models.customBadge'));
  else if (m.reference) meta.push(t('ui.models.referenceBadge'));
  if (!m.inProviderList) meta.push(t('ui.models.orphanBadge'));

  const checked = options.isModelChecked(m);
  const scopedId = `${prefix}${m.modelId}`;

  return `
    <div class="model-list-row model-list-item">
      <input type="checkbox" data-list-model value="${esc(scopedId)}"
             ${checked ? 'checked' : ''} onchange="onModelListModelToggle(this)" />
      <div class="model-list-label">
        <span class="mono">${esc(scopedId)}</span>
        <div class="text-muted text-sm">
          ${m.displayName && m.displayName !== m.modelId ? `${esc(m.displayName)} · ` : ''}${esc(meta.join(' · '))}
        </div>
      </div>
      <div class="model-list-meta">
        ${options.showActions ? `
          <button class="btn btn-sm btn-ghost" onclick="openModelDialog('${modelJsArg(m.providerId)}','${modelJsArg(m.modelId)}')">${esc(t('ui.models.edit'))}</button>
          ${!m.providerIsExternal && m.inProviderList
            ? `<button class="btn btn-sm btn-danger" onclick="removeModelFromProvider('${modelJsArg(m.providerId)}','${modelJsArg(m.modelId)}','${modelJsArg(m.providerName)}')">✕</button>`
            : ''}
        ` : ''}
      </div>
    </div>
  `;
}

/** Collapse or expand one provider group inside a list instance. */
function toggleModelGroup(key) {
  if (collapsedModelGroups.has(key)) {
    collapsedModelGroups.delete(key);
  } else {
    collapsedModelGroups.add(key);
  }
  // The key carries its instance prefix, so only that instance re-renders.
  if (key.startsWith('models-tab:')) {
    renderModels();
  } else if (key.startsWith('access-dialog:')) {
    refreshModelAccessDialogList();
  }
}

/** Check/uncheck every model under a provider row. */
function onModelListProviderToggle(checkbox) {
  const group = checkbox.closest('[data-provider-prefix]');
  if (!group) return;
  group.querySelectorAll('[data-list-model]').forEach((model) => {
    model.checked = checkbox.checked;
  });
  onModelListChanged(checkbox.closest('[data-model-list]'));
}

/** A single model checkbox changed. */
function onModelListModelToggle(checkbox) {
  const list = checkbox.closest('[data-model-list]');
  if (!list) return;

  // Keep the provider row honest: it is checked only while every child is.
  const group = checkbox.closest('[data-provider-prefix]');
  if (group) {
    const providerBox = group.querySelector('[data-list-provider]');
    const children = [...group.querySelectorAll('[data-list-model]')];
    if (providerBox) {
      providerBox.checked = children.length > 0 && children.every((child) => child.checked);
    }
  }

  onModelListChanged(list);
}

/**
 * Hook for the owning view. The Models tab saves the caller's visibility
 * preference straight away; the access dialog only tracks state until Save.
 */
function onModelListChanged(list) {
  if (!list || list.dataset.modelList !== 'models-tab') return;
  saveModelVisibility(list);
}

/** Read a list instance back into a set of scoped model IDs that are checked. */
function collectModelListChecked(list) {
  if (!list) return [];
  return [...list.querySelectorAll('[data-list-model]')]
    .filter((input) => input.checked)
    .map((input) => input.value);
}

/**
 * Persist the current user's visibility preference.
 *
 * Only the *unchecked* models are stored, and a provider whose models are all
 * unchecked collapses to a single `PREFIX-*` entry so the list stays short.
 */
async function saveModelVisibility(list) {
  const hidden = [];
  for (const group of list.querySelectorAll('[data-provider-prefix]')) {
    const prefix = group.dataset.providerPrefix || '';
    const children = [...group.querySelectorAll('[data-list-model]')];
    if (children.length === 0) continue;

    const unchecked = children.filter((input) => !input.checked);
    if (unchecked.length === 0) continue;

    const pattern = providerGrantPattern(prefix);
    // Without a short prefix a provider cannot be named by a wildcard, so its
    // models always have to be listed individually.
    if (pattern && unchecked.length === children.length) {
      hidden.push(pattern);
      continue;
    }

    hidden.push(...unchecked.map((input) => input.value));
  }

  try {
    const result = await api('/models/visibility', {
      method: 'PUT',
      body: JSON.stringify({ hiddenModels: hidden }),
    });
    modelsTabData.hiddenModels = result?.hiddenModels || hidden;
    toast(t('ui.models.visibilitySaved', { hidden: modelsTabData.hiddenModels.length }));
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
    await renderModels();
  }
}

/** Show or hide every model in the current user's list at once. */
async function setAllModelVisibility(visible) {
  const list = document.querySelector('[data-model-list="models-tab"]');
  if (!list) return;

  list.querySelectorAll('[data-list-provider]').forEach((box) => { box.checked = visible; });
  list.querySelectorAll('[data-list-model]').forEach((box) => { box.checked = visible; });
  await saveModelVisibility(list);
}

// ── Access dialog (Users tab) ─────────────────────────────────────────────
//
// Admins edit another user's grants here. Same list component as the Models
// tab, but nothing is saved until the dialog is confirmed.

let modelAccessDialogState = null;

/**
 * Cached provider/model catalogue for the access dialog.
 *
 * A user's list can hold hundreds of models and the Users tab renders one
 * button per account, so the payload is fetched once and reused until the
 * Models tab refreshes it.
 */
let modelCatalogueCache = null;

async function loadModelCatalogue() {
  if (modelCatalogueCache) return modelCatalogueCache;
  const data = await api('/models');
  modelCatalogueCache = {
    providers: Array.isArray(data?.providers) ? data.providers : [],
    models: Array.isArray(data?.models) ? data.models : [],
  };
  return modelCatalogueCache;
}

function closeModelAccessDialog() {
  const backdrop = document.getElementById('modelAccessDialogBackdrop');
  if (backdrop) backdrop.remove();
  modelAccessDialogState = null;
}

/** Re-render just the list inside the open dialog (keeps scroll position). */
function refreshModelAccessDialogList() {
  if (!modelAccessDialogState) return;
  const host = document.getElementById('modelAccessDialogList');
  if (host) host.innerHTML = renderModelAccessDialogList(modelAccessDialogState.grants);
}

function renderModelAccessDialogList(grants) {
  const catalogue = modelCatalogueCache || { providers: [], models: [] };
  const all = modelGrantsAll(grants);

  return `
    <div class="model-list-row model-list-head" style="border-bottom:1px solid var(--border);padding-bottom:8px">
      <input type="checkbox" id="modelAccessAll" ${all ? 'checked' : ''}
             onchange="onModelAccessAllToggle(this)" />
      <div class="model-list-label">
        <strong>${esc(t('ui.models.grantAll'))}</strong>
        <div class="text-muted text-sm">${esc(t('ui.models.grantAllHint'))}</div>
      </div>      <div class="model-list-meta"><span class="tag mono">*-*</span></div>
    </div>
    <div id="modelAccessListBody">
      ${renderModelList({
        idPrefix: 'access-dialog',
        providers: catalogue.providers,
        models: catalogue.models,
        showActions: false,
        isProviderChecked: (provider) => all
          || modelGrantsProvider(grants, provider.shortPrefix ? `${provider.shortPrefix}-` : ''),
        isModelChecked: (model) => all || grants.some((grant) => modelGrantMatches(grant, model.scopedId)),
      })}
    </div>
  `;
}

/** The `*-*` row implies every other checkbox. */
function onModelAccessAllToggle(checkbox) {
  const body = document.getElementById('modelAccessListBody');
  if (!body) return;

  body.querySelectorAll('[data-list-provider], [data-list-model]').forEach((box) => {
    box.checked = checkbox.checked;
  });
}

/**
 * Open the access dialog for one user.
 *
 * `userId` is `null` for the create form, in which case the confirmed grants
 * are stashed for `createUser()` to send.
 */
async function openModelAccessDialog(userId, label, grants) {
  modelAccessDialogState = { userId, label, grants: [...(grants || [])] };

  const backdrop = document.createElement('div');
  backdrop.id = 'modelAccessDialogBackdrop';
  backdrop.className = 'summary-dialog-backdrop';
  backdrop.setAttribute('role', 'presentation');
  backdrop.innerHTML = `
    <div class="summary-dialog models-dialog model-access-dialog" role="dialog" aria-modal="true"
         aria-labelledby="modelAccessDialogTitle">
      <div class="summary-dialog-header">
        <div>
          <h3 id="modelAccessDialogTitle">${esc(t('ui.models.accessDialogTitle', { user: label }))}</h3>
          <div class="text-muted text-sm mt-8">${esc(t('ui.models.accessDialogHint'))}</div>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" onclick="closeModelAccessDialog()">${esc(t('ui.models.close'))}</button>
      </div>
      <div id="modelAccessDialogList" class="mt-12">
        <div class="text-muted text-sm">${esc(t('ui.models.accessLoading'))}</div>
      </div>
      <div class="flex mt-16" style="gap:8px;justify-content:flex-end">
        <button class="btn" onclick="confirmModelAccessDialog()">${esc(t('ui.models.accessDialogApply'))}</button>
        <button class="btn btn-ghost" onclick="closeModelAccessDialog()">${esc(t('ui.models.cancel'))}</button>
      </div>
    </div>
  `;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModelAccessDialog();
  });
  document.body.appendChild(backdrop);

  try {
    await loadModelCatalogue();
    refreshModelAccessDialogList();
  } catch (err) {
    const host = document.getElementById('modelAccessDialogList');
    if (host) {
      host.innerHTML = `<div class="text-sm" style="color:var(--red)">${esc(getErrorMessage(err))}</div>`;
    }
  }
}

/** Turn the dialog's checkboxes back into a grant list. */
function collectModelAccessGrants() {
  const list = document.querySelector('[data-model-list="access-dialog"]');
  const all = document.getElementById('modelAccessAll');
  if (all && all.checked) return ['*-*'];
  if (!list) return [];

  const grants = [];
  for (const group of list.querySelectorAll('[data-provider-prefix]')) {
    const prefix = group.dataset.providerPrefix || '';
    const providerBox = group.querySelector('[data-list-provider]');
    const children = [...group.querySelectorAll('[data-list-model]')];
    const pattern = providerGrantPattern(prefix);

    if (pattern && providerBox && providerBox.checked) {
      grants.push(pattern);
      continue;
    }

    grants.push(...children.filter((input) => input.checked).map((input) => input.value));
  }

  return grants;
}

/** Apply the dialog's selection and close. */
function confirmModelAccessDialog() {
  if (!modelAccessDialogState) return;
  const { userId } = modelAccessDialogState;
  const grants = collectModelAccessGrants();

  closeModelAccessDialog();

  if (userId === null) {
    // Create form: hold the selection until the user is actually created.
    draftUserGrants = grants;
    renderDraftUserGrantsLabel();
    return;
  }

  const field = document.getElementById(`user_grants_${userId}`);
  if (field) field.value = JSON.stringify(grants);
  renderUserGrantsLabel(userId, grants);
}

/**
 * Grants chosen in the dialog for a user that does not exist yet.
 * `createUser()` reads this when building the request.
 */
let draftUserGrants = [];

/** Summary chip shown on the create form next to the dialog button. */
function renderDraftUserGrantsLabel() {
  const el = document.getElementById('newUserGrantsLabel');
  if (el) el.innerHTML = renderGrantsSummary(draftUserGrants);
}

/** Summary chip shown on an existing user's card. */
function renderUserGrantsLabel(userId, grants) {
  const el = document.getElementById(`user_grants_label_${userId}`);
  if (el) el.innerHTML = renderGrantsSummary(grants);
}

/** Human-readable rendering of a grant list, shared by both call sites. */
function renderGrantsSummary(grants) {
  const list = Array.isArray(grants) ? grants : [];

  if (modelGrantsAll(list)) {
    return `<span class="tag mono">*-*</span> <span class="text-muted text-sm">${esc(t('ui.models.accessAll'))}</span>`;
  }

  if (list.length === 0) {
    return `<span class="text-muted text-sm">${esc(t('ui.models.accessNone'))}</span>`;
  }

  return `${list.map((grant) => `<span class="tag mono">${esc(grant)}</span>`).join(' ')}
    <span class="text-muted text-sm">${esc(t('ui.models.accessSome', { count: list.length }))}</span>`;
}

// ── Add / edit dialog ─────────────────────────────────────────────────────

function findModelRow(providerId, modelId) {
  return modelsTabData.models.find((model) => model.providerId === providerId && model.modelId === modelId);
}

function closeModelDialog() {
  const backdrop = document.getElementById('modelsDialogBackdrop');
  if (backdrop) backdrop.remove();
  modelDialogState = null;
}

function showAddModelDialog() {
  const provider = modelsTabData.providers.find((p) => !p.isExternal);
  if (!provider) {
    toast(t('ui.models.validationProvider'), true);
    return;
  }
  openModelDialog(provider.id, null);
}

function openModelDialog(providerId, modelId) {
  const provider = modelsTabData.providers.find((p) => p.id === providerId);
  if (!provider) {
    toast(t('ui.models.validationProvider'), true);
    return;
  }

  const editing = Boolean(modelId);
  const model = editing ? findModelRow(providerId, modelId) : undefined;
  if (editing && !model) {
    toast(t('api.error.modelNotFound'), true);
    return;
  }

  // Prefill only from the user's override, so saving without touching a field
  // never freezes the provider's reported value into an override.
  const override = model?.override ?? {};
  const reported = model?.reported ?? {};
  const providerFormat = provider.type === 'anthropic' ? 'anthropic' : 'openai';
  const effectiveFormat = model?.apiFormat ?? providerFormat;

  closeModelDialog();
  modelDialogState = { mode: editing ? 'edit' : 'add', providerId, modelId: modelId ?? '' };

  const providerOptions = modelsTabData.providers
    .filter((p) => !p.isExternal || p.id === providerId)
    .map((p) => `<option value="${esc(p.id)}" ${p.id === providerId ? 'selected' : ''}>${esc(p.name)}</option>`)
    .join('');

  const displayNameHint = reported.displayName
    ? t('ui.models.displayNameReported', { value: reported.displayName })
    : t('ui.models.displayNamePlaceholder');
  const contextHint = reported.contextLength
    ? t('ui.models.contextReported', { value: Number(reported.contextLength).toLocaleString() })
    : model?.reference?.contextLength
      ? t('ui.models.contextReference', { value: Number(model.reference.contextLength).toLocaleString() })
      : model
        ? t('ui.models.contextReported', { value: Number(model.contextLength).toLocaleString() })
        : '';

  const backdrop = document.createElement('div');
  backdrop.id = 'modelsDialogBackdrop';
  backdrop.className = 'summary-dialog-backdrop';
  backdrop.setAttribute('role', 'presentation');
  backdrop.innerHTML = `
    <div class="summary-dialog models-dialog" role="dialog" aria-modal="true" aria-labelledby="modelDialogTitle">
      <div class="summary-dialog-header">
        <div>
          <h3 id="modelDialogTitle">${esc(editing ? t('ui.models.editModel') : t('ui.models.newModel'))}</h3>
          <div class="text-muted text-sm mt-8 mono">${esc(model ? model.scopedId : '')}</div>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" onclick="closeModelDialog()">${esc(t('ui.models.close'))}</button>
      </div>

      <div class="edit-panel" data-enter-submit>
        <div class="form-row">
          <div>
            <label>${esc(t('ui.models.provider'))}</label>
            <select id="modelDialog_provider" onchange="onModelProviderChange()" ${editing ? 'disabled' : ''}>
              ${providerOptions}
            </select>
          </div>
        </div>
        ${model?.reference
          ? `<div class="callout mb-12">${esc(t('ui.models.referenceHint', { model: model.reference.modelId, source: model.reference.source }))}</div>`
          : ''}
        <div class="form-row form-2">
          <div>
            <label>${esc(t('ui.models.modelId'))}</label>
            <input id="modelDialog_modelId" value="${esc(modelId ?? '')}" placeholder="${esc(t('ui.models.modelIdPlaceholder'))}" ${editing && provider.isExternal ? 'disabled' : ''} />
          </div>
          <div>
            <label>${esc(t('ui.models.displayName'))}</label>
            <input id="modelDialog_displayName" value="${esc(override.displayName ?? '')}" placeholder="${esc(t('ui.models.displayNamePlaceholder'))}" />
            <div class="text-muted text-sm mt-8">${esc(displayNameHint)}</div>
          </div>
        </div>
        <div class="form-row form-2">
          <div>
            <label>${esc(t('ui.models.context'))}</label>
            <input id="modelDialog_context" type="number" min="1" step="1" value="${override.contextLength ?? ''}" placeholder="${esc(t('ui.models.contextPlaceholder'))}" />
            ${contextHint ? `<div class="text-muted text-sm mt-8">${esc(contextHint)}</div>` : ''}
          </div>
          <div>
            <label>${esc(t('ui.models.apiFormat'))}</label>
            <select id="modelDialog_apiFormat">
              <option value="" ${override.apiFormat ? '' : 'selected'}>${esc(t('ui.models.apiFormatInherit', { value: providerFormat }))}</option>
              <option value="openai" ${override.apiFormat === 'openai' ? 'selected' : ''}>${esc(t('ui.type.openaiCompatible'))}</option>
              <option value="anthropic" ${override.apiFormat === 'anthropic' ? 'selected' : ''}>${esc(t('ui.type.anthropic'))}</option>
            </select>
            <div class="text-muted text-sm mt-8">${esc(formatContextLength(model?.contextLength))} · ${esc(effectiveFormat)}</div>
          </div>
        </div>
        <div class="form-row">
          <label class="models-checkbox">
            <input type="checkbox" id="modelDialog_reasoning" ${override.supportsReasoning ? 'checked' : ''} />
            ${esc(t('ui.models.supportsReasoning'))}
          </label>
          <div class="text-muted text-sm">${esc(t('ui.models.supportsReasoningHint'))}</div>
        </div>
        <div class="form-row">
          <label class="models-checkbox">
            <input type="checkbox" id="modelDialog_vision" ${override.supportsVision ? 'checked' : ''} />
            ${esc(t('ui.models.supportsVision'))}
          </label>
          <div class="text-muted text-sm">${esc(t('ui.models.supportsVisionHint'))}</div>
        </div>
        <div class="flex" style="gap:8px;flex-wrap:wrap">
          <button class="btn" data-submit-button onclick="saveModelDialog()">${esc(t('ui.models.save'))}</button>
          <button class="btn btn-ghost" onclick="closeModelDialog()">${esc(t('ui.models.cancel'))}</button>
          ${editing && model?.override
            ? `<button class="btn btn-ghost" onclick="resetModelOverrides('${modelJsArg(providerId)}','${modelJsArg(modelId)}')">${esc(t('ui.models.reset'))}</button>`
            : ''}
          ${editing && !provider.isExternal && model?.inProviderList
            ? `<button class="btn btn-danger" onclick="removeModelFromProvider('${modelJsArg(providerId)}','${modelJsArg(modelId)}','${modelJsArg(provider.name)}')">${esc(t('ui.models.remove'))}</button>`
            : ''}
        </div>
      </div>
    </div>
  `;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeModelDialog();
  });
  document.body.appendChild(backdrop);
}

function onModelProviderChange() {
  const providerId = document.getElementById('modelDialog_provider')?.value;
  const provider = modelsTabData.providers.find((p) => p.id === providerId);
  const select = document.getElementById('modelDialog_apiFormat');
  if (!provider || !select) return;
  const providerFormat = provider.type === 'anthropic' ? 'anthropic' : 'openai';
  const inheritOption = select.options[0];
  if (inheritOption) inheritOption.textContent = t('ui.models.apiFormatInherit', { value: providerFormat });
}

async function saveModelDialog() {
  if (!modelDialogState) return;
  const { mode, providerId, modelId } = modelDialogState;

  const idInput = document.getElementById('modelDialog_modelId');
  const newModelId = String(idInput?.value || '').trim();
  const displayName = String(document.getElementById('modelDialog_displayName')?.value || '').trim();
  const contextRaw = String(document.getElementById('modelDialog_context')?.value || '').trim();
  const apiFormat = document.getElementById('modelDialog_apiFormat')?.value || '';
  const supportsReasoning = Boolean(document.getElementById('modelDialog_reasoning')?.checked);
  const supportsVision = Boolean(document.getElementById('modelDialog_vision')?.checked);

  if (!newModelId) {
    toast(t('ui.models.validationModelId'), true);
    return;
  }

  let contextLength = null;
  if (contextRaw) {
    contextLength = Number(contextRaw);
    if (!Number.isInteger(contextLength) || contextLength <= 0) {
      toast(t('ui.models.validationContext'), true);
      return;
    }
  }

  const body = {
    displayName: displayName || null,
    contextLength,
    apiFormat: apiFormat || null,
    supportsReasoning,
    supportsVision,
  };

  try {
    if (mode === 'add') {
      await api('/models', {
        method: 'POST',
        body: JSON.stringify({
          providerId,
          modelId: newModelId,
          displayName: displayName || undefined,
          contextLength: contextLength === null ? undefined : contextLength,
          apiFormat: apiFormat || undefined,
          // Omit when unchecked so a plain "add" stores no override row.
          supportsReasoning: supportsReasoning || undefined,
          supportsVision: supportsVision || undefined,
        }),
      });
      toast(t('ui.models.added'));
    } else {
      await api(`/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        body: JSON.stringify({ ...body, modelId: newModelId }),
      });
      toast(t('ui.models.updated'));
    }
    closeModelDialog();
    await renderModels();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}

async function resetModelOverrides(providerId, modelId) {
  if (!confirm(t('ui.models.confirmReset', { model: modelId }))) return;

  try {
    await api(`/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}/override`, { method: 'DELETE' });
    toast(t('ui.models.overrideCleared'));
    closeModelDialog();
    await renderModels();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}

async function removeModelFromProvider(providerId, modelId, providerName) {
  if (!confirm(t('ui.models.confirmRemove', { model: modelId, provider: providerName }))) return;

  try {
    await api(`/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
    toast(t('ui.models.removed'));
    closeModelDialog();
    await renderModels();
  } catch (err) {
    toastRequestError(err, t('ui.errors.requestFailed'));
  }
}
