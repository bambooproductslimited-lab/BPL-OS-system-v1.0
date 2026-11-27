import { activeIntlLocale, tr, msg } from './i18n.jsx';
import { codeLabel } from './codeLabels.js';

// Work orders (the OS once called them tasks; the server still keeps them
// in its tasks table). The statuses read the way the workshop's sheet named
// them — "In process", "Suspended", "Awaiting material" — wherever a WO is
// shown, so codeLabel()'s generic words ("Not started", "Waiting") are not
// used for them.
export const WO_STATUSES = ['discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review', 'completed', 'cancelled'];
export const WO_OPEN = (t) => t.status !== 'completed' && t.status !== 'cancelled';

const LABELS = {
  discussing: msg('Discussing'), not_started: msg('Issued'), in_progress: msg('In process'), awaiting_material: msg('Awaiting material'),
  waiting: msg('Suspended'), under_review: msg('Ready for check'), completed: msg('Completed'), cancelled: msg('Cancelled')
};
export function woStatusLabel(status) { return LABELS[status] ? tr(LABELS[status]) : codeLabel(status); }

// WO-0042, for a number the server sent without its label.
export function woNumber(n) { return n === null || n === undefined ? '' : 'WO-' + String(n).padStart(4, '0'); }

// ── the week a WO is under ────────────────────────────────────────────
// The workshop's sheet numbers the weeks with Google Sheets' WEEKNUM(): a
// week runs Sunday to Saturday, and week 1 is the one with 1 January in it
// (so the first and last weeks of a year can be short). A WO's week there
// is WEEKNUM of the day it was closed (Stage's "Closed", Arc Stage's
// "Date"), and its Closed tab lists the finished WOs week by week. A WO
// still open is under the week it was issued until it is closed.
function utcDay(iso) { const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d); }
function isoOf(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function weekNum(iso) {
  if (!iso) return null;
  const day = utcDay(iso);
  const jan1 = utcDay(String(iso).slice(0, 4) + '-01-01');
  const firstSunday = jan1 - new Date(jan1).getUTCDay() * 86400000;
  return Math.floor((day - firstSunday) / (7 * 86400000)) + 1;
}
// The days of a week: Sunday to Saturday, cut at the year's ends.
export function weekDays(year, n) {
  const jan1 = utcDay(year + '-01-01');
  const sunday = jan1 - new Date(jan1).getUTCDay() * 86400000 + (n - 1) * 7 * 86400000;
  return { from: isoOf(Math.max(sunday, jan1)), to: isoOf(Math.min(sunday + 6 * 86400000, utcDay(year + '-12-31'))) };
}
function localDay(ts) { if (!ts) return null; const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
// { n, year, key, closed, day, from, to } — key sorts weeks across years (202648).
export function woWeek(t) {
  const shut = !WO_OPEN(t) && (t.completedAt || t.cancelledAt);
  const day = shut ? localDay(shut) : t.issuedOn || localDay(t.createdAt);
  if (!day) return null;
  const n = weekNum(day), year = Number(day.slice(0, 4));
  return { n, year, key: year * 100 + n, closed: !!shut, day, ...weekDays(year, n) };
}
// "22–28 Nov", "29 Nov – 5 Dec", with the year when it isn't this year's.
export function weekSpan(w) {
  if (!w) return '';
  const a = new Date(w.from + 'T00:00'), b = new Date(w.to + 'T00:00');
  const year = b.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {};
  if (w.from === w.to) return b.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', ...year });
  const first = a.getMonth() === b.getMonth() ? String(a.getDate()) : a.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' });
  return first + (a.getMonth() === b.getMonth() ? '–' : ' – ') + b.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', ...year });
}
export function weekTitle(w) {
  if (!w) return '';
  return w.closed ? tr('Closed in week {n} ({days})', { n: w.n, days: weekSpan(w) }) : tr('Issued in week {n} ({days}); still open — it takes the week it is closed in', { n: w.n, days: weekSpan(w) });
}
