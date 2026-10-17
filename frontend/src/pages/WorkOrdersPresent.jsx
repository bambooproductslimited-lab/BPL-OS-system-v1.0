import { useEffect, useMemo, useRef, useState } from 'react';
import SlideDeck, { recentWeeks, weekLabel } from '../components/SlideDeck';
import Photo from '../components/Photo';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { WO_OPEN, WO_STATUSES, woStatusLabel } from '../lib/workOrders.js';
import { ForBadge, StatusGlyph, addDays, colHint, daysBetween, forName, isoDay, nextLabel, pmOf, shortDate } from './WorkOrdersFun';
import './WorkOrdersPresent.css';

// The Saturday review: the week's work orders as slides on a screen. It
// opens on the week at a glance (with how it compares to last week and an
// on-time score), then the week's highlights — fastest finish, biggest
// order, busiest day, top customer, star project manager, the run of weeks
// with work finished — the last 8 weeks, what was completed (each card with
// what was made, planned against taken, and who made it), where every open
// work order is, what is in process and what is pending, what needs a push,
// who the work was for, the project managers on a podium, next week day by
// day, and a thank-you with the week's shout-outs. The slide show itself
// (keys, full screen, printing) is components/SlideDeck.jsx; a card opens
// its work order over the slides (onOpen). Figures come from the work
// orders the page has loaded (the scope chosen there).

const PER_SLIDE = 6;
const IN_PROCESS = ['in_progress', 'under_review'];
const PENDING = ['discussing', 'not_started', 'awaiting_material', 'waiting'];
const FLOW = ['discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review'];
function dayOf(ts) { return ts ? isoDay(new Date(ts)) : null; }
function monday(iso) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); }
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
function median(nums) { if (!nums.length) return null; const s = nums.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function qtyOf(t) { const n = Number(String(t.quantity || '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; }
function whatOf(t) { const p = t.product && t.product.name ? t.product.name : t.itemCode || ''; return [p, t.quantity ? '× ' + t.quantity : ''].filter(Boolean).join(' '); }
function weekday(iso, style) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: style || 'short' }); }
function dayNum(iso) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
function daysWord(n) { return n === 1 ? tr('1 day') : tr('{n} days', { n }); }

// A number that counts up when its slide comes on (straight to the end when
// printed, or for anyone who asked their device for less motion).
function CountUp({ value, ms = 900 }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const el = ref.current;
    const still = !el || el.closest('.wop-print') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || typeof value !== 'number';
    if (still) { setShown(value); return undefined; }
    let raf, start;
    const step = (ts) => {
      if (start === undefined) start = ts;
      const k = Math.min(1, (ts - start) / ms);
      setShown(Math.round(value * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    setShown(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <span ref={ref} className="wpx-n">{typeof shown === 'number' ? shown.toLocaleString(activeIntlLocale()) : shown}</span>;
}

// The on-time share as a ring.
function Ring({ pct, label }) {
  const r = 42, c = 2 * Math.PI * r, v = pct === null ? 0 : pct;
  const tone = pct === null ? 'none' : pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad';
  return (
    <div className={'wpx-ring is-' + tone}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="is-track" />
        <circle cx="50" cy="50" r={r} className="is-fill" strokeDasharray={c} strokeDashoffset={c - (c * v) / 100} transform="rotate(-90 50 50)" />
      </svg>
      <span className="wpx-ring-in"><b>{pct === null ? '—' : <><CountUp value={pct} />%</>}</b><small>{label}</small></span>
    </div>
  );
}

// "▲ 3 more than last week".
function Delta({ now, before }) {
  const d = now - before;
  if (!d) return <span className="wpx-delta">{tr('same as last week')}</span>;
  return <span className={'wpx-delta ' + (d > 0 ? 'is-up' : 'is-down')}>{d > 0 ? '▲ ' + tr('{n} more than last week', { n: d }) : '▼ ' + tr('{n} less than last week', { n: -d })}</span>;
}

function Faces({ people, max = 4 }) {
  if (!people.length) return null;
  return (
    <span className="wpx-faces">
      {people.slice(0, max).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={22} />)}
      {people.length > max && <i>+{people.length - max}</i>}
    </span>
  );
}

// One work order on a slide.
function PCard({ t, today, mode, onOpen }) {
  const pm = pmOf(t);
  const what = whatOf(t);
  const team = (t.assignees || []).filter((a) => !t.projectManager || a.id !== t.projectManager.id);
  let when, tone = '', frac = null, barTone = 'ok', barText = '';
  if (mode === 'done') {
    when = tr('Done {date}', { date: shortDate(dayOf(t.completedAt)) });
    tone = t.onTime === false ? 'bad' : 'good';
    if (t.plannedDays !== null && t.plannedDays !== undefined && t.daysToClose !== null && t.daysToClose !== undefined) {
      const planned = Math.max(1, t.plannedDays);
      frac = Math.max(0.04, Math.min(1, t.daysToClose / Math.max(planned, t.daysToClose || 1)));
      barTone = t.onTime === false ? 'bad' : 'good';
      barText = t.daysToClose === 0 ? tr('done the same day, {b} planned', { b: daysWord(t.plannedDays) }) : tr('took {a}, {b} planned', { a: daysWord(t.daysToClose), b: daysWord(t.plannedDays) });
    } else if (t.daysToClose !== null && t.daysToClose !== undefined) barText = t.daysToClose === 0 ? tr('done the same day') : tr('took {a}', { a: daysWord(t.daysToClose) });
  } else {
    if (!t.dueDate) when = tr('No due date');
    else {
      const d = daysBetween(today, t.dueDate);
      when = d < 0 ? (-d === 1 ? tr('1 day late') : tr('{n} days late', { n: -d })) : d === 0 ? tr('Due today') : d === 1 ? tr('Due tomorrow') : tr('Due {date}', { date: shortDate(t.dueDate) });
      tone = d < 0 ? 'bad' : d <= 2 ? 'warn' : '';
    }
    if (t.issuedOn && t.dueDate) {
      const planned = Math.max(1, daysBetween(t.issuedOn, t.dueDate)), gone = Math.max(0, daysBetween(t.issuedOn, today));
      frac = Math.max(0.04, Math.min(1, gone / planned));
      barTone = t.overdue ? 'bad' : frac >= 0.75 ? 'warn' : 'ok';
      barText = tr('{a} gone, {b} planned', { a: daysWord(gone), b: daysWord(planned) });
    }
  }
  return (
    <button type="button" className={'wop-card wpx-card is-' + t.status + (mode !== 'done' && t.overdue ? ' is-late' : '')} onClick={() => onOpen(t)}>
      <span className="wop-card-top">
        <span className="wop-no">{t.number}</span>
        {t.priority === 'high' && <span className="wop-hot">{codeLabel('high')}</span>}
        <span className="wop-st"><span className="wpx-glyph"><StatusGlyph status={t.status} /></span>{woStatusLabel(t.status)}</span>
      </span>
      <strong className="wop-card-title">{t.title}</strong>
      <span className="wpx-card-meta">
        {forName(t) && <span className="wop-for"><ForBadge name={forName(t)} /><span>{forName(t)}</span></span>}
        {what && <span className="wpx-what">{what}</span>}
      </span>
      <span className={'wop-when is-' + (tone || 'plain')}>
        {when}
        {mode === 'done' && t.onTime === false && <b>{tr('finished late')}</b>}
        {mode === 'done' && t.onTime !== false && t.dueDate && <b>{tr('on time')}</b>}
      </span>
      {frac !== null && <span className={'wpx-bar is-' + barTone}><i style={{ width: Math.round(frac * 100) + '%' }} /></span>}
      {barText && <span className="wpx-bar-text">{barText}</span>}
      <span className="wop-people">
        {t.projectManager ? <Photo id={t.projectManager.id} name={t.projectManager.name} photo={t.projectManager.photo} size={22} /> : null}
        <span>{pm ? tr('PM {name}', { name: pm }) : tr('No project manager')}</span>
        {mode !== 'done' && nextLabel(t.status) ? <em>{tr('Next: {step}', { step: nextLabel(t.status) })}</em> : <Faces people={team} max={3} />}
      </span>
    </button>
  );
}

function Bars({ items, max }) {
  return (
    <ul className="wop-bars">
      {items.map((it) => (
        <li key={it.key} className={'wop-sbar is-' + it.key}>
          <span className="wop-sbar-label">{it.label}</span>
          <span className="wop-sbar-track"><span style={{ width: (max ? Math.max(it.n ? 3 : 0, (it.n / max) * 100) : 0) + '%' }} /></span>
          <b>{it.n}</b>
        </li>
      ))}
    </ul>
  );
}

const MEDAL = ['is-gold', 'is-silver', 'is-bronze'];
// The highlights' pictures.
const HL_ICON = {
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" />,
  box: <><path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" /><path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9" /></>,
  cal: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M9 14h2M13 14h2M9 17h2" /></>,
  home: <><path d="M4 20V9l8-5 8 5v11" /><path d="M9.5 20v-6h5v6" /></>,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z" />,
  fire: <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.3 2.2-5.3 3.6-7.4.4 1.7 1.3 2.8 2.4 3.4C11.2 7.6 12.4 5 15 3c.2 2.6 1.4 4.3 2.5 5.9 1 1.5 1.5 3 1.5 4.8 0 4.2-3 7.3-7 7.3z" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>
};

export default function WorkOrdersPresent({ wos, scopeName, onClose, onOpen, paused }) {
  const today = isoDay(new Date());
  const thisMonday = monday(today);
  const [weekFrom, setWeekFrom] = useState(thisMonday);
  const weekTo = addDays(weekFrom, 6);
  const nextFrom = addDays(weekTo, 1), nextTo = addDays(weekTo, 7);

  const data = useMemo(() => {
    const doneIn = (from, to) => wos.filter((t) => t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= from && dayOf(t.completedAt) <= to);
    const done = doneIn(weekFrom, weekTo).sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
    const late = done.filter((t) => t.onTime === false);
    const before = doneIn(addDays(weekFrom, -7), addDays(weekFrom, -1));
    const issued = wos.filter((t) => t.issuedOn && t.issuedOn >= weekFrom && t.issuedOn <= weekTo);
    const issuedBefore = wos.filter((t) => t.issuedOn && t.issuedOn >= addDays(weekFrom, -7) && t.issuedOn <= addDays(weekFrom, -1));
    const open = wos.filter(WO_OPEN).sort((a, b) => {
      if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
      if (!a.dueDate !== !b.dueDate) return a.dueDate ? -1 : 1;
      return String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || (a.number || '').localeCompare(b.number || '');
    });
    const process = open.filter((t) => IN_PROCESS.includes(t.status));
    const pending = open.filter((t) => !IN_PROCESS.includes(t.status));
    const overdue = open.filter((t) => t.overdue).sort((a, b) => (b.daysOverdue || 0) - (a.daysOverdue || 0));
    const dueNext = open.filter((t) => !t.overdue && t.dueDate && t.dueDate >= nextFrom && t.dueDate <= nextTo);
    const part = (list, statuses) => ({
      list,
      late: list.filter((t) => t.overdue).length,
      dueNext: list.filter((t) => !t.overdue && t.dueDate && t.dueDate >= nextFrom && t.dueDate <= nextTo).length,
      oldest: list.filter((t) => t.issuedOn).sort((a, b) => a.issuedOn.localeCompare(b.issuedOn))[0] || null,
      byStatus: statuses.map((st) => ({ key: st, label: woStatusLabel(st), n: list.filter((t) => t.status === st).length }))
    });
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekFrom, i);
      return { key: d, label: weekday(d), n: done.filter((t) => dayOf(t.completedAt) === d).length };
    });
    // The 8 weeks up to this one.
    const trend = Array.from({ length: 8 }, (_, i) => {
      const from = addDays(weekFrom, -7 * (7 - i)), to = addDays(from, 6);
      const d = doneIn(from, to);
      return { from, done: d.length, onTime: d.filter((t) => t.onTime !== false).length, issued: wos.filter((t) => t.issuedOn && t.issuedOn >= from && t.issuedOn <= to).length };
    });
    // Weeks in a row, up to this one, with something completed.
    let streak = 0;
    for (let w = weekFrom; streak < 104; w = addDays(w, -7)) { if (doneIn(w, addDays(w, 6)).length) streak++; else break; }
    // Project managers.
    const people = {};
    wos.forEach((t) => {
      const pm = pmOf(t);
      if (!pm) return;
      const inDone = done.includes(t), isOpen = WO_OPEN(t);
      if (!inDone && !isOpen) return;
      const p = people[pm] || (people[pm] = { name: pm, person: t.projectManager || null, done: 0, onTime: 0, process: 0, pending: 0, late: 0 });
      if (inDone) { p.done++; if (t.onTime !== false) p.onTime++; }
      if (isOpen) { if (IN_PROCESS.includes(t.status)) p.process++; else p.pending++; if (t.overdue) p.late++; }
    });
    const pms = Object.values(people).sort((a, b) => b.done - a.done || b.onTime - a.onTime || (b.process + b.pending) - (a.process + a.pending) || a.name.localeCompare(b.name));
    // Who the work was for.
    const fors = {};
    wos.forEach((t) => {
      const who = forName(t);
      if (!who) return;
      const inDone = done.includes(t), isOpen = WO_OPEN(t);
      if (!inDone && !isOpen) return;
      const f = fors[who] || (fors[who] = { name: who, done: 0, open: 0, late: 0 });
      if (inDone) f.done++;
      if (isOpen) { f.open++; if (t.overdue) f.late++; }
    });
    const forList = Object.values(fors).sort((a, b) => (b.done + b.open) - (a.done + a.open) || a.name.localeCompare(b.name));
    // The people who made what was completed.
    const makers = {};
    done.forEach((t) => (t.assignees || []).forEach((a) => { (makers[a.id] = makers[a.id] || { ...a, n: 0 }).n++; }));
    // Highlights.
    const fastest = done.filter((t) => t.daysToClose !== null && t.daysToClose !== undefined).sort((a, b) => a.daysToClose - b.daysToClose || String(a.completedAt).localeCompare(String(b.completedAt)))[0] || null;
    const biggest = done.filter((t) => qtyOf(t)).sort((a, b) => qtyOf(b) - qtyOf(a))[0] || null;
    const busiest = days.slice().sort((a, b) => b.n - a.n)[0];
    const topFor = forList.filter((f) => f.done).sort((a, b) => b.done - a.done)[0] || null;
    const star = pms.filter((p) => p.done)[0] || null;
    const oldest = open.filter((t) => t.daysOpen !== null && t.daysOpen !== undefined).sort((a, b) => b.daysOpen - a.daysOpen)[0] || null;
    const next = Array.from({ length: 7 }, (_, i) => { const d = addDays(nextFrom, i); return { key: d, list: dueNext.filter((t) => t.dueDate === d) }; });
    return {
      done, late, before, issued, issuedBefore, open, overdue, dueNext, days, trend, streak, pms, forList, next,
      makers: Object.values(makers).sort((a, b) => b.n - a.n),
      process: part(process, IN_PROCESS), pending: part(pending, PENDING.concat(WO_STATUSES.filter((st) => st !== 'completed' && st !== 'cancelled' && !IN_PROCESS.includes(st) && !PENDING.includes(st)))),
      flow: FLOW.map((st) => ({ key: st, n: open.filter((t) => t.status === st).length, late: open.filter((t) => t.status === st && t.overdue).length })),
      median: median(done.map((t) => t.daysToClose).filter((n) => n !== null && n !== undefined)),
      hl: { fastest, biggest, busiest: busiest && busiest.n ? busiest : null, topFor, star, oldest }
    };
  }, [wos, weekFrom, weekTo, nextFrom, nextTo]);

  const slides = useMemo(() => {
    const s = [{ key: 'cover', kind: 'cover' }];
    if (data.done.length || data.open.length) s.push({ key: 'highlights', kind: 'highlights' });
    s.push({ key: 'trend', kind: 'trend' });
    s.push({ key: 'done-sum', kind: 'done-sum' });
    chunk(data.done, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'done-' + i, kind: 'list', mode: 'done', list, page: i + 1, pages: all.length }));
    if (data.open.length) s.push({ key: 'flow', kind: 'flow' });
    ['process', 'pending'].forEach((g) => {
      s.push({ key: g + '-sum', kind: 'open-sum', group: g });
      chunk(data[g].list, PER_SLIDE).forEach((list, i, all) => s.push({ key: g + '-' + i, kind: 'list', mode: g, list, page: i + 1, pages: all.length }));
    });
    if (data.overdue.length) s.push({ key: 'push', kind: 'push' });
    if (data.forList.length) s.push({ key: 'for', kind: 'for' });
    if (data.pms.length) s.push({ key: 'people', kind: 'people' });
    s.push({ key: 'next', kind: 'next' }, { key: 'end', kind: 'end' });
    return s;
  }, [data]);
  const weeks = recentWeeks(thisMonday);
  const range = weekLabel(weekFrom, weekTo);
  const onTimeN = data.done.length - data.late.length;
  const pct = data.done.length ? Math.round((onTimeN / data.done.length) * 100) : null;

  function render(sl) {
    if (sl.kind === 'cover') {
      const mood = !data.done.length ? tr('A quiet week on the floor.')
        : pct >= 80 ? tr('A strong week: {n} completed, {k} of them on time.', { n: data.done.length, k: onTimeN })
          : tr('{n} completed this week, {k} of them on time.', { n: data.done.length, k: onTimeN });
      return (
        <div className="wop-cover wpx-cover">
          <span className="wpx-orb is-a" aria-hidden="true" /><span className="wpx-orb is-b" aria-hidden="true" /><span className="wpx-orb is-c" aria-hidden="true" />
          <div className="wpx-cover-top">
            <div>
              <span className="wop-eyebrow">{tr('Saturday review')} · {scopeName}</span>
              <h1>{tr('Work orders this week')}</h1>
              <p className="wop-range">{range}</p>
              <p className="wpx-mood">{mood}</p>
            </div>
            <Ring pct={pct} label={tr('on time')} />
          </div>
          <div className="wop-tiles">
            <div className="wop-tile is-good"><b><CountUp value={data.done.length} /></b><span>{tr('completed this week')}</span><Delta now={data.done.length} before={data.before.length} /></div>
            <div className="wop-tile is-open"><b><CountUp value={data.process.list.length} /></b><span>{tr('in process')}</span><span className="wpx-delta">{data.process.dueNext ? tr('{n} due next week', { n: data.process.dueNext }) : ' '}</span></div>
            <div className="wop-tile is-pend"><b><CountUp value={data.pending.list.length} /></b><span>{tr('pending')}</span><span className="wpx-delta">{tr('{n} new this week', { n: data.issued.length })}</span></div>
            <div className={'wop-tile' + (data.overdue.length ? ' is-bad' : ' is-good')}><b><CountUp value={data.overdue.length} /></b><span>{tr('late, in process or pending')}</span><span className="wpx-delta">{data.overdue.length ? tr('the longest {n} late', { n: daysWord(data.overdue[0].daysOverdue || 0) }) : tr('nothing late')}</span></div>
          </div>
        </div>
      );
    }
    if (sl.kind === 'highlights') {
      const h = data.hl;
      const cards = [
        h.fastest && { key: 'fast', icon: 'bolt', tone: 'good', label: tr('Fastest finish'), value: h.fastest.daysToClose === 0 ? tr('Same day') : daysWord(h.fastest.daysToClose), sub: h.fastest.number + ' · ' + h.fastest.title, t: h.fastest },
        h.biggest && { key: 'big', icon: 'box', tone: 'open', label: tr('Biggest order'), value: h.biggest.quantity, sub: h.biggest.number + ' · ' + (whatOf(h.biggest) || h.biggest.title), t: h.biggest },
        h.busiest && { key: 'day', icon: 'cal', tone: 'warn', label: tr('Busiest day'), value: weekday(h.busiest.key, 'long'), sub: h.busiest.n === 1 ? tr('1 completed') : tr('{n} completed', { n: h.busiest.n }) },
        h.topFor && { key: 'for', icon: 'home', tone: 'violet', label: tr('Top customer'), value: h.topFor.name, sub: h.topFor.done === 1 ? tr('1 completed for them') : tr('{n} completed for them', { n: h.topFor.done }) },
        h.star && { key: 'star', icon: 'star', tone: 'gold', label: tr('Star project manager'), value: h.star.name, sub: tr('{n} completed, {k} on time', { n: h.star.done, k: h.star.onTime }), person: h.star.person },
        { key: 'streak', icon: 'fire', tone: data.streak ? 'hot' : 'muted', label: tr('Weeks in a row'), value: String(data.streak), sub: data.streak ? tr('with work orders completed') : tr('nothing completed this week') },
        h.oldest && { key: 'old', icon: 'clock', tone: 'bad', label: tr('Longest running'), value: daysWord(h.oldest.daysOpen), sub: h.oldest.number + ' · ' + h.oldest.title, t: h.oldest }
      ].filter(Boolean).slice(0, 6);
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-good">{tr('Highlights')}</span><h2>{tr('The week in highlights')}</h2></header>
          <div className="wpx-hl">
            {cards.map((c, i) => {
              const Tag = c.t ? 'button' : 'div';
              return (
                <Tag key={c.key} type={c.t ? 'button' : undefined} className={'wpx-hl-card is-' + c.tone} style={{ '--d': i }} onClick={c.t ? () => onOpen(c.t) : undefined}>
                  <span className="wpx-hl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{HL_ICON[c.icon]}</svg></span>
                  <small>{c.label}</small>
                  <b>{c.person ? <span className="wpx-hl-person"><Photo id={c.person.id} name={c.person.name} photo={c.person.photo} size={34} />{c.value}</span> : c.value}</b>
                  <span>{c.sub}</span>
                </Tag>
              );
            })}
          </div>
        </div>
      );
    }
    if (sl.kind === 'trend') {
      const max = Math.max(1, ...data.trend.map((w) => Math.max(w.done, w.issued)));
      const best = data.trend.slice().sort((a, b) => b.done - a.done)[0];
      const avg = Math.round((data.trend.reduce((a, w) => a + w.done, 0) / data.trend.length) * 10) / 10;
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-open">{tr('The last 8 weeks')}</span>
            <h2>{tr('Completed and issued, week by week')}</h2>
          </header>
          <div className="wop-sum-grid">
            <section className="wop-panel">
              <div className="wpx-cols" role="img" aria-label={data.trend.map((w) => dayNum(w.from) + ': ' + w.done + ' / ' + w.issued).join(', ')}>
                {data.trend.map((w) => (
                  <span key={w.from} className={'wpx-col' + (w.from === weekFrom ? ' is-now' : '')}>
                    <span className="wpx-pair">
                      <i className="is-done" style={{ height: (w.done / max) * 86 + '%' }}><b>{w.done || ''}</b></i>
                      <i className="is-issued" style={{ height: (w.issued / max) * 86 + '%' }}><b>{w.issued || ''}</b></i>
                    </span>
                    <small>{dayNum(w.from)}</small>
                  </span>
                ))}
              </div>
              <ul className="wpx-key"><li><i className="is-done" />{tr('Completed')}</li><li><i className="is-issued" />{tr('Issued')}</li></ul>
            </section>
            <section className="wop-panel wop-facts">
              <div className="wop-fact"><b><CountUp value={data.done.length} /></b><span>{tr('completed this week')} · <Delta now={data.done.length} before={data.before.length} /></span></div>
              <div className="wop-fact"><b>{avg.toLocaleString(activeIntlLocale())}</b><span>{tr('a week on average, over the 8 weeks')}</span></div>
              <div className="wop-fact is-warn"><b>{best.done}</b><span>{tr('the best week: {date}', { date: weekLabel(best.from, addDays(best.from, 6)) })}</span></div>
              <div className="wop-fact"><b><CountUp value={data.issued.length} /></b><span>{tr('issued this week')} · <Delta now={data.issued.length} before={data.issuedBefore.length} /></span></div>
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'done-sum') {
      const max = Math.max(1, ...data.days.map((d) => d.n));
      const makers = data.makers;
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-good">{tr('Completed this week')}</span><h2>{data.done.length === 1 ? tr('1 work order completed') : tr('{n} work orders completed', { n: data.done.length })}</h2></header>
          {!data.done.length ? <p className="wop-empty">{tr('No work orders were completed this week.')}</p> : (
            <div className="wpx-three">
              <section className="wop-panel">
                <h3>{tr('Completed each day')}</h3>
                <div className="wop-days" role="img" aria-label={data.days.map((d) => d.label + ' ' + d.n).join(', ')}>
                  {data.days.map((d) => (
                    <span key={d.key} className={'wop-day' + (d.key === today ? ' is-today' : '')}>
                      <b>{d.n || ''}</b>
                      <i style={{ height: (d.n / max) * 100 + '%' }} />
                      <small>{d.label}</small>
                    </span>
                  ))}
                </div>
              </section>
              <section className="wop-panel wpx-center">
                <h3>{tr('On time or late')}</h3>
                <Ring pct={pct} label={tr('{a} on time · {b} late', { a: onTimeN, b: data.late.length })} />
                {data.median !== null && <p className="wop-note">{data.median === 1 ? tr('Half were done within 1 day of being issued.') : tr('Half were done within {n} days of being issued.', { n: data.median })}</p>}
              </section>
              <section className="wop-panel">
                <h3>{tr('Who made them')}</h3>
                {makers.length ? (
                  <ul className="wpx-makers">
                    {makers.slice(0, 6).map((m) => <li key={m.id}><Photo id={m.id} name={m.name} photo={m.photo} size={30} /><span>{m.name}</span><b>{m.n}</b></li>)}
                    {makers.length > 6 && <li className="ssr-more">{tr('and {n} more', { n: makers.length - 6 })}</li>}
                  </ul>
                ) : <p className="wop-note">{tr('No team was put on them.')}</p>}
              </section>
            </div>
          )}
        </div>
      );
    }
    if (sl.kind === 'flow') {
      const max = Math.max(1, ...data.flow.map((f) => f.n));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-open">{tr('Where everything is')}</span>
            <h2>{data.open.length === 1 ? tr('1 open work order, step by step') : tr('{n} open work orders, step by step', { n: data.open.length })}</h2>
            <p className="wop-sub">{tr('From being talked over to being checked, then completed.')}</p>
          </header>
          <div className="wpx-flow">
            {data.flow.map((f, i) => (
              <div key={f.key} className={'wpx-step is-' + f.key + (f.n ? '' : ' is-empty')} style={{ '--d': i }}>
                <span className="wpx-step-glyph"><StatusGlyph status={f.key} /></span>
                <b><CountUp value={f.n} /></b>
                <strong>{woStatusLabel(f.key)}</strong>
                <small>{colHint(f.key)}</small>
                <span className="wpx-step-bar"><i style={{ height: (f.n / max) * 100 + '%' }} /></span>
                {f.late > 0 && <em>{f.late === 1 ? tr('1 past due') : tr('{n} past due', { n: f.late })}</em>}
              </div>
            ))}
            <div className="wpx-step is-completed is-goal" style={{ '--d': FLOW.length }}>
              <span className="wpx-step-glyph"><StatusGlyph status="completed" /></span>
              <b><CountUp value={data.done.length} /></b>
              <strong>{tr('Completed this week')}</strong>
              <small>{pct === null ? '' : tr('{pct}% on time', { pct })}</small>
            </div>
          </div>
        </div>
      );
    }
    if (sl.kind === 'open-sum') {
      const g = data[sl.group], proc = sl.group === 'process';
      const max = Math.max(1, ...g.byStatus.map((x) => x.n));
      const shown = g.byStatus.filter((x) => x.n || IN_PROCESS.includes(x.key) || PENDING.includes(x.key));
      const soonN = Math.max(2, 6 - shown.length);
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className={'wop-eyebrow ' + (proc ? 'is-open' : 'is-pend')}>{proc ? tr('In process') : tr('Pending')}</span>
            <h2>{proc ? (g.list.length === 1 ? tr('1 work order in process') : tr('{n} work orders in process', { n: g.list.length }))
              : (g.list.length === 1 ? tr('1 work order pending') : tr('{n} work orders pending', { n: g.list.length }))}</h2>
            <p className="wop-sub">{proc ? tr('Being made now, or made and waiting for their check.') : tr('Not started yet or held up: still being discussed, issued, waiting for material or suspended.')}</p>
          </header>
          {!g.list.length ? <p className="wop-empty">{proc ? tr('Nothing in process right now.') : tr('Nothing pending.')}</p> : (
            <div className="wop-sum-grid">
              <section className="wop-panel">
                <h3>{tr('Where they are')}</h3>
                <Bars items={shown} max={max} />
                <h3 className="wpx-h3-gap">{tr('Due soonest')}</h3>
                <ul className="wpx-soon">
                  {g.list.filter((t) => t.dueDate).slice(0, soonN).map((t) => (
                    <li key={t.id}><button type="button" className={'is-' + t.status} onClick={() => onOpen(t)}>
                      <span className="wop-no">{t.number}</span>
                      <span className="wpx-soon-main"><strong>{t.title}</strong><small>{[forName(t), pmOf(t) ? tr('PM {name}', { name: pmOf(t) }) : null].filter(Boolean).join(' · ')}</small></span>
                      <em className={t.overdue ? 'is-bad' : ''}>{t.overdue ? ((t.daysOverdue || 0) === 1 ? tr('1 day late') : tr('{n} days late', { n: t.daysOverdue || 0 })) : shortDate(t.dueDate)}</em>
                    </button></li>
                  ))}
                </ul>
              </section>
              <section className="wop-panel wop-facts">
                <div className={'wop-fact' + (g.late ? ' is-bad' : '')}><b><CountUp value={g.late} /></b><span>{tr('late: past their date due')}</span></div>
                <div className="wop-fact is-warn"><b><CountUp value={g.dueNext} /></b><span>{tr('due next week ({dates})', { dates: weekLabel(nextFrom, nextTo) })}</span></div>
                {g.oldest && <div className="wop-fact"><b>{daysBetween(g.oldest.issuedOn, today)}</b><span>{tr('days open: the oldest, {no} {title}', { no: g.oldest.number, title: g.oldest.title })}</span></div>}
              </section>
            </div>
          )}
        </div>
      );
    }
    if (sl.kind === 'list') {
      const done = sl.mode === 'done', proc = sl.mode === 'process';
      const lateFirst = sl.list.some((t) => t.overdue);
      return (
        <div className="wop-list">
          <header className="wop-head is-row">
            <span className={'wop-eyebrow ' + (done ? 'is-good' : proc ? 'is-open' : 'is-pend')}>{done ? tr('Completed this week') : proc ? tr('In process') : tr('Pending')}</span>
            <h2>{done ? tr('Completed') : proc ? (lateFirst ? tr('In process: late ones first') : tr('In process: soonest due first'))
              : (lateFirst ? tr('Pending: late ones first') : tr('Pending: soonest due first'))}</h2>
            {sl.pages > 1 && <span className="wop-page">{tr('{a} of {b}', { a: sl.page, b: sl.pages })}</span>}
          </header>
          <div className="wop-cards wpx-cards">
            {sl.list.map((t, i) => <div key={t.id} className="wpx-in" style={{ '--d': i }}><PCard t={t} today={today} mode={done ? 'done' : sl.mode} onOpen={onOpen} /></div>)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'push') {
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow wpx-eb-bad">{tr('Needs a push')}</span>
            <h2>{data.overdue.length === 1 ? tr('1 work order is late') : tr('{n} work orders are late', { n: data.overdue.length })}</h2>
            <p className="wop-sub">{tr('The longest late first, with who has it and the next step.')}</p>
          </header>
          <ul className="wpx-push">
            {data.overdue.slice(0, 6).map((t, i) => (
              <li key={t.id} style={{ '--d': i }}><button type="button" onClick={() => onOpen(t)}>
                <span className="wpx-push-days"><b>{t.daysOverdue || 0}</b><small>{(t.daysOverdue || 0) === 1 ? tr('day late') : tr('days late')}</small></span>
                <span className="wpx-push-main">
                  <strong><span className="wop-no">{t.number}</span>{t.title}</strong>
                  <small>{[forName(t), woStatusLabel(t.status), pmOf(t) ? tr('PM {name}', { name: pmOf(t) }) : tr('No project manager'), t.dueDate ? tr('was due {date}', { date: shortDate(t.dueDate) }) : null].filter(Boolean).join(' · ')}</small>
                </span>
                {nextLabel(t.status) && <em>{tr('Next: {step}', { step: nextLabel(t.status) })}</em>}
              </button></li>
            ))}
          </ul>
          {data.overdue.length > 6 && <p className="wop-note">{tr('and {n} more late', { n: data.overdue.length - 6 })}</p>}
        </div>
      );
    }
    if (sl.kind === 'for') {
      const list = data.forList.slice(0, 7);
      const max = Math.max(1, ...list.map((f) => f.done + f.open));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow wpx-eb-violet">{tr('Who we worked for')}</span>
            <h2>{tr('Customers and companies')}</h2>
            <p className="wop-sub">{tr('Completed this week, and still open.')}</p>
          </header>
          <ul className="wpx-for">
            {list.map((f, i) => (
              <li key={f.name} style={{ '--d': i }}>
                <span className="wpx-for-name"><ForBadge name={f.name} /><span>{f.name}</span></span>
                <span className="wpx-for-track">
                  <i className="is-done" style={{ width: (f.done / max) * 100 + '%' }} />
                  <i className="is-open" style={{ width: (f.open / max) * 100 + '%' }} />
                </span>
                <span className="wpx-for-n">{tr('{a} completed · {b} open', { a: f.done, b: f.open })}{f.late ? <em> · {tr('{n} past due', { n: f.late })}</em> : null}</span>
              </li>
            ))}
          </ul>
          <ul className="wpx-key"><li><i className="is-done" />{tr('Completed this week')}</li><li><i className="is-open" />{tr('Still open')}</li></ul>
          {data.forList.length > 7 && <p className="wop-note">{tr('and {n} more', { n: data.forList.length - 7 })}</p>}
        </div>
      );
    }
    if (sl.kind === 'people') {
      const podium = data.pms.filter((p) => p.done).slice(0, 3);
      const order = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium;
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-pend">{tr('Project managers')}</span><h2>{tr('Who has what')}</h2></header>
          <div className={'wpx-team' + (podium.length ? '' : ' is-flat')}>
            {podium.length > 0 && (
              <div className="wpx-podium">
                {order.map((p) => {
                  const place = podium.indexOf(p);
                  return (
                    <div key={p.name} className={'wpx-place ' + MEDAL[place]}>
                      {p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={place === 0 ? 64 : 52} /> : <span className="wpx-noface">{p.name.slice(0, 1)}</span>}
                      <strong>{p.name}</strong>
                      <span>{p.done === 1 ? tr('1 completed') : tr('{n} completed', { n: p.done })}</span>
                      <div className="wpx-block"><b>{place + 1}</b></div>
                    </div>
                  );
                })}
              </div>
            )}
            <table className="wop-table">
              <thead><tr><th>{tr('Project manager')}</th><th>{tr('Completed')}</th><th>{tr('On time')}</th><th>{tr('In process')}</th><th>{tr('Pending')}</th><th>{tr('Overdue')}</th></tr></thead>
              <tbody>
                {data.pms.slice(0, podium.length ? 6 : 8).map((p) => (
                  <tr key={p.name}>
                    <td><span className="wop-pm">{p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={26} /> : null}{p.name}</span></td>
                    <td><b className="is-good">{p.done}</b></td>
                    <td>{p.done ? <b className={p.onTime < p.done ? 'is-bad' : 'is-good'}>{Math.round((p.onTime / p.done) * 100)}%</b> : <span className="wop-zero">—</span>}</td>
                    <td><b>{p.process}</b></td>
                    <td><b>{p.pending}</b></td>
                    <td>{p.late ? <b className="is-bad">{p.late}</b> : <span className="wop-zero">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.pms.length > (podium.length ? 6 : 8) && <p className="wop-note">{tr('and {n} more', { n: data.pms.length - (podium.length ? 6 : 8) })}</p>}
        </div>
      );
    }
    if (sl.kind === 'next') {
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-pend">{tr('Next week')}</span>
            <h2>{data.dueNext.length === 1 ? tr('1 work order due: {dates}', { dates: weekLabel(nextFrom, nextTo) }) : tr('{n} work orders due: {dates}', { n: data.dueNext.length, dates: weekLabel(nextFrom, nextTo) })}</h2>
            <p className="wop-sub">{data.overdue.length ? (data.overdue.length === 1 ? tr('Plus 1 already late to bring back on track.') : tr('Plus {n} already late to bring back on track.', { n: data.overdue.length })) : tr('Nothing late is carried over.')}</p>
          </header>
          <div className="wpx-week">
            {data.next.map((d, i) => (
              <div key={d.key} className={'wpx-wday' + (d.list.length ? ' is-busy' : '')} style={{ '--d': i }}>
                <span className="wpx-wday-head"><b>{weekday(d.key)}</b><small>{dayNum(d.key)}</small></span>
                {d.list.slice(0, 3).map((t) => (
                  <button key={t.id} type="button" className={'wpx-chip is-' + t.status} onClick={() => onOpen(t)}>
                    <span className="wop-no">{t.number}</span><span className="wpx-chip-title">{t.title}</span>
                    <small>{[forName(t), pmOf(t)].filter(Boolean).join(' · ')}</small>
                  </button>
                ))}
                {d.list.length > 3 && <span className="wpx-more">{tr('+{n} more', { n: d.list.length - 3 })}</span>}
                {!d.list.length && <span className="wpx-free">{tr('Nothing due')}</span>}
              </div>
            ))}
          </div>
        </div>
      );
    }
    const good = data.done.length && pct >= 80 && !data.overdue.length;
    const shout = [
      data.hl.star ? tr('Star project manager: {name}', { name: data.hl.star.name }) : null,
      data.hl.fastest ? tr('Fastest finish: {no}, {days}', { no: data.hl.fastest.number, days: data.hl.fastest.daysToClose === 0 ? tr('the same day') : daysWord(data.hl.fastest.daysToClose) }) : null,
      data.makers[0] ? tr('Most hands-on: {name}', { name: data.makers[0].name }) : null
    ].filter(Boolean);
    return (
      <div className="wop-cover is-end wpx-end">
        <span className="wpx-orb is-a" aria-hidden="true" /><span className="wpx-orb is-b" aria-hidden="true" />
        {good ? <span className="wpx-confetti" aria-hidden="true">{Array.from({ length: 36 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</span> : null}
        <span className="wop-eyebrow">{tr('Saturday review')} · {range}</span>
        <h1>{tr('Thank you, team')}</h1>
        {shout.length > 0 && <ul className="wpx-shout">{shout.map((s) => <li key={s}>{s}</li>)}</ul>}
        <p className="wop-range">{data.overdue.length ? tr('This week, bring the {n} late work orders back on track.', { n: data.overdue.length }) : tr('Nothing is late. Keep it that way next week.')}</p>
      </div>
    );
  }

  return (
    <SlideDeck brand={tr('Saturday review')} className="is-wo" weeks={weeks} weekFrom={weekFrom} onWeek={setWeekFrom}
      slides={slides} render={render} onClose={onClose} paused={paused} />
  );
}
