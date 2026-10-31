// ── Notifications & task runs tab ─────────────────────────────────────────

let notificationPollTimer = null;

async function pollUnreadNotifications() {
  if (!state.currentUser || state.currentUser.role !== 'admin') return;
  try {
    const data = await api('/task-runs/unread-count');
    const badge = document.getElementById('notificationBadge');
    const count = data.count || 0;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  } catch { /* ignore */ }
  notificationPollTimer = setTimeout(pollUnreadNotifications, 60_000);
}

async function openNotificationDialog() {
  const backdrop = document.getElementById('notificationDialogBackdrop');
  const body = document.getElementById('notificationDialogBody');
  try {
    const runs = await api('/task-runs');
    const unread = runs.filter((r) => r.willNotifyUser && !r.read);
    body.innerHTML = unread.length === 0
      ? '<div class="text-muted" style="padding:16px;text-align:center">No unread notifications.</div>'
      : unread.map((r) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div class="flex" style="justify-content:space-between;margin-bottom:4px">
            <strong>${esc(r.taskType)}</strong>
            <span class="text-sm text-muted">${fmtDate(r.completedAt)}</span>
          </div>
          <div style="font-size:13px;color:var(--muted);margin-bottom:4px">${esc(r.summary)}</div>
          ${r.errorMessage ? `<div class="callout warn" style="font-size:12px;padding:6px 10px">${esc(r.errorMessage)}</div>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="markNotificationRead('${esc(r.id)}')">Mark read</button>
        </div>
      `).join('');
  } catch (err) {
    body.innerHTML = `<div class="callout warn">Failed to load notifications: ${esc(String(err?.message || err))}</div>`;
  }
  backdrop.style.display = 'block';
}

function closeNotificationDialog() {
  document.getElementById('notificationDialogBackdrop').style.display = 'none';
}

async function markNotificationRead(id) {
  await api(`/task-runs/${id}/mark-read`, { method: 'POST' });
  pollUnreadNotifications();
  openNotificationDialog();
}

async function markAllNotificationsRead() {
  await api('/task-runs/mark-all-read', { method: 'POST' });
  pollUnreadNotifications();
  openNotificationDialog();
}

async function renderTaskRuns() {
  const el = document.getElementById('tab-task-runs');
  try {
    const runs = await api('/task-runs?limit=100');
    const rows = runs.map((r) => `
      <tr>
        <td>${esc(r.taskType)}</td>
        <td><span class="badge ${r.status === 'error' ? 'badge-red' : r.status === 'skipped' ? 'badge-gray' : 'badge-green'}">${esc(r.status)}</span></td>
        <td>${esc(r.summary)}</td>
        <td>${esc(r.model)}</td>
        <td>${esc(r.providerName)}</td>
        <td style="font-size:11px">${fmtDate(r.completedAt)}</td>
      </tr>
    `).join('');
    el.innerHTML = `
      <h2>Background Task Runs</h2>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Task</th><th>Status</th><th>Summary</th><th>Model</th><th>Provider</th><th>Completed</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">No task runs recorded yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div class="callout warn">${esc(String(err?.message || err))}</div>`;
  }
}
