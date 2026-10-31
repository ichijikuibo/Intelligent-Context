// ── Settings tab ──────────────────────────────────────────────────────────

async function renderSettings() {
  const el = document.getElementById('tab-settings');
  const s = await api('/settings');
  const modelOptions = normalizeAvailableModelOptions(s.availableModels, s.availableModelOptions);
  const avail = modelOptions.map((option) => option.value);
  const visionOptions = normalizeAvailableModelOptions(
    (s.availableVisionModelOptions || []).map((option) => option.value),
    s.availableVisionModelOptions,
  );
  const visionModel = s.models.vision || '';
  const modelReference = s.modelReference || { enabled: true, count: 0, lastSyncAt: '', lastError: '' };
  const referenceLastSync = modelReference.lastSyncAt
    ? fmtDate(modelReference.lastSyncAt)
    : t('ui.settings.modelReferenceNever');
  const visionSelect =
    `<select onchange="saveSetting('visionModel', this.value)" style="width:100%;max-width:400px">` +
    `<option value="">${esc(t('ui.settings.visionDisabled'))}</option>` +
    visionOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === visionModel ? 'selected' : ''}>${esc(option.label)}</option>`).join('') +
    `</select>`;
  const requestContextMode = ['basic', 'selector', 'gatherer'].includes(s.models.requestContextMode)
    ? s.models.requestContextMode
    : (s.models.gatherer ? 'gatherer' : 'selector');
  const modelSelections = {
    contextSelectorModel: getPersistedSettingsModel('contextSelectorModel', s.models.contextSelector, modelOptions),
    summarizerModel: getPersistedSettingsModel('summarizerModel', s.models.summarizer, modelOptions),
    analyzerModel: getPersistedSettingsModel('analyzerModel', s.models.analyzer, modelOptions),
    learningModel: getPersistedSettingsModel('learningModel', s.models.learning, modelOptions),
    gathererModel: getPersistedSettingsModel('gathererModel', s.models.gatherer, modelOptions),
    icToolsModel: getPersistedSettingsModel('icToolsModel', s.models.icTools, modelOptions),
  };
  const dd = (name, selected, emptyLabelKey = 'ui.settings.selectOption') =>
    `<select onchange="${PERSISTED_MODEL_SETTING_KEYS.has(name) ? `saveModelSetting('${name}', this.value)` : `saveSetting('${name}', this.value)`}" style="width:100%;max-width:400px">` +
    `<option value="">${esc(t(emptyLabelKey))}</option>` +
    modelOptions.map((option) => `<option value="${esc(option.value)}" ${option.value === selected ? 'selected' : ''}>${esc(option.label)}</option>`).join('') +
    `</select>`;
  const num = (name, value, hintKey) =>
    `<div style="display:grid;grid-template-columns:1fr 160px;gap:8px;align-items:center">` +
      `<div><label style="margin:0">${esc(t(name))}</label>` +
        (hintKey ? `<div class="text-muted text-sm mt-8">${esc(t(hintKey))}</div>` : '') +
      `</div>` +
      `<input type="number" value="${esc(value)}" min="0" onchange="saveSetting('${name}', Number(this.value))" />` +
    `</div>`;
  const requestContextModeOptions = [
    {
      value: 'basic',
      titleKey: 'ui.settings.requestContextModeBasic',
      hintKey: 'ui.settings.requestContextModeBasicHint',
    },
    {
      value: 'selector',
      titleKey: 'ui.settings.requestContextModeSelector',
      hintKey: 'ui.settings.requestContextModeSelectorHint',
    },
    {
      value: 'gatherer',
      titleKey: 'ui.settings.requestContextModeGatherer',
      hintKey: 'ui.settings.requestContextModeGathererHint',
    },
  ];
  const activeRequestContextModelKey = requestContextMode === 'gatherer'
    ? 'gathererModel'
    : requestContextMode === 'selector'
      ? 'contextSelectorModel'
      : null;
  const activeRequestContextModelLabelKey = requestContextMode === 'gatherer'
    ? 'ui.settings.requestContextModeGathererModel'
    : 'ui.settings.requestContextModeSelectorModel';
  const activeRequestContextModelEmptyLabelKey = requestContextMode === 'gatherer'
    ? 'ui.settings.gathererDisabled'
    : 'ui.settings.selectOption';
  const renderRequestContextModeCard = (option) => {
    const isSelected = option.value === requestContextMode;
    const showModelSelect = isSelected && activeRequestContextModelKey && option.value !== 'basic';
    const showBasicNote = isSelected && option.value === 'basic';

    return `
      <label class="choice-card ${isSelected ? 'is-selected' : ''}" data-choice-group="request-context-mode">
        <input type="radio" name="requestContextMode" value="${option.value}" ${isSelected ? 'checked' : ''} onchange="saveRequestContextMode(this.value)" />
        <div style="flex:1;min-width:0">
          <strong>${esc(t(option.titleKey))}</strong>
          <span>${esc(t(option.hintKey))}</span>
          ${showModelSelect ? `
            <div class="mt-12" style="display:grid;gap:6px">
              <label style="margin:0">${esc(t(activeRequestContextModelLabelKey))}</label>
              ${dd(activeRequestContextModelKey, modelSelections[activeRequestContextModelKey], activeRequestContextModelEmptyLabelKey)}
            </div>
          ` : ''}
          ${showBasicNote ? `<div class="text-muted text-sm mt-12">${esc(t('ui.settings.requestContextModeBasicNoModel'))}</div>` : ''}
        </div>
      </label>
    `;
  };

  el.innerHTML = `
    <h2>${esc(t('ui.settings.title'))}</h2>
    <div class="card">
      <h3>${esc(t('ui.settings.requestContextStrategy'))}</h3>
      <p class="text-muted text-sm mb-12">${esc(t('ui.settings.requestContextStrategyHint'))}</p>
      <div class="choice-grid">
        ${requestContextModeOptions.map(renderRequestContextModeCard).join('')}
      </div>
      ${avail.length === 0 ? `<p class="text-muted text-sm mt-12">${esc(t('ui.settings.noModels'))}</p>` : ''}
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.backgroundJobModels'))}</h3>
      <p class="text-muted text-sm mb-12">${esc(t('ui.settings.backgroundJobHint'))}</p>
      <div class="form-row" style="grid-template-columns:1fr 2fr;gap:8px;align-items:center">
        <label style="margin:0">${esc(t('ui.settings.summarizer'))}</label>
        ${dd('summarizerModel', modelSelections.summarizerModel)}
      </div>
      <div class="form-row mt-8" style="grid-template-columns:1fr 2fr;gap:8px;align-items:center">
        <label style="margin:0">${esc(t('ui.settings.analyzer'))}</label>
        ${dd('analyzerModel', modelSelections.analyzerModel)}
      </div>
      <div class="form-row mt-8" style="grid-template-columns:1fr 2fr;gap:8px;align-items:center">
        <div>
          <label style="margin:0">${esc(t('ui.settings.learning'))}</label>
          <div class="text-muted text-sm mt-8">${esc(t('ui.settings.learningHint'))}</div>
        </div>
        ${dd('learningModel', modelSelections.learningModel, 'ui.settings.learningAppendMode')}
      </div>
      <div class="form-row mt-8" style="grid-template-columns:1fr 2fr;gap:8px;align-items:center">
        <div>
          <label style="margin:0">${esc(t('ui.settings.icTools'))}</label>
          <div class="text-muted text-sm mt-8">${esc(t('ui.settings.icToolsHint'))}</div>
        </div>
        ${dd('icToolsModel', modelSelections.icToolsModel)}
      </div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.vision'))}</h3>
      <p class="text-muted text-sm mb-12">${esc(t('ui.settings.visionHint'))}</p>
      <div class="form-row" style="grid-template-columns:1fr 2fr;gap:8px;align-items:center">
        <div>
          <label style="margin:0">${esc(t('ui.settings.visionModel'))}</label>
          <div class="text-muted text-sm mt-8">${esc(t('ui.settings.visionModelHint'))}</div>
        </div>
        ${visionSelect}
      </div>
      ${visionModel
        ? `<p class="text-muted text-sm mt-12">${esc(t('ui.settings.visionConfigured'))}</p>`
        : visionOptions.length === 0
          ? `<p class="text-muted text-sm mt-12">${esc(t('ui.settings.visionNoModels'))}</p>`
          : ''}
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.modelReference'))}</h3>
      <p class="text-muted text-sm mb-12">${esc(t('ui.settings.modelReferenceHint'))}</p>
      <div class="form-row" style="display:grid;grid-template-columns:1fr 160px;gap:8px;align-items:center">
        <div>
          <label style="margin:0">${esc(t('ui.settings.modelReferenceEnabled'))}</label>
          <div class="text-muted text-sm mt-8">${esc(t('ui.settings.modelReferenceEnabledHint'))}</div>
        </div>
        <label style="display:flex;justify-content:flex-end;align-items:center">
          <input type="checkbox" ${modelReference.enabled ? 'checked' : ''} onchange="saveSetting('modelReferenceSyncEnabled', this.checked)" />
        </label>
      </div>
      <div class="text-muted text-sm mt-12">
        ${esc(t('ui.settings.modelReferenceStatus', { count: modelReference.count, lastSync: referenceLastSync }))}
      </div>
      ${modelReference.lastError ? `<div class="text-sm mt-8" style="color:var(--red)">${esc(modelReference.lastError)}</div>` : ''}
      <div class="flex mt-12" style="gap:8px">
        <button class="btn btn-sm" onclick="syncModelReferenceNow()">${esc(t('ui.settings.modelReferenceSyncNow'))}</button>
      </div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.learningRecording'))}</h3>
      <div class="form-row">${num('ui.settings.maxRecordLearnings', s.context.maxRecordLearnings, 'ui.settings.maxRecordLearningsHint')}</div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.analyzerAgent'))}</h3>
      <div class="form-row" style="display:grid;grid-template-columns:1fr 160px;gap:8px;align-items:center">
        <div>
          <label style="margin:0">${esc(t('ui.settings.enableAgentAnalyzer'))}</label>
          <div class="text-muted text-sm mt-8">${esc(t('ui.settings.enableAgentAnalyzerHint'))}</div>
        </div>
        <label style="display:flex;justify-content:flex-end;align-items:center">
          <input type="checkbox" ${s.analyzer.agentEnabled ? 'checked' : ''} onchange="saveSetting('enableAgentAnalyzer', this.checked)" />
        </label>
      </div>
      <div class="form-row mt-12">${num('ui.settings.analyzerAgentMaxTurns', s.analyzer.agentMaxTurns, 'ui.settings.analyzerAgentMaxTurnsHint')}</div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.context'))}</h3>
      <div class="table-scroll">
        <table class="mt-8"><tbody>
          <tr><td class="text-muted" style="width:240px">${esc(t('ui.settings.tokenBudget'))}</td><td>${esc(t('ui.settings.valueTokens', { value: s.context.tokenBudget }))}</td></tr>
          <tr><td class="text-muted">${esc(t('ui.settings.autoSummarizeThreshold'))}</td><td>${esc(t('ui.settings.valueChunks', { value: s.context.autoSummarizeThreshold }))}</td></tr>
          <tr><td class="text-muted">${esc(t('ui.settings.embeddingModel'))}</td><td class="mono">${esc(s.context.embeddingModel)}</td></tr>
          <tr><td class="text-muted">${esc(t('ui.settings.minConfidence'))}</td><td>${s.context.minConfidence}</td></tr>
        </tbody></table>
      </div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.selectorBypass'))}</h3>
      <p class="text-muted text-sm mb-12">${esc(t('ui.settings.bypassItemThresholdHint'))}</p>
      <div class="form-row">${num('ui.settings.bypassItemThreshold', s.context.bypassSelectorItemThreshold)}</div>
      <div class="form-row mt-12">${num('ui.settings.bypassTokenThreshold', s.context.bypassSelectorTokenThreshold, 'ui.settings.bypassTokenThresholdHint')}</div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.budget'))}</h3>
      <div class="form-row">${num('ui.settings.tokenBudget', s.context.tokenBudget, 'ui.settings.bypassItemThresholdHint')}</div>
      <div class="form-row mt-12">${num('ui.settings.reservedResponseTokens', s.context.reservedResponseTokens, 'ui.settings.reservedResponseTokensHint')}</div>
      <div class="form-row mt-12">${num('ui.settings.contextOverheadTokens', s.context.contextOverheadTokens, 'ui.settings.contextOverheadTokensHint')}</div>
      <div class="form-row mt-12">${num('ui.settings.defaultModelMaxTokens', s.context.defaultModelMaxTokens, 'ui.settings.defaultModelMaxTokensHint')}</div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.replayTtl'))}</h3>
      <p class="text-muted text-sm mb-12">${esc(t('ui.settings.replayTtlHint'))}</p>
      <div class="form-row">${num('ui.settings.contextReplayTtlMinutes', s.context.contextReplayTtlMinutes)}</div>
      <div class="form-row mt-12">${num('ui.settings.maxCachedContexts', s.context.maxCachedContexts, 'ui.settings.maxCachedContextsHint')}</div>
    </div>
    <div class="card">
      <h3>${esc(t('ui.settings.workers'))}</h3>
      <div class="table-scroll">
        <table class="mt-8"><tbody>
          <tr><td class="text-muted" style="width:240px">${esc(t('ui.settings.summarizeInterval'))}</td><td>${esc(t('ui.settings.everyMinutes', { value: s.workers.summarizeIntervalMinutes }))}</td></tr>
          <tr><td class="text-muted">${esc(t('ui.settings.analysisInterval'))}</td><td>${esc(t('ui.settings.everyHours', { value: s.workers.analyzeIntervalHours }))}</td></tr>
          <tr><td class="text-muted">${esc(t('ui.settings.idleThreshold'))}</td><td>${esc(t('ui.settings.valueMinutes', { value: s.workers.idleThresholdMinutes }))}</td></tr>
        </tbody></table>
      </div>
    </div>
    <div class="callout">
      ${esc(t('ui.settings.calloutIntro'))} <code>intelligent-context.yaml</code> ${esc(t('ui.settings.calloutMiddle'))}
      ${esc(t('ui.settings.calloutOutro'))}
    </div>
  `;
}

async function saveSetting(key, value) {
  try {
    // Map i18n key (used as the on-screen label) to the actual config field
    // the API expects — the user-facing string is the label, not the key.
    const keyMap = {
      'ui.settings.bypassItemThreshold': 'bypassSelectorItemThreshold',
      'ui.settings.bypassTokenThreshold': 'bypassSelectorTokenThreshold',
      'ui.settings.contextReplayTtlMinutes': 'contextReplayTtlMinutes',
      'ui.settings.reservedResponseTokens': 'reservedResponseTokens',
      'ui.settings.contextOverheadTokens': 'contextOverheadTokens',
      'ui.settings.defaultModelMaxTokens': 'defaultModelMaxTokens',
      'ui.settings.maxRecordLearnings': 'maxRecordLearnings',
      'ui.settings.tokenBudget': 'tokenBudget',
      'ui.settings.analyzerAgentMaxTurns': 'analyzerAgentMaxTurns',
    };
    const apiKey = keyMap[key] || key;
    await api('/settings', { method: 'PUT', body: JSON.stringify({ [apiKey]: value }) });
    toast(t('ui.settings.saved'));
  } catch (err) { toast(getErrorMessage(err), true); }
}

/** Pull the shared model-reference catalog now and refresh the card. */
async function syncModelReferenceNow() {
  toast(t('ui.settings.modelReferenceSyncing'));
  try {
    const result = await api('/settings/reference/sync', { method: 'POST' });
    toast(t('ui.settings.modelReferenceSynced', { count: result.count }));
    await renderSettings();
  } catch (err) {
    toast(t('ui.settings.modelReferenceSyncFailed', { message: getErrorMessage(err) }), true);
  }
}

async function saveModelSetting(key, value) {
  storeSettingsModel(key, value);
  await saveSetting(key, value);
}

async function saveRequestContextMode(value) {
  await saveSetting('requestContextMode', value);
  await renderSettings();
}
