// Shared bits for the browser-facing Gemini functions: sign-in check and reading the upload.

const MAX_TEXT = 20000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];

// Checks the Firebase ID token the browser sent. Returns the user, or null.
export async function verifyUser(req) {
  try {
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
  } catch {
    return null;
  }
}

// Turns { image } or { text } from the browser into Gemini content parts.
// Returns { parts } or { status, error }.
export function inputParts(rawBody, label) {
  const body = typeof rawBody === 'string' ? JSON.parse(rawBody || '{}') : rawBody || {};
  if (body.image) {
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(body.image);
    if (!m || !IMAGE_TYPES.includes(m[1])) return { status: 400, error: 'That doesn\'t look like a picture I can read.' };
    if (m[2].length * 0.75 > MAX_IMAGE_BYTES) return { status: 413, error: 'That picture is too big.' };
    return { parts: [{ inline_data: { mime_type: m[1], data: m[2] } }] };
  }
  if (typeof body.text === 'string' && body.text.trim()) {
    return { parts: [{ text: `${label}:\n${body.text.slice(0, MAX_TEXT)}` }] };
  }
  return null;
}
