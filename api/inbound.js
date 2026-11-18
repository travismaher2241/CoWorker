// Vercel serverless function: the "capture address" webhook.
//
// Point a Postmark inbound stream at:
//   https://capture:<INBOUND_SECRET>@<your-site>/api/inbound
// Then:
//   - BCC the capture address on an email you send  -> a new "waiting on" item
//     (or a follow-up, if you already have an open item for that email thread)
//   - Forward an old sent email to the capture address -> an item dated when
//     you originally sent it
//   - Put "todo" in the subject (e.g. "todo: FW: Pricing", or email the capture
//     address directly with "todo Call Sam") -> a to-do instead
//
// Env vars:
//   INBOUND_SECRET            (required) password in the webhook URL
//   INBOUND_SENDERS           (required) your work email address(es), comma separated.
//                             Mail from anyone else is ignored.
//   INBOUND_UID               (required) your user ID, shown at the bottom of the app
//   FIREBASE_SERVICE_ACCOUNT  (required) service account JSON, to write to Firestore
//   GEMINI_API_KEY            (recommended) to work out what you asked for and any deadline
import crypto from 'node:crypto';
import { readEmail, readTodos } from './_lib/gemini.js';
import { createDoc, updateDoc, findWhere } from './_lib/firestore.js';
import { localInputToIso } from '../public/time.js';

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

// "todo: FW: Pricing", "[TODO] Call Sam", "FW: Pricing - to-do" all count: "todo" has to be
// at the start or the end, so an email about "the todo list review" isn't caught.
export function isTodoSubject(subject) {
  const s = String(subject || '').replace(/^\s*((re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '');
  return /^\s*[[(]?\s*to-?do([^a-z0-9]|$)/i.test(s) || /(^|[^a-z0-9])to-?do\s*[\])]?\s*$/i.test(s);
}

// "todo: FW: Pricing for Barriers Plus" -> "Pricing for Barriers Plus"
export function todoTitle(subject) {
  let s = String(subject || '');
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^\s*((re|fw|fwd|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '')
      .replace(/^\s*[[(]?\s*to-?do\s*[\])]?\s*[:\-–]?\s*/i, '')
      .replace(/\s*[\-–:]?\s*[[(]?\s*to-?do\s*[\])]?\s*$/i, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim().slice(0, 500);
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
  const started = Date.now();
  const json = res.json.bind(res);
  res.json = (body) => {
    console.log('Inbound result', { status: res.statusCode, ...body, ms: Date.now() - started });
    return json(body);
  };
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
    if (isTodoSubject(c.subject)) {
      const fallback = todoTitle(c.subject);
      let t = null;
      try {
        [t] = await readTodos([{ text: `EMAIL:\n${emailText(mail, c)}` }], {
          extraInstructions: 'The user emailed this to their own to-do list. Return exactly ONE to-do that captures what they need to do about it. '
            + `Their subject line, with the word "todo" removed, is: "${fallback}". If that already reads as an action, use it as the text.`,
        });
      } catch (err) {
        console.warn('Gemini unavailable, using the subject line as the to-do:', err.message);
      }
      const created = await createDoc(`${userPath}/todos`, id, {
        text: (t?.text || fallback || '(no subject)').slice(0, 500),
        notes: (t?.notes || '').slice(0, 5000),
        due: t?.due || null,
        priority: t?.priority || 'normal',
        done: false,
        doneAt: null,
        repeat: null,
        blockedBy: null,
        source: 'email',
        createdAt: nowIso(),
      });
      return res.status(200).json({ result: created ? 'todo-created' : 'duplicate', item: id });
    }

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
    let ai;
    try {
      ai = await readEmail([{ text: `EMAIL:\n${emailText(mail, c)}` }], {
        extraInstructions: 'IMPORTANT: the user FORWARDED this to their own tracking address. Ignore the forward itself: '
          + 'use the recipients, subject and sent date of the ORIGINAL email they sent, which appears inside the forwarded message. '
          + 'If several emails are quoted, use the most recent one the user sent.',
      });
    } catch (err) {
      // Gemini is down: read the forwarded header block ourselves so the email isn't lost.
      console.warn('Gemini unavailable, reading the forwarded headers directly:', err.message);
      const h = parseForwardHeaders(c.body);
      ai = {
        person: h.to || '',
        subject: h.subject || threadKey(c.subject),
        details: h.subject ? `Email subject: ${h.subject}` : '',
        sentAt: h.sentAt,
        needBy: null,
        emailSubject: h.subject,
      };
    }
    const original = ai.emailSubject || c.subject;
    const key = threadKey(original);
    const open = key ? await findWhere(userPath, 'requests', { emailKey: key, status: 'open' }) : [];
    if (open.length) return res.status(200).json({ result: 'already-tracked', item: open[0].id });
    const created = await createDoc(`${userPath}/requests`, id, newItem({
      person: ai.person || 'Unknown',
      subject: ai.subject || threadKey(c.subject) || '(no subject)',
      details: ai.details,
      sentAt: ai.sentAt ? localInputToIso(ai.sentAt) : c.sentAt,
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

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Reads the "From / Sent / To / Subject" block Outlook and Gmail put at the top of a forward.
// Returns sentAt as Melbourne local "YYYY-MM-DDTHH:MM" (or null).
export function parseForwardHeaders(body) {
  const text = String(body || '');
  const field = (names) => {
    const m = new RegExp(`^\\s*\\*?(?:${names})\\*?:\\s*(.+)$`, 'im').exec(text);
    return m ? m[1].trim() : '';
  };
  const to = field('To').replace(/<[^>]*>/g, '').replace(/\s*;\s*/g, ', ').replace(/\s+,/g, ',').trim();
  const subject = field('Subject');
  const sent = field('Sent|Date');
  let sentAt = null;
  // "Thursday, 15 October 2026 8:23 AM"  or  "Thursday, October 15, 2026 8:23 AM"  or  "Thu, 15 Oct 2026 at 08:23"
  const m = /(?:(\d{1,2})\s+([A-Za-z]+)|([A-Za-z]+)\s+(\d{1,2}),?)\s+(\d{4})(?:,|\s+at)?\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?/.exec(sent);
  if (m) {
    const day = Number(m[1] || m[4]);
    const monthName = (m[2] || m[3]).toLowerCase();
    const month = MONTHS.findIndex((n) => n.startsWith(monthName.slice(0, 3))) + 1;
    let hour = Number(m[6]);
    const ampm = (m[8] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    if (month > 0) {
      const pad = (n) => String(n).padStart(2, '0');
      sentAt = `${m[5]}-${pad(month)}-${pad(day)}T${pad(hour)}:${m[7]}`;
    }
  }
  return { to, subject, sentAt };
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
