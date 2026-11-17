// Vercel serverless function: reads a screenshot or pasted text of an email
// Trav sent, and asks Gemini to pull out who it went to, what was asked for,
// and when it was sent. The Gemini key never leaves the server.
//
// Env vars:
//   GEMINI_API_KEY     (required) from https://aistudio.google.com/apikey
//   GEMINI_MODEL       (optional) defaults to gemini-flash-latest
//   FIREBASE_API_KEY   (required) used to check the caller is signed in
//   ALLOWED_EMAILS     (optional) comma-separated list of Google accounts allowed to use it

const MAX_TEXT = 20000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    isEmail: { type: 'BOOLEAN', description: 'false if this does not look like an email at all' },
    person: { type: 'STRING', description: 'Who the email was sent to: name(s) as written, e.g. "Sam Lee" or "Sam Lee, Priya Shah". Prefer display names over addresses.' },
    subject: { type: 'STRING', description: 'What the sender is waiting for, as a short task-style phrase (max ~12 words), e.g. "Q3 budget numbers for the board pack".' },
    sentAt: { type: 'STRING', nullable: true, description: 'When it was sent, as Sydney local time "YYYY-MM-DDTHH:MM". null if not visible.' },
    needBy: { type: 'STRING', nullable: true, description: 'A deadline the email asks for, as "YYYY-MM-DD". null if none is mentioned.' },
    emailSubject: { type: 'STRING', nullable: true, description: 'The email subject line, if visible.' },
    summary: { type: 'STRING', description: 'One or two sentences on what was asked, for the notes field.' },
  },
  required: ['isEmail', 'person', 'subject', 'sentAt', 'needBy', 'emailSubject', 'summary'],
};

function sydneyNow() {
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return fmt.format(new Date());
}

function prompt() {
  return `You are helping someone track emails they SENT to coworkers and are waiting on a reply for.
The input is a screenshot or the text of one email they sent (it may be in Outlook's Sent Items, a reading pane, or a phone mail app).
It is now ${sydneyNow()} in Sydney, Australia. Use that to resolve relative dates such as "Yesterday 3:15 PM", "Mon 9:02 AM" or a time with no date (meaning today).
Times shown in the email are already Sydney local time. Australian dates are day/month/year.
Extract:
- person: the recipient(s) in To (not the sender, ignore Cc unless there is no To).
- subject: what the sender is asking the recipient for, phrased as a short thing they're waiting on.
- sentAt: the sent date and time.
- needBy: only if the email gives a deadline ("by Friday", "before 20 Nov").
If something isn't visible, use null (or an empty string for text fields). Never invent names.`;
}

async function verifyUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(process.env.FIREBASE_API_KEY || '')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) },
  );
  if (!res.ok) return null;
  const user = (await res.json()).users?.[0];
  if (!user) return null;
  const allowed = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes((user.email || '').toLowerCase())) return null;
  return user;
}

const fail = (res, status, error) => res.status(status).json({ error });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'Use POST');
  if (!process.env.GEMINI_API_KEY) return fail(res, 503, 'Gemini isn\'t set up yet: add GEMINI_API_KEY in Vercel.');

  let user;
  try {
    user = await verifyUser(req);
  } catch {
    user = null;
  }
  if (!user) return fail(res, 401, 'Reading emails with Gemini needs you to be signed in (it doesn\'t work in demo mode).');

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const parts = [{ text: prompt() }];

  if (body.image) {
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(body.image);
    if (!m || !IMAGE_TYPES.includes(m[1])) return fail(res, 400, 'That doesn\'t look like a picture I can read.');
    if (m[2].length * 0.75 > MAX_IMAGE_BYTES) return fail(res, 413, 'That picture is too big.');
    parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
  } else if (typeof body.text === 'string' && body.text.trim()) {
    parts.push({ text: `EMAIL:\n${body.text.slice(0, MAX_TEXT)}` });
  } else {
    return fail(res, 400, 'Send a screenshot or paste the email text.');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  let gem;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA },
      }),
    });
    gem = await r.json();
    if (!r.ok) {
      console.error('Gemini error', r.status, JSON.stringify(gem).slice(0, 500));
      return fail(res, 502, `Gemini couldn't read it (${gem.error?.status || r.status}).`);
    }
  } catch (err) {
    console.error(err);
    return fail(res, 502, 'Couldn\'t reach Gemini. Try again in a moment.');
  }

  const text = gem.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    return fail(res, 502, 'Gemini gave an answer I couldn\'t understand. Try again.');
  }
  return res.status(200).json(cleanResult(out));
}

export function cleanResult(out) {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const sentAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(out.sentAt || '') ? out.sentAt : null;
  const needBy = /^\d{4}-\d{2}-\d{2}$/.test(out.needBy || '') ? out.needBy : null;
  const notes = [out.emailSubject && `Email subject: ${str(out.emailSubject, 300)}`, str(out.summary, 1000)]
    .filter(Boolean).join('\n');
  return {
    isEmail: out.isEmail !== false,
    person: str(out.person, 200),
    subject: str(out.subject, 500),
    sentAt,
    needBy,
    details: notes,
  };
}
