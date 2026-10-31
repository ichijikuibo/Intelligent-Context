// ── Project chat tab ──────────────────────────────────────────────────────
// A conversational interface over the selected project's knowledge. The heavy
// lifting (ic tool access, agent loop, knowledge edits) happens server-side in
// src/chat/chatService.ts; this file only manages the transcript, the
// composer (file/image + stored-knowledge attachments), and rendering.

const CHAT_STORAGE_PREFIX = 'ic.chat.';
const CHAT_MODEL_STORAGE_PREFIX = 'ic.chat.model.';
const CHAT_MAX_TEXT_FILE_BYTES = 400 * 1024;
const CHAT_MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;
const CHAT_MAX_ATTACHMENTS = 8;
const CHAT_MAX_KNOWLEDGE = 10;

// Per-project transcripts, plus the composer state for the active project.
const chatState = {
  messages: [],       // [{ role, content, attachments?, knowledge? }]
  attachments: [],    // [{ name, mimeType, text?, data?, size }]
  knowledge: [],      // [{ type, id, label }] — stored entities to attach
  knowledgeOptions: null, // { summaries, findings, files } from /context-options
  // Picker filters: free-text search + which entity types are shown.
  knowledgeFilter: { search: '', types: { summary: true, finding: true, file: true } },
  models: [],         // [{ value, label }] — models this user may chat with
  model: '',          // selected model (scoped id) or '' for the default
  defaultModel: '',   // configured default, when the user may use it
  busy: false,
  loadedProjectId: null,
  status: null,
};

function chatStorageKey(projectId) {
  return CHAT_STORAGE_PREFIX + projectId;
}

function chatModelStorageKey(projectId) {
  return CHAT_MODEL_STORAGE_PREFIX + projectId;
}

function loadChatModel(projectId) {
  try {
    return localStorage.getItem(chatModelStorageKey(projectId)) || '';
  } catch {
    return '';
  }
}

function saveChatModel(projectId, model) {
  try {
    if (model) localStorage.setItem(chatModelStorageKey(projectId), model);
    else localStorage.removeItem(chatModelStorageKey(projectId));
  } catch {
    // Ignore storage failures — the in-memory selection still applies.
  }
}

function loadChatTranscript(projectId) {
  try {
    const raw = localStorage.getItem(chatStorageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatTranscript(projectId, messages) {
  try {
    // Persist only text turns and knowledge labels; attachments are re-sent per
    // turn and would bloat localStorage with base64 payloads.
    const compact = messages.map((message) => ({
      role: message.role,
      content: message.content,
      knowledge: (message.knowledge || []).map((ref) => ({ type: ref.type, id: ref.id, label: ref.label })),
    }));
    localStorage.setItem(chatStorageKey(projectId), JSON.stringify(compact));
  } catch {
    // Storage full or unavailable — the in-memory transcript still works.
  }
}

/** Minimal, XSS-safe markdown rendering: escape first, then format. */
function renderChatMarkdown(text) {
  const escaped = esc(String(text ?? ''));
  const blocks = escaped.split(/```/);
  return blocks
    .map((block, index) => {
      if (index % 2 === 1) {
        return `<pre class="chat-code">${block.replace(/^\n/, '')}</pre>`;
      }
      return block
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\n/g, '<br />');
    })
    .join('');
}

function chatEmptyState() {
  return `
    <div class="chat-empty">
      <div class="chat-empty-title">${esc(t('ui.chat.emptyTitle'))}</div>
      <div class="chat-empty-hint">${esc(t('ui.chat.emptyHint'))}</div>
      <div class="chat-suggestions">
        ${['ui.chat.suggestion1', 'ui.chat.suggestion2', 'ui.chat.suggestion3']
          .map((key) => `<button type="button" class="btn btn-sm btn-ghost" onclick="askChatSuggestion('${esc(t(key))}')">${esc(t(key))}</button>`)
          .join('')}
      </div>
    </div>
  `;
}

function chatKnowledgeChipHtml(ref) {
  const typeLabel = t('ui.chat.kind.' + ref.type);
  return `<span class="chat-attachment-chip chat-knowledge-chip" title="${esc(typeLabel)}">` +
    `<span class="chat-knowledge-kind">${esc(typeLabel)}</span>${esc(ref.label || ref.id)}</span>`;
}

function renderChatMessage(message) {
  const isUser = message.role === 'user';
  const attachmentChips = (message.attachments || [])
    .map((attachment) => `<span class="chat-attachment-chip">${esc(attachment.name)}</span>`)
    .join('');
  const knowledgeChips = (message.knowledge || []).map(chatKnowledgeChipHtml).join('');
  const body = isUser
    ? esc(message.content).replace(/\n/g, '<br />')
    : renderChatMarkdown(message.content);
  const toolNote = message.toolStatus
    ? `<div class="chat-tool-note">${esc(t('ui.chat.usedTools'))}</div>`
    : '';
  return `
    <div class="chat-message ${isUser ? 'chat-message-user' : 'chat-message-assistant'}">
      <div class="chat-bubble">${body || (isUser ? '' : '<span class="text-muted chat-typing">…</span>')}${toolNote}${attachmentChips || knowledgeChips ? `<div class="chat-message-attachments">${knowledgeChips}${attachmentChips}</div>` : ''}</div>
    </div>
  `;
}

function renderChatTranscript() {
  const list = document.getElementById('chatMessages');
  if (!list) return;
  if (chatState.messages.length === 0) {
    list.innerHTML = chatEmptyState();
    return;
  }
  list.innerHTML = chatState.messages.map(renderChatMessage).join('');
  scrollChatToBottom();
}

/** Repaint only the streaming assistant bubble (keeps scroll smooth). */
function updateStreamingBubble(index) {
  const list = document.getElementById('chatMessages');
  if (!list) return;
  const nodes = list.querySelectorAll('.chat-message');
  const node = nodes[index];
  if (!node) {
    renderChatTranscript();
    return;
  }
  const message = chatState.messages[index];
  const bubble = node.querySelector('.chat-bubble');
  if (!bubble) return;
  const body = renderChatMarkdown(message.content);
  const toolNote = message.toolStatus
    ? `<div class="chat-tool-note">${esc(t('ui.chat.usedTools'))}</div>`
    : '';
  bubble.innerHTML = `${body || '<span class="text-muted chat-typing">…</span>'}${toolNote}`;
  scrollChatToBottom();
}

function scrollChatToBottom() {
  const list = document.getElementById('chatMessages');
  if (list) list.scrollTop = list.scrollHeight;
}

function renderChatComposerState() {
  const chips = document.getElementById('chatAttachmentChips');
  if (chips) {
    chips.innerHTML = chatState.knowledge.map((ref, index) => `
        <span class="chat-attachment-chip chat-knowledge-chip" title="${esc(t('ui.chat.kind.' + ref.type))}">
          <span class="chat-knowledge-kind">${esc(t('ui.chat.kind.' + ref.type))}</span>${esc(ref.label || ref.id)}
          <button type="button" class="chat-attachment-remove" aria-label="${esc(t('ui.chat.removeAttachment'))}" onclick="removeChatKnowledge(${index})">&times;</button>
        </span>`).join('') +
      chatState.attachments
        .map((attachment, index) => `
        <span class="chat-attachment-chip">
          ${esc(attachment.name)}
          <button type="button" class="chat-attachment-remove" aria-label="${esc(t('ui.chat.removeAttachment'))}" onclick="removeChatAttachment(${index})">&times;</button>
        </span>`)
        .join('');
  }

  const sendBtn = document.getElementById('chatSendBtn');
  if (sendBtn) {
    sendBtn.disabled = chatState.busy;
    sendBtn.textContent = chatState.busy ? t('ui.chat.sending') : t('ui.chat.send');
  }

  const input = document.getElementById('chatInput');
  if (input) input.disabled = chatState.busy;

  const attachBtn = document.getElementById('chatAttachBtn');
  if (attachBtn) attachBtn.disabled = chatState.busy;

  const knowledgeBtn = document.getElementById('chatKnowledgeBtn');
  if (knowledgeBtn) {
    knowledgeBtn.disabled = chatState.busy;
    knowledgeBtn.textContent = chatState.knowledge.length > 0
      ? `${t('ui.chat.attachKnowledge')} (${chatState.knowledge.length})`
      : t('ui.chat.attachKnowledge');
  }
}

function renderChatStatus() {
  const el = document.getElementById('chatStatus');
  if (!el) return;
  if (!chatState.status) {
    el.innerHTML = '';
    return;
  }
  if (chatState.status.configured) {
    el.innerHTML = `<span class="text-sm text-muted">${esc(t('ui.chat.usingProject', { project: getSelectedProjectName() || t('ui.chat.noProject') }))}</span>`;
  } else {
    el.innerHTML = `<div class="callout warn">${esc(t('ui.chat.noModel'))}</div>`;
  }
}

/** Populate the model picker with the models this user may chat with. */
function renderChatModelSelect() {
  const select = document.getElementById('chatModelSelect');
  if (!select) return;

  if (chatState.models.length === 0) {
    select.innerHTML = `<option value="">${esc(t('ui.chat.noModels'))}</option>`;
    select.disabled = true;
    return;
  }

  select.disabled = chatState.busy;
  const defaultLabel = chatState.defaultModel
    ? `${t('ui.chat.modelPlaceholder')} (${chatState.defaultModel})`
    : t('ui.chat.modelPlaceholder');
  select.innerHTML =
    `<option value="">${esc(defaultLabel)}</option>` +
    chatState.models
      .map((model) => `<option value="${esc(model.value)}" ${model.value === chatState.model ? 'selected' : ''}>${esc(model.label)}</option>`)
      .join('');
  select.value = chatState.model;
}

function onChatModelChange(value) {
  chatState.model = value || '';
  if (state.selectedProject) saveChatModel(state.selectedProject, chatState.model);
}

async function renderChat() {
  const el = document.getElementById('tab-chat');
  if (!state.selectedProject) {
    el.innerHTML = `<div class="empty">${esc(t('ui.chat.selectProjectFirst'))}</div>`;
    return;
  }

  // Swap transcripts when the selected project changes.
  if (chatState.loadedProjectId !== state.selectedProject) {
    chatState.loadedProjectId = state.selectedProject;
    chatState.messages = loadChatTranscript(state.selectedProject);
    chatState.attachments = [];
    chatState.knowledge = [];
    chatState.knowledgeOptions = null;
    chatState.models = [];
    chatState.model = loadChatModel(state.selectedProject);
    chatState.defaultModel = '';
  }

  el.innerHTML = `
    <div class="chat-layout">
      <div class="chat-header">
        <h2>${esc(t('ui.chat.title'))}</h2>
        <div class="chat-header-actions">
          <span id="chatStatus"></span>
          <div class="chat-model-field">
            <label for="chatModelSelect">${esc(t('ui.chat.model'))}</label>
            <select id="chatModelSelect" class="header-inline-select" onchange="onChatModelChange(this.value)"></select>
          </div>
          <button type="button" class="btn btn-sm btn-ghost" onclick="clearChat()">${esc(t('ui.chat.clear'))}</button>
        </div>
      </div>
      <div id="chatMessages" class="chat-messages"></div>
      <div class="chat-composer">
        <div id="chatAttachmentChips" class="chat-attachment-chips"></div>
        <div class="chat-composer-row">
          <button type="button" id="chatAttachBtn" class="btn btn-ghost chat-attach-btn" title="${esc(t('ui.chat.attachTitle'))}" onclick="document.getElementById('chatFileInput').click()">&#128206;</button>
          <input type="file" id="chatFileInput" multiple style="display:none" onchange="handleChatFiles(this)" />
          <button type="button" id="chatKnowledgeBtn" class="btn btn-ghost chat-attach-btn" title="${esc(t('ui.chat.attachKnowledgeTitle'))}" onclick="openChatKnowledgeDialog()">${esc(t('ui.chat.attachKnowledge'))}</button>
          <textarea id="chatInput" class="chat-input" rows="2" placeholder="${esc(t('ui.chat.placeholder'))}" onkeydown="chatInputKeydown(event)"></textarea>
          <button type="button" id="chatSendBtn" class="btn" onclick="sendChatMessage()">${esc(t('ui.chat.send'))}</button>
        </div>
        <div class="text-sm text-muted chat-composer-hint">${esc(t('ui.chat.composerHint'))}</div>
      </div>
    </div>
  `;

  renderChatTranscript();
  renderChatComposerState();
  renderChatStatus();
  renderChatModelSelect();

  try {
    chatState.status = await api(`/projects/${state.selectedProject}/chat/status`);
  } catch {
    chatState.status = { configured: false };
  }
  renderChatStatus();

  try {
    const data = await api(`/projects/${state.selectedProject}/chat/models`);
    chatState.models = Array.isArray(data?.models) ? data.models : [];
    chatState.defaultModel = typeof data?.defaultModel === 'string' ? data.defaultModel : '';
    // Drop a stale selection the user can no longer access.
    if (chatState.model && !chatState.models.some((model) => model.value === chatState.model)) {
      chatState.model = '';
      saveChatModel(state.selectedProject, '');
    }
  } catch {
    chatState.models = [];
    chatState.defaultModel = '';
  }
  renderChatModelSelect();
}

function chatInputKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
}

function askChatSuggestion(text) {
  const input = document.getElementById('chatInput');
  if (input) {
    input.value = text;
    input.focus();
  }
}

// ── File / image attachments ──────────────────────────────────────────────

function readChatFile(file) {
  return new Promise((resolve) => {
    const isImage = typeof file.type === 'string' && file.type.startsWith('image/');
    const limit = isImage ? CHAT_MAX_IMAGE_FILE_BYTES : CHAT_MAX_TEXT_FILE_BYTES;
    if (file.size > limit) {
      toast(t('ui.chat.fileTooLarge', { name: file.name }), true);
      resolve(null);
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      if (isImage) {
        const result = String(reader.result || '');
        const commaIndex = result.indexOf(',');
        resolve({
          name: file.name,
          mimeType: file.type || 'image/png',
          data: commaIndex >= 0 ? result.slice(commaIndex + 1) : result,
          size: file.size,
        });
      } else {
        resolve({
          name: file.name,
          mimeType: file.type || 'text/plain',
          text: String(reader.result || ''),
          size: file.size,
        });
      }
    };

    if (isImage) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });
}

async function handleChatFiles(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  for (const file of files) {
    if (chatState.attachments.length >= CHAT_MAX_ATTACHMENTS) {
      toast(t('ui.chat.tooManyAttachments'), true);
      break;
    }
    const attachment = await readChatFile(file);
    if (attachment) chatState.attachments.push(attachment);
  }
  renderChatComposerState();
}

function removeChatAttachment(index) {
  chatState.attachments.splice(index, 1);
  renderChatComposerState();
}

// ── Stored-knowledge attachments ──────────────────────────────────────────

async function loadChatKnowledgeOptions() {
  if (chatState.knowledgeOptions) return chatState.knowledgeOptions;
  const options = await api(`/projects/${state.selectedProject}/chat/context-options`);
  chatState.knowledgeOptions = {
    summaries: Array.isArray(options?.summaries) ? options.summaries : [],
    findings: Array.isArray(options?.findings) ? options.findings : [],
    files: Array.isArray(options?.files) ? options.files : [],
  };
  return chatState.knowledgeOptions;
}

function isChatKnowledgeSelected(type, id) {
  return chatState.knowledge.some((ref) => ref.type === type && ref.id === id);
}

/** Case-insensitive match of the search text against an entity's fields. */
function chatKnowledgeMatchesSearch(search, fields) {
  if (!search) return true;
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(search));
}

function chatKnowledgeOptionRow(type, id, label, sublabel) {
  const selected = isChatKnowledgeSelected(type, id);
  return `
    <label class="chat-knowledge-option ${selected ? 'is-selected' : ''}">
      <input type="checkbox" ${selected ? 'checked' : ''} onchange="toggleChatKnowledge('${esc(type)}', '${esc(id)}', this)" />
      <span class="chat-knowledge-option-body">
        <span class="chat-knowledge-option-label">${esc(label)}</span>
        ${sublabel ? `<span class="chat-knowledge-option-sub">${esc(sublabel)}</span>` : ''}
      </span>
    </label>`;
}

function renderChatKnowledgeDialogBody() {
  const body = document.getElementById('chatKnowledgeBody');
  if (!body) return;
  const options = chatState.knowledgeOptions || { summaries: [], findings: [], files: [] };

  const search = chatState.knowledgeFilter.search.trim().toLowerCase();
  const types = chatState.knowledgeFilter.types;

  const summaryRows = types.summary
    ? options.summaries
        .filter((s) => chatKnowledgeMatchesSearch(search, [s.title, s.oneLineSummary, s.id]))
        .map((s) => chatKnowledgeOptionRow('summary', s.id, s.title || s.id, s.oneLineSummary))
        .join('')
    : '';
  const findingRows = types.finding
    ? options.findings
        .filter((f) => chatKnowledgeMatchesSearch(search, [f.title, f.type, f.severity, f.status, f.id]))
        .map((f) => chatKnowledgeOptionRow('finding', f.id, f.title || f.id, `${f.type} · ${f.severity} · ${f.status}`))
        .join('')
    : '';
  const fileRows = types.file
    ? options.files
        .filter((f) => chatKnowledgeMatchesSearch(search, [f.fileName, f.purpose, f.id]))
        .map((f) => chatKnowledgeOptionRow('file', f.id, f.fileName, t('ui.chat.fileLinked', { chunks: f.chunkCount, summaries: f.summaryCount })))
        .join('')
    : '';

  // Distinguish "nothing stored yet" from "nothing matches the filters".
  const totalAvailable = options.summaries.length + options.findings.length + options.files.length;
  if (totalAvailable === 0) {
    body.innerHTML = `<div class="text-muted text-sm" style="padding:12px">${esc(t('ui.chat.knowledgeNone'))}</div>`;
    return;
  }
  if (!summaryRows && !findingRows && !fileRows) {
    body.innerHTML = `<div class="text-muted text-sm" style="padding:12px">${esc(t('ui.chat.knowledgeNoMatches'))}</div>`;
    return;
  }

  const section = (titleKey, rows, emptyKey) => `
    <div class="chat-knowledge-section">
      <h4>${esc(t(titleKey))}</h4>
      <div class="chat-knowledge-list">${rows || `<div class="text-muted text-sm">${esc(t(emptyKey))}</div>`}</div>
    </div>`;

  body.innerHTML =
    section('ui.chat.knowledgeSummaries', summaryRows, 'ui.chat.knowledgeNoSummaries') +
    section('ui.chat.knowledgeFindings', findingRows, 'ui.chat.knowledgeNoFindings') +
    section('ui.chat.knowledgeFiles', fileRows, 'ui.chat.knowledgeNoFiles');
}

function onChatKnowledgeSearch(value) {
  chatState.knowledgeFilter.search = value || '';
  renderChatKnowledgeDialogBody();
}

function onChatKnowledgeTypeToggle(type, checked) {
  if (type in chatState.knowledgeFilter.types) {
    chatState.knowledgeFilter.types[type] = checked !== false;
  }
  renderChatKnowledgeDialogBody();
}

async function openChatKnowledgeDialog() {
  if (!state.selectedProject) return;
  const backdrop = document.getElementById('chatKnowledgeBackdrop');
  if (!backdrop) return;
  backdrop.style.display = 'block';

  // Localize + reflect the current filter state on the static inputs.
  const search = document.getElementById('chatKnowledgeSearch');
  if (search) {
    search.placeholder = t('ui.chat.knowledgeSearchPlaceholder');
    search.value = chatState.knowledgeFilter.search;
  }
  for (const type of ['summary', 'finding', 'file']) {
    const label = backdrop.querySelector(`[data-kind-label="${type}"]`);
    if (label) label.textContent = t('ui.chat.kind.' + type);
    const checkbox = document.getElementById(`chatKnowledgeType-${type}`);
    if (checkbox) checkbox.checked = chatState.knowledgeFilter.types[type] !== false;
  }

  const body = document.getElementById('chatKnowledgeBody');
  if (body) body.innerHTML = `<div class="text-muted text-sm" style="padding:12px">${esc(t('ui.chat.loading'))}</div>`;
  try {
    await loadChatKnowledgeOptions();
    renderChatKnowledgeDialogBody();
  } catch (err) {
    if (body) body.innerHTML = `<div class="callout warn">${esc(getErrorMessage(err))}</div>`;
  }
}

function closeChatKnowledgeDialog() {
  const backdrop = document.getElementById('chatKnowledgeBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

function toggleChatKnowledge(type, id, checkbox) {
  if (checkbox?.checked) {
    if (chatState.knowledge.length >= CHAT_MAX_KNOWLEDGE) {
      toast(t('ui.chat.tooManyKnowledge'), true);
      if (checkbox) checkbox.checked = false;
      return;
    }
    const options = chatState.knowledgeOptions || {};
    let label = id;
    if (type === 'summary') label = (options.summaries || []).find((s) => s.id === id)?.title || id;
    else if (type === 'finding') label = (options.findings || []).find((f) => f.id === id)?.title || id;
    else if (type === 'file') label = (options.files || []).find((f) => f.id === id)?.fileName || id;
    chatState.knowledge.push({ type, id, label });
  } else {
    chatState.knowledge = chatState.knowledge.filter((ref) => !(ref.type === type && ref.id === id));
  }
  renderChatComposerState();
  renderChatKnowledgeDialogBody();
}

function removeChatKnowledge(index) {
  chatState.knowledge.splice(index, 1);
  renderChatComposerState();
  const backdrop = document.getElementById('chatKnowledgeBackdrop');
  if (backdrop && backdrop.style.display === 'block') renderChatKnowledgeDialogBody();
}

// ── Sending ───────────────────────────────────────────────────────────────

function setChatBusy(busy) {
  chatState.busy = busy;
  renderChatComposerState();
}

function buildChatPayload(messages) {
  const payload = {
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      attachments: (message.attachments || []).map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        text: attachment.text,
        data: attachment.data,
      })),
      knowledge: (message.knowledge || []).map((ref) => ({ type: ref.type, id: ref.id })),
    })),
  };
  if (chatState.model) payload.model = chatState.model;
  return payload;
}

/** Stream a turn via SSE, invoking onEvent for each parsed event. */
async function streamChatTurn(payload, onEvent) {
  const res = await fetch(API + `/api/projects/${state.selectedProject}/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-IC-Locale': state.locale || DEFAULT_LOCALE,
    },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errPayload = await res.json().catch(() => ({}));
    const message = typeof errPayload?.error === 'string' ? errPayload.error : res.statusText;
    if (res.status === 401) {
      state.currentUser = null;
      setShellAuthenticated(false);
      renderAuthScreen(false, 'Your session expired. Please sign in again.');
    }
    throw new Error(message || 'The chat request failed.');
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('Streaming is not supported by this browser.');

  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data: ')) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;
      try {
        onEvent(JSON.parse(jsonStr));
      } catch {
        // Ignore malformed event lines.
      }
    }
  }
}

async function sendChatMessage() {
  if (chatState.busy || !state.selectedProject) return;

  const input = document.getElementById('chatInput');
  const text = (input?.value || '').trim();
  if (!text && chatState.attachments.length === 0 && chatState.knowledge.length === 0) return;

  const attachments = chatState.attachments.slice();
  const knowledge = chatState.knowledge.slice();
  chatState.messages.push({ role: 'user', content: text, attachments, knowledge });
  chatState.attachments = [];
  chatState.knowledge = [];
  if (input) input.value = '';

  renderChatTranscript();
  renderChatComposerState();
  setChatBusy(true);

  // Placeholder assistant bubble while the turn streams in.
  const assistantIndex = chatState.messages.length;
  chatState.messages.push({ role: 'assistant', content: '' });
  renderChatTranscript();

  const assistant = chatState.messages[assistantIndex];
  const payload = buildChatPayload(chatState.messages.slice(0, assistantIndex));

  try {
    await streamChatTurn(payload, (event) => {
      if (event.type === 'delta') {
        assistant.content += event.content || '';
        updateStreamingBubble(assistantIndex);
      } else if (event.type === 'status' && event.status === 'tool') {
        assistant.toolStatus = true;
        updateStreamingBubble(assistantIndex);
      } else if (event.type === 'error') {
        assistant.content = `**${t('ui.chat.errorTitle')}**\n${event.error}`;
        updateStreamingBubble(assistantIndex);
      }
    });

    if (!assistant.content) {
      assistant.content = t('ui.chat.emptyResponse');
    }
  } catch (err) {
    assistant.content = `**${t('ui.chat.errorTitle')}**\n${getErrorMessage(err)}`;
  } finally {
    setChatBusy(false);
    renderChatTranscript();
    saveChatTranscript(state.selectedProject, chatState.messages);
  }
}

function clearChat() {
  if (!state.selectedProject) return;
  if (chatState.messages.length > 0 && !confirm(t('ui.chat.confirmClear'))) return;
  chatState.messages = [];
  chatState.attachments = [];
  chatState.knowledge = [];
  saveChatTranscript(state.selectedProject, []);
  renderChatTranscript();
  renderChatComposerState();
}
