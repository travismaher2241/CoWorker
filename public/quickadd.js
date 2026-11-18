// "Quick add": turn a screenshot or pasted text of a sent email into a filled-in form,
// using Gemini through our /api/extract function.
const MAX_SIDE = 2000;

// Shrink big screenshots so uploads are quick and stay under Vercel's size limit.
export async function toDataUrl(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    // Browser can't decode it (e.g. some HEIC files): send as-is.
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
}

export function setupQuickAdd({ form, getToken, toast }) {
  const $ = (id) => document.getElementById(id);
  const drop = $('dropZone');
  const status = $('quickStatus');
  const fileInput = $('imageInput');
  let busy = false;

  const setStatus = (msg, kind = '') => {
    status.textContent = msg;
    status.className = 'quick-status ' + kind;
  };

  function fill(data) {
    const fields = { person: data.person, subject: data.subject, needBy: data.needBy, details: data.details };
    if (data.sentAt) fields.sentAt = data.sentAt;
    for (const [name, value] of Object.entries(fields)) {
      if (!value) continue;
      form[name].value = value;
      form[name].classList.add('ai-filled');
    }
    const missing = ['person', 'subject'].filter((n) => !form[n].value);
    if (!data.sentAt) {
      setStatus('Filled in. I couldn\'t see when it was sent, so the time is set to now. Check it, then press Start tracking.', 'ok');
    } else {
      setStatus(missing.length
        ? 'Filled in what I could. Add the missing details, then press Start tracking.'
        : 'Filled in. Check the highlighted details, then press Start tracking.', 'ok');
    }
    (form[missing[0]] || form.querySelector('button[type=submit]')).focus();
  }

  async function extract(payload) {
    if (busy) return;
    busy = true;
    drop.classList.add('busy');
    setStatus('Reading the email with Gemini…');
    try {
      const token = await getToken();
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
      if (!data.isEmail && !data.person && !data.subject) {
        setStatus('That doesn\'t look like an email. Try a screenshot that shows the To line and the message.', 'error');
        return;
      }
      fill(data);
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      busy = false;
      drop.classList.remove('busy');
    }
  }

  async function handleImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const url = await toDataUrl(file);
    showPreview(url);
    extract({ image: url });
  }

  function showPreview(url) {
    let img = drop.querySelector('.preview');
    if (!img) {
      img = document.createElement('img');
      img.className = 'preview';
      img.alt = 'The screenshot being read';
      drop.append(img);
    }
    img.src = url;
  }

  drop.addEventListener('click', (e) => { if (!e.target.closest('button')) fileInput.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  $('pickImageBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { handleImage(fileInput.files[0]); fileInput.value = ''; });

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    handleImage([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')));
  });

  // Paste a screenshot anywhere on the Waiting on tab.
  document.addEventListener('paste', (e) => {
    if (document.getElementById('tab-waiting').hidden) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    document.getElementById('addRequestCard').open = true;
    handleImage(item.getAsFile());
  });

  $('readTextBtn').addEventListener('click', () => {
    const text = $('emailText').value.trim();
    if (!text) return toast('Paste the email text first.', true);
    extract({ text });
  });

  // Typing in a field clears its "filled by Gemini" highlight.
  form.addEventListener('input', (e) => e.target.classList.remove('ai-filled'));

  return {
    reset() {
      form.querySelectorAll('.ai-filled').forEach((el) => el.classList.remove('ai-filled'));
      drop.querySelector('.preview')?.remove();
      $('emailText').value = '';
      setStatus('');
    },
  };
}
