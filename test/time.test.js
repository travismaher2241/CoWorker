import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localInputToIso, isoToLocalInput, todayLocal, duration, addDays, relativeDay } from '../public/time.js';
import { requestStatus, lastContact, peopleStats, splitPeople, nextDue } from '../public/logic.js';

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

test('an unanswered request is waiting, however long it has been', () => {
  assert.equal(requestStatus(base, NOW).level, 'waiting');
  assert.equal(requestStatus({ ...base, sentAt: '2026-10-01T21:00:00Z' }, NOW).level, 'waiting');
});

test('last contact counts follow-ups', () => {
  const r = { ...base, sentAt: '2026-11-10T21:00:00Z', followUps: [{ id: 'a', at: '2026-11-17T20:00:00Z', method: 'email' }] };
  assert.equal(lastContact(r), '2026-11-17T20:00:00Z');
});

test('past the need-by date is overdue', () => {
  assert.equal(requestStatus({ ...base, needBy: '2026-11-17' }, NOW).level, 'overdue');
  assert.equal(requestStatus({ ...base, needBy: '2026-11-18' }, NOW).level, 'waiting');
});

test('answered wins over everything', () => {
  assert.equal(requestStatus({ ...base, needBy: '2026-01-01', status: 'resolved' }, NOW).level, 'resolved');
});

test('reply times are grouped by person, splitting group emails', () => {
  const rs = [
    { person: 'Sam Lee', sentAt: '2026-11-10T00:00:00Z', status: 'resolved', resolvedAt: '2026-11-12T00:00:00Z' },
    { person: 'Sam Lee, Priya Shah', sentAt: '2026-11-15T00:00:00Z', status: 'open' },
    { person: 'priya shah', sentAt: '2026-11-01T00:00:00Z', status: 'resolved', resolvedAt: '2026-11-11T00:00:00Z' },
  ];
  const stats = peopleStats(rs, Date.parse('2026-11-18T00:00:00Z'));
  const sam = stats.find((s) => s.person === 'Sam Lee');
  const priya = stats.find((s) => s.person.toLowerCase() === 'priya shah');
  assert.deepEqual([sam.asked, sam.answered, sam.open], [2, 1, 1]);
  assert.equal(sam.avgMs, 2 * 86400000);
  assert.equal(sam.longestOpenMs, 3 * 86400000);
  assert.equal(priya.avgMs, 10 * 86400000);
  assert.deepEqual(splitPeople('Sam Lee and Jo Wu; Ann'), ['Sam Lee', 'Jo Wu', 'Ann']);
});

test('repeating to-dos roll forward to the next date after today', () => {
  assert.equal(nextDue('2026-11-18', 'weekly', '2026-11-18'), '2026-11-25');
  assert.equal(nextDue('2026-11-01', 'weekly', '2026-11-18'), '2026-11-22'); // late: skip past today
  assert.equal(nextDue('2026-11-20', 'weekdays', '2026-11-18'), '2026-11-23'); // Fri -> Mon
  assert.equal(nextDue('2026-01-31', 'monthly', '2026-01-31'), '2026-02-28');
  assert.equal(nextDue(null, 'daily', '2026-11-18'), '2026-11-19');
  assert.equal(nextDue('2026-11-18', null, '2026-11-18'), null);
});
