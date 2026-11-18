import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import handler, { threadKey, classify, isTodoSubject, todoTitle } from '../api/inbound.js';
import { toFields, fromFields, _resetTokenCache } from '../api/_lib/firestore.js';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { project_id: 'demo-proj', client_email: 'svc@demo-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const CAPTURE = 'abc123@inbound.postmarkapp.com';

let docs, calls, gemini;
function installFetch() {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const body = typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts.body;
    calls.push({ url, method: opts.method, body });
    const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('generativelanguage')) {
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] } }] });
    }
    const path = decodeURIComponent(url.split('/documents/')[1] || '');
    if (url.includes(':runQuery')) {
      const filters = body.structuredQuery.where.compositeFilter?.filters || [body.structuredQuery.where];
      const want = Object.fromEntries(filters.map((f) => [f.fieldFilter.field.fieldPath, f.fieldFilter.value.stringValue]));
      const rows = Object.entries(docs)
        .filter(([, d]) => Object.entries(want).every(([k, v]) => d[k] === v))
        .map(([p, d]) => ({ document: { name: `projects/demo-proj/databases/(default)/documents/${p}`, fields: toFields(d) } }));
      return json(rows);
    }
    if (opts.method === 'POST') {
      const [col, qs] = path.split('?');
      const id = new URLSearchParams(qs).get('documentId');
      if (docs[`${col}/${id}`]) return json({ error: { message: 'exists' } }, 409);
      docs[`${col}/${id}`] = fromFields(body.fields);
      return json({});
    }
    if (opts.method === 'PATCH') {
      const p = path.split('?')[0];
      Object.assign(docs[p], fromFields(body.fields));
      return json({});
    }
    return json({}, 404);
  };
}

beforeEach(() => {
  Object.assign(process.env, {
    INBOUND_SECRET: 's3cret', INBOUND_SENDERS: 'trav@work.com.au', INBOUND_UID: 'u1',
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify(SA), GEMINI_API_KEY: 'g',
  });
  _resetTokenCache();
  docs = {};
  gemini = { isEmail: true, person: 'Sam Lee', subject: 'Q3 budget numbers', sentAt: null, needBy: '2026-11-20', emailSubject: 'Q3 numbers', summary: 'Asked for Q3 numbers.' };
  installFetch();
});

const auth = 'Basic ' + Buffer.from('capture:s3cret').toString('base64');
async function post(mail, headers = { authorization: auth }) {
  const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', url: '/api/inbound', headers, body: mail }, res);
  return res;
}

const bccMail = (over = {}) => ({
  FromFull: { Email: 'Trav@work.com.au', Name: 'Trav' },
  ToFull: [{ Email: 'sam.lee@work.com.au', Name: 'Sam Lee' }],
  CcFull: [], OriginalRecipient: CAPTURE,
  Subject: 'Q3 numbers', Date: 'Wed, 18 Nov 2026 11:24:15 +1100',
  MessageID: 'msg-1', TextBody: 'Hi Sam, can you send the Q3 numbers by Friday?', ...over,
});

test('thread keys ignore Re:/Fw: prefixes and case', () => {
  assert.equal(threadKey('RE: Fwd: Q3  Numbers'), 'q3 numbers');
  assert.equal(threadKey('Q3 numbers'), 'q3 numbers');
});

test('rejects a wrong secret', async () => {
  const res = await post(bccMail(), { authorization: 'Basic ' + Buffer.from('capture:nope').toString('base64') });
  assert.equal(res.statusCode, 401);
});

test('ignores mail from senders not on the list', async () => {
  const res = await post(bccMail({ FromFull: { Email: 'spam@else.com' } }));
  assert.equal(res.body.result, 'ignored');
  assert.equal(Object.keys(docs).length, 0);
});

test('a BCC creates an item using the real recipients and sent time', async () => {
  const res = await post(bccMail());
  assert.equal(res.body.result, 'created');
  const [path, item] = Object.entries(docs)[0];
  assert.match(path, /^users\/u1\/requests\//);
  assert.equal(item.person, 'Sam Lee');
  assert.equal(item.subject, 'Q3 budget numbers');
  assert.equal(item.sentAt, '2026-11-18T00:24:15.000Z');
  assert.equal(item.needBy, '2026-11-20');
  assert.equal(item.status, 'open');
  assert.equal(item.needsReview, true);
  assert.equal(item.emailKey, 'q3 numbers');
});

test('the same email arriving twice is not duplicated', async () => {
  await post(bccMail());
  const res = await post(bccMail());
  assert.equal(Object.keys(docs).length, 1);
  assert.match(res.body.result, /duplicate/);
});

test('a BCC on a reply in the same thread becomes a follow-up', async () => {
  await post(bccMail());
  const res = await post(bccMail({ Subject: 'RE: Q3 numbers', MessageID: 'msg-2', Date: 'Fri, 20 Nov 2026 09:00:00 +1100' }));
  assert.equal(res.body.result, 'follow-up');
  const item = Object.values(docs)[0];
  assert.equal(Object.keys(docs).length, 1);
  assert.equal(item.followUps.length, 1);
  assert.equal(item.followUps[0].at, '2026-11-19T22:00:00.000Z');
});

test('a forwarded old email uses the original sent date from Gemini', async () => {
  gemini = { ...gemini, person: 'Priya Shah', subject: 'Sign-off on vendor contract', sentAt: '2026-11-03T14:05', emailSubject: 'Vendor contract', needBy: null };
  const res = await post(bccMail({
    ToFull: [{ Email: CAPTURE, Name: '' }], Subject: 'FW: Vendor contract', MessageID: 'msg-3',
    TextBody: '---------- Forwarded message ---------\nFrom: Trav\nSent: Tuesday, 3 November 2026 2:05 PM\nTo: Priya Shah\nSubject: Vendor contract\n\nHi Priya, can you sign off?',
  }));
  assert.equal(res.body.result, 'created');
  const item = Object.values(docs)[0];
  assert.equal(item.person, 'Priya Shah');
  assert.equal(item.sentAt, '2026-11-03T03:05:00.000Z');
  const prompt = calls.find((c) => c.url.includes('generativelanguage')).body.contents[0].parts[0].text;
  assert.match(prompt, /FORWARDED/);
});

test('classify spots a forward when only the capture address is a recipient', () => {
  assert.equal(classify(bccMail({ ToFull: [{ Email: CAPTURE }] })).forwarded, true);
  assert.equal(classify(bccMail()).forwarded, false);
});

test('falls back to the subject line if Gemini is down', async () => {
  globalThis.fetch = ((orig) => async (url, opts) => (url.includes('generativelanguage')
    ? { ok: false, status: 503, json: async () => ({ error: { status: 'UNAVAILABLE' } }) }
    : orig(url, opts)))(globalThis.fetch);
  const res = await post(bccMail({ Subject: 'Org chart', MessageID: 'msg-9' }));
  assert.equal(res.body.result, 'created');
  assert.equal(Object.values(docs)[0].subject, 'Org chart');
});

test('the service-account token request is a signed JWT', async () => {
  await post(bccMail());
  const tok = calls.find((c) => c.url.startsWith('https://oauth2'));
  const assertion = new URLSearchParams(tok.body.toString()).get('assertion');
  const [h, p, sig] = assertion.split('.');
  const ok = crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(crypto.createPublicKey(privateKey), Buffer.from(sig, 'base64url'));
  assert.ok(ok);
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, SA.client_email);
});

test('reads Outlook forward headers without Gemini', async () => {
  const { parseForwardHeaders } = await import('../api/inbound.js');
  assert.deepEqual(
    parseForwardHeaders('From: Travis Maher\nSent: Thursday, 15 October 2026 8:23 PM\nTo: Alan Berryman <a@x.com>; Sue Ng <s@x.com>\nSubject: Contact details'),
    { to: 'Alan Berryman, Sue Ng', subject: 'Contact details', sentAt: '2026-10-15T20:23' },
  );
  assert.equal(parseForwardHeaders('Sent: Thursday, October 15, 2026 12:05 AM').sentAt, '2026-10-15T00:05');
});

test('a forward still gets tracked when every Gemini model is overloaded', async () => {
  const tried = [];
  globalThis.fetch = ((orig) => async (url, opts) => {
    if (!url.includes('generativelanguage')) return orig(url, opts);
    tried.push(url.split('/models/')[1].split(':')[0]);
    return { ok: false, status: 503, json: async () => ({ error: { status: 'UNAVAILABLE' } }) };
  })(globalThis.fetch);
  const res = await post(bccMail({
    ToFull: [{ Email: CAPTURE }], Subject: 'Fw: Contact details', MessageID: 'msg-fw',
    TextBody: 'From: Travis Maher\nSent: Thursday, 15 October 2026 8:23 AM\nTo: Alan Berryman <aberryman@plasgain.com.au>\nSubject: Contact details\n\nHi Alan',
  }));
  assert.equal(res.body.result, 'created');
  const item = Object.values(docs)[0];
  assert.equal(item.person, 'Alan Berryman');
  assert.equal(item.sentAt, '2026-10-14T21:23:00.000Z');
  assert.equal(item.subject, 'Contact details');
  assert.deepEqual(tried, ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash']);
});

test('"todo" at the start or end of the subject makes a to-do', () => {
  assert.equal(isTodoSubject('todo: FW: Pricing'), true);
  assert.equal(isTodoSubject('FW: [TODO] Call Sam'), true);
  assert.equal(isTodoSubject('FW: Pricing - to-do'), true);
  assert.equal(isTodoSubject('Pricing for the depot'), false);
  assert.equal(todoTitle('todo: FW: Pricing for Barriers Plus'), 'Pricing for Barriers Plus');
  assert.equal(todoTitle('FW: Pricing - todo'), 'Pricing');
});

test('emailing a "todo" subject creates a to-do, not a waiting-on item', async () => {
  gemini = { todos: [{ text: 'Send Barriers Plus the updated pricing', due: '2026-11-20', priority: 'high', notes: 'From Priya' }] };
  const res = await post(bccMail({ ToFull: [{ Email: CAPTURE }], Subject: 'todo: FW: Pricing', MessageID: 'msg-t' }));
  assert.equal(res.body.result, 'todo-created');
  const [path, t] = Object.entries(docs)[0];
  assert.match(path, /^users\/u1\/todos\//);
  assert.equal(t.text, 'Send Barriers Plus the updated pricing');
  assert.equal(t.due, '2026-11-20');
  assert.equal(t.priority, 'high');
  assert.equal(t.done, false);
});

test('a "todo" email still becomes a to-do when Gemini is down', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (url.includes('generativelanguage')
    ? { ok: false, status: 400, json: async () => ({ error: { status: 'INVALID_ARGUMENT' } }) }
    : realFetch(url, opts));
  const res = await post(bccMail({ ToFull: [{ Email: CAPTURE }], Subject: 'todo Call Sam about freight', MessageID: 'msg-t2' }));
  assert.equal(res.body.result, 'todo-created');
  assert.equal(Object.values(docs)[0].text, 'Call Sam about freight');
});
