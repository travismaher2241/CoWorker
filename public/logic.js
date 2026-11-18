// Pure rules for the "waiting on" log, kept separate so they can be tested.
import { showDate, todayLocal, relativeDay, addDays } from './time.js';

export function lastContact(r) {
  const times = [r.sentAt, ...(r.followUps || []).map((f) => f.at)];
  return times.sort().at(-1);
}

// Returns { level: 'overdue' | 'waiting' | 'resolved', reason }
export function requestStatus(r, nowMs = Date.now()) {
  if (r.status === 'resolved') return { level: 'resolved', reason: 'Answered' };
  const today = todayLocal(nowMs);
  if (r.needBy && r.needBy < today) {
    return { level: 'overdue', reason: `Overdue: needed ${showDate(r.needBy)}` };
  }
  if (r.needBy) return { level: 'waiting', reason: `Needed by ${showDate(r.needBy)} (${relativeDay(r.needBy, today)})` };
  return { level: 'waiting', reason: 'Waiting' };
}

export const PRIORITIES = ['high', 'normal', 'low'];

// ---------------- reply times by person ----------------

// "Sam Lee, Priya Shah" -> ["Sam Lee", "Priya Shah"], so a group email counts for each person.
export function splitPeople(person) {
  return String(person || '').split(/\s*[,;]\s*|\s+(?:and|&)\s+/i).map((p) => p.trim()).filter(Boolean);
}

// One row per person: how many requests, how many answered, average time to answer,
// and how long the oldest unanswered one has been waiting.
export function peopleStats(requests, nowMs = Date.now()) {
  const byKey = new Map();
  for (const r of requests) {
    for (const name of splitPeople(r.person)) {
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { person: name, asked: 0, answered: 0, open: 0, totalMs: 0, longestOpenMs: 0 });
      const s = byKey.get(key);
      s.asked++;
      if (r.status === 'resolved' && r.resolvedAt) {
        s.answered++;
        s.totalMs += Math.max(0, Date.parse(r.resolvedAt) - Date.parse(r.sentAt));
      } else if (r.status !== 'resolved') {
        s.open++;
        s.longestOpenMs = Math.max(s.longestOpenMs, nowMs - Date.parse(r.sentAt));
      }
    }
  }
  return [...byKey.values()]
    .map(({ totalMs, ...s }) => ({ ...s, avgMs: s.answered ? totalMs / s.answered : null }))
    .sort((a, b) => b.open - a.open || b.longestOpenMs - a.longestOpenMs || (b.avgMs ?? 0) - (a.avgMs ?? 0) || a.person.localeCompare(b.person));
}

// ---------------- repeating to-dos ----------------

export const REPEATS = {
  daily: 'Every day',
  weekdays: 'Every weekday',
  weekly: 'Every week',
  fortnightly: 'Every fortnight',
  monthly: 'Every month',
};

const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();

function addMonth(d) {
  const [y, m, day] = d.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

function step(d, repeat) {
  switch (repeat) {
    case 'daily': return addDays(d, 1);
    case 'weekdays': {
      let n = addDays(d, 1);
      while ([0, 6].includes(weekday(n))) n = addDays(n, 1);
      return n;
    }
    case 'weekly': return addDays(d, 7);
    case 'fortnightly': return addDays(d, 14);
    case 'monthly': return addMonth(d);
    default: return null;
  }
}

// When a repeating to-do is ticked off, the next one is due one step after its due
// date (or after today if it had none), skipping ahead past today if you were late.
export function nextDue(due, repeat, today) {
  if (!REPEATS[repeat]) return null;
  let next = step(due || today, repeat);
  while (next <= today) next = step(next, repeat);
  return next;
}
