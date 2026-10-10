import { useMemo, useState } from 'react';
import SlideDeck, { recentWeeks, weekLabel } from '../components/SlideDeck';
import Photo from '../components/Photo';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { WO_OPEN, WO_STATUSES, woStatusLabel } from '../lib/workOrders.js';
import { ForBadge, addDays, daysBetween, forName, isoDay, nextLabel, pmOf, shortDate } from './WorkOrdersFun';

// The Saturday review: the week's work orders as slides to show on a
// screen, in three parts — what was completed this week, what is in
// process, and what is pending (not started or held up), late ones first
// — with the numbers that sum them up. The slide show itself (keys, full
// screen, printing) is components/SlideDeck.jsx. A card opens its work
// order over the slides (onOpen).

const PER_SLIDE = 6;
// The open work orders in two parts: being made (or made and waiting for
// their check), and not started or held up.
const IN_PROCESS = ['in_progress', 'under_review'];
const PENDING = ['discussing', 'not_started', 'awaiting_material', 'waiting'];
function dayOf(ts) { return ts ? isoDay(new Date(ts)) : null; }
function monday(iso) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); }
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
function median(nums) { if (!nums.length) return null; const s = nums.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }

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
  const weekTo = addDays(weekFrom, 6);
  const nextFrom = addDays(weekTo, 1), nextTo = addDays(weekTo, 7);

  const data = useMemo(() => {
    const done = wos.filter((t) => t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= weekFrom && dayOf(t.completedAt) <= weekTo)
      .sort((a, b) => String(a.completedAt).localeCompare(String(b.completedAt)));
    const late = done.filter((t) => t.onTime === false);
    const issued = wos.filter((t) => t.issuedOn && t.issuedOn >= weekFrom && t.issuedOn <= weekTo);
    const open = wos.filter(WO_OPEN).sort((a, b) => {
      if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
      if (!a.dueDate !== !b.dueDate) return a.dueDate ? -1 : 1;
      return String(a.dueDate || '').localeCompare(String(b.dueDate || '')) || (a.number || '').localeCompare(b.number || '');
    });
    // Anything open with another status counts as pending.
    const process = open.filter((t) => IN_PROCESS.includes(t.status));
    const pending = open.filter((t) => !IN_PROCESS.includes(t.status));
    const overdue = open.filter((t) => t.overdue);
    const dueNext = open.filter((t) => !t.overdue && t.dueDate && t.dueDate >= nextFrom && t.dueDate <= nextTo);
    // The facts for each open part.
    const part = (list, statuses) => ({
      list,
      late: list.filter((t) => t.overdue).length,
      dueNext: list.filter((t) => !t.overdue && t.dueDate && t.dueDate >= nextFrom && t.dueDate <= nextTo).length,
      oldest: list.filter((t) => t.issuedOn).sort((a, b) => a.issuedOn.localeCompare(b.issuedOn))[0] || null,
      byStatus: statuses.map((st) => ({ key: st, label: woStatusLabel(st), n: list.filter((t) => t.status === st).length }))
    });
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(weekFrom, i);
      return { key: d, label: new Date(d + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short' }), n: done.filter((t) => dayOf(t.completedAt) === d).length };
    });
    const people = {};
    wos.forEach((t) => {
      const pm = pmOf(t);
      if (!pm) return;
      const inDone = done.includes(t), isOpen = WO_OPEN(t);
      if (!inDone && !isOpen) return;
      const p = people[pm] || (people[pm] = { name: pm, person: t.projectManager || null, done: 0, process: 0, pending: 0, late: 0 });
      if (inDone) p.done++;
      if (isOpen) { if (IN_PROCESS.includes(t.status)) p.process++; else p.pending++; if (t.overdue) p.late++; }
    });
    const pms = Object.values(people).sort((a, b) => b.done - a.done || (b.process + b.pending) - (a.process + a.pending) || a.name.localeCompare(b.name));
    return {
      done, late, issued, open, overdue, dueNext, days, pms,
      process: part(process, IN_PROCESS), pending: part(pending, PENDING.concat(WO_STATUSES.filter((st) => st !== 'completed' && st !== 'cancelled' && !IN_PROCESS.includes(st) && !PENDING.includes(st)))),
      median: median(done.map((t) => t.daysToClose).filter((n) => n !== null && n !== undefined))
    };
  }, [wos, weekFrom, weekTo, nextFrom, nextTo]);

  const slides = useMemo(() => {
    const s = [{ key: 'cover', kind: 'cover' }];
    s.push({ key: 'done-sum', kind: 'done-sum' });
    chunk(data.done, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'done-' + i, kind: 'list', mode: 'done', list, page: i + 1, pages: all.length }));
    ['process', 'pending'].forEach((g) => {
      s.push({ key: g + '-sum', kind: 'open-sum', group: g });
      chunk(data[g].list, PER_SLIDE).forEach((list, i, all) => s.push({ key: g + '-' + i, kind: 'list', mode: g, list, page: i + 1, pages: all.length }));
    });
    if (data.pms.length) s.push({ key: 'people', kind: 'people' });
    s.push({ key: 'end', kind: 'end' });
    return s;
  }, [data]);
  const weeks = recentWeeks(thisMonday);
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
            <div className="wop-tile is-open"><b>{data.process.list.length}</b><span>{tr('in process')}</span></div>
            <div className="wop-tile is-pend"><b>{data.pending.list.length}</b><span>{tr('pending')}</span></div>
            <div className={'wop-tile' + (data.overdue.length ? ' is-bad' : '')}><b>{data.overdue.length}</b><span>{tr('late, in process or pending')}</span></div>
          </div>
          <p className="wop-foot">{[
            pct === null ? null : tr('{pct}% of those completed were on time', { pct }),
            data.issued.length === 1 ? tr('1 new work order issued this week') : tr('{n} new work orders issued this week', { n: data.issued.length }),
            data.dueNext.length === 1 ? tr('1 due next week') : tr('{n} due next week', { n: data.dueNext.length })
          ].filter(Boolean).join(' · ')}</p>
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
    if (sl.kind === 'open-sum') {
      const g = data[sl.group], proc = sl.group === 'process';
      const max = Math.max(1, ...g.byStatus.map((x) => x.n));
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
                <Bars items={g.byStatus.filter((x) => x.n || IN_PROCESS.includes(x.key) || PENDING.includes(x.key))} max={max} />
              </section>
              <section className="wop-panel wop-facts">
                <div className={'wop-fact' + (g.late ? ' is-bad' : '')}><b>{g.late}</b><span>{tr('late: past their date due')}</span></div>
                <div className="wop-fact is-warn"><b>{g.dueNext}</b><span>{tr('due next week ({dates})', { dates: weekLabel(nextFrom, nextTo) })}</span></div>
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
          <div className="wop-cards">
            {sl.list.map((t) => <PCard key={t.id} t={t} today={today} mode={done ? 'done' : 'pending'} onOpen={onOpen} />)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'people') {
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow">{tr('Project managers')}</span><h2>{tr('Who has what')}</h2></header>
          <table className="wop-table">
            <thead><tr><th>{tr('Project manager')}</th><th>{tr('Completed this week')}</th><th>{tr('In process')}</th><th>{tr('Pending')}</th><th>{tr('Late')}</th></tr></thead>
            <tbody>
              {data.pms.slice(0, 8).map((p) => (
                <tr key={p.name}>
                  <td><span className="wop-pm">{p.person ? <Photo id={p.person.id} name={p.person.name} photo={p.person.photo} size={28} /> : null}{p.name}</span></td>
                  <td><b className="is-good">{p.done}</b></td>
                  <td><b>{p.process}</b></td>
                  <td><b>{p.pending}</b></td>
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
    <SlideDeck brand={tr('Saturday review')} weeks={weeks} weekFrom={weekFrom} onWeek={setWeekFrom}
      slides={slides} render={render} onClose={onClose} paused={paused} />
  );
}
