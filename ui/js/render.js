// ── Tab navigation, shared render helpers & detail dialogs ────────────────

function showTab(tab) {
  if (!state.currentUser) return;
  closeResponsiveChrome();
  document.querySelectorAll('#main > div').forEach(d => d.style.display = 'none');
  document.getElementById('tab-' + tab).style.display = 'block';
  document.querySelectorAll('#nav button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  renderTab(tab);
}

async function renderTab(tab) {
  if      (tab === 'overview')   await renderOverview();
  else if (tab === 'providers')  await renderProviders();
  else if (tab === 'external-providers') await renderExternalProviders();
  else if (tab === 'models')     await renderModels();
  else if (tab === 'projects')   await renderProjects();
  else if (tab === 'users')      await renderUsers();
  else if (tab === 'api-keys')   await renderApiKeys();
  else if (tab === 'chat')       await renderChat();
  else if (tab === 'chunks')     await renderChunks();
  else if (tab === 'code-extracts') await renderCodeExtracts();
  else if (tab === 'files')      await renderFiles();
  else if (tab === 'summaries')  await renderSummaries();
  else if (tab === 'findings')   await renderFindings();
  else if (tab === 'stats')      await renderStats();
  else if (tab === 'settings')   await renderSettings();
  else if (tab === 'task-runs') await renderTaskRuns();
}

function badgeSeverity(s) {
  const map = { critical:'badge-red', high:'badge-red', medium:'badge-amber', low:'badge-blue', info:'badge-gray', positive:'badge-green' };
  const labels = {
    critical: 'ui.severity.critical',
    high: 'ui.severity.high',
    medium: 'ui.severity.medium',
    low: 'ui.severity.low',
    info: 'ui.severity.info',
    positive: 'ui.severity.positive',
  };
  return `<span class="badge ${map[s]||'badge-gray'}">${esc(t(labels[s] || 'ui.severity.info'))}</span>`;
}

function typeLabel(type) {
  return type === 'anthropic'
    ? `<span class="badge badge-purple">${esc(t('ui.type.anthropic'))}</span>`
    : `<span class="badge badge-blue">${esc(t('ui.type.openaiCompatible'))}</span>`;
}

function renderModelIdList(models, shortPrefix, metadata) {
  if (!models) return '<span class="text-muted text-sm">No models configured.</span>';
  const ids = models.split(',').map(m => m.trim()).filter(Boolean);
  if (ids.length === 0) return '<span class="text-muted text-sm">No models configured.</span>';

  // Optional per-model metadata (context window) synced from the provider's
  // /models endpoint, keyed by raw model ID.
  const contextByModel = {};
  if (Array.isArray(metadata)) {
    for (const m of metadata) {
      if (m && m.modelId && typeof m.contextLength === 'number') {
        contextByModel[m.modelId] = m.contextLength;
      }
    }
  }
  const formatContext = (value) => value >= 1000000
    ? `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M ctx`
    : `${Math.round(value / 1000)}K ctx`;

  const onclickId = 'copy_' + Math.random().toString(36).slice(2, 8);
  return `
    <div class="card mt-8" style="background:var(--bg);border:1px solid var(--border)">
      <div class="flex" style="gap:8px;align-items:center;margin-bottom:6px">
        <span class="text-sm text-muted">Use these IDs in your IDE / client:</span>
        <button class="btn btn-sm btn-ghost" id="${onclickId}" onclick="copyModelIds(this, '${shortPrefix}', ${JSON.stringify(ids)})">Copy all</button>
      </div>
      <div class="mono text-sm" style="background:var(--bg-secondary);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto">
        ${ids.map(id => {
          const ctx = contextByModel[id];
          const suffix = typeof ctx === 'number'
            ? ` <span class="text-muted" style="font-family:var(--font);font-size:0.7rem">${esc(formatContext(ctx))}</span>`
            : '';
          return `<div style="padding:2px 0">${esc(shortPrefix + '-' + id)}${suffix}</div>`;
        }).join('')}
      </div>
    </div>
  `;
}

window.copyModelIds = function(btn, prefix, ids) {
  const text = ids.map(id => prefix + '-' + id).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 1500);
  }).catch(() => {});
};

function findingStatusLabel(status) {
  const labels = {
    open: 'ui.findingStatus.open',
    accepted: 'ui.findingStatus.accepted',
    dismissed: 'ui.findingStatus.dismissed',
    implemented: 'ui.findingStatus.implemented',
    actioned: 'ui.findingStatus.actioned',
    false: 'ui.findingStatus.false',
  };
  return t(labels[status] || 'ui.findingStatus.open');
}

// ── Dialogs ────────────────────────────────────────────────────────────────

function closeSummaryDialog() {
  const backdrop = document.getElementById('summaryDialogBackdrop');
  if (backdrop) {
    backdrop.remove();
  }
}

function openSummaryDialog(summaryId) {
  const summaries = Array.isArray(state.summariesData) ? state.summariesData : [];
  const summary = summaries.find((item) => item.id === summaryId);
  if (!summary) {
    toast('Summary details are unavailable.', true);
    return;
  }

  closeSummaryDialog();
  const backdrop = document.createElement('div');
  backdrop.id = 'summaryDialogBackdrop';
  backdrop.className = 'summary-dialog-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const versionLabel = Number(summary.version || 0) > 0 ? `v${summary.version}` : '-';
  backdrop.innerHTML = `
    <div class="summary-dialog" role="dialog" aria-modal="true" aria-labelledby="summaryDialogTitle">
      <div class="summary-dialog-header">
        <div>
          <h3 id="summaryDialogTitle">${esc(summary.title || 'Untitled summary')}</h3>
          <div class="text-muted text-sm mt-8">${esc(fmtDate(summary.updatedAt))} · ${esc(versionLabel)}</div>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" onclick="closeSummaryDialog()">Close</button>
      </div>
      <div class="summary-dialog-body">${esc(summary.content || '')}</div>
    </div>
  `;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      closeSummaryDialog();
    }
  });

  document.body.appendChild(backdrop);
}

function copyRowDetails(type, id) {
  let data;
  switch (type) {
    case 'chunk':
      data = state.chunksData?.find(function(c) { return c.id === id; });
      break;
    case 'code-extract':
      data = state.codeExtractsData?.find(function(e) { return e.id === id; });
      break;
    case 'file':
      data = state.filesData?.find(function(f) { return f.id === id; });
      break;
    case 'summary':
      data = state.summariesData?.find(function(s) { return s.id === id; });
      break;
    case 'finding':
      data = state.findingsData?.find(function(f) { return f.id === id; });
      break;
  }
  if (!data) {
    toast('Item not found.', true);
    return;
  }

  var text = '';
  switch (type) {
    case 'chunk':
      text = [
        'ID: ' + data.id,
        'Fact: ' + data.fact,
        'Category: ' + data.category,
        'Confidence: ' + (data.confidence * 100).toFixed(0) + '%',
        'Source: ' + (data.source || '-'),
        'Summarized: ' + (data.summarized ? 'Yes' : 'No'),
        'Created: ' + fmtDate(data.createdAt),
      ].join('\n');
      break;
    case 'code-extract':
      text = [
        'ID: ' + data.id,
        'File: ' + (data.fileName || '-'),
        'Language: ' + (data.language || '-'),
        'Chunk ID: ' + (data.chunkId || '-'),
        'Created: ' + fmtDate(data.createdAt),
      ].join('\n');
      break;
    case 'file':
      text = [
        'ID: ' + data.id,
        'File: ' + data.fileName,
        'Purpose: ' + (data.purpose || '-'),
        'Linked chunks: ' + String(data.chunkCount || 0),
        'Linked summaries: ' + String(data.summaryCount || 0),
        'Updated: ' + fmtDate(data.updatedAt || data.createdAt),
      ].join('\n');
      break;
    case 'summary':
      text = [
        'ID: ' + data.id,
        'Title: ' + (data.title || 'Untitled'),
        'One-line summary: ' + (data.oneLineSummary || '-'),
        'Categories: ' + ((Array.isArray(data.categories) ? data.categories.join(', ') : null) || (typeof data.categoriesList === 'string' ? data.categoriesList.replace(/[\\[\\]"]/g, '') : null) || '-'),
        'Version: ' + (data.version || '1'),
        'Created: ' + fmtDate(data.createdAt),
        'Updated: ' + fmtDate(data.updatedAt),
      ].join('\n');
      break;
    case 'finding':
      text = [
        'ID: ' + data.id,
        'Title: ' + data.title,
        'Type: ' + data.type,
        'Severity: ' + data.severity,
        'Status: ' + data.status,
        'Description: ' + summarizeInline(data.description, 200),
        'Related IDs: ' + (Array.isArray(data.relatedIds) ? data.relatedIds.join(', ') : (data.relatedIds || '-')),
        'Created: ' + fmtDate(data.createdAt),
      ].join('\n');
      break;
  }

  navigator.clipboard.writeText(text).then(function() {
    toast('Details copied to clipboard.');
  }).catch(function() {
    toast('Copy failed — check clipboard permissions.', true);
  });
}

function closeCodeExtractDialog() {
  const backdrop = document.getElementById('codeExtractDialogBackdrop');
  if (backdrop) {
    backdrop.remove();
  }
}

function openCodeExtractDialog(extractId) {
  const extracts = Array.isArray(state.codeExtractsData) ? state.codeExtractsData : [];
  const extract = extracts.find((item) => item.id === extractId);
  if (!extract) {
    toast('Code extract details are unavailable.', true);
    return;
  }

  closeCodeExtractDialog();
  const backdrop = document.createElement('div');
  backdrop.id = 'codeExtractDialogBackdrop';
  backdrop.className = 'summary-dialog-backdrop';
  backdrop.setAttribute('role', 'presentation');

  const symbols = parseCodeExtractSymbols(extract.symbolsJson);
  backdrop.innerHTML = `
    <div class="summary-dialog" role="dialog" aria-modal="true" aria-labelledby="codeExtractDialogTitle">
      <div class="summary-dialog-header">
        <div>
          <h3 id="codeExtractDialogTitle">${esc(extract.fileName || 'Code extract')}</h3>
          <div class="text-muted text-sm mt-8">${esc(extract.language || '-')} · ${fmtDate(extract.createdAt)} · ${esc(extract.chunkId ? extract.chunkId.slice(0, 8) + '…' : '-')}</div>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" onclick="closeCodeExtractDialog()">Close</button>
      </div>
      <div class="text-sm text-muted">${esc(translateOr('ui.codeExtracts.symbols', 'Symbols'))}</div>
      <div class="symbol-list mt-8">${symbols.length > 0 ? symbols.map(symbol => `<span class="tag mono">${esc(symbol)}</span>`).join('') : `<span class="text-muted">${esc(t('ui.codeExtracts.none'))}</span>`}</div>
      <div class="text-sm text-muted" style="margin-top:12px">${esc(translateOr('ui.codeExtracts.code', 'Code'))}</div>
      <pre class="summary-dialog-body">${esc(extract.code || '')}</pre>
    </div>
  `;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      closeCodeExtractDialog();
    }
  });

  document.body.appendChild(backdrop);
}

function closeFileDetailsDialog() {
  const backdrop = document.getElementById('fileDetailsDialogBackdrop');
  if (backdrop) {
    backdrop.remove();
  }
}

async function openFileDetailsDialog(fileId, focusSection) {
  const file = Array.isArray(state.filesData) ? state.filesData.find((item) => item.id === fileId) : null;
  if (!file || !state.selectedProject) {
    toast('File details are unavailable.', true);
    return;
  }

  const [chunkResponse, summaryResponse] = await Promise.all([
    api('/projects/' + state.selectedProject + '/files/' + fileId + '/chunks'),
    api('/projects/' + state.selectedProject + '/files/' + fileId + '/summaries'),
  ]);

  const chunkItems = Array.isArray(chunkResponse?.items) ? chunkResponse.items : [];
  const summaryItems = Array.isArray(summaryResponse?.items) ? summaryResponse.items : [];

  closeFileDetailsDialog();

  const chunkSection = chunkItems.length === 0
    ? `<div class="empty" style="padding:16px">${esc(translateOr('ui.files.noLinkedChunks', 'No linked chunks recorded for this file yet.'))}</div>`
    : `<div class="card" style="margin-bottom:12px">
        <h3>${esc(translateOr('ui.files.linkedChunks', 'Linked chunks'))} <span class="text-muted text-sm">(${esc(String(chunkResponse.total || chunkItems.length))})</span></h3>
        <div style="display:grid;gap:10px;margin-top:12px">${chunkItems.map((chunk) => `
          <div class="snippet-preview">
            <div class="flex mb-12"><span class="tag">${esc(chunk.category || 'general')}</span><span class="text-muted text-sm">${esc(fmtDate(chunk.createdAt))}</span></div>
            <div>${esc(chunk.fact || '')}</div>
          </div>`).join('')}</div>
      </div>`;

  const summarySection = summaryItems.length === 0
    ? `<div class="empty" style="padding:16px">${esc(translateOr('ui.files.noLinkedSummaries', 'No linked summaries recorded for this file yet.'))}</div>`
    : `<div class="card" style="margin-bottom:12px">
        <h3>${esc(translateOr('ui.files.linkedSummaries', 'Linked summaries'))} <span class="text-muted text-sm">(${esc(String(summaryResponse.total || summaryItems.length))})</span></h3>
        <div style="display:grid;gap:10px;margin-top:12px">${summaryItems.map((summary) => `
          <div class="snippet-preview">
            <div class="flex" style="justify-content:space-between;align-items:flex-start">
              <div>
                <div><strong>${esc(summary.title || 'Untitled summary')}</strong></div>
                <div class="text-muted text-sm mt-8">${esc(fmtDate(summary.updatedAt))}</div>
              </div>
              <button class="btn btn-sm btn-ghost" type="button" onclick="openSummaryDialog('${esc(summary.id)}')">${esc(translateOr('ui.summaries.viewDetails', 'View details'))}</button>
            </div>
            <div class="mt-12">${esc(summary.oneLineSummary || summary.contentPreview || '')}</div>
          </div>`).join('')}</div>
      </div>`;

  const backdrop = document.createElement('div');
  backdrop.id = 'fileDetailsDialogBackdrop';
  backdrop.className = 'summary-dialog-backdrop';
  backdrop.setAttribute('role', 'presentation');
  backdrop.innerHTML = `
    <div class="summary-dialog" role="dialog" aria-modal="true" aria-labelledby="fileDetailsDialogTitle">
      <div class="summary-dialog-header">
        <div>
          <h3 id="fileDetailsDialogTitle">${esc(file.fileName)}</h3>
          <div class="text-muted text-sm mt-8">${esc(file.purpose || 'No stored file summary')} · ${esc(String(file.chunkCount || 0))} ${esc(translateOr('ui.files.linkedChunks', 'Linked chunks').toLowerCase())} · ${esc(String(file.summaryCount || 0))} ${esc(translateOr('ui.files.linkedSummaries', 'Linked summaries').toLowerCase())}</div>
        </div>
        <button class="btn btn-sm btn-ghost" type="button" onclick="closeFileDetailsDialog()">Close</button>
      </div>
      <div>
        ${focusSection === 'summaries' ? summarySection + chunkSection : chunkSection + summarySection}
      </div>
    </div>
  `;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      closeFileDetailsDialog();
    }
  });

  document.body.appendChild(backdrop);
}

// ── Overview tab ───────────────────────────────────────────────────────────

async function renderOverview() {
  const el = document.getElementById('tab-overview');
  try {
    const h = await api('/health');
    state.health = h;
    const numProviders = h.providers?.length ?? 0;
    renderHeaderStatus();

    el.innerHTML = `
      <h2>${esc(t('ui.overview.title'))}</h2>
      ${numProviders === 0 ? `<div class="callout warn" style="margin-bottom:16px">
        ${esc(t('ui.overview.noProvidersWarning'))}
        <button class="btn btn-sm" style="margin-left:8px" onclick="showTab('providers')">${esc(t('ui.overview.addProvider'))}</button>
      </div>` : ''}
      <div class="metric-grid">
        <div class="card"><h3>${esc(t('ui.overview.providers'))}</h3><div style="font-size:32px;font-weight:700">${numProviders}</div></div>
        <div class="card"><h3>${esc(t('ui.overview.projects'))}</h3><div style="font-size:32px;font-weight:700">${h.projects}</div></div>
        <div class="card"><h3>${esc(t('ui.overview.mode'))}</h3><div style="font-size:32px;font-weight:700">${esc(h.mode)}</div></div>
      </div>
      ${numProviders > 0 ? `<div class="card mb-16">
        <h3>${esc(t('ui.overview.activeProviders'))}</h3>
        <div class="flex mt-8" style="flex-wrap:wrap;gap:8px">
          ${h.providers.map(p => `<span>${typeLabel(p.type)} <strong>${esc(p.name)}</strong>${p.isDefault ? `&nbsp;<span class="badge badge-green">${esc(t('ui.overview.default'))}</span>` : ''}</span>`).join('  ')}
        </div>
      </div>` : ''}
      <div class="card mb-16">
        <h3>${esc(t('ui.overview.detectedClient'))}</h3>
        ${renderDetectedClient(h.lastClient)}
      </div>
      <div class="card"><h3>${esc(t('ui.overview.ideSetup'))}</h3>
        <p style="font-size:13px;color:var(--muted);line-height:1.8;margin-top:6px">
          ${esc(t('ui.overview.ideSetupIntro'))}
          <code style="background:var(--bg);padding:2px 6px;border-radius:4px;color:var(--accent)">${proxyUrl()}</code><br/>
          ${esc(t('ui.overview.ideSetupOutro'))}
        </p>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="card"><span class="status-dot status-err"></span>${esc(t('ui.errors.cannotConnect', { message: getErrorMessage(err) }))}</div>`;
  }
}

/**
 * Render the most recently detected IDE client. Falls back to a hint pointing
 * at the VS Code extension when no client has identified itself yet.
 */
function renderDetectedClient(client) {
  if (!client) {
    return `<p style="font-size:13px;color:var(--muted);margin-top:6px">${esc(t('ui.overview.noClientYet'))}</p>`;
  }

  const rows = [];
  const add = (labelKey, value) => {
    if (!value) return;
    rows.push(`<div class="flex" style="gap:8px;padding:3px 0">
      <span class="text-muted text-sm" style="min-width:120px">${esc(t(labelKey))}</span>
      <span class="text-sm mono" style="word-break:break-all">${esc(value)}</span>
    </div>`);
  };

  add('ui.overview.clientIde', client.ide);
  add('ui.overview.clientProject', client.resolvedProjectName || client.projectName);
  add('ui.overview.clientRoot', client.projectRoot);
  add('ui.overview.clientFile', client.file);
  add('ui.overview.clientBranch', client.branch);
  add('ui.overview.clientUserAgent', client.userAgent);

  const lastSeen = client.lastSeenAt
    ? `<div class="text-muted text-sm mt-8">${esc(t('ui.overview.clientLastSeen'))}: ${esc(fmtDate(client.lastSeenAt))}</div>`
    : '';

  return `<div class="mt-8">${rows.join('')}</div>${lastSeen}`;
}
