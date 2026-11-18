// Pure rules for the "waiting on" log, kept separate so they can be tested.
import { showDate, todayLocal, relativeDay } from './time.js';

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
