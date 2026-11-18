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
import { verifyUser, inputParts } from './_lib/request.js';

const fail = (res, status, error) => res.status(status).json({ error });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'Use POST');
  if (!(await verifyUser(req))) return fail(res, 401, 'Reading emails with Gemini needs you to be signed in (it doesn\'t work in demo mode).');

  const input = inputParts(req.body, 'EMAIL');
  if (!input) return fail(res, 400, 'Send a screenshot or paste the email text.');
  if (input.error) return fail(res, input.status, input.error);

  try {
    const { emailSubject, ...out } = await readEmail(input.parts);
    return res.status(200).json(out);
  } catch (err) {
    return fail(res, err.status || 500, err.message);
  }
}

export { cleanResult };
