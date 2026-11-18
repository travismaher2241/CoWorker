// "Turn notes into to-dos": paste notes or a screenshot, Gemini suggests to-dos,
// you untick any you don't want and add the rest. Uses /api/todos.
import { toDataUrl } from './quickadd.js';
import { showDate } from './time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function setupNotes({ getToken, addTodos, toast }) {
  const $ = (id) => document.getElementById(id);
  const card = $('notesCard');
  const drop = $('notesDrop');
  const status = $('notesStatus');
  const results = $('notesResults');
  const fileInput = $('notesImage');
  let busy = false;
  let found = [];

  const setStatus = (msg, kind = '') => {
    status.textContent = msg;
    status.className = 'quick-status ' + kind;
  };

  function show() {
    if (!found.length) { results.innerHTML = ''; return; }
    results.innerHTML = `
      <ul class="suggestions">
        ${found.map((t, i) => `
          <li>
            <label>
              <input type="checkbox" data-i="${i}" checked>
              <span class="s-text">${t.priority === 'high' ? '<span class="flag" title="High priority">!</span>' : ''}${esc(t.text)}
                ${t.notes ? `<small>${esc(t.notes)}</small>` : ''}</span>
              ${t.due ? `<span class="due">${esc(showDate(t.due))}</span>` : ''}
            </label>
          </li>`).join('')}
      </ul>
      <div class="actions">
        <button type="button" class="primary" id="notesAddBtn">Add ticked to-dos</button>
        <button type="button" class="link" id="notesClearBtn">Clear</button>
      </div>`;
  }

  async function read(payload) {
    if (busy) return;
    busy = true;
    drop.classList.add('busy');
    found = [];
    show();
    setStatus('Reading it with Gemini…');
    try {
      const token = await getToken();
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
      found = data.todos || [];
      setStatus(found.length
        ? `Found ${found.length} to-do${found.length > 1 ? 's' : ''}. Untick any you don't want, then add them.`
        : 'I couldn\'t find anything for you to do in that.', found.length ? 'ok' : 'error');
      show();
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      busy = false;
      drop.classList.remove('busy');
    }
  }

  async function handleImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    card.open = true;
    read({ image: await toDataUrl(file) });
  }

  function reset() {
    found = [];
    show();
    setStatus('');
    $('notesText').value = '';
  }

  drop.addEventListener('click', (e) => { if (!e.target.closest('button')) fileInput.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  $('notesPickBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { handleImage(fileInput.files[0]); fileInput.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleImage([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')));
  });

  // Paste a picture anywhere on the To-do tab (pasted text goes wherever you're typing as usual).
  document.addEventListener('paste', (e) => {
    if (document.getElementById('tab-todos').hidden) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    handleImage(item.getAsFile());
  });

  $('notesReadBtn').addEventListener('click', () => {
    const text = $('notesText').value.trim();
    if (!text) return toast('Paste some notes first.', true);
    read({ text });
  });

  results.addEventListener('click', (e) => {
    if (e.target.id === 'notesClearBtn') return reset();
    if (e.target.id !== 'notesAddBtn') return;
    const picked = [...results.querySelectorAll('input[data-i]:checked')].map((b) => found[Number(b.dataset.i)]);
    if (!picked.length) return toast('Tick at least one to-do.', true);
    addTodos(picked);
    toast(`Added ${picked.length} to-do${picked.length > 1 ? 's' : ''}`);
    reset();
    card.open = false;
  });
}
