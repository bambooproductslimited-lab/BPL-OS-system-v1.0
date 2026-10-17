import { weekLabel } from '../../components/SlideDeck';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { L, REQUEST_KINDS } from './mkKit';

// Ask marketing's summary, shared by the page's Summary section
// (MkRequestsSummary.jsx) and its slides (MkRequestsPresent.jsx): weeks run
// Monday to Sunday, months from the 1st, as the backend counts them
// (mkRequestSummary.service.js).

function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function addDaysIso(iso, n) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDay(d); }
export function periodOf(kind, iso) {
  const d = new Date(iso + 'T00:00');
  if (kind === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const from = isoDay(d); return { from, to: addDaysIso(from, 6) }; }
  return { from: isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), to: isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}
export function shiftPeriod(kind, from, n) {
  const p = periodOf(kind, from);
  return n < 0 ? periodOf(kind, addDaysIso(p.from, -1)) : periodOf(kind, addDaysIso(p.to, 1));
}
function monthName(from) { return new Date(from + 'T00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' }); }
// "October 2026", "6 – 12 October 2026".
export function periodName(kind, from) {
  const p = periodOf(kind, from);
  return kind === 'week' ? weekLabel(p.from, p.to) : monthName(p.from);
}
// The periods to pick from, newest first: this one, the last one, then dates.
export function recentPeriods(kind, today, n = 8) {
  const out = [];
  let p = periodOf(kind, today);
  for (let i = 0; i < n; i++) {
    const name = periodName(kind, p.from);
    const label = i === 0 ? (kind === 'week' ? tr('This week ({dates})', { dates: name }) : tr('This month ({month})', { month: name }))
      : i === 1 ? (kind === 'week' ? tr('Last week ({dates})', { dates: name }) : tr('Last month ({month})', { month: name })) : name;
    out.push({ from: p.from, label });
    p = shiftPeriod(kind, p.from, -1);
  }
  return out;
}
// A column's label: "6 Oct" for a week, "Oct" for a month.
export function columnLabel(kind, from) {
  return new Date(from + 'T00:00').toLocaleDateString(activeIntlLocale(), kind === 'week' ? { day: 'numeric', month: 'short' } : { month: 'short' });
}
// What a figure is set against: the same days of the period before while
// this one is still going, the whole of it once it has ended.
export function againstWhat(kind, current) {
  if (kind === 'week') return current ? tr('this time last week') : tr('last week');
  return current ? tr('this time last month') : tr('last month');
}
// "▲ 3 more than last month", "same as this time last week".
export function changeText(now, before, kind, current) {
  const when = againstWhat(kind, current);
  const d = now - before;
  if (!d) return { dir: '', text: tr('same as {when}', { when }) };
  return d > 0 ? { dir: 'up', text: tr('▲ {n} more than {when}', { n: d, when }) } : { dir: 'down', text: tr('▼ {n} fewer than {when}', { n: -d, when }) };
}
export function pct(n, of) { return of ? Math.round((n / of) * 100) : null; }
export function daysText(n) {
  if (n === null || n === undefined) return '—';
  return n === 1 ? tr('1 day') : tr('{n} days', { n: n.toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }) });
}

// What stands out, in words (the backend picks them).
export function insightText(i, kind, current) {
  const v = i.values || {};
  const when = againstWhat(kind, current);
  switch (i.kind) {
    case 'late': return v.n === 1 ? tr('1 request to marketing is past the date it was needed by.') : tr('{n} requests to marketing are past the date they were needed by.', { n: v.n });
    case 'on_time': return tr('{pct}% were done by the day they were needed ({n} of {of}).', v);
    case 'not_taken': return v.n === 1 ? tr('1 new request is waiting for someone to take it on.') : tr('{n} new requests are waiting for someone to take them on.', { n: v.n });
    case 'to_check': return v.n === 1 ? tr('1 is ready for the one who asked to check it.') : tr('{n} are ready for the ones who asked to check them.', { n: v.n });
    case 'asked_more': return tr('More was asked for than {when}: {now} against {before}.', { when, now: v.now, before: v.before });
    case 'asked_less': return tr('Less was asked for than {when}: {now} against {before}.', { when, now: v.now, before: v.before });
    case 'faster': return tr('Requests got done faster: {days} on average, against {before}.', { days: daysText(v.days), before: daysText(v.before) });
    case 'slower': return tr('Requests took longer: {days} on average, against {before}.', { days: daysText(v.days), before: daysText(v.before) });
    case 'top_kind': return tr('Most asked for: {kind} ({n}).', { kind: L(REQUEST_KINDS, v.kind), n: v.n });
    case 'top_doer': return tr('{name} did the most: {n} done.', v);
    case 'top_asker': return tr('{name} asked for the most: {n}.', v);
    case 'routines': return v.n === 1 ? tr('1 was made by a routine.') : tr('{n} were made by routines.', { n: v.n });
    default: return '';
  }
}
