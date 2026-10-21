import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { L, REQUEST_KINDS, dayLabel } from './mkKit';
import { addDaysIso, periodName, periodOf } from './mkReqSum';

// The filters on Ask marketing's board (MkRequestFilters.jsx), as the
// backend reads them (mkRequests.service.js list): a day, a week (Monday to
// Sunday), a month, a year or days picked by hand, on when a request was
// asked for, the date it is needed by, or when it was done; and its type,
// a person on it, its company, urgent, late, from a routine, and words.

export const UNITS = ['all', 'day', 'week', 'month', 'year', 'custom'];
export const DATE_BY = ['asked', 'needed', 'done'];
export function noFilters(today) {
  return { unit: 'all', at: today, from: '', to: '', dateBy: 'asked', kind: '', person: '', company: '', urgent: false, late: false, routine: false, q: '' };
}

// The days of a day, week, month or year holding iso.
export function rangeOf(unit, iso) {
  if (unit === 'day') return { from: iso, to: iso };
  if (unit === 'year') return { from: iso.slice(0, 4) + '-01-01', to: iso.slice(0, 4) + '-12-31' };
  return periodOf(unit, iso);
}
// The one before (n < 0) or after.
export function stepRange(unit, iso, n) {
  const r = rangeOf(unit, iso);
  return rangeOf(unit, n < 0 ? addDaysIso(r.from, -1) : addDaysIso(r.to, 1));
}
// "Wed 21 Oct 2026", "19 – 25 October 2026", "October 2026", "2026".
export function rangeName(unit, iso) {
  if (unit === 'day') return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  if (unit === 'year') return iso.slice(0, 4);
  return periodName(unit, iso);
}

// The days asked for, if any: { from, to } (either may be empty for days picked by hand).
export function daysOf(f) {
  if (f.unit === 'custom') return f.from || f.to ? { from: f.from, to: f.to } : null;
  return f.unit === 'all' ? null : rangeOf(f.unit, f.at);
}
// The query the board's list takes.
export function filterQuery(f) {
  const q = {};
  const d = daysOf(f);
  if (d) { if (d.from) q.from = d.from; if (d.to) q.to = d.to; q.dateBy = f.dateBy; }
  if (f.kind) q.kind = f.kind;
  if (f.person) q.person = f.person;
  if (f.company) q.company = f.company;
  if (f.urgent) q.urgent = '1';
  if (f.late) q.late = '1';
  if (f.routine) q.routine = '1';
  if (f.q.trim()) q.q = f.q.trim();
  return q;
}

// "asked for in October 2026", "needed by a day from 1 Oct to 15 Oct 2026"…
function whenPhrase(f) {
  const d = daysOf(f);
  if (!d) return '';
  let when;
  if (f.unit === 'day') when = tr('on {day}', { day: rangeName('day', f.at) });
  else if (f.unit === 'week') when = tr('in the week of {dates}', { dates: rangeName('week', f.at) });
  else if (f.unit === 'month') when = tr('in {month}', { month: rangeName('month', f.at) });
  else if (f.unit === 'year') when = tr('in {year}', { year: rangeName('year', f.at) });
  else if (d.from && d.to) when = tr('from {from} to {to}', { from: dayLabel(d.from, { day: 'numeric', month: 'short', year: 'numeric' }), to: dayLabel(d.to, { day: 'numeric', month: 'short', year: 'numeric' }) });
  else if (d.from) when = tr('from {from} on', { from: dayLabel(d.from, { day: 'numeric', month: 'short', year: 'numeric' }) });
  else when = tr('up to {to}', { to: dayLabel(d.to, { day: 'numeric', month: 'short', year: 'numeric' }) });
  return f.dateBy === 'needed' ? tr('needed {when}', { when }) : f.dateBy === 'done' ? tr('done {when}', { when }) : tr('asked for {when}', { when });
}

// The filters on, in words, each with the change that takes it off:
// [{ key, label, off }].
export function activeFilters(f, people, companies) {
  const out = [];
  const when = whenPhrase(f);
  if (when) out.push({ key: 'when', label: when, off: { unit: 'all', from: '', to: '' } });
  if (f.kind) out.push({ key: 'kind', label: L(REQUEST_KINDS, f.kind), off: { kind: '' } });
  if (f.person) {
    const p = people.find((x) => x.id === f.person);
    out.push({ key: 'person', label: tr('{name} is on it', { name: p ? p.name : '…' }), off: { person: '' } });
  }
  if (f.company) {
    const c = companies.find((x) => x.code === f.company);
    out.push({ key: 'company', label: c ? c.name : f.company, off: { company: '' } });
  }
  if (f.urgent) out.push({ key: 'urgent', label: tr('Urgent'), off: { urgent: false } });
  if (f.late) out.push({ key: 'late', label: tr('Late'), off: { late: false } });
  if (f.routine) out.push({ key: 'routine', label: tr('From a routine'), off: { routine: false } });
  if (f.q.trim()) out.push({ key: 'q', label: '“' + f.q.trim() + '”', off: { q: '' } });
  return out;
}
