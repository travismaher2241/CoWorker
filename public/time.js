// Date/time helpers. Everything is shown and entered in Sydney time,
// whatever time zone the computer or phone happens to be set to.
export const TZ = 'Australia/Sydney';
export const DAY = 86400000;

const fmtParts = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function zoneParts(ms) {
  const p = {};
  for (const { type, value } of fmtParts.formatToParts(new Date(ms))) p[type] = value;
  return p;
}

// Offset of Sydney from UTC at a given instant, in ms.
function zoneOffset(ms) {
  const p = zoneParts(ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// "2026-11-18T09:30" (Sydney wall time) -> ISO string
export function sydneyLocalToIso(local) {
  const [d, t = '00:00'] = local.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  let ms = guess - zoneOffset(guess);
  ms = guess - zoneOffset(ms); // second pass handles daylight-saving edges
  return new Date(ms).toISOString();
}

// ISO -> "2026-11-18T09:30" for a datetime-local input
export function isoToSydneyLocal(iso) {
  const p = zoneParts(new Date(iso).getTime());
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function todaySydney(nowMs = Date.now()) {
  const p = zoneParts(nowMs);
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const fmtDateTime = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});
const fmtDateTimeYear = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
});
const fmtDate = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
const fmtLongDay = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const fmtClock = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});

export function showDateTime(iso, nowMs = Date.now()) {
  const d = new Date(iso);
  const sameYear = zoneParts(d.getTime()).year === zoneParts(nowMs).year;
  return (sameYear ? fmtDateTime : fmtDateTimeYear).format(d);
}

// "2026-11-18" -> "Wed 18 Nov"
export function showDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return fmtDate.format(new Date(Date.UTC(y, m - 1, d)));
}

export const showLongDay = (iso) => fmtLongDay.format(new Date(iso));
export const showClock = (ms = Date.now()) => fmtClock.format(new Date(ms));

export function duration(ms) {
  if (ms < 0) ms = 0;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ${hours % 24}h`;
  return `${days} days`;
}

export function relativeDay(ymd, today = todaySydney()) {
  const diff = Math.round((Date.parse(ymd) - Date.parse(today)) / DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff < 0) return `${-diff} days ago`;
  return `in ${diff} days`;
}
