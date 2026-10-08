import { useEffect, useMemo, useRef, useState } from 'react';
import PrintLayer from '../components/PrintLayer';
import Photo from '../components/Photo';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { WO_OPEN, WO_STATUSES, woStatusLabel } from '../lib/workOrders.js';
import { ForBadge, addDays, daysBetween, forName, isoDay, nextLabel, pmOf, shortDate } from './WorkOrdersFun';
import './WorkOrdersPresent.css';

// The Saturday review: the week's work orders as slides to show on a
// screen — what was completed this week, and what is still pending, late
// ones first — with the numbers that sum them up. Arrow keys or the
// buttons move through it; F is full screen; it prints one slide a page.
// A card opens its work order over the slides (onOpen).

const PER_SLIDE = 6;
function dayOf(ts) { return ts ? isoDay(new Date(ts)) : null; }
function monday(iso) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); }
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
function median(nums) { if (!nums.length) return null; const s = nums.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
function weekLabel(from, to) {
  const a = new Date(from + 'T00:00'), b = new Date(to + 'T00:00');
  const loc = activeIntlLocale();
  const end = b.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  return a.getMonth() === b.getMonth() && !/^(zh|ja)/.test(loc)
    ? a.toLocaleDateString(loc, { day: 'numeric' }) + ' – ' + end
    : a.toLocaleDateString(loc, { day: 'numeric', month: 'long' }) + ' – ' + end;
}

// One work order on a slide.
function PCard({ t, today, mode, onOpen }) {
  const pm = pmOf(t);
  let when, tone = '';
  if (mode === 'done') {
    const days = t.daysToClose;
    when = [tr('Done {date}', { date: shortDate(dayOf(t.completedAt)) }), days !== null && days !== undefined ? (days === 1 ? tr('1 day') : tr('{n} days', { n: days })) : null].filter(Boolean).join(' · ');
    tone = t.onTime === false ? 'bad' : 'good';
  } else if (!t.dueDate) {
    when = tr('No due date');
  } else {
    const d = daysBetween(today, t.dueDate);
    when = d < 0 ? (-d === 1 ? tr('1 day late') : tr('{n} days late', { n: -d })) : d === 0 ? tr('Due today') : d === 1 ? tr('Due tomorrow') : tr('Due {date}', { date: shortDate(t.dueDate) });
    tone = d < 0 ? 'bad' : d <= 2 ? 'warn' : '';
  }
  return (
    <button type="button" className={'wop-card is-' + t.status + (mode === 'pending' && t.overdue ? ' is-late' : '')} onClick={() => onOpen(t)}>
      <span className="wop-card-top">
        <span className="wop-no">{t.number}</span>
        {t.priority === 'high' && <span className="wop-hot">{codeLabel('high')}</span>}
        <span className="wop-st"><i aria-hidden="true" />{woStatusLabel(t.status)}</span>
      </span>
      <strong className="wop-card-title">{t.title}</strong>
      {forName(t) && <span className="wop-for"><ForBadge name={forName(t)} /><span>{forName(t)}</span></span>}
      <span className={'wop-when is-' + (tone || 'plain')}>
        {when}
        {mode === 'done' && t.onTime === false && <b>{tr('late')}</b>}
        {mode === 'done' && t.onTime !== false && t.dueDate && <b>{tr('on time')}</b>}
      </span>
      <span className="wop-people">
        {t.projectManager ? <Photo id={t.projectManager.id} name={t.projectManager.name} photo={t.projectManager.photo} size={22} /> : null}
        <span>{pm ? tr('PM {name}', { name: pm }) : tr('No project manager')}</span>
        {mode === 'pending' && nextLabel(t.status) && <em>{tr('Next: {step}', { step: nextLabel(t.status) })}</em>}
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

export default function WorkOrdersPresent({ wos, scopeName, onClose, onOpen, paused }) {
  const today = isoDay(new Date());
  const thisMonday = monday(today);
  const [weekFrom, setWeekFrom] = useState(thisMonday);
  const [at, setAt] = useState(0);
  const [printing, setPrinting] = useState(false);
  const stageRef = useRef(null);
  const weekTo = addDays(weekFrom, 6);
  const nextFrom = addDays(weekTo, 1), nextTo = addDays(weekTo, 7);

  const data = useMemo(() => {
    const done = wos.filter((t) => t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= weekFrom && dayOf(t.completedAt) <= weekTo)
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
    const late = done.filter((t) => t.onTime === false);
    const issued = wos.filter((t) => t.issuedOn && t.issuedOn >= weekFrom && t.issuedOn <= weekTo);
    const pending = wos.filter(WO_OPEN).sort((a, b) => {
      if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
      if (!a.dueDate !== !b.dueDate) return a.dueDate ? -1 : 1;
      return String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || (a.number || '').localeCompare(b.number || '');
    });
    const overdue = pending.filter((t) => t.overdue);
    const dueNext = pending.filter((t) => !t.overdue && t.dueDate && t.dueDate >= nextFrom && t.dueDate <= nextTo);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekFrom, i);
      return { key: d, label: new Date(d + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short' }), n: done.filter((t) => dayOf(t.completedAt) === d).length };
    });
    const byStatus = WO_STATUSES.filter((s) => s !== 'completed' && s !== 'cancelled').map((s) => ({ key: s, label: woStatusLabel(s), n: pending.filter((t) => t.status === s).length })).filter((x) => x.n);
    const people = {};
    wos.forEach((t) => {
      const pm = pmOf(t);
      if (!pm) return;
      const inDone = done.includes(t), inPending = WO_OPEN(t);
      if (!inDone && !inPending) return;
      const p = people[pm] || (people[pm] = { name: pm, person: t.projectManager || null, done: 0, open: 0, late: 0 });
      if (inDone) p.done++;
      if (inPending) { p.open++; if (t.overdue) p.late++; }
    });
    const pms = Object.values(people).sort((a, b) => b.done - a.done || b.open - a.open || a.name.localeCompare(b.name));
    const oldest = pending.filter((t) => t.issuedOn).sort((a, b) => a.issuedOn.localeCompare(b.issuedOn))[0] || null;
    return { done, late, issued, pending, overdue, dueNext, days, byStatus, pms, oldest, median: median(done.map((t) => t.daysToClose).filter((n) => n !== null && n !== undefined)) };
  }, [wos, weekFrom, weekTo, nextFrom, nextTo]);

  const slides = useMemo(() => {
    const s = [{ key: 'cover', kind: 'cover' }];
    s.push({ key: 'done-sum', kind: 'done-sum' });
    chunk(data.done, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'done-' + i, kind: 'list', mode: 'done', list, page: i + 1, pages: all.length }));
    s.push({ key: 'pending-sum', kind: 'pending-sum' });
    chunk(data.pending, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'pending-' + i, kind: 'list', mode: 'pending', list, page: i + 1, pages: all.length }));
    if (data.pms.length) s.push({ key: 'people', kind: 'people' });
    s.push({ key: 'end', kind: 'end' });
    return s;
  }, [data]);
  const cur = Math.min(at, slides.length - 1);

  useEffect(() => { setAt(0); }, [weekFrom]);
  useEffect(() => {
    function onKey(e) {
      if (paused || e.target.closest('select, input, textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); setAt((i) => Math.min(i + 1, slides.length - 1)); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Home') setAt(0);
      else if (e.key === 'End') setAt(slides.length - 1);
      else if (e.key === 'Escape' && !document.fullscreenElement) onClose();
      else if (e.key === 'f' || e.key === 'F') fullScreen();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!printing) return undefined;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const id = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(id); window.removeEventListener('afterprint', done); };
  }, [printing]);

  // The whole page goes full screen, not only the slides, so a work order
  // opened from a card still shows over them.
  function fullScreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  const weeks = [0, 1, 2, 3].map((n) => {
    const from = addDays(thisMonday, -7 * n);
    return { from, label: n === 0 ? tr('This week ({dates})', { dates: weekLabel(from, addDays(from, 6)) }) : n === 1 ? tr('Last week ({dates})', { dates: weekLabel(from, addDays(from, 6)) }) : weekLabel(from, addDays(from, 6)) };
  });
  const range = weekLabel(weekFrom, weekTo);
  const pct = data.done.length ? Math.round(((data.done.length - data.late.length) / data.done.length) * 100) : null;

  function render(sl) {
    if (sl.kind === 'cover') {
      return (
        <div className="wop-cover">
          <span className="wop-eyebrow">{tr('Saturday review')} · {scopeName}</span>
          <h1>{tr('Work orders this week')}</h1>
          <p className="wop-range">{range}</p>
          <div className="wop-tiles">
            <div className="wop-tile is-good"><b>{data.done.length}</b><span>{tr('completed this week')}</span></div>
            <div className="wop-tile"><b>{pct === null ? '—' : pct + '%'}</b><span>{tr('of them on time')}</span></div>
            <div className="wop-tile is-open"><b>{data.pending.length}</b><span>{tr('still pending')}</span></div>
            <div className={'wop-tile' + (data.overdue.length ? ' is-bad' : '')}><b>{data.overdue.length}</b><span>{tr('of them late')}</span></div>
          </div>
          <p className="wop-foot">{(data.issued.length === 1 ? tr('1 new work order issued this week') : tr('{n} new work orders issued this week', { n: data.issued.length })) + ' · ' + (data.dueNext.length === 1 ? tr('1 due next week') : tr('{n} due next week', { n: data.dueNext.length }))}</p>
        </div>
      );
    }
    if (sl.kind === 'done-sum') {
      const max = Math.max(1, ...data.days.map((d) => d.n));
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-good">{tr('Completed this week')}</span><h2>{data.done.length === 1 ? tr('1 work order completed') : tr('{n} work orders completed', { n: data.done.length })}</h2></header>
          {!data.done.length ? <p className="wop-empty">{tr('No work orders were completed this week.')}</p> : (
            <div className="wop-sum-grid">
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
              <section className="wop-panel">
                <h3>{tr('On time or late')}</h3>
                <div className="wop-split" aria-hidden="true">
                  <span className="is-good" style={{ flex: data.done.length - data.late.length }} />
                  <span className="is-bad" style={{ flex: data.late.length }} />
                </div>
                <ul className="wop-legend">
                  <li><i className="is-good" />{tr('On time')} <b>{data.done.length - data.late.length}</b></li>
                  <li><i className="is-bad" />{tr('Late')} <b>{data.late.length}</b></li>
                </ul>
                {data.median !== null && <p className="wop-note">{data.median === 1 ? tr('Half were done within 1 day of being issued.') : tr('Half were done within {n} days of being issued.', { n: data.median })}</p>}
              </section>
            </div>
          )}
        </div>
      );
    }
    if (sl.kind === 'pending-sum') {
      const max = Math.max(1, ...data.byStatus.map((x) => x.n));
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow is-open">{tr('Still pending')}</span><h2>{data.pending.length === 1 ? tr('1 work order still pending') : tr('{n} work orders still pending', { n: data.pending.length })}</h2></header>
          {!data.pending.length ? <p className="wop-empty">{tr('Nothing pending. Every work order is finished.')}</p> : (
            <div className="wop-sum-grid">
              <section className="wop-panel">
                <h3>{tr('Where they are')}</h3>
                <Bars items={data.byStatus} max={max} />
              </section>
              <section className="wop-panel wop-facts">
                <div className={'wop-fact' + (data.overdue.length ? ' is-bad' : '')}><b>{data.overdue.length}</b><span>{tr('late: past their date due')}</span></div>
                <div className="wop-fact is-warn"><b>{data.dueNext.length}</b><span>{tr('due next week ({dates})', { dates: weekLabel(nextFrom, nextTo) })}</span></div>
                {data.oldest && <div className="wop-fact"><b>{daysBetween(data.oldest.issuedOn, today)}</b><span>{tr('days open: the oldest, {no} {title}', { no: data.oldest.number, title: data.oldest.title })}</span></div>}
              </section>
            </div>
          )}
        </div>
      );
    }
    if (sl.kind === 'list') {
      const done = sl.mode === 'done';
      return (
        <div className="wop-list">
          <header className="wop-head is-row">
            <span className={'wop-eyebrow ' + (done ? 'is-good' : 'is-open')}>{done ? tr('Completed this week') : tr('Still pending')}</span>
            <h2>{done ? tr('Completed') : sl.list.some((t) => t.overdue) ? tr('Pending: late ones first') : tr('Pending: soonest due first')}</h2>
            {sl.pages > 1 && <span className="wop-page">{tr('{a} of {b}', { a: sl.page, b: sl.pages })}</span>}
          </header>
          <div className="wop-cards">
            {sl.list.map((t) => <PCard key={t.id} t={t} today={today} mode={sl.mode} onOpen={onOpen} />)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'people') {
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow">{tr('Project managers')}</span><h2>{tr('Who has what')}</h2></header>
          <table className="wop-table">
            <thead><tr><th>{tr('Project manager')}</th><th>{tr('Completed this week')}</th><th>{tr('Still pending')}</th><th>{tr('Late')}</th></tr></thead>
            <tbody>
              {data.pms.slice(0, 8).map((p) => (
                <tr key={p.name}>
                  <td><span className="wop-pm">{p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={28} /> : null}{p.name}</span></td>
                  <td><b className="is-good">{p.done}</b></td>
                  <td><b>{p.open}</b></td>
                  <td>{p.late ? <b className="is-bad">{p.late}</b> : <span className="wop-zero">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.pms.length > 8 && <p className="wop-note">{tr('and {n} more', { n: data.pms.length - 8 })}</p>}
        </div>
      );
    }
    return (
      <div className="wop-cover is-end">
        <span className="wop-eyebrow">{tr('Saturday review')} · {range}</span>
        <h1>{tr('Thank you')}</h1>
        <p className="wop-range">{data.overdue.length ? tr('This week, bring the {n} late work orders back on track.', { n: data.overdue.length }) : tr('Nothing is late. Keep it that way next week.')}</p>
      </div>
    );
  }

  return (
    <PrintLayer>
      <div className={'wop' + (printing ? ' is-printing' : '')} ref={stageRef} role="dialog" aria-modal="true" aria-label={tr('Saturday review')}>
        <div className="wop-bar no-print">
          <strong className="wop-brand">{tr('Saturday review')}</strong>
          <select className="wop-week" value={weekFrom} onChange={(e) => setWeekFrom(e.target.value)} aria-label={tr('Which week')}>
            {weeks.map((w) => <option key={w.from} value={w.from}>{w.label}</option>)}
          </select>
          <span className="wop-fill" />
          <button type="button" className="wop-btn" onClick={fullScreen} title={tr('Full screen (F)')}>{tr('Full screen')}</button>
          <button type="button" className="wop-btn" onClick={() => setPrinting(true)}>{tr('Print or save as PDF')}</button>
          <button type="button" className="wop-btn is-close" onClick={onClose} aria-label={tr('Close')}>×</button>
        </div>
        {printing ? (
          <div className="wop-print">
            {slides.map((sl) => <section key={sl.key} className={'wop-slide is-' + sl.kind}>{render(sl)}</section>)}
          </div>
        ) : (
          <div className="wop-stage">
            <section key={slides[cur].key} className={'wop-slide is-' + slides[cur].kind}>{render(slides[cur])}</section>
          </div>
        )}
        <p className="wop-turn no-print">{tr('Best on a TV or laptop, or with the phone turned sideways.')}</p>
        <div className="wop-nav no-print">
          <button type="button" className="wop-btn" disabled={cur === 0} onClick={() => setAt(cur - 1)} aria-label={tr('Previous slide')}>←</button>
          <span className="wop-dots">
            {slides.map((sl, i) => <button key={sl.key} type="button" className={'wop-dot' + (i === cur ? ' is-on' : '')} onClick={() => setAt(i)} aria-label={tr('Slide {n}', { n: i + 1 })} />)}
          </span>
          <span className="wop-count">{tr('{a} of {b}', { a: cur + 1, b: slides.length })}</span>
          <button type="button" className="wop-btn" disabled={cur === slides.length - 1} onClick={() => setAt(cur + 1)} aria-label={tr('Next slide')}>→</button>
        </div>
      </div>
    </PrintLayer>
  );
}
