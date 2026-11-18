import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInputToIso, isoToLocalInput, todayLocal, duration, addDays, relativeDay } from '../public/time.js';
import { requestStatus, lastContact, nudgeText } from '../public/logic.js';

test('Melbourne wall time converts to UTC in summer (AEDT, +11)', () => {
  assert.equal(localInputToIso('2026-11-18T09:16'), '2026-11-17T22:16:00.000Z');
});

test('Melbourne wall time converts to UTC in winter (AEST, +10)', () => {
  assert.equal(localInputToIso('2026-07-01T09:00'), '2026-06-30T23:00:00.000Z');
});

test('round trips through the input format', () => {
  for (const local of ['2026-04-05T01:30', '2026-10-04T03:30', '2026-12-31T23:59']) {
    assert.equal(isoToLocalInput(localInputToIso(local)), local);
  }
});

test('"today" is the Melbourne date, not the UTC date', () => {
  assert.equal(todayLocal(Date.parse('2026-11-17T22:16:00Z')), '2026-11-18');
});

test('durations read naturally', () => {
  assert.equal(duration(30 * 1000), 'just now');
  assert.equal(duration(45 * 60000), '45m');
  assert.equal(duration(5 * 3600000 + 5 * 60000), '5h 5m');
  assert.equal(duration(3 * 86400000 + 4 * 3600000), '3d 4h');
  assert.equal(duration(20 * 86400000), '20 days');
});

test('date maths', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(relativeDay('2026-11-19', '2026-11-18'), 'tomorrow');
  assert.equal(relativeDay('2026-11-15', '2026-11-18'), '3 days ago');
});

const NOW = Date.parse('2026-11-17T22:00:00Z'); // Wed 18 Nov, 9am Melbourne
const base = { person: 'Sam Lee', subject: 'Q3 budget numbers', sentAt: '2026-11-17T21:00:00Z', followUps: [], status: 'open' };

test('a fresh request is just waiting', () => {
  assert.equal(requestStatus(base, 2, NOW).level, 'waiting');
});

test('silence past the nudge window needs a nudge', () => {
  const r = { ...base, sentAt: '2026-11-14T21:00:00Z' };
  assert.equal(requestStatus(r, 2, NOW).level, 'nudge');
});

test('a follow-up resets the nudge clock', () => {
  const r = { ...base, sentAt: '2026-11-10T21:00:00Z', followUps: [{ id: 'a', at: '2026-11-17T20:00:00Z', method: 'email' }] };
  assert.equal(lastContact(r), '2026-11-17T20:00:00Z');
  assert.equal(requestStatus(r, 2, NOW).level, 'waiting');
});

test('past the need-by date is overdue', () => {
  assert.equal(requestStatus({ ...base, needBy: '2026-11-17' }, 2, NOW).level, 'overdue');
  assert.equal(requestStatus({ ...base, needBy: '2026-11-18' }, 2, NOW).level, 'nudge');
});

test('resolved wins over everything', () => {
  assert.equal(requestStatus({ ...base, needBy: '2026-01-01', status: 'resolved' }, 2, NOW).level, 'resolved');
});

test('nudge text addresses the person by first name', () => {
  const text = nudgeText({ ...base, needBy: '2026-11-20' });
  assert.match(text, /^Hi Sam,/);
  assert.match(text, /Wednesday 18 November/);
  assert.match(text, /need this by Fri,? 20 Nov/);
});
