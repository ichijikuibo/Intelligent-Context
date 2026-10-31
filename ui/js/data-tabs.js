// ── Learning data tabs: chunks, code extracts, files, summaries, findings ─

async function renderChunks() {
  const el = document.getElementById('tab-chunks');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.chunks.selectProjectFirst'))}</div>`;
    return;
  }
  const { chunks, total } = await api('/projects/' + state.selectedProject + '/context/chunks');
  state.chunksData = chunks;
  el.innerHTML = `
    <h2>${esc(t('ui.chunks.title'))} <span class="text-muted" style="font-size:14px;font-weight:400">${esc(t('ui.chunks.total', { total }))}</span></h2>
    ${chunks.length === 0
      ? `<div class="empty">${esc(t('ui.chunks.empty'))}</div>`
      : `<table id="chunksTable">
          <thead><tr><th>${esc(t('ui.chunks.fact'))}</th><th>${esc(t('ui.chunks.category'))}</th><th>${esc(t('ui.chunks.confidence'))}</th><th>${esc(t('ui.chunks.created'))}</th><th data-sortable="false">Actions</th></tr></thead>
          <tbody>${chunks.map(c => `
            <tr>
              <td class="fact-text">${esc(c.fact)}</td>
              <td><span class="tag">${esc(c.category)}</span></td>
              <td data-sort="${c.confidence}">${(c.confidence*100).toFixed(0)}%</td>
              <td data-sort="${c.createdAt}">${fmtDate(c.createdAt)}</td>
              <td class="flex"><button class="btn btn-sm btn-ghost" onclick="copyRowDetails('chunk','${c.id}')" title="Copy details">📋</button><button class="btn btn-sm btn-danger" onclick="deleteChunk('${c.id}')">✕</button></td>
            </tr>`).join('')}
          </tbody>
        </table>`}
  `;
  if (chunks.length > 0 && typeof simpleDatatables !== 'undefined') {
    new simpleDatatables.DataTable("#chunksTable", {
      searchable: true,
      perPage: 10,
      perPageSelect: [10, 25, 50, 100],
      sortable: true,
      labels: { placeholder: "Search chunks…", noRows: "No chunks found", info: "Showing {start} to {end} of {rows} chunks" }
    });
  }
}

async function deleteChunk(id) {
  await api('/projects/' + state.selectedProject + '/context/chunks/' + id, { method: 'DELETE' });
  toast(t('ui.chunks.deleted'));
  renderChunks();
}

function parseCodeExtractSymbols(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(symbol => typeof symbol === 'string' && symbol.length > 0) : [];
  } catch {
    return [];
  }
}

async function renderCodeExtracts() {
  const el = document.getElementById('tab-code-extracts');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.codeExtracts.selectProjectFirst'))}</div>`;
    return;
  }

  const { codeExtracts, total } = await api('/projects/' + state.selectedProject + '/code-extracts');
  state.codeExtractsData = codeExtracts;
  el.innerHTML = `
    <h2>${esc(t('ui.codeExtracts.title'))} <span class="text-muted" style="font-size:14px;font-weight:400">${esc(t('ui.codeExtracts.total', { total }))}</span></h2>
    ${codeExtracts.length === 0
      ? `<div class="empty">${esc(t('ui.codeExtracts.empty'))}</div>`
      : `<table id="codeExtractsTable">
          <thead><tr><th>${esc(t('ui.codeExtracts.fileName'))}</th><th>${esc(t('ui.codeExtracts.language'))}</th><th>${esc(translateOr('ui.codeExtracts.symbols', 'Symbols'))}</th><th>${esc(translateOr('ui.codeExtracts.preview', 'Preview'))}</th><th>${esc(t('ui.codeExtracts.chunkId'))}</th><th>${esc(t('ui.codeExtracts.created'))}</th><th data-sortable="false">${esc(translateOr('ui.codeExtracts.actions', 'Actions'))}</th></tr></thead>
          <tbody>${codeExtracts.map(extract => `
            <tr>
              <td class="mono">${esc(extract.fileName || '-')}</td>
              <td class="mono text-sm">${esc(extract.language || '-')}</td>
              <td>${(() => {
                const symbols = parseCodeExtractSymbols(extract.symbolsJson);
                if (symbols.length === 0) return '<span class="text-muted">-</span>';
                return `${symbols.length} ${symbols.length === 1 ? 'symbol' : 'symbols'}`;
              })()}</td>
              <td>${esc(summarizeInline(extract.code, 120) || '-')}</td>
              <td class="mono text-sm">${esc(extract.chunkId.slice(0,8))}...</td>
              <td data-sort="${extract.createdAt}">${fmtDate(extract.createdAt)}</td>
              <td class="flex">
                <button class="btn btn-sm btn-ghost" onclick="copyRowDetails('code-extract','${extract.id}')" title="Copy details">📋</button>
                <button class="btn btn-sm btn-ghost" type="button" data-extract-id="${esc(extract.id)}" onclick="openCodeExtractDialog(this.dataset.extractId)">${esc(translateOr('ui.codeExtracts.viewDetails', 'View details'))}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteCodeExtract('${extract.id}')">✕</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
  `;

  if (codeExtracts.length > 0 && typeof simpleDatatables !== 'undefined') {
    new simpleDatatables.DataTable("#codeExtractsTable", {
      searchable: true,
      perPage: 10,
      perPageSelect: [10, 25, 50, 100],
      sortable: true,
      labels: {
        placeholder: translateOr('ui.codeExtracts.searchPlaceholder', 'Search code extracts...'),
        noRows: translateOr('ui.codeExtracts.noRows', 'No code extracts found'),
        info: translateOr('ui.codeExtracts.tableInfo', 'Showing {start} to {end} of {rows} code extracts')
      }
    });
  }
}

async function deleteCodeExtract(id) {
  await api('/projects/' + state.selectedProject + '/code-extracts/' + id, { method: 'DELETE' });
  toast(t('ui.codeExtracts.deleted'));
  renderCodeExtracts();
}

async function renderFiles() {
  const el = document.getElementById('tab-files');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.files.selectProjectFirst'))}</div>`;
    return;
  }
  const { files, total } = await api('/projects/' + state.selectedProject + '/files');
  state.filesData = files;
  el.innerHTML = `
    <h2>${esc(t('ui.files.title'))} <span class="text-muted" style="font-size:14px;font-weight:400">${esc(t('ui.files.total', { total }))}</span></h2>
    ${files.length === 0
      ? `<div class="empty">${esc(t('ui.files.empty'))}</div>`
      : `<table id="filesTable">
          <thead><tr><th>${esc(t('ui.files.fileName'))}</th><th>${esc(t('ui.files.purpose'))}</th><th>${esc(translateOr('ui.files.linkedChunks', 'Linked chunks'))}</th><th>${esc(translateOr('ui.files.linkedSummaries', 'Linked summaries'))}</th><th>${esc(t('ui.files.created'))}</th><th data-sortable="false">Actions</th></tr></thead>
          <tbody>${files.map(f => `
            <tr>
              <td class="mono">${esc(f.fileName)}</td>
              <td>${esc(f.purpose || '-')}</td>
              <td data-sort="${esc(String(f.chunkCount || 0))}"><button class="btn btn-sm btn-ghost" type="button" onclick="openFileDetailsDialog('${f.id}', 'chunks')">${esc(String(f.chunkCount || 0))}</button></td>
              <td data-sort="${esc(String(f.summaryCount || 0))}"><button class="btn btn-sm btn-ghost" type="button" onclick="openFileDetailsDialog('${f.id}', 'summaries')">${esc(String(f.summaryCount || 0))}</button></td>
              <td data-sort="${f.updatedAt || f.createdAt}">${fmtDate(f.updatedAt || f.createdAt)}</td>
              <td class="flex"><button class="btn btn-sm btn-ghost" onclick="copyRowDetails('file','${f.id}')" title="Copy details">📋</button><button class="btn btn-sm btn-ghost" type="button" onclick="openFileDetailsDialog('${f.id}')">${esc(translateOr('ui.files.viewLinks', 'View links'))}</button><button class="btn btn-sm btn-danger" onclick="deleteFile('${f.id}')">✕</button></td>
            </tr>`).join('')}
          </tbody>
        </table>`}
  `;
  if (files.length > 0 && typeof simpleDatatables !== 'undefined') {
    new simpleDatatables.DataTable("#filesTable", {
      searchable: true,
      perPage: 10,
      perPageSelect: [10, 25, 50, 100],
      sortable: true,
      labels: { placeholder: "Search files…", noRows: "No files found", info: "Showing {start} to {end} of {rows} files" }
    });
  }
}

async function deleteFile(id) {
  await api('/projects/' + state.selectedProject + '/files/' + id, { method: 'DELETE' });
  toast(t('ui.files.deleted'));
  renderFiles();
}

async function renderSummaries() {
  const el = document.getElementById('tab-summaries');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.chunks.selectProjectFirst'))}</div>`;
    return;
  }

  const summaries = await api('/projects/' + state.selectedProject + '/context/summaries');

  state.summariesData = summaries;

  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.summaries.title'))}</h2>
      <button class="btn btn-sm" onclick="triggerSummarize()">${esc(t('ui.summaries.runNow'))}</button>
    </div>

    ${summaries.length === 0
      ? `<div class="empty">${esc(t('ui.summaries.empty'))}</div>`
      : `<table id="summariesTable">
          <thead>
            <tr>
              <th>${esc(translateOr('ui.summaries.table.title', 'Title'))}</th>
              <th>${esc(translateOr('ui.summaries.table.preview', 'Summary'))}</th>
              <th>${esc(translateOr('ui.summaries.table.updated', 'Updated'))}</th>
              <th>${esc(translateOr('ui.summaries.table.version', 'Version'))}</th>
              <th data-sortable="false">${esc(translateOr('ui.summaries.table.actions', 'Actions'))}</th>
            </tr>
          </thead>
          <tbody>
            ${summaries.map((summary) => {
              const versionLabel = Number(summary.version || 0) > 0 ? `v${summary.version}` : '-';
              return `
                <tr>
                  <td><strong>${esc(summary.title || 'Untitled summary')}</strong></td>
                  <td>${esc(summarizeInline(summary.content))}</td>
                  <td data-sort="${esc(summary.updatedAt || '')}">${fmtDate(summary.updatedAt)}</td>
                  <td data-sort="${esc(String(summary.version ?? ''))}">${esc(versionLabel)}</td>
                  <td class="flex">
                    <button class="btn btn-sm btn-ghost" onclick="copyRowDetails('summary','${summary.id}')" title="Copy details">📋</button>
                    <button class="btn btn-sm btn-ghost" type="button" data-summary-id="${esc(summary.id)}" onclick="openSummaryDialog(this.dataset.summaryId)">${esc(translateOr('ui.summaries.viewDetails', 'View details'))}</button>
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`}
  `;

  if (summaries.length > 0 && typeof simpleDatatables !== 'undefined') {
    new simpleDatatables.DataTable('#summariesTable', {
      searchable: true,
      perPage: 10,
      perPageSelect: [10, 25, 50, 100],
      sortable: true,
      labels: {
        placeholder: translateOr('ui.summaries.searchPlaceholder', 'Search summaries...'),
        noRows: translateOr('ui.summaries.noRows', 'No summaries found'),
        info: translateOr('ui.summaries.tableInfo', 'Showing {start} to {end} of {rows} summaries'),
      }
    });
  }
}

async function triggerSummarize() {
  try {
    await api('/projects/' + state.selectedProject + '/summarize', { method: 'POST' });
    toast(t('ui.summaries.triggered'));
    setTimeout(() => renderSummaries(), 4000);
  } catch (err) { toast(getErrorMessage(err), true); }
}

async function renderFindings() {
  const el = document.getElementById('tab-findings');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.chunks.selectProjectFirst'))}</div>`;
    return;
  }
  const findings = await api('/projects/' + state.selectedProject + '/findings');
  state.findingsData = findings;
  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.findings.title'))}</h2>
      <button class="btn btn-sm" onclick="triggerAnalysis()">${esc(t('ui.findings.runNow'))}</button>
    </div>
    ${findings.length === 0
      ? `<div class="empty">${esc(t('ui.findings.empty'))}</div>`
      : `<table id="findingsTable">
          <thead><tr><th>${esc(t('ui.findings.severity'))}</th><th>${esc(t('ui.findings.type'))}</th><th>${esc(t('ui.findings.titleHeader'))}</th><th>${esc(t('ui.findings.status'))}</th><th data-sortable="false">Actions</th></tr></thead>
          <tbody>${findings.map(f => `
            <tr>
              <td data-sort="${esc(f.severity)}">${badgeSeverity(f.severity)}</td>
              <td><span class="tag">${esc(f.type)}</span></td>
              <td><strong>${esc(f.title)}</strong><div class="text-muted text-sm mt-8">${esc(f.description)}</div></td>
              <td data-sort="${esc(f.status)}"><span class="badge badge-gray">${esc(findingStatusLabel(f.status))}</span></td>
              <td class="flex">
                <button class="btn btn-sm btn-ghost" onclick="copyRowDetails('finding','${f.id}')" title="Copy details">📋</button>
                <select onchange="updateFinding('${f.id}',this.value)" style="width:auto;padding:4px 6px;font-size:11px">
                  <option ${f.status==='open'?'selected':''} value="open">${esc(t('ui.findingStatus.open'))}</option>
                  <option ${f.status==='accepted'?'selected':''} value="accepted">${esc(t('ui.findings.accept'))}</option>
                  <option ${f.status==='dismissed'?'selected':''} value="dismissed">${esc(t('ui.findings.dismiss'))}</option>
                  <option ${f.status==='actioned'?'selected':''} value="actioned">${esc(t('ui.findingStatus.actioned'))}</option>
                  <option ${f.status==='false'?'selected':''} value="false">${esc(t('ui.findingStatus.false'))}</option>
                  <option ${f.status==='implemented'?'selected':''} value="implemented">${esc(t('ui.findings.done'))}</option>
                </select>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
  `;
  if (findings.length > 0 && typeof simpleDatatables !== 'undefined') {
    new simpleDatatables.DataTable("#findingsTable", {
      searchable: true,
      perPage: 10,
      perPageSelect: [10, 25, 50, 100],
      sortable: true,
      labels: { placeholder: "Search findings…", noRows: "No findings", info: "Showing {start} to {end} of {rows} findings" }
    });
  }
}

async function updateFinding(id, status) {
  await api('/projects/' + state.selectedProject + '/findings/' + id, { method: 'PUT', body: JSON.stringify({ status }) });
  toast(t('ui.findings.updated'));
}

async function triggerAnalysis() {
  try {
    await api('/projects/' + state.selectedProject + '/analyze', { method: 'POST' });
    toast(t('ui.findings.triggered'));
    setTimeout(() => renderFindings(), 8000);
  } catch (err) { toast(getErrorMessage(err), true); }
}
