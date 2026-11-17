import {
  isoToSydneyLocal, sydneyLocalToIso, todaySydney, addDays,
  showDateTime, showDate, showClock, duration, relativeDay,
} from './time.js';
import { lastContact, requestStatus, nudgeText, PRIORITIES } from './logic.js';
import { firebaseStore, localStore, DEFAULT_SETTINGS } from './store.js';

let store;
const state = {
  requests: [],
  todos: [],
  settings: { ...DEFAULT_SETTINGS },
  filter: 'open',
  search: '',
  todoSearch: '',
  expanded: new Set(),
  openForm: null, // { id, kind: 'followup' | 'resolve' | 'edit' | 'todo-edit' }
};

// ---------------- helpers ----------------

const $ = (sel, root = document) => root.querySelector(sel);
const nowIso = () => new Date().toISOString();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2800);
}

// Firestore shows changes instantly and syncs in the background, so we don't block the UI on writes.
function save(promise) {
  Promise.resolve(promise).catch((err) => {
    console.error(err);
    toast(`Couldn't save: ${err.message}`, true);
  });
}

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const status = (r) => requestStatus(r, state.settings.nudgeAfterDays);

// ---------------- waiting on ----------------

const LEVEL_RANK = { overdue: 0, nudge: 1, waiting: 2, resolved: 3 };

function sortedRequests() {
  const q = state.search.toLowerCase();
  return state.requests
    .filter((r) => state.filter === 'all' || r.status === state.filter)
    .filter((r) => !q || `${r.person} ${r.subject} ${r.details}`.toLowerCase().includes(q))
    .map((r) => ({ r, s: status(r) }))
    .sort((a, b) => {
      if (a.r.status === 'resolved' && b.r.status === 'resolved') {
        return (b.r.resolvedAt || '').localeCompare(a.r.resolvedAt || '');
      }
      return LEVEL_RANK[a.s.level] - LEVEL_RANK[b.s.level] || a.r.sentAt.localeCompare(b.r.sentAt);
    });
}

function renderSummary() {
  const open = state.requests.filter((r) => r.status === 'open');
  const counts = { overdue: 0, nudge: 0, waiting: 0 };
  for (const r of open) counts[status(r).level]++;
  const oldest = open.map((r) => r.sentAt).sort()[0];
  const resolved = state.requests.filter((r) => r.status === 'resolved' && r.resolvedAt);
  const avg = resolved.length
    ? resolved.reduce((sum, r) => sum + (Date.parse(r.resolvedAt) - Date.parse(r.sentAt)), 0) / resolved.length
    : null;

  $('#waitingSummary').innerHTML = `
    <div class="stat ${counts.overdue ? 'bad' : ''}"><b>${counts.overdue}</b><span>overdue</span></div>
    <div class="stat ${counts.nudge ? 'warn' : ''}"><b>${counts.nudge}</b><span>need a nudge</span></div>
    <div class="stat"><b>${open.length}</b><span>open in total</span></div>
    <div class="stat"><b>${oldest ? duration(Date.now() - Date.parse(oldest)) : '–'}</b><span>longest wait</span></div>
    <div class="stat"><b>${avg === null ? '–' : duration(avg)}</b><span>average time to answer</span></div>`;

  $('#waitingCount').textContent = open.length || '';
  $('#waitingCount').className = 'pill' + (counts.overdue + counts.nudge ? ' hot' : '');
}

function renderPeople() {
  const people = [...new Set(state.requests.map((r) => r.person))].sort((a, b) => a.localeCompare(b));
  $('#peopleList').innerHTML = people.map((p) => `<option value="${esc(p)}">`).join('');
}

function requestCard({ r, s }) {
  const waitedMs = (r.status === 'resolved' ? Date.parse(r.resolvedAt) : Date.now()) - Date.parse(r.sentAt);
  const expanded = state.expanded.has(r.id);
  const form = state.openForm?.id === r.id ? state.openForm.kind : null;
  const nudges = r.followUps.length;
  const nowLocal = isoToSydneyLocal(nowIso());

  const timeline = [
    { at: r.sentAt, label: 'Original email sent', note: r.details },
    ...r.followUps.map((f, i) => ({ at: f.at, label: `Follow-up ${i + 1} (${f.method})`, note: f.note, fid: f.id })),
    ...(r.status === 'resolved' ? [{ at: r.resolvedAt, label: 'Resolved', note: r.resolution }] : []),
  ];

  return `
  <article class="card req lvl-${s.level}" data-id="${r.id}">
    <div class="req-main">
      <div class="req-head">
        <span class="person">${esc(r.person)}</span>
        <span class="badge b-${s.level}">${esc(s.reason)}</span>
      </div>
      <div class="subject">${esc(r.subject)}</div>
      <div class="meta">
        Sent ${esc(showDateTime(r.sentAt))}
        ${nudges ? ` · ${nudges} follow-up${nudges > 1 ? 's' : ''}, last ${esc(showDateTime(lastContact(r)))}` : ' · no follow-ups yet'}
        ${r.needBy && r.status === 'open' ? ` · need by ${esc(showDate(r.needBy))}` : ''}
      </div>
    </div>
    <div class="req-wait">
      <b>${duration(waitedMs)}</b>
      <span>${r.status === 'resolved' ? 'to get an answer' : 'waiting'}</span>
    </div>
    <div class="req-actions">
      ${r.status === 'open' ? `
        <button data-act="followup" class="${s.level !== 'waiting' ? 'primary' : ''}">Log follow-up</button>
        <button data-act="copy">Copy nudge text</button>
        <button data-act="resolve">Got it ✓</button>` : `
        <button data-act="reopen">Reopen</button>`}
      <button data-act="toggle" class="link">${expanded ? 'Hide history' : 'History'}</button>
      <button data-act="edit" class="link">Edit</button>
      <button data-act="delete" class="link danger">Delete</button>
    </div>
    ${form === 'followup' ? `
      <form class="inline-form" data-form="followup">
        <label>When <input name="at" type="datetime-local" value="${nowLocal}" required></label>
        <label>How
          <select name="method"><option>email</option><option>teams</option><option>call</option><option>in person</option><option>other</option></select>
        </label>
        <label class="grow">Note <input name="note" placeholder="optional"></label>
        <button class="primary">Save</button><button type="button" data-act="cancel" class="link">Cancel</button>
      </form>` : ''}
    ${form === 'resolve' ? `
      <form class="inline-form" data-form="resolve">
        <label>Answered <input name="resolvedAt" type="datetime-local" value="${nowLocal}" required></label>
        <label class="grow">Outcome <input name="resolution" placeholder="optional, e.g. Sam sent the file"></label>
        <button class="primary">Mark resolved</button><button type="button" data-act="cancel" class="link">Cancel</button>
      </form>` : ''}
    ${form === 'edit' ? `
      <form class="inline-form" data-form="edit">
        <label>Who <input name="person" value="${esc(r.person)}" list="peopleList" required></label>
        <label class="grow">What <input name="subject" value="${esc(r.subject)}" required></label>
        <label>Sent <input name="sentAt" type="datetime-local" value="${isoToSydneyLocal(r.sentAt)}" required></label>
        <label>Need by <input name="needBy" type="date" value="${esc(r.needBy || '')}"></label>
        <label class="full">Notes <textarea name="details" rows="2">${esc(r.details)}</textarea></label>
        <button class="primary">Save</button><button type="button" data-act="cancel" class="link">Cancel</button>
      </form>` : ''}
    ${expanded ? `
      <ol class="timeline">
        ${timeline.map((t) => `
          <li>
            <span class="t-when">${esc(showDateTime(t.at))}</span>
            <span class="t-what">${esc(t.label)}${t.note ? `: <span class="muted">${esc(t.note)}</span>` : ''}</span>
            ${t.fid ? `<button class="link danger small" data-act="delfu" data-fid="${t.fid}" title="Remove this follow-up">remove</button>` : ''}
          </li>`).join('')}
      </ol>` : ''}
  </article>`;
}

function renderRequests() {
  renderSummary();
  renderPeople();
  const items = sortedRequests();
  if (!items.length) {
    const msg = state.requests.length
      ? 'Nothing matches here.'
      : 'Nothing tracked yet. When you send someone an email asking for something, log it above.';
    $('#requestList').innerHTML = `<p class="empty">${msg}</p>`;
    return;
  }
  $('#requestList').innerHTML = items.map(requestCard).join('');
}

// ---------------- to-dos ----------------

function todoRow(t) {
  const today = todaySydney();
  const overdue = !t.done && t.due && t.due < today;
  if (state.openForm?.id === t.id && state.openForm.kind === 'todo-edit') {
    return `
    <li class="todo editing" data-id="${t.id}">
      <form class="inline-form" data-form="todo-edit">
        <label class="grow">To-do <input name="text" value="${esc(t.text)}" required></label>
        <label>Due <input name="due" type="date" value="${esc(t.due || '')}"></label>
        <label>Priority
          <select name="priority">
            ${PRIORITIES.map((p) => `<option value="${p}" ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </label>
        <label class="full">Notes <textarea name="notes" rows="2">${esc(t.notes)}</textarea></label>
        <button class="primary">Save</button><button type="button" data-act="cancel" class="link">Cancel</button>
      </form>
    </li>`;
  }
  return `
  <li class="todo ${t.done ? 'done' : ''} ${overdue ? 'overdue' : ''} prio-${t.priority}" data-id="${t.id}">
    <input type="checkbox" data-act="check" ${t.done ? 'checked' : ''} aria-label="Done">
    <div class="todo-body">
      <span class="todo-text">${t.priority === 'high' ? '<span class="flag" title="High priority">!</span>' : ''}${esc(t.text)}</span>
      ${t.notes ? `<span class="todo-notes">${esc(t.notes)}</span>` : ''}
    </div>
    ${t.due ? `<span class="due ${overdue ? 'bad' : t.due === today ? 'warn' : ''}">${esc(showDate(t.due))}${t.done ? '' : ` · ${relativeDay(t.due, today)}`}</span>` : ''}
    <button data-act="todo-edit" class="link">Edit</button>
    <button data-act="todo-delete" class="link danger">Delete</button>
  </li>`;
}

const PRIO_RANK = { high: 0, normal: 1, low: 2 };

function renderTodos() {
  const q = state.todoSearch.toLowerCase();
  const today = todaySydney();
  const weekEnd = addDays(today, 7);
  const items = state.todos.filter((t) => !q || `${t.text} ${t.notes}`.toLowerCase().includes(q));
  const open = items.filter((t) => !t.done);
  const bySort = (a, b) =>
    (a.due || '9999').localeCompare(b.due || '9999') ||
    PRIO_RANK[a.priority] - PRIO_RANK[b.priority] ||
    (a.createdAt || '').localeCompare(b.createdAt || '');

  const groups = [
    ['Overdue', open.filter((t) => t.due && t.due < today), 'bad'],
    ['Today', open.filter((t) => t.due === today), 'warn'],
    ['Next 7 days', open.filter((t) => t.due && t.due > today && t.due <= weekEnd), ''],
    ['Later', open.filter((t) => t.due && t.due > weekEnd), ''],
    ['No date', open.filter((t) => !t.due), ''],
  ];
  const done = items.filter((t) => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));

  const openCount = state.todos.filter((t) => !t.done).length;
  $('#todoCount').textContent = openCount || '';
  $('#todoCount').className = 'pill' + (state.todos.some((t) => !t.done && t.due && t.due <= today) ? ' hot' : '');

  let html = '';
  for (const [title, list, cls] of groups) {
    if (!list.length) continue;
    html += `<h2 class="group ${cls}">${title} <span class="muted">${list.length}</span></h2>
      <ul class="card todos">${list.sort(bySort).map(todoRow).join('')}</ul>`;
  }
  if (!open.length) {
    html += `<p class="empty">${state.todos.length ? 'All done. Nice.' : 'No to-dos yet. Add one above.'}</p>`;
  }
  if (done.length) {
    html += `<details class="done-group"><summary>Completed (${done.length})</summary>
      <ul class="card todos">${done.slice(0, 100).map(todoRow).join('')}</ul>
      <button class="link danger" data-act="clear-done">Clear completed</button>
      </details>`;
  }
  $('#todoList').innerHTML = html;
}

// Re-render, unless you're in the middle of typing into a form on the page.
let pendingRender = false;
function render(force) {
  if (!force && document.activeElement?.closest('.inline-form')) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const doneOpen = $('.done-group')?.open;
  renderRequests();
  renderTodos();
  if (doneOpen) $('.done-group').open = true;
}

// ---------------- events: waiting on ----------------

function resetSentAt() {
  $('#requestForm').sentAt.value = isoToSydneyLocal(nowIso());
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === filter));
}

function closeForm() {
  state.openForm = null;
  render(true);
}

function bindEvents() {
  $('#requestForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const person = clean(f.person.value, 200);
    const subject = clean(f.subject.value, 500);
    if (!person || !subject) return toast('Add who you emailed and what you asked for.', true);
    save(store.addRequest({
      person, subject,
      details: clean(f.details.value, 5000),
      sentAt: f.sentAt.value ? sydneyLocalToIso(f.sentAt.value) : nowIso(),
      needBy: f.needBy.value || null,
      followUps: [], status: 'open', resolvedAt: null, resolution: '', createdAt: nowIso(),
    }));
    f.reset();
    resetSentAt();
    if (state.filter === 'resolved') setFilter('open');
    toast(`Tracking: ${person}`);
    f.person.focus();
  });

  $('#sentNowBtn').addEventListener('click', resetSentAt);

  document.querySelectorAll('[data-filter]').forEach((b) =>
    b.addEventListener('click', () => { setFilter(b.dataset.filter); renderRequests(); }));

  $('#requestSearch').addEventListener('input', (e) => { state.search = e.target.value; renderRequests(); });

  $('#nudgeAfter').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (!Number.isFinite(n) || n < 0 || n > 60) return toast('Pick between 0 and 60 days.', true);
    state.settings = { ...state.settings, nudgeAfterDays: n };
    save(store.saveSettings(state.settings));
    renderRequests();
  });

  $('#requestList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const r = state.requests.find((x) => x.id === btn.closest('[data-id]').dataset.id);
    if (!r) return;
    const act = btn.dataset.act;

    if (['followup', 'resolve', 'edit'].includes(act)) {
      state.openForm = state.openForm?.id === r.id && state.openForm.kind === act ? null : { id: r.id, kind: act };
      render(true);
      $(`[data-id="${r.id}"] .inline-form input:not([type=datetime-local])`)?.focus();
    } else if (act === 'cancel') {
      closeForm();
    } else if (act === 'toggle') {
      state.expanded.has(r.id) ? state.expanded.delete(r.id) : state.expanded.add(r.id);
      renderRequests();
    } else if (act === 'copy') {
      const text = nudgeText(r);
      navigator.clipboard.writeText(text).then(
        () => toast('Nudge text copied. Paste it into your reply in Outlook.'),
        () => window.prompt('Copy this text:', text),
      );
    } else if (act === 'reopen') {
      save(store.updateRequest(r.id, { status: 'open', resolvedAt: null }));
    } else if (act === 'delete') {
      if (confirm(`Delete "${r.subject}" for ${r.person}? This can't be undone.`)) save(store.deleteRequest(r.id));
    } else if (act === 'delfu') {
      save(store.updateRequest(r.id, { followUps: r.followUps.filter((f) => f.id !== btn.dataset.fid) }));
    }
  });

  $('#requestList').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const r = state.requests.find((x) => x.id === f.closest('[data-id]').dataset.id);
    if (!r) return;
    if (f.dataset.form === 'followup') {
      const fu = {
        id: crypto.randomUUID(),
        at: sydneyLocalToIso(f.at.value),
        method: f.method.value,
        note: clean(f.note.value, 1000),
      };
      const followUps = [...r.followUps, fu].sort((a, b) => a.at.localeCompare(b.at));
      save(store.updateRequest(r.id, { followUps }));
      toast('Follow-up logged');
    } else if (f.dataset.form === 'resolve') {
      save(store.updateRequest(r.id, {
        status: 'resolved', resolvedAt: sydneyLocalToIso(f.resolvedAt.value), resolution: clean(f.resolution.value, 1000),
      }));
      toast('Resolved. One less thing to chase.');
    } else if (f.dataset.form === 'edit') {
      const person = clean(f.person.value, 200);
      const subject = clean(f.subject.value, 500);
      if (!person || !subject) return toast('Who and what can\'t be empty.', true);
      save(store.updateRequest(r.id, {
        person, subject, details: clean(f.details.value, 5000),
        sentAt: sydneyLocalToIso(f.sentAt.value), needBy: f.needBy.value || null,
      }));
    }
    closeForm();
  });

  // ---------------- events: to-dos ----------------

  $('#todoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const text = clean(f.text.value, 500);
    if (!text) return;
    save(store.addTodo({
      text, notes: '', due: f.due.value || null,
      priority: PRIORITIES.includes(f.priority.value) ? f.priority.value : 'normal',
      done: false, doneAt: null, createdAt: nowIso(),
    }));
    f.text.value = '';
    f.text.focus();
  });

  $('#todoSearch').addEventListener('input', (e) => { state.todoSearch = e.target.value; renderTodos(); });

  $('#todoList').addEventListener('change', (e) => {
    if (e.target.dataset.act !== 'check') return;
    const id = e.target.closest('[data-id]').dataset.id;
    const done = e.target.checked;
    save(store.updateTodo(id, { done, doneAt: done ? nowIso() : null }));
  });

  $('#todoList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'clear-done') {
      const ids = state.todos.filter((t) => t.done).map((t) => t.id);
      if (confirm(`Remove ${ids.length} completed to-do${ids.length > 1 ? 's' : ''}?`)) save(store.deleteTodos(ids));
      return;
    }
    const id = btn.closest('[data-id]').dataset.id;
    if (act === 'todo-edit') {
      state.openForm = { id, kind: 'todo-edit' };
      render(true);
      $(`[data-id="${id}"] input[name=text]`)?.focus();
    } else if (act === 'cancel') {
      closeForm();
    } else if (act === 'todo-delete') {
      save(store.deleteTodo(id));
    }
  });

  $('#todoList').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const id = f.closest('[data-id]').dataset.id;
    const text = clean(f.text.value, 500);
    if (!text) return toast('A to-do needs some text.', true);
    save(store.updateTodo(id, {
      text, due: f.due.value || null,
      priority: PRIORITIES.includes(f.priority.value) ? f.priority.value : 'normal',
      notes: clean(f.notes.value, 5000),
    }));
    closeForm();
  });

  // ---------------- tabs, account, backup ----------------

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('#signInBtn').addEventListener('click', () =>
    store.signIn().catch((err) => toast(`Sign-in failed: ${err.message}`, true)));
  $('#signOutBtn').addEventListener('click', () => store.signOut());
  $('#exportBtn').addEventListener('click', exportBackup);
  document.addEventListener('focusout', () => setTimeout(() => {
    if (pendingRender && !document.activeElement?.closest('.inline-form')) render();
  }));
}

function exportBackup() {
  const blob = new Blob([JSON.stringify({
    exportedAt: nowIso(), requests: state.requests, todos: state.todos, settings: state.settings,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `coworker-backup-${todaySydney()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  try { localStorage.setItem('tab', name); } catch {}
}

function showScreen(name) {
  for (const id of ['loading', 'setup', 'signin', 'app']) $(`#screen-${id}`).hidden = id !== name;
}

// ---------------- boot ----------------

async function loadConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (!res.ok) return null;
    const cfg = await res.json();
    return cfg.apiKey && cfg.projectId ? cfg : null;
  } catch {
    return null;
  }
}

async function boot() {
  bindEvents();
  let tab = null;
  try { tab = localStorage.getItem('tab'); } catch {}
  showTab(tab === 'todos' ? 'todos' : 'waiting');
  $('#clock').textContent = showClock();

  const demo = new URLSearchParams(location.search).has('demo');
  if (demo) {
    store = localStore();
  } else {
    const config = await loadConfig();
    if (!config) return showScreen('setup');
    try {
      store = await firebaseStore(config);
    } catch (err) {
      console.error(err);
      $('#setupError').textContent = `Couldn't load Firebase: ${err.message}`;
      return showScreen('setup');
    }
  }
  $('#demoBanner').hidden = !demo;

  let unsubscribe = () => {};
  let firstLoad = true;
  store.onUser((user) => {
    unsubscribe();
    if (!user) return showScreen('signin');
    $('#who').textContent = user.email || user.name || '';
    showScreen('app');
    resetSentAt();
    unsubscribe = store.subscribe(
      (data) => {
        Object.assign(state, data);
        $('#nudgeAfter').value = state.settings.nudgeAfterDays;
        if (firstLoad && state.requests.length) $('#addRequestCard').open = false;
        firstLoad = false;
        render();
      },
      (err) => toast(`Couldn't load your data: ${err.message}`, true),
    );
  });

  // Keep the "waiting" clocks ticking.
  setInterval(() => {
    $('#clock').textContent = showClock();
    if (!state.openForm) render();
  }, 60000);
}

boot();
