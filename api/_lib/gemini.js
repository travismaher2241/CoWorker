// Shared Gemini helper: turns an email (screenshot or text) into tracker fields.

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
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date());
}

export function basePrompt() {
  return `You are helping someone track emails they SENT to coworkers and are waiting on a reply for.
The input is a screenshot or the text of one email they sent (it may be in Outlook's Sent Items, a reading pane, a phone mail app, or a forwarded copy).
It is now ${sydneyNow()} in Sydney, Australia. Use that to resolve relative dates such as "Yesterday 3:15 PM", "Mon 9:02 AM" or a time with no date (meaning today).
Times shown in the email are already Sydney local time unless a time zone is given. Australian dates are day/month/year.
Extract:
- person: the recipient(s) in To (not the sender, ignore Cc unless there is no To).
- subject: what the sender is asking the recipient for, phrased as a short thing they're waiting on.
- sentAt: the sent date and time.
- needBy: only if the email gives a deadline ("by Friday", "before 20 Nov").
If something isn't visible, use null (or an empty string for text fields). Never invent names.`;
}

export class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// parts: Gemini content parts AFTER the prompt (an inline image or text).
const RETRYABLE = new Set([429, 500, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Models to try in order. Gemini's busiest model is sometimes "overloaded"; the
// next one usually isn't. GEMINI_MODEL (if set) goes first.
export function modelChain() {
  const preferred = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : [];
  return [...new Set([...preferred, 'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash'])];
}

// parts: Gemini content parts AFTER the prompt (an inline image or text).
export async function readEmail(parts, { extraInstructions = '', deadlineMs = 40000 } = {}) {
  if (!process.env.GEMINI_API_KEY) throw new GeminiError(503, 'Gemini isn\'t set up yet: add GEMINI_API_KEY in Vercel.');
  const started = Date.now();
  const body = (thinking) => JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: basePrompt() + (extraInstructions ? `\n${extraInstructions}` : '') }, ...parts] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      // Extracting a few fields doesn't need "thinking", and it makes replies several times faster.
      ...(thinking ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  });

  let lastError = 'unknown';
  for (const model of modelChain()) {
    const left = deadlineMs - (Date.now() - started);
    if (left < 3000) break;
    try {
      const call = (thinking) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        signal: AbortSignal.timeout(Math.min(15000, left)),
        body: body(thinking),
      });
      let r = await call(false);
      let gem = await r.json();
      if (r.status === 400 && /thinking/i.test(JSON.stringify(gem))) {
        // Some models don't allow switching thinking off: ask again with the default.
        r = await call(true);
        gem = await r.json();
      }
      if (r.ok) {
        const text = gem.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        try {
          return cleanResult(JSON.parse(text));
        } catch {
          lastError = 'unreadable answer';
          continue;
        }
      }
      lastError = gem.error?.status || String(r.status);
      console.warn(`Gemini ${model} failed`, r.status, JSON.stringify(gem).slice(0, 300));
      if (!RETRYABLE.has(r.status) && r.status !== 404) break; // e.g. bad key: other models won't help
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? 'too slow' : 'network error';
      console.warn(`Gemini ${model} ${lastError}`);
    }
    await sleep(300);
  }
  throw new GeminiError(502, `Gemini couldn't read it right now (${lastError}). Try again in a minute.`);
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
    emailSubject: str(out.emailSubject, 300),
  };
}
