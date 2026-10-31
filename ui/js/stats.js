// ── Statistics tab ────────────────────────────────────────────────────────
// Surfaces always-recorded telemetry from the `stats` table: injected
// context, persisted learnings, and IC tool retrieval/learning activity.

const STATS_TYPE_LABEL_KEYS = {
  context_injection: 'ui.stats.type.contextInjection',
  learning: 'ui.stats.type.learning',
  ic_retrieval: 'ui.stats.type.icRetrieval',
  ic_record_learning: 'ui.stats.type.icRecordLearning',
  ic_write: 'ui.stats.type.icWrite',
  ic_tool: 'ui.stats.type.icTool',
};

// Only user-facing knowledge activity is surfaced here. Raw model request
// telemetry (gatherer/analyzer/summarizer token counts) is deliberately
// excluded — it is not actionable for the end user.
const STATS_VISIBLE_TYPES = [
  'context_injection',
  'learning',
  'ic_retrieval',
  'ic_record_learning',
  'ic_write',
  'ic_tool',
];

const STATS_TYPE_BADGE_CLASSES = {
  context_injection: 'badge-blue',
  learning: 'badge-green',
  ic_retrieval: 'badge-purple',
  ic_record_learning: 'badge-green',
  ic_write: 'badge-amber',
  ic_tool: 'badge-gray',
};

const STAT_DETAILS_BACKDROP_ID = 'statDetailsBackdrop';

let statsFilterType = '';

function statTypeLabel(type) {
  const key = STATS_TYPE_LABEL_KEYS[type];
  return key ? t(key) : String(type || '-');
}

function statTypeBadge(type) {
  const badgeClass = STATS_TYPE_BADGE_CLASSES[type] || 'badge-gray';
  return `<span class="badge ${badgeClass}">${esc(statTypeLabel(type))}</span>`;
}

function parseStatMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
}

function statSummary(row) {
  const meta = parseStatMeta(row.meta);
  const parts = [];

  if (meta.tool) parts.push(String(meta.tool));
  if (meta.action && meta.action !== meta.tool) parts.push(String(meta.action));
  if (meta.dataType) parts.push(String(meta.dataType));
  if (meta.method) parts.push(String(meta.method));

  if (Array.isArray(meta.ids) && meta.ids.length > 0) {
    parts.push(`${meta.ids.length} id${meta.ids.length === 1 ? '' : 's'}`);
  }
  if (typeof meta.numChunksSelected === 'number') parts.push(`chunks: ${meta.numChunksSelected}`);
  if (typeof meta.numSummariesSelected === 'number') parts.push(`summaries: ${meta.numSummariesSelected}`);
  if (typeof meta.numFindingsSelected === 'number') parts.push(`findings: ${meta.numFindingsSelected}`);
  if (typeof meta.totalReceived === 'number') parts.push(`received: ${meta.totalReceived}`);
  if (typeof meta.stored === 'number') parts.push(`stored: ${meta.stored}`);
  if (typeof meta.updated === 'number') parts.push(`updated: ${meta.updated}`);
  if (meta.success === false) parts.push(String(t('ui.stats.failed')));

  return parts.join(' · ') || '-';
}

async function renderStats() {
  const el = document.getElementById('tab-stats');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.stats.selectProjectFirst'))}</div>`;
    return;
  }

  const params = new URLSearchParams();
  params.set('types', STATS_VISIBLE_TYPES.join(','));
  if (statsFilterType) params.set('type', statsFilterType);
  const data = await api('/projects/' + state.selectedProject + '/stats?' + params.toString());
  const stats = Array.isArray(data.stats) ? data.stats : [];
  state.statsData = stats;

  const typeCounts = (Array.isArray(data.typeCounts) ? data.typeCounts : [])
    .filter((entry) => STATS_VISIBLE_TYPES.includes(entry.type));
  const total = typeof data.total === 'number' ? data.total : stats.length;

  const options = [{ value: '', label: t('ui.stats.filterAll') }].concat(
    typeCounts.map((entry) => ({ value: entry.type, label: `${statTypeLabel(entry.type)} (${entry.count})` }))
  );

  el.innerHTML = `
    <div class="flex mb-16">
      <h2 style="flex:1">${esc(t('ui.stats.title'))} <span class="text-muted" style="font-size:14px;font-weight:400">${esc(t('ui.stats.total', { total }))}</span></h2>
      <div class="header-field">
        <label for="statsTypeFilter">${esc(t('ui.stats.typeFilter'))}</label>
        <select id="statsTypeFilter" class="header-inline-select" onchange="onStatsFilterChange()">
          ${options.map((option) => `<option value="${esc(option.value)}" ${option.value === statsFilterType ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${stats.length === 0
      ? `<div class="empty">${esc(t('ui.stats.empty'))}</div>`
      : `<table id="statsTable">
          <thead>
            <tr>
              <th>${esc(t('ui.stats.created'))}</th>
              <th>${esc(t('ui.stats.type'))}</th>
              <th>${esc(t('ui.stats.summary'))}</th>
              <th>${esc(t('ui.stats.model'))}</th>
              <th>${esc(t('ui.stats.tokens'))}</th>
              <th>${esc(t('ui.stats.session'))}</th>
              <th data-sortable="false">${esc(t('ui.stats.actions'))}</th>
            </tr>
          </thead>
          <tbody>${stats.map((row) => `
            <tr>
              <td data-sort="${esc(row.createdAt || '')}">${fmtDate(row.createdAt)}</td>
              <td>${statTypeBadge(row.type)}</td>
              <td>${esc(statSummary(row))}</td>
              <td class="mono text-sm">${esc(row.model || '-')}</td>
              <td data-sort="${Number(row.tokens) || 0}">${Number(row.tokens) || 0}</td>
              <td class="mono text-sm">${esc((row.sessionId || row.requestId || '-').slice(0, 12))}</td>
              <td class="flex">
                <button class="btn btn-sm btn-ghost" type="button" onclick="openStatDetailsDialog('${esc(row.id)}')">${esc(t('ui.stats.viewDetails'))}</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`}
  `;

  if (stats.length > 0 && typeof simpleDatatables !== 'undefined') {
    new simpleDatatables.DataTable('#statsTable', {
      searchable: true,
      perPage: 10,
      perPageSelect: [10, 25, 50, 100],
      sortable: true,
      labels: {
        placeholder: t('ui.stats.searchPlaceholder'),
        noRows: t('ui.stats.noRows'),
        info: t('ui.stats.tableInfo'),
      },
    });
  }
}

function onStatsFilterChange() {
  statsFilterType = document.getElementById('statsTypeFilter').value || '';
  renderStats();
}

function statDetailRow(label, value) {
  return `<tr><td class="text-muted" style="white-space:nowrap;padding-right:16px;vertical-align:top">${esc(label)}</td><td>${esc(value)}</td></tr>`;
}

async function openStatDetailsDialog(id) {
  const row = await api('/projects/' + state.selectedProject + '/stats/' + id);
  const meta = parseStatMeta(row.meta);

  const backdrop = document.createElement('div');
  backdrop.className = 'summary-dialog-backdrop';
  backdrop.id = STAT_DETAILS_BACKDROP_ID;
  backdrop.innerHTML = `
    <div class="summary-dialog" role="dialog" aria-modal="true" onclick="event.stopPropagation()">
      <div class="summary-dialog-header">
        <h3>${esc(t('ui.stats.detailTitle'))}</h3>
        <button class="btn btn-sm btn-ghost" type="button" onclick="closeStatDetailsDialog()">${esc(t('ui.stats.close'))}</button>
      </div>
      <div class="summary-dialog-body">
        <table class="text-sm">
          ${statDetailRow(t('ui.stats.type'), statTypeLabel(row.type))}
          ${statDetailRow(t('ui.stats.direction'), row.direction || '-')}
          ${statDetailRow(t('ui.stats.model'), row.model || '-')}
          ${statDetailRow(t('ui.stats.tokens'), String(Number(row.tokens) || 0))}
          ${statDetailRow(t('ui.stats.created'), fmtDate(row.createdAt))}
          ${statDetailRow(t('ui.stats.sessionId'), row.sessionId || '-')}
          ${statDetailRow(t('ui.stats.requestId'), row.requestId || '-')}
          ${statDetailRow(t('ui.stats.runId'), row.runId || '-')}
        </table>
        <h4 class="mt-16">${esc(t('ui.stats.meta'))}</h4>
        <pre class="mono text-sm" style="white-space:pre-wrap;word-break:break-word;margin:0">${esc(JSON.stringify(meta, null, 2))}</pre>
        ${row.body ? `<h4 class="mt-16">${esc(t('ui.stats.body'))}</h4><pre class="mono text-sm" style="white-space:pre-wrap;word-break:break-word;margin:0">${esc(row.body)}</pre>` : ''}
      </div>
    </div>
  `;

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      closeStatDetailsDialog();
    }
  });

  document.body.appendChild(backdrop);
}

function closeStatDetailsDialog() {
  const existing = document.getElementById(STAT_DETAILS_BACKDROP_ID);
  if (existing) existing.remove();
}
