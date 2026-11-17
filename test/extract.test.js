import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { cleanResult } from '../api/extract.js';

function mockRes() {
  const res = { statusCode: 0, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

let calls;
function mockFetch({ signedIn = true, email = 'trav@example.com', gemini } = {}) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (url.includes('identitytoolkit')) {
      return { ok: signedIn, json: async () => (signedIn ? { users: [{ email }] } : { error: {} }) };
    }
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] } }] }),
    };
  };
}

const GOOD = {
  isEmail: true, person: 'Sam Lee', subject: 'Q3 budget numbers', sentAt: '2026-11-17T15:12',
  needBy: '2026-11-20', emailSubject: 'Budget numbers?', summary: 'Asked Sam for the Q3 numbers.',
};

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.FIREBASE_API_KEY = 'fb-key';
  delete process.env.ALLOWED_EMAILS;
});

test('reads pasted text and returns cleaned fields', async () => {
  mockFetch({ gemini: GOOD });
  const res = mockRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'To: Sam Lee ...' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    isEmail: true, person: 'Sam Lee', subject: 'Q3 budget numbers', sentAt: '2026-11-17T15:12',
    needBy: '2026-11-20', details: 'Email subject: Budget numbers?\nAsked Sam for the Q3 numbers.',
  });
  const gem = calls.find((c) => c.url.includes('generativelanguage'));
  assert.match(gem.body.contents[0].parts[1].text, /^EMAIL:\nTo: Sam Lee/);
});

test('sends screenshots to Gemini as inline images', async () => {
  mockFetch({ gemini: GOOD });
  const res = mockRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { image: 'data:image/jpeg;base64,AAAA' } }, res);
  assert.equal(res.statusCode, 200);
  const gem = calls.find((c) => c.url.includes('generativelanguage'));
  assert.deepEqual(gem.body.contents[0].parts[1], { inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
});

test('refuses callers who are not signed in, without calling Gemini', async () => {
  mockFetch({ signedIn: false, gemini: GOOD });
  const res = mockRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer bad' }, body: { text: 'hi' } }, res);
  assert.equal(res.statusCode, 401);
  assert.ok(!calls.some((c) => c.url.includes('generativelanguage')));
});

test('ALLOWED_EMAILS limits who can use it', async () => {
  process.env.ALLOWED_EMAILS = 'someone@else.com';
  mockFetch({ gemini: GOOD });
  const res = mockRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { text: 'hi' } }, res);
  assert.equal(res.statusCode, 401);
});

test('rejects non-image uploads', async () => {
  mockFetch({ gemini: GOOD });
  const res = mockRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok' }, body: { image: 'data:text/html;base64,AAAA' } }, res);
  assert.equal(res.statusCode, 400);
});

test('drops badly formatted dates instead of trusting them', () => {
  const out = cleanResult({ ...GOOD, sentAt: 'yesterday', needBy: '20/11/2026', emailSubject: null });
  assert.equal(out.sentAt, null);
  assert.equal(out.needBy, null);
  assert.equal(out.details, 'Asked Sam for the Q3 numbers.');
});
