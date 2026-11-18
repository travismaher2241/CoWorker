// Vercel serverless function: the "capture address" webhook.
//
// Point a Postmark inbound stream at:
//   https://capture:<INBOUND_SECRET>@<your-site>/api/inbound
// Then:
//   - BCC the capture address on an email you send  -> a new "waiting on" item
//     (or a follow-up, if you already have an open item for that email thread)
//   - Forward an old sent email to the capture address -> an item dated when
//     you originally sent it
//
// Env vars:
//   INBOUND_SECRET            (required) password in the webhook URL
//   INBOUND_SENDERS           (required) your work email address(es), comma separated.
//                             Mail from anyone else is ignored.
//   INBOUND_UID               (required) your user ID, shown at the bottom of the app
//   FIREBASE_SERVICE_ACCOUNT  (required) service account JSON, to write to Firestore
//   GEMINI_API_KEY            (recommended) to work out what you asked for and any deadline
import crypto from 'node:crypto';
import { readEmail } from './_lib/gemini.js';
import { createDoc, updateDoc, findWhere } from './_lib/firestore.js';
import { sydneyLocalToIso } from '../public/time.js';

const MAX_BODY = 20000;
const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function authorized(req) {
  const secret = process.env.INBOUND_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const [, pass = ''] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    if (safeEqual(pass, secret)) return true;
  }
  const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
  return safeEqual(key, secret);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// "RE: Fwd: Q3 numbers" -> "q3 numbers"
export function threadKey(subject) {
  return String(subject || '')
    .replace(/^\s*((re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/tr)[^>]*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n');
}

const nameOf = (p) => (p.Name && p.Name.trim()) || p.Email;

// Works out what kind of email this is from the Postmark payload.
export function classify(mail) {
  const capture = new Set([
    (mail.OriginalRecipient || '').toLowerCase(),
    ...list(process.env.INBOUND_ADDRESSES),
  ].filter(Boolean));
  const isCapture = (email) => {
    const e = (email || '').toLowerCase();
    return capture.has(e) || e.endsWith('@inbound.postmarkapp.com');
  };
  const to = (mail.ToFull || []).filter((p) => !isCapture(p.Email));
  const cc = (mail.CcFull || []).filter((p) => !isCapture(p.Email));
  const forwarded = to.length === 0 && cc.length === 0;
  return {
    forwarded,
    recipients: to.length ? to : cc,
    subject: mail.Subject || '',
    body: (mail.TextBody && mail.TextBody.trim()) ? mail.TextBody : htmlToText(mail.HtmlBody),
    sentAt: (() => {
      const d = new Date(mail.Date);
      return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    })(),
    messageId: mail.MessageID || (mail.Headers || []).find((h) => /^message-id$/i.test(h.Name))?.Value || '',
  };
}

function emailText(mail, c) {
  const people = (arr) => (arr || []).map((p) => (p.Name ? `${p.Name} <${p.Email}>` : p.Email)).join(', ');
  return [
    `From: ${people([mail.FromFull || { Email: mail.From }])}`,
    `To: ${people(mail.ToFull)}`,
    mail.CcFull?.length ? `Cc: ${people(mail.CcFull)}` : '',
    `Date: ${mail.Date}`,
    `Subject: ${c.subject}`,
    '',
    c.body.slice(0, MAX_BODY),
  ].filter((l) => l !== '').join('\n');
}

const nowIso = () => new Date().toISOString();

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!authorized(req)) {
    console.warn('Inbound rejected: wrong or missing secret in the webhook URL');
    return res.status(401).json({ error: 'Not authorised: the password in the webhook URL does not match INBOUND_SECRET' });
  }

  const uid = process.env.INBOUND_UID;
  if (!uid || !process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn('Inbound rejected: INBOUND_UID or FIREBASE_SERVICE_ACCOUNT missing');
    return res.status(503).json({ error: 'Email capture is not set up: add INBOUND_UID and FIREBASE_SERVICE_ACCOUNT in Vercel.' });
  }

  const mail = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const from = (mail.FromFull?.Email || mail.From || '').toLowerCase();
  const senders = list(process.env.INBOUND_SENDERS);
  // Reply 200 to anything we ignore so the mail service doesn't keep retrying it.
  if (!senders.includes(from)) {
    console.warn('Ignored email from unlisted sender', from);
    return res.status(200).json({ result: 'ignored', reason: 'sender not in INBOUND_SENDERS' });
  }

  const c = classify(mail);
  console.log('Inbound email', { from, forwarded: c.forwarded, subject: c.subject.slice(0, 80) });
  const id = crypto.createHash('sha256').update(c.messageId || `${from}|${c.subject}|${mail.Date}`).digest('hex').slice(0, 32);
  const userPath = `users/${uid}`;

  try {
    if (!c.forwarded) {
      // BCC'd on a new email, or on a reply in a thread we're already tracking.
      const key = threadKey(c.subject);
      const open = key ? await findWhere(userPath, 'requests', { emailKey: key, status: 'open' }) : [];
      if (open.length) {
        const item = open[0];
        const followUps = Array.isArray(item.followUps) ? item.followUps : [];
        if (followUps.some((f) => f.id === id) || item.emailId === id) {
          return res.status(200).json({ result: 'duplicate' });
        }
        followUps.push({ id, at: c.sentAt, method: 'email', note: 'Logged by BCC' });
        followUps.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        await updateDoc(item.path, { followUps });
        return res.status(200).json({ result: 'follow-up', item: item.id });
      }

      let ai = null;
      try {
        ai = await readEmail([{ text: `EMAIL:\n${emailText(mail, c)}` }]);
      } catch (err) {
        console.warn('Gemini unavailable, using the subject line instead:', err.message);
      }
      const created = await createDoc(`${userPath}/requests`, id, newItem({
        person: c.recipients.map(nameOf).join(', ') || ai?.person || 'Unknown',
        subject: ai?.subject || c.subject.replace(/^\s*(re|fw|fwd)\s*:\s*/i, '') || '(no subject)',
        details: ai?.details || `Email subject: ${c.subject}`,
        sentAt: c.sentAt,
        needBy: ai?.needBy || null,
        emailKey: key,
        emailId: id,
      }));
      return res.status(200).json({ result: created ? 'created' : 'duplicate', item: id });
    }

    // Forwarded an older email to the capture address: use the ORIGINAL email's details.
    const ai = await readEmail([{ text: `EMAIL:\n${emailText(mail, c)}` }], {
      extraInstructions: 'IMPORTANT: the user FORWARDED this to their own tracking address. Ignore the forward itself: '
        + 'use the recipients, subject and sent date of the ORIGINAL email they sent, which appears inside the forwarded message. '
        + 'If several emails are quoted, use the most recent one the user sent.',
    });
    const original = ai.emailSubject || c.subject;
    const key = threadKey(original);
    const open = key ? await findWhere(userPath, 'requests', { emailKey: key, status: 'open' }) : [];
    if (open.length) return res.status(200).json({ result: 'already-tracked', item: open[0].id });
    const created = await createDoc(`${userPath}/requests`, id, newItem({
      person: ai.person || 'Unknown',
      subject: ai.subject || threadKey(c.subject) || '(no subject)',
      details: ai.details,
      sentAt: ai.sentAt ? sydneyLocalToIso(ai.sentAt) : c.sentAt,
      needBy: ai.needBy,
      emailKey: key,
      emailId: id,
    }));
    return res.status(200).json({ result: created ? 'created' : 'duplicate', item: id });
  } catch (err) {
    console.error(err);
    // 500 so the mail service retries later (e.g. Gemini or Firestore hiccup).
    return res.status(500).json({ error: err.message });
  }
}

function newItem({ person, subject, details, sentAt, needBy, emailKey, emailId }) {
  return {
    person: person.slice(0, 200),
    subject: subject.slice(0, 500),
    details: (details || '').slice(0, 5000),
    sentAt,
    needBy: needBy || null,
    followUps: [],
    status: 'open',
    resolvedAt: null,
    resolution: '',
    createdAt: nowIso(),
    source: 'email',
    needsReview: true,
    emailKey,
    emailId,
  };
}
