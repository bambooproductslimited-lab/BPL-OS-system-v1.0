import { useMemo, useState } from 'react';
import SlideDeck, { recentWeeks, weekLabel } from '../components/SlideDeck';
import Photo from '../components/Photo';
import { CountUp, Delta, Ring } from '../components/SlideKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { kindIcon, kindName, priorityName, statusName } from '../lib/maintenance.js';
import { addDays, daysBetween, isoDay, shortDate } from './WorkOrdersFun';
import '../components/SlideKit.css';
import './MaintenancePresent.css';

// The maintenance & IT Saturday review: the week's jobs as slides on a
// screen, like the workshop's (WorkOrdersPresent.jsx), from the jobs and
// routines the page has loaded (MaintenanceOrders.jsx). It opens on the
// week at a glance (with last week beside it, and how many jobs were done
// by their planned day), then the highlights, the last 8 weeks, what was
// done (each day, by kind of job, who did it, what it cost) and every job
// done as cards; where the open jobs are, the ones on hold with why, the
// ones past their planned day; the places; the team on a podium; the
// routines due; next week day by day; and a thank-you. The slide show
// itself (keys, full screen, printing) is components/SlideDeck.jsx; a card
// opens its job over the slides (onOpen).

const PER_SLIDE = 6;
const FLOW = ['new', 'scheduled', 'in_progress', 'on_hold'];
const MEDAL = ['is-gold', 'is-silver', 'is-bronze'];
const GLYPH = {
  new: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v8M8 12h8" /></>,
  scheduled: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></>,
  in_progress: <path d="M8 5.5v13l10.5-6.5z" />,
  on_hold: <path d="M8.5 5.5v13M15.5 5.5v13" />,
  completed: <path d="m5 12.5 4.5 4.5L19 7.5" />
};
const HL_ICON = {
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
  cal: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M9 14h2M13 14h2M9 17h2" /></>,
  pin: <><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z" />,
  fire: <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.3 2.2-5.3 3.6-7.4.4 1.7 1.3 2.8 2.4 3.4C11.2 7.6 12.4 5 15 3c.2 2.6 1.4 4.3 2.5 5.9 1 1.5 1.5 3 1.5 4.8 0 4.2-3 7.3-7 7.3z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  cash: <><rect x="3" y="6.5" width="18" height="11" rx="1.5" /><circle cx="12" cy="12" r="2.5" /></>
};
function Glyph({ status }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[status] || GLYPH.new}</svg>;
}
function monday(iso) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); }
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
function median(nums) { if (!nums.length) return null; const s = nums.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function weekday(iso, style) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: style || 'short' }); }
function dayNum(iso) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
function daysWord(n) { return n === 1 ? tr('1 day') : tr('{n} days', { n }); }
function money(n, currency) {
  try { return new Intl.NumberFormat(activeIntlLocale(), { style: 'currency', currency: currency || 'GHS', maximumFractionDigits: 0 }).format(n); } catch { return (currency || '') + ' ' + Math.round(n); }
}
function moneyMap(m) { const ks = Object.keys(m); return ks.length ? ks.map((c) => money(m[c], c)).join(' + ') : '—'; }
// Done after the day it was planned for.
function doneLate(o) { return !!(o.scheduledOn && o.completedOn && o.completedOn > o.scheduledOn); }
function lateBy(o, today) { return o.scheduledOn ? Math.max(0, daysBetween(o.scheduledOn, today)) : 0; }
function lastNote(o) { const lines = String(o.notes || '').split('\n').map((l) => l.trim()).filter(Boolean); return lines.length ? lines[lines.length - 1] : ''; }

// One job on a slide.
function JobCard({ o, today, mode, onOpen }) {
  let when, tone = '';
  if (mode === 'done') {
    when = tr('Done {date}', { date: shortDate(o.completedOn) });
    tone = doneLate(o) ? 'bad' : 'good';
  } else if (o.overdue) {
    const d = lateBy(o, today);
    when = d === 1 ? tr('1 day late') : tr('{n} days late', { n: d });
    tone = 'bad';
  } else if (o.scheduledOn) {
    const d = daysBetween(today, o.scheduledOn);
    when = d === 0 ? tr('Planned for today') : d === 1 ? tr('Planned for tomorrow') : tr('Planned for {date}', { date: shortDate(o.scheduledOn) });
    tone = d <= 1 ? 'warn' : '';
  } else when = tr('Not planned yet');
  const note = mode === 'on_hold' ? lastNote(o) : '';
  return (
    <button type="button" className={'wop-card sk-card is-' + o.status + (mode !== 'done' && o.overdue ? ' is-late' : '')} onClick={() => onOpen(o)}>
      <span className="wop-card-top">
        <span className="wop-no">{o.ref}</span>
        {(o.priority === 'high' || o.priority === 'urgent') && <span className={'wop-hot' + (o.priority === 'urgent' ? ' mwp-urgent' : '')}>{priorityName(o.priority)}</span>}
        <span className="wop-st"><i />{statusName(o.status)}</span>
      </span>
      <strong className="wop-card-title">{o.description}</strong>
      <span className="sk-card-meta">
        <span className="mwp-place">📍 {o.location || '—'}</span>
        <span className="sk-what">{kindIcon(o.category)} {kindName(o.category)}</span>
      </span>
      <span className={'wop-when is-' + (tone || 'plain')}>
        {when}
        {mode === 'done' && (doneLate(o) ? <b>{tr('after its planned day')}</b> : o.scheduledOn ? <b>{tr('on its day')}</b> : null)}
      </span>
      {note && <span className="mwp-note">“{note}”</span>}
      <span className="sk-bar-text">
        {mode === 'done'
          ? (o.daysOpen === 0 ? tr('fixed the day it was asked for') : tr('{n} from asked to done', { n: daysWord(o.daysOpen) }))
          : tr('waiting {n}', { n: daysWord(o.daysOpen) })}
        {o.actualCost !== null && mode === 'done' ? ' · ' + money(o.actualCost, o.currency) : ''}
      </span>
      <span className="wop-people">
        {o.assignedTo ? (o.assignedTo.id ? <Photo id={o.assignedTo.id} name={o.assignedTo.name} photo={o.assignedTo.photo} size={22} /> : null) : null}
        <span>{o.assignedTo ? o.assignedTo.name : tr('Not given to anyone')}</span>
        {o.requestedBy && o.requestedBy.name ? <em>{tr('asked by {name}', { name: o.requestedBy.name })}</em> : null}
      </span>
    </button>
  );
}

function Bars({ items, max }) {
  return (
    <ul className="wop-bars">
      {items.map((it) => (
        <li key={it.key} className={'wop-sbar is-' + (it.tone || it.key)}>
          <span className="wop-sbar-label">{it.label}</span>
          <span className="wop-sbar-track"><span style={{ width: (max ? Math.max(it.n ? 3 : 0, (it.n / max) * 100) : 0) + '%' }} /></span>
          <b>{it.n}</b>
        </li>
      ))}
    </ul>
  );
}

export default function MaintenancePresent({ orders, routines, today, scopeName, onClose, onOpen, paused }) {
  const thisMonday = monday(today);
  const [weekFrom, setWeekFrom] = useState(thisMonday);
  const weekTo = addDays(weekFrom, 6);
  const nextFrom = addDays(weekTo, 1), nextTo = addDays(weekTo, 7);

  const data = useMemo(() => {
    const doneIn = (from, to) => orders.filter((o) => o.status === 'completed' && o.completedOn && o.completedOn >= from && o.completedOn <= to);
    const askedIn = (from, to) => orders.filter((o) => o.requestedOn >= from && o.requestedOn <= to);
    const done = doneIn(weekFrom, weekTo).sort((a, b) => a.completedOn.localeCompare(b.completedOn) || a.ref.localeCompare(b.ref));
    const late = done.filter(doneLate);
    const before = doneIn(addDays(weekFrom, -7), addDays(weekFrom, -1));
    const asked = askedIn(weekFrom, weekTo), askedBefore = askedIn(addDays(weekFrom, -7), addDays(weekFrom, -1));
    const open = orders.filter((o) => o.open).sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.overdue) return lateBy(b, today) - lateBy(a, today);
      if (!a.scheduledOn !== !b.scheduledOn) return a.scheduledOn ? -1 : 1;
      return String(a.scheduledOn || '').localeCompare(String(b.scheduledOn || '')) || a.requestedOn.localeCompare(b.requestedOn);
    });
    const overdue = open.filter((o) => o.overdue);
    const held = open.filter((o) => o.status === 'on_hold').sort((a, b) => b.daysOpen - a.daysOpen);
    const nobody = open.filter((o) => !o.assignedTo);
    const days = Array.from({ length: 7 }, (_, i) => { const d = addDays(weekFrom, i); return { key: d, label: weekday(d), n: done.filter((o) => o.completedOn === d).length }; });
    const trend = Array.from({ length: 8 }, (_, i) => {
      const from = addDays(weekFrom, -7 * (7 - i)), to = addDays(from, 6);
      return { from, done: doneIn(from, to).length, asked: askedIn(from, to).length };
    });
    let streak = 0;
    for (let w = weekFrom; streak < 104; w = addDays(w, -7)) { if (doneIn(w, addDays(w, 6)).length) streak++; else break; }
    // Kinds of job done this week.
    const kinds = {};
    done.forEach((o) => { kinds[o.category] = (kinds[o.category] || 0) + 1; });
    const kindList = Object.keys(kinds).map((k) => ({ key: k, tone: 'kind', label: kindIcon(k) + ' ' + kindName(k), n: kinds[k] })).sort((a, b) => b.n - a.n);
    // What it cost.
    const spent = {};
    done.forEach((o) => { if (o.actualCost !== null) spent[o.currency] = (spent[o.currency] || 0) + o.actualCost; });
    // The places: done this week and still open.
    const places = {};
    orders.forEach((o) => {
      const inDone = done.includes(o);
      if (!inDone && !o.open) return;
      const name = o.location || '—';
      const p = places[name] || (places[name] = { name, done: 0, open: 0, late: 0 });
      if (inDone) p.done++;
      if (o.open) { p.open++; if (o.overdue) p.late++; }
    });
    const placeList = Object.values(places).sort((a, b) => (b.done + b.open) - (a.done + a.open) || a.name.localeCompare(b.name));
    // The team: who did what.
    const people = {};
    orders.forEach((o) => {
      if (!o.assignedTo) return;
      const inDone = done.includes(o);
      if (!inDone && !o.open) return;
      const key = o.assignedTo.id || 'name:' + o.assignedTo.name;
      const p = people[key] || (people[key] = { key, name: o.assignedTo.name, person: o.assignedTo.id ? o.assignedTo : null, done: 0, onDay: 0, open: 0, late: 0 });
      if (inDone) { p.done++; if (!doneLate(o)) p.onDay++; }
      if (o.open) { p.open++; if (o.overdue) p.late++; }
    });
    const team = Object.values(people).sort((a, b) => b.done - a.done || b.onDay - a.onDay || b.open - a.open || a.name.localeCompare(b.name));
    // Routines: past their day, and due next week.
    const live = (routines || []).filter((r) => !r.archived);
    const rtLate = live.filter((r) => r.nextOn && r.nextOn < today).sort((a, b) => a.nextOn.localeCompare(b.nextOn));
    const rtNext = live.filter((r) => r.nextOn && r.nextOn >= nextFrom && r.nextOn <= nextTo).sort((a, b) => a.nextOn.localeCompare(b.nextOn));
    const rtSoon = live.filter((r) => r.nextOn && r.nextOn >= today && r.nextOn < nextFrom);
    // Next week, day by day: jobs planned and routines due.
    const next = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(nextFrom, i);
      return { key: d, jobs: open.filter((o) => o.scheduledOn === d), routines: rtNext.filter((r) => r.nextOn === d) };
    });
    const plannedNext = next.reduce((a, d) => a + d.jobs.length, 0);
    // Highlights.
    const fastest = done.slice().sort((a, b) => a.daysOpen - b.daysOpen || a.completedOn.localeCompare(b.completedOn))[0] || null;
    const busiest = days.slice().sort((a, b) => b.n - a.n)[0];
    const topPlace = placeList.filter((p) => p.done).sort((a, b) => b.done - a.done)[0] || null;
    const star = team.filter((p) => p.done)[0] || null;
    const oldest = open.slice().sort((a, b) => b.daysOpen - a.daysOpen)[0] || null;
    const dearest = done.filter((o) => o.actualCost !== null).sort((a, b) => b.actualCost - a.actualCost)[0] || null;
    return {
      done, late, before, asked, askedBefore, open, overdue, held, nobody, days, trend, streak, kindList, spent, placeList, team,
      rtLate, rtNext, rtSoon, next, plannedNext,
      flow: FLOW.map((st) => ({ key: st, n: open.filter((o) => o.status === st).length, late: open.filter((o) => o.status === st && o.overdue).length })),
      median: median(done.map((o) => o.daysOpen).filter((n) => n !== null)),
      hl: { fastest, busiest: busiest && busiest.n ? busiest : null, topPlace, star, oldest, dearest }
    };
  }, [orders, routines, today, weekFrom, weekTo, nextFrom, nextTo]);

  const slides = useMemo(() => {
    const s = [{ key: 'cover', kind: 'cover' }];
    if (data.done.length || data.open.length) s.push({ key: 'highlights', kind: 'highlights' });
    s.push({ key: 'trend', kind: 'trend' }, { key: 'done-sum', kind: 'done-sum' });
    chunk(data.done, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'done-' + i, kind: 'list', mode: 'done', list, page: i + 1, pages: all.length }));
    if (data.open.length) s.push({ key: 'flow', kind: 'flow' });
    chunk(data.held, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'held-' + i, kind: 'list', mode: 'on_hold', list, page: i + 1, pages: all.length }));
    if (data.overdue.length) s.push({ key: 'push', kind: 'push' });
    if (data.placeList.length) s.push({ key: 'places', kind: 'places' });
    if (data.team.length) s.push({ key: 'team', kind: 'team' });
    if (data.rtLate.length || data.rtNext.length || data.rtSoon.length) s.push({ key: 'routines', kind: 'routines' });
    s.push({ key: 'next', kind: 'next' }, { key: 'end', kind: 'end' });
    return s;
  }, [data]);
  const weeks = recentWeeks(thisMonday);
  const range = weekLabel(weekFrom, weekTo);
  const onDayN = data.done.length - data.late.length;
  const pct = data.done.length ? Math.round((onDayN / data.done.length) * 100) : null;

  function render(sl) {
    if (sl.kind === 'cover') {
      const mood = !data.done.length ? tr('A quiet week for the maintenance team.')
        : pct >= 80 ? tr('A strong week: {n} jobs done, {k} of them by their planned day.', { n: data.done.length, k: onDayN })
          : tr('{n} jobs done this week, {k} of them by their planned day.', { n: data.done.length, k: onDayN });
      return (
        <div className="wop-cover sk-cover">
          <span className="sk-orb is-a" aria-hidden="true" /><span className="sk-orb is-b" aria-hidden="true" /><span className="sk-orb is-c" aria-hidden="true" />
          <div className="sk-cover-top">
            <div>
              <span className="wop-eyebrow">{tr('Saturday review')} · {tr('Maintenance & IT')} · {scopeName}</span>
              <h1>{tr('Maintenance & IT this week')}</h1>
              <p className="wop-range">{range}</p>
              <p className="sk-mood">{mood}</p>
            </div>
            <Ring pct={pct} label={tr('by their day')} />
          </div>
          <div className="wop-tiles">
            <div className="wop-tile is-good"><b><CountUp value={data.done.length} /></b><span>{tr('jobs done this week')}</span><Delta now={data.done.length} before={data.before.length} /></div>
            <div className="wop-tile is-open"><b><CountUp value={data.asked.length} /></b><span>{tr('asked for this week')}</span><Delta now={data.asked.length} before={data.askedBefore.length} /></div>
            <div className="wop-tile is-pend"><b><CountUp value={data.open.length} /></b><span>{tr('jobs still open')}</span><span className="sk-delta">{data.held.length ? tr('{n} on hold', { n: data.held.length }) : ' '}</span></div>
            <div className={'wop-tile' + (data.overdue.length ? ' is-bad' : ' is-good')}><b><CountUp value={data.overdue.length} /></b><span>{tr('past their planned day')}</span><span className="sk-delta">{data.overdue.length ? tr('the longest {n} late', { n: daysWord(lateBy(data.overdue[0], today)) }) : tr('nothing late')}</span></div>
          </div>
        </div>
      );
    }
    if (sl.kind === 'highlights') {
      const h = data.hl;
      const cards = [
        h.fastest && { key: 'fast', icon: 'bolt', tone: 'good', label: tr('Fastest fix'), value: h.fastest.daysOpen === 0 ? tr('Same day') : daysWord(h.fastest.daysOpen), sub: h.fastest.ref + ' · ' + h.fastest.description, o: h.fastest },
        h.busiest && { key: 'day', icon: 'cal', tone: 'warn', label: tr('Busiest day'), value: weekday(h.busiest.key, 'long'), sub: h.busiest.n === 1 ? tr('1 job done') : tr('{n} jobs done', { n: h.busiest.n }) },
        h.topPlace && { key: 'place', icon: 'pin', tone: 'violet', label: tr('Busiest place'), value: h.topPlace.name, sub: h.topPlace.done === 1 ? tr('1 job done there') : tr('{n} jobs done there', { n: h.topPlace.done }) },
        h.star && { key: 'star', icon: 'star', tone: 'gold', label: tr('Star of the week'), value: h.star.name, sub: h.star.done === 1 ? tr('1 job done, {k} by its day', { k: h.star.onDay }) : tr('{n} jobs done, {k} by their day', { n: h.star.done, k: h.star.onDay }), person: h.star.person },
        { key: 'streak', icon: 'fire', tone: data.streak ? 'hot' : 'muted', label: tr('Weeks in a row'), value: String(data.streak), sub: data.streak ? tr('with jobs done') : tr('nothing done this week') },
        h.dearest && { key: 'cost', icon: 'cash', tone: 'open', label: tr('Biggest spend'), value: money(h.dearest.actualCost, h.dearest.currency), sub: h.dearest.ref + ' · ' + h.dearest.description, o: h.dearest },
        h.oldest && { key: 'old', icon: 'clock', tone: 'bad', label: tr('Longest waiting'), value: daysWord(h.oldest.daysOpen), sub: h.oldest.ref + ' · ' + h.oldest.description, o: h.oldest }
      ].filter(Boolean).slice(0, 6);
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-good">{tr('Highlights')}</span><h2>{tr('The week in highlights')}</h2></header>
          <div className="sk-hl">
            {cards.map((c, i) => {
              const Tag = c.o ? 'button' : 'div';
              return (
                <Tag key={c.key} type={c.o ? 'button' : undefined} className={'sk-hl-card is-' + c.tone} style={{ '--d': i }} onClick={c.o ? () => onOpen(c.o) : undefined}>
                  <span className="sk-hl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{HL_ICON[c.icon]}</svg></span>
                  <small>{c.label}</small>
                  <b>{c.person ? <span className="sk-hl-person"><Photo id={c.person.id} name={c.person.name} photo={c.person.photo} size={34} />{c.value}</span> : c.value}</b>
                  <span>{c.sub}</span>
                </Tag>
              );
            })}
          </div>
        </div>
      );
    }
    if (sl.kind === 'trend') {
      const max = Math.max(1, ...data.trend.map((w) => Math.max(w.done, w.asked)));
      const best = data.trend.slice().sort((a, b) => b.done - a.done)[0];
      const avg = Math.round((data.trend.reduce((a, w) => a + w.done, 0) / data.trend.length) * 10) / 10;
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-open">{tr('The last 8 weeks')}</span><h2>{tr('Jobs done and asked for, week by week')}</h2></header>
          <div className="wop-sum-grid">
            <section className="wop-panel">
              <div className="sk-cols" role="img" aria-label={data.trend.map((w) => dayNum(w.from) + ': ' + w.done + ' / ' + w.asked).join(', ')}>
                {data.trend.map((w) => (
                  <span key={w.from} className={'sk-col' + (w.from === weekFrom ? ' is-now' : '')}>
                    <span className="sk-pair">
                      <i className="is-done" style={{ height: (w.done / max) * 86 + '%' }}><b>{w.done || ''}</b></i>
                      <i className="is-issued" style={{ height: (w.asked / max) * 86 + '%' }}><b>{w.asked || ''}</b></i>
                    </span>
                    <small>{dayNum(w.from)}</small>
                  </span>
                ))}
              </div>
              <ul className="sk-key"><li><i className="is-done" />{tr('Done')}</li><li><i className="is-issued" />{tr('Asked for')}</li></ul>
            </section>
            <section className="wop-panel wop-facts">
              <div className="wop-fact"><b><CountUp value={data.done.length} /></b><span>{tr('jobs done this week')} · <Delta now={data.done.length} before={data.before.length} /></span></div>
              <div className="wop-fact"><b>{avg.toLocaleString(activeIntlLocale())}</b><span>{tr('a week on average, over the 8 weeks')}</span></div>
              <div className="wop-fact is-warn"><b>{best.done}</b><span>{tr('the best week: {date}', { date: weekLabel(best.from, addDays(best.from, 6)) })}</span></div>
              <div className="wop-fact"><b><CountUp value={data.asked.length} /></b><span>{tr('asked for this week')} · <Delta now={data.asked.length} before={data.askedBefore.length} /></span></div>
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'done-sum') {
      const max = Math.max(1, ...data.days.map((d) => d.n));
      const kmax = Math.max(1, ...data.kindList.map((k) => k.n));
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-good">{tr('Done this week')}</span><h2>{data.done.length === 1 ? tr('1 job done') : tr('{n} jobs done', { n: data.done.length })}</h2></header>
          {!data.done.length ? <p className="wop-empty">{tr('No jobs were done this week.')}</p> : (
            <div className="sk-three">
              <section className="wop-panel">
                <h3>{tr('Done each day')}</h3>
                <div className="wop-days" role="img" aria-label={data.days.map((d) => d.label + ' ' + d.n).join(', ')}>
                  {data.days.map((d) => (
                    <span key={d.key} className={'wop-day' + (d.key === today ? ' is-today' : '')}>
                      <b>{d.n || ''}</b><i style={{ height: (d.n / max) * 100 + '%' }} /><small>{d.label}</small>
                    </span>
                  ))}
                </div>
                <h3 className="sk-h3-gap">{tr('Kinds of job')}</h3>
                <Bars items={data.kindList.slice(0, 5)} max={kmax} />
              </section>
              <section className="wop-panel sk-center">
                <h3>{tr('By their planned day')}</h3>
                <Ring pct={pct} label={tr('{a} on their day · {b} after', { a: onDayN, b: data.late.length })} />
                {data.median !== null && <p className="wop-note">{data.median === 0 ? tr('Half were fixed the day they were asked for.') : data.median === 1 ? tr('Half were fixed within 1 day of being asked for.') : tr('Half were fixed within {n} days of being asked for.', { n: data.median })}</p>}
                {Object.keys(data.spent).length > 0 && <p className="mwp-spent"><small>{tr('Spent on these jobs')}</small><b>{moneyMap(data.spent)}</b></p>}
              </section>
              <section className="wop-panel">
                <h3>{tr('Who did them')}</h3>
                {data.team.some((p) => p.done) ? (
                  <ul className="sk-makers">
                    {data.team.filter((p) => p.done).slice(0, 6).map((p) => <li key={p.key}>{p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={30} /> : <span className="sk-noface is-small">{p.name.slice(0, 1)}</span>}<span>{p.name}</span><b>{p.done}</b></li>)}
                  </ul>
                ) : <p className="wop-note">{tr('Nobody was given these jobs.')}</p>}
              </section>
            </div>
          )}
        </div>
      );
    }
    if (sl.kind === 'flow') {
      const max = Math.max(1, ...data.flow.map((f) => f.n));
      const HINT = { new: tr('asked for, not planned yet'), scheduled: tr('planned for a day'), in_progress: tr('being done now'), on_hold: tr('waiting on something') };
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-open">{tr('Where everything is')}</span>
            <h2>{data.open.length === 1 ? tr('1 open job, step by step') : tr('{n} open jobs, step by step', { n: data.open.length })}</h2>
            <p className="wop-sub">{data.nobody.length ? (data.nobody.length === 1 ? tr('1 of them is not given to anyone yet.') : tr('{n} of them are not given to anyone yet.', { n: data.nobody.length })) : tr('Every open job is given to someone.')}</p>
          </header>
          <div className="sk-flow">
            {data.flow.map((f, i) => (
              <div key={f.key} className={'sk-step is-' + f.key + (f.n ? '' : ' is-empty')} style={{ '--d': i }}>
                <span className="sk-step-glyph"><Glyph status={f.key} /></span>
                <b><CountUp value={f.n} /></b>
                <strong>{statusName(f.key)}</strong>
                <small>{HINT[f.key]}</small>
                <span className="sk-step-bar"><i style={{ height: (f.n / max) * 100 + '%' }} /></span>
                {f.late > 0 && <em>{f.late === 1 ? tr('1 past due') : tr('{n} past due', { n: f.late })}</em>}
              </div>
            ))}
            <div className="sk-step is-completed is-goal" style={{ '--d': FLOW.length }}>
              <span className="sk-step-glyph"><Glyph status="completed" /></span>
              <b><CountUp value={data.done.length} /></b>
              <strong>{tr('Done this week')}</strong>
              <small>{pct === null ? '' : tr('{pct}% by their day', { pct })}</small>
            </div>
          </div>
        </div>
      );
    }
    if (sl.kind === 'list') {
      const done = sl.mode === 'done';
      return (
        <div className="wop-list">
          <header className="wop-head is-row">
            <span className={'wop-eyebrow ' + (done ? 'is-good' : 'is-pend')}>{done ? tr('Done this week') : tr('On hold')}</span>
            <h2>{done ? tr('Jobs done') : tr('On hold, and why')}</h2>
            {sl.pages > 1 && <span className="wop-page">{tr('{a} of {b}', { a: sl.page, b: sl.pages })}</span>}
          </header>
          <div className="wop-cards sk-cards">
            {sl.list.map((o, i) => <div key={o.id} className="sk-in" style={{ '--d': i }}><JobCard o={o} today={today} mode={sl.mode} onOpen={onOpen} /></div>)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'push') {
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow sk-eb-bad">{tr('Needs a push')}</span>
            <h2>{data.overdue.length === 1 ? tr('1 job is past its planned day') : tr('{n} jobs are past their planned day', { n: data.overdue.length })}</h2>
            <p className="wop-sub">{tr('The longest late first, with who has it.')}</p>
          </header>
          <ul className="sk-push">
            {data.overdue.slice(0, 6).map((o, i) => (
              <li key={o.id} style={{ '--d': i }}><button type="button" onClick={() => onOpen(o)}>
                <span className="sk-push-days"><b>{lateBy(o, today)}</b><small>{lateBy(o, today) === 1 ? tr('day late') : tr('days late')}</small></span>
                <span className="sk-push-main">
                  <strong><span className="wop-no">{o.ref}</span>{o.description}</strong>
                  <small>{['📍 ' + (o.location || '—'), kindName(o.category), statusName(o.status), o.assignedTo ? o.assignedTo.name : tr('Not given to anyone'), tr('planned for {date}', { date: shortDate(o.scheduledOn) })].join(' · ')}</small>
                </span>
                {lastNote(o) && <em>{lastNote(o)}</em>}
              </button></li>
            ))}
          </ul>
          {data.overdue.length > 6 && <p className="wop-note">{tr('and {n} more late', { n: data.overdue.length - 6 })}</p>}
        </div>
      );
    }
    if (sl.kind === 'places') {
      const list = data.placeList.slice(0, 7);
      const max = Math.max(1, ...list.map((p) => p.done + p.open));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow sk-eb-violet">{tr('Where we worked')}</span>
            <h2>{tr('Our places')}</h2>
            <p className="wop-sub">{tr('Done this week, and still open.')}</p>
          </header>
          <ul className="sk-for">
            {list.map((p, i) => (
              <li key={p.name} style={{ '--d': i }}>
                <span className="sk-for-name"><span className="mwp-pin" aria-hidden="true">📍</span><span>{p.name}</span></span>
                <span className="sk-for-track">
                  <i className="is-done" style={{ width: (p.done / max) * 100 + '%' }} />
                  <i className="is-open" style={{ width: (p.open / max) * 100 + '%' }} />
                </span>
                <span className="sk-for-n">{tr('{a} done · {b} open', { a: p.done, b: p.open })}{p.late ? <em> · {tr('{n} past due', { n: p.late })}</em> : null}</span>
              </li>
            ))}
          </ul>
          <ul className="sk-key"><li><i className="is-done" />{tr('Done this week')}</li><li><i className="is-open" />{tr('Still open')}</li></ul>
          {data.placeList.length > 7 && <p className="wop-note">{tr('and {n} more places', { n: data.placeList.length - 7 })}</p>}
        </div>
      );
    }
    if (sl.kind === 'team') {
      const podium = data.team.filter((p) => p.done).slice(0, 3);
      const order = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium;
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-pend">{tr('The team')}</span><h2>{tr('Who did what')}</h2></header>
          <div className={'sk-team' + (podium.length ? '' : ' is-flat')}>
            {podium.length > 0 && (
              <div className="sk-podium">
                {order.map((p) => {
                  const place = podium.indexOf(p);
                  return (
                    <div key={p.key} className={'sk-place ' + MEDAL[place]}>
                      {p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={place === 0 ? 64 : 52} /> : <span className="sk-noface">{p.name.slice(0, 1)}</span>}
                      <strong>{p.name}</strong>
                      <span>{p.done === 1 ? tr('1 job done') : tr('{n} jobs done', { n: p.done })}</span>
                      <div className="sk-block"><b>{place + 1}</b></div>
                    </div>
                  );
                })}
              </div>
            )}
            <table className="wop-table">
              <thead><tr><th>{tr('Who')}</th><th>{tr('Done')}</th><th>{tr('By their day')}</th><th>{tr('Still open')}</th><th>{tr('Overdue')}</th></tr></thead>
              <tbody>
                {data.team.slice(0, podium.length ? 6 : 8).map((p) => (
                  <tr key={p.key}>
                    <td><span className="wop-pm">{p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={26} /> : null}{p.name}</span></td>
                    <td><b className="is-good">{p.done}</b></td>
                    <td>{p.done ? <b className={p.onDay < p.done ? 'is-bad' : 'is-good'}>{Math.round((p.onDay / p.done) * 100)}%</b> : <span className="wop-zero">—</span>}</td>
                    <td><b>{p.open}</b></td>
                    <td>{p.late ? <b className="is-bad">{p.late}</b> : <span className="wop-zero">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    if (sl.kind === 'routines') {
      const rows = data.rtLate.map((r) => ({ r, tone: 'bad', words: tr('{n} past its day', { n: daysWord(daysBetween(r.nextOn, today)) }) }))
        .concat(data.rtSoon.map((r) => ({ r, tone: 'warn', words: tr('this week, {date}', { date: shortDate(r.nextOn) }) })))
        .concat(data.rtNext.map((r) => ({ r, tone: 'open', words: weekday(r.nextOn, 'long') + ' ' + dayNum(r.nextOn) })));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-open">{tr('Routine jobs')}</span>
            <h2>{tr('Routines due')}</h2>
            <p className="wop-sub">{data.rtLate.length ? (data.rtLate.length === 1 ? tr('1 is past its day: do it first.') : tr('{n} are past their day: do them first.', { n: data.rtLate.length })) : tr('None is past its day.')}</p>
          </header>
          <ul className="mwp-rts">
            {rows.slice(0, 8).map(({ r, tone, words }, i) => (
              <li key={r.id} className={'is-' + tone} style={{ '--d': i }}>
                <span className="mwp-rt-when">{words}</span>
                <span className="mwp-rt-main"><strong>{kindIcon(r.category)} {r.name}</strong><small>{[r.description, r.location ? '📍 ' + r.location : null, r.assignedTo ? r.assignedTo.name : null, r.everyDays ? tr('every {n} days', { n: r.everyDays }) : null].filter(Boolean).join(' · ')}</small></span>
              </li>
            ))}
          </ul>
          {rows.length > 8 && <p className="wop-note">{tr('and {n} more routines', { n: rows.length - 8 })}</p>}
        </div>
      );
    }
    if (sl.kind === 'next') {
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-pend">{tr('Next week')}</span>
            <h2>{!data.plannedNext ? tr('Nothing planned yet: {dates}', { dates: weekLabel(nextFrom, nextTo) }) : data.plannedNext === 1 ? tr('1 job planned: {dates}', { dates: weekLabel(nextFrom, nextTo) }) : tr('{n} jobs planned: {dates}', { n: data.plannedNext, dates: weekLabel(nextFrom, nextTo) })}</h2>
            <p className="wop-sub">{[
              data.rtNext.length ? (data.rtNext.length === 1 ? tr('1 routine due.') : tr('{n} routines due.', { n: data.rtNext.length })) : null,
              data.overdue.length ? (data.overdue.length === 1 ? tr('Plus 1 late job to bring back on track.') : tr('Plus {n} late jobs to bring back on track.', { n: data.overdue.length })) : tr('No late jobs carried over.'),
              data.nobody.length ? (data.nobody.length === 1 ? tr('1 job still to give to someone.') : tr('{n} jobs still to give to someone.', { n: data.nobody.length })) : null
            ].filter(Boolean).join(' ')}</p>
          </header>
          <div className="sk-week">
            {data.next.map((d, i) => (
              <div key={d.key} className={'sk-wday' + (d.jobs.length || d.routines.length ? ' is-busy' : '')} style={{ '--d': i }}>
                <span className="sk-wday-head"><b>{weekday(d.key)}</b><small>{dayNum(d.key)}</small></span>
                {d.jobs.slice(0, 3).map((o) => (
                  <button key={o.id} type="button" className={'sk-chip is-' + o.status} onClick={() => onOpen(o)}>
                    <span className="wop-no">{o.ref}</span><span className="sk-chip-title">{o.description}</span>
                    <small>{[o.location, o.assignedTo ? o.assignedTo.name : null].filter(Boolean).join(' · ')}</small>
                  </button>
                ))}
                {d.routines.slice(0, 2).map((r) => (
                  <span key={r.id} className="sk-chip mwp-rt-chip">
                    <span className="wop-no">🔁 {r.ref}</span><span className="sk-chip-title">{r.name}</span>
                    <small>{[r.location, r.assignedTo ? r.assignedTo.name : null].filter(Boolean).join(' · ')}</small>
                  </span>
                ))}
                {d.jobs.length + d.routines.length > 5 && <span className="sk-more">{tr('+{n} more', { n: d.jobs.length + d.routines.length - 5 })}</span>}
                {!d.jobs.length && !d.routines.length && <span className="sk-free">{tr('Nothing planned')}</span>}
              </div>
            ))}
          </div>
        </div>
      );
    }
    const good = data.done.length && pct >= 80 && !data.overdue.length;
    const shout = [
      data.hl.star ? tr('Star of the week: {name}', { name: data.hl.star.name }) : null,
      data.hl.fastest ? tr('Fastest fix: {ref}, {days}', { ref: data.hl.fastest.ref, days: data.hl.fastest.daysOpen === 0 ? tr('the same day') : daysWord(data.hl.fastest.daysOpen) }) : null,
      data.hl.topPlace ? tr('Busiest place: {name}', { name: data.hl.topPlace.name }) : null
    ].filter(Boolean);
    return (
      <div className="wop-cover is-end sk-end">
        <span className="sk-orb is-a" aria-hidden="true" /><span className="sk-orb is-b" aria-hidden="true" />
        {good ? <span className="sk-confetti" aria-hidden="true">{Array.from({ length: 36 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</span> : null}
        <span className="wop-eyebrow">{tr('Saturday review')} · {range}</span>
        <h1>{tr('Thank you, team')}</h1>
        {shout.length > 0 && <ul className="sk-shout">{shout.map((s) => <li key={s}>{s}</li>)}</ul>}
        <p className="wop-range">{data.overdue.length ? (data.overdue.length === 1 ? tr('This week, bring the 1 late job back on track.') : tr('This week, bring the {n} late jobs back on track.', { n: data.overdue.length })) : tr('No job is late. Keep it that way next week.')}</p>
      </div>
    );
  }

  return (
    <SlideDeck brand={tr('Saturday review') + ' · ' + tr('Maintenance & IT')} className="is-fancy is-wo is-mw" weeks={weeks} weekFrom={weekFrom} onWeek={setWeekFrom}
      slides={slides} render={render} onClose={onClose} paused={paused} />
  );
}
