// Minimal server-side Firestore access over REST, using a Firebase service
// account (no extra packages needed).
//
// Env: FIREBASE_SERVICE_ACCOUNT = the service account JSON file's contents
//      (raw JSON, or base64 of it).
import crypto from 'node:crypto';

let cached = null; // { token, exp, projectId }

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const json = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(json);
  return { ...sa, private_key: sa.private_key.replace(/\\n/g, '\n') };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function accessToken() {
  if (cached && cached.exp > Date.now() + 60000) return cached;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google sign-in for the service account failed: ${data.error_description || res.status}`);
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000, projectId: sa.project_id };
  return cached;
}

// ----- value conversion -----

export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
}

export const toFields = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toValue(v)]));

export function fromValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}

export const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, fromValue(v)]));

// ----- requests -----

async function call(method, path, body) {
  const { token, projectId } = await accessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Create a document with a chosen id. Returns false if it already exists.
export async function createDoc(collectionPath, id, obj) {
  const r = await call('POST', `/${collectionPath}?documentId=${encodeURIComponent(id)}`, { fields: toFields(obj) });
  if (r.status === 409) return false;
  if (!r.ok) throw new Error(`Firestore create failed (${r.status}): ${r.data.error?.message || ''}`);
  return true;
}

export async function updateDoc(docPath, obj) {
  const mask = Object.keys(obj).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await call('PATCH', `/${docPath}?${mask}&currentDocument.exists=true`, { fields: toFields(obj) });
  if (!r.ok) throw new Error(`Firestore update failed (${r.status}): ${r.data.error?.message || ''}`);
}

// Find documents in a user's collection where every field equals the given value.
export async function findWhere(parentPath, collectionId, equals) {
  const filters = Object.entries(equals).map(([field, value]) => ({
    fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: toValue(value) },
  }));
  const r = await call('POST', `/${parentPath}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId }],
      where: filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } },
      limit: 20,
    },
  });
  if (!r.ok) throw new Error(`Firestore query failed (${r.status}): ${r.data.error?.message || ''}`);
  return (Array.isArray(r.data) ? r.data : [])
    .filter((row) => row.document)
    .map((row) => ({ path: row.document.name.split('/documents/')[1], id: row.document.name.split('/').pop(), ...fromFields(row.document.fields) }));
}

export function _resetTokenCache() {
  cached = null;
}
