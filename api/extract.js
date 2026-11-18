// Vercel serverless function: reads a screenshot or pasted text of an email
// Trav sent, and asks Gemini to pull out who it went to, what was asked for,
// and when it was sent. The Gemini key never leaves the server.
//
// Env vars:
//   GEMINI_API_KEY     (required) from https://aistudio.google.com/apikey
//   GEMINI_MODEL       (optional) defaults to gemini-flash-latest
//   FIREBASE_API_KEY   (required) used to check the caller is signed in
//   ALLOWED_EMAILS     (optional) comma-separated list of Google accounts allowed to use it

import { readEmail, cleanResult } from './_lib/gemini.js';

const MAX_TEXT = 20000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

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

  let user;
  try {
    user = await verifyUser(req);
  } catch {
    user = null;
  }
  if (!user) return fail(res, 401, 'Reading emails with Gemini needs you to be signed in (it doesn\'t work in demo mode).');

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const parts = [];

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

  try {
    const { emailSubject, ...out } = await readEmail(parts);
    return res.status(200).json(out);
  } catch (err) {
    return fail(res, err.status || 500, err.message);
  }
}

export { cleanResult };
