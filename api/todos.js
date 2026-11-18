// Vercel serverless function: turns meeting notes, a list, or a screenshot into
// suggested to-dos with Gemini. The browser shows them for Trav to pick from.
// Same env vars as api/extract.js.

import { readTodos } from './_lib/gemini.js';
import { verifyUser, inputParts } from './_lib/request.js';

const fail = (res, status, error) => res.status(status).json({ error });

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return fail(res, 405, 'Use POST');
  if (!(await verifyUser(req))) return fail(res, 401, 'Reading notes with Gemini needs you to be signed in (it doesn\'t work in demo mode).');

  const input = inputParts(req.body, 'NOTES');
  if (!input) return fail(res, 400, 'Paste some notes or a picture first.');
  if (input.error) return fail(res, input.status, input.error);

  try {
    return res.status(200).json({ todos: await readTodos(input.parts) });
  } catch (err) {
    return fail(res, err.status || 500, err.message);
  }
}
