// Pure rules for the "waiting on" tracker, kept separate so they can be tested.
import { DAY, duration, showDate, showLongDay, todayLocal, relativeDay } from './time.js';

export function lastContact(r) {
  const times = [r.sentAt, ...(r.followUps || []).map((f) => f.at)];
  return times.sort().at(-1);
}

// Returns { level: 'overdue' | 'nudge' | 'waiting' | 'resolved', reason }
export function requestStatus(r, nudgeAfterDays, nowMs = Date.now()) {
  if (r.status === 'resolved') return { level: 'resolved', reason: 'Resolved' };
  const today = todayLocal(nowMs);
  if (r.needBy && r.needBy < today) {
    return { level: 'overdue', reason: `Overdue: needed ${showDate(r.needBy)}` };
  }
  const silentMs = nowMs - Date.parse(lastContact(r));
  if (silentMs >= nudgeAfterDays * DAY) {
    return { level: 'nudge', reason: `No reply for ${duration(silentMs)}: time to nudge` };
  }
  if (r.needBy === today) return { level: 'nudge', reason: 'Needed today' };
  if (r.needBy) return { level: 'waiting', reason: `Needed by ${showDate(r.needBy)} (${relativeDay(r.needBy, today)})` };
  return { level: 'waiting', reason: 'Waiting' };
}

export function nudgeText(r) {
  const first = r.person.split(/\s+/)[0];
  const when = showLongDay(r.sentAt);
  const opener = (r.followUps || []).length === 0
    ? `Just following up on my email from ${when} about ${r.subject}.`
    : `Following up again on ${r.subject} (I first emailed on ${when}).`;
  const ask = r.needBy
    ? ` I need this by ${showDate(r.needBy)}, so could you let me know where this is at, or who else I should ask?`
    : ' Could you let me know where this is at, or who else I should ask?';
  return `Hi ${first},\n\n${opener}${ask}\n\nThanks!`;
}

export const PRIORITIES = ['high', 'normal', 'low'];
