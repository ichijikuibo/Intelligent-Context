// ── Generic DOM / formatting / error helpers ──────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(v) {
  // Returns yyyy-MM-dd for unambiguous date display
  if (v == null) return '-';
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === 'number') {
    const ms = v < 4102444800 ? v * 1000 : v;
    d = new Date(ms);
  } else {
    d = new Date(v);
  }
  if (isNaN(d.getTime())) return '-';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function summarizeInline(content, maxLength = 160) {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength - 1) + '…';
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--red)' : 'var(--green)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function isConflictError(err) {
  return Number(err?.status) === 409;
}

function toastRequestError(err, fallbackMessage) {
  const message = getErrorMessage(err) || fallbackMessage;
  if (isConflictError(err)) {
    toast(t('ui.errors.conflict', { message }), true);
    return;
  }

  toast(message || fallbackMessage, true);
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
