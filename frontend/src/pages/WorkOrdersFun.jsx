import { useMemo, useState } from 'react';
import { api } from '../api/client';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import { Icon, fmtDate } from '../components/DashKit';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { WO_OPEN, WO_STATUSES, woStatusLabel } from '../lib/workOrders.js';

// The work-order page's livelier pieces (WorkOrdersPage.jsx): a banner
// with the key numbers, the flow of statuses a WO moves through, who the
// work is for, the project managers' load, the WOs finished each week and
// how long they take, the cards on the board, and the import of the
// workshop's sheet. Colours: each status has its own, always written
// beside it; the weekly chart uses the validated categorical pair, with a
// legend; magnitudes use one hue.

export function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function addDays(iso, n) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDay(d); }
export function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000); }
function dayOf(ts) { return ts ? isoDay(new Date(ts)) : null; }
function short(iso) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
// A date in a tight column: "27 Sep", with the year only when it isn't this year's.
export function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(String(iso).slice(0, 10) + 'T00:00');
  return d.toLocaleDateString(activeIntlLocale(), d.getFullYear() === new Date().getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
// Monday of the week a day falls in.
function weekOf(iso) { const d = new Date(iso + 'T00:00'); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return isoDay(d); }
function median(nums) { if (!nums.length) return null; const s = nums.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function one(n) { return Math.round(n * 10) / 10; }

// Who a WO is for, as one name: our company, the customer, or the name on the sheet.
export function forName(t) { return t.requestedFor || ''; }
// Its project manager, picked from staff or as written on the sheet.
export function pmOf(t) { return t.projectManager ? t.projectManager.name : t.pmName || ''; }

// How a WO's timing reads: { text, tone } — tone 'bad' | 'warn' | 'good' | ''.
export function dueInfo(t, today) {
  if (t.status === 'completed') {
    const when = t.completedAt ? fmtDate(dayOf(t.completedAt)) : '';
    if (t.onTime === false) return { text: tr('Done {date}, late', { date: when }), tone: 'warn' };
    return { text: when ? tr('Done {date}', { date: when }) : tr('Done'), tone: 'good' };
  }
  if (t.status === 'cancelled') return { text: tr('Cancelled'), tone: '' };
  if (!t.dueDate) return { text: tr('No due date'), tone: '' };
  const d = daysBetween(today, t.dueDate);
  if (d < 0) return { text: -d === 1 ? tr('1 day overdue') : tr('{n} days overdue', { n: -d }), tone: 'bad' };
  if (d === 0) return { text: tr('Due today'), tone: 'warn' };
  if (d === 1) return { text: tr('Due tomorrow'), tone: 'warn' };
  if (d < 7) return { text: tr('Due {day}', { day: new Date(t.dueDate + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long' }) }), tone: '' };
  return { text: tr('Due {date}', { date: fmtDate(t.dueDate) }), tone: '' };
}

const GLYPH = {
  for: <><path d="M4 20V9l8-5 8 5v11" /><path d="M9.5 20v-6h5v6" /></>,
  pm: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6" /><path d="m15.5 4.5 1.5-1.5 1.5 1.5" /></>,
  week: <><path d="M4 20h16" /><rect x="5.5" y="12" width="3" height="6" rx="1" /><rect x="10.5" y="8" width="3" height="10" rx="1" /><rect x="15.5" y="5" width="3" height="13" rx="1" /></>,
  speed: <><path d="M4.5 16a7.5 7.5 0 1 1 15 0" /><path d="m12 16 4-5" /><path d="M12 16v.1" /></>,
  saw: <><path d="M3.5 15.5 15 4l5 5-11.5 11.5z" /><path d="m7 12 1.5 1.5M10 9l1.5 1.5M13 6l1.5 1.5" /></>
};
export function PanelHead({ icon, title, sub }) {
  return (
    <header className="wo-panel-head">
      <h3><span className={'wo-panel-icon is-' + icon}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[icon]}</svg></span>{title}</h3>
      {sub && <p>{sub}</p>}
    </header>
  );
}

export function StatusPill({ status }) {
  return <span className={'wo-pill is-' + status}><i aria-hidden="true" />{woStatusLabel(status)}</span>;
}

export function Faces({ people, size = 26, max = 3, extra }) {
  const n = (people || []).length;
  if (!n && !extra) return <span className="dk-muted wo-small">{tr('Nobody yet')}</span>;
  return (
    <span className="wo-faces" title={(people || []).map((p) => p.name).concat(extra ? [extra] : []).join(', ')}>
      {(people || []).slice(0, max).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={size} />)}
      {n > max && <span className="wo-faces-more">+{n - max}</span>}
      {extra && <span className="wo-faces-text">{extra}</span>}
    </span>
  );
}

// ── the banner ─────────────────────────────────────────────────────────
export function WoBanner({ eyebrow, title, sub, actions, tiles }) {
  return (
    <section className="wo-hero">
      <div className="wo-hero-glow" aria-hidden="true" />
      <div className="wo-hero-main">
        <p className="wo-eyebrow">{eyebrow}</p>
        <h1 className="wo-hero-title">{title}</h1>
        <p className="wo-hero-sub">{sub}</p>
        {actions && <div className="wo-hero-actions">{actions}</div>}
      </div>
      <div className="wo-tiles">
        {tiles.map((t, i) => {
          const Tag = t.onClick ? 'button' : 'div';
          return (
            <Tag key={i} type={t.onClick ? 'button' : undefined} onClick={t.onClick} className={'wo-tile' + (t.tone ? ' is-' + t.tone : '') + (t.active ? ' is-on' : '')}>
              <span className="wo-tile-top"><span className="wo-tile-icon"><Icon name={t.icon} /></span><span className="wo-cap">{t.label}</span></span>
              <strong>{t.value}</strong>
              <small>{t.note}</small>
            </Tag>
          );
        })}
      </div>
    </section>
  );
}

// ── the flow: every status a WO passes through, with how many are there ──
const FLOW = ['discussing', 'not_started', 'in_progress', 'awaiting_material', 'waiting', 'under_review', 'completed'];
export function Pipeline({ counts, active, onPick, doneLabel }) {
  return (
    <nav className="wo-flow" aria-label={tr('Work orders by status')}>
      {FLOW.map((s, i) => (
        <span key={s} className="wo-flow-step">
          <button type="button" className={'wo-flow-node is-' + s + (active === s ? ' is-on' : '') + (counts[s] ? '' : ' is-zero')} onClick={() => onPick(s)} aria-pressed={active === s}>
            <span className="wo-flow-n">{counts[s] || 0}</span>
            <span className="wo-flow-label">{woStatusLabel(s)}</span>
            {s === 'completed' && doneLabel && <span className="wo-flow-note">{doneLabel}</span>}
          </button>
          {i < FLOW.length - 1 && <span className="wo-flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>}
        </span>
      ))}
    </nav>
  );
}

// ── who the work is for ───────────────────────────────────────────────
export function ForWhom({ wos, onPick, active }) {
  const rows = useMemo(() => {
    const m = new Map();
    wos.forEach((t) => {
      const k = forName(t) || tr('Not said');
      if (!m.has(k)) m.set(k, { name: k, n: 0, open: 0, ours: !!t.forCompanyCode, real: !!forName(t) });
      const r = m.get(k);
      r.n++;
      if (WO_OPEN(t)) r.open++;
    });
    return Array.from(m.values()).sort((a, b) => b.n - a.n);
  }, [wos]);
  if (!rows.length) return <p className="dk-muted wo-small">{tr('No work orders yet.')}</p>;
  const top = rows.slice(0, 6);
  const rest = rows.slice(6);
  const max = Math.max(...top.map((r) => r.n), rest.reduce((a, r) => a + r.n, 0));
  const shown = rest.length ? top.concat([{ name: rest.length === 1 ? tr('1 other') : tr('{n} others', { n: rest.length }), n: rest.reduce((a, r) => a + r.n, 0), open: rest.reduce((a, r) => a + r.open, 0), other: true }]) : top;
  return (
    <ul className="wo-bars">
      {shown.map((r) => (
        <li key={r.name}>
          <button type="button" className={'wo-bar-row' + (active === r.name ? ' is-on' : '')} disabled={r.other || !r.real} onClick={() => onPick(r.name)}>
            <span className="wo-bar-name" title={r.name}><span className="wo-bar-text">{r.name}</span>{r.ours && <span className="wo-ours">{tr('ours')}</span>}</span>
            <span className="wo-bar-track"><span className="wo-bar-fill" style={{ width: Math.max(3, (r.n / max) * 100) + '%' }} /></span>
            <span className="wo-bar-n"><strong>{r.n}</strong>{r.open ? <small>{tr('{n} open', { n: r.open })}</small> : null}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── the project managers ──────────────────────────────────────────────
export function Managers({ wos, today, onPick, active }) {
  const rows = useMemo(() => {
    const m = new Map();
    const monthAgo = addDays(today, -30);
    wos.forEach((t) => {
      const name = pmOf(t);
      if (!name) return;
      if (!m.has(name)) m.set(name, { name, person: t.projectManager, open: 0, overdue: 0, done: 0, days: [] });
      const r = m.get(name);
      if (WO_OPEN(t)) { r.open++; if (t.overdue) r.overdue++; }
      if (t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= monthAgo) { r.done++; if (t.daysToClose !== null) r.days.push(t.daysToClose); }
    });
    return Array.from(m.values()).filter((r) => r.open || r.done).sort((a, b) => b.open - a.open || b.done - a.done).slice(0, 6);
  }, [wos, today]);
  if (!rows.length) return <p className="dk-muted wo-small">{tr('No project manager has open work orders or finished any in the last 30 days.')}</p>;
  return (
    <ul className="wo-pms">
      {rows.map((r) => {
        const avg = r.days.length ? one(r.days.reduce((a, b) => a + b, 0) / r.days.length) : null;
        return (
          <li key={r.name}>
            <button type="button" className={'wo-pm' + (active === r.name ? ' is-on' : '')} onClick={() => onPick(r.name)}>
              {r.person ? <Photo id={r.person.id} name={r.person.name} photo={r.person.photo} size={36} /> : <span className="wo-pm-initial" aria-hidden="true">{r.name.slice(0, 1).toUpperCase()}</span>}
              <span className="wo-pm-main">
                <strong>{r.name}</strong>
                <span className="dk-muted">{avg === null ? tr('{n} done in 30 days', { n: r.done }) : tr('{n} done in 30 days · {d} days each on average', { n: r.done, d: avg })}</span>
              </span>
              <span className="wo-pm-load">
                <span className="wo-pm-open"><strong>{r.open}</strong> {tr('open')}</span>
                {r.overdue > 0 && <span className="wo-pm-late">{tr('{n} late', { n: r.overdue })}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── finished each week: on time and late, the last 12 weeks ───────────
export function Weekly({ wos, today }) {
  const [hover, setHover] = useState(null);
  const weeks = useMemo(() => {
    const first = weekOf(addDays(today, -7 * 11));
    const list = [];
    for (let i = 0; i < 12; i++) list.push({ start: addDays(first, i * 7), onTime: 0, late: 0 });
    wos.forEach((t) => {
      if (t.status !== 'completed' || !t.completedAt) return;
      const w = weekOf(dayOf(t.completedAt));
      const row = list.find((x) => x.start === w);
      if (!row) return;
      if (t.onTime === false) row.late++; else row.onTime++;
    });
    return list;
  }, [wos, today]);
  const max = Math.max(1, ...weeks.map((w) => w.onTime + w.late));
  const total = weeks.reduce((a, w) => a + w.onTime + w.late, 0);
  const late = weeks.reduce((a, w) => a + w.late, 0);
  const last = weeks[weeks.length - 1];
  return (
    <div className="wo-weekly">
      <div className="wo-legend">
        <span><i className="is-ontime" />{tr('On time')}</span>
        <span><i className="is-late" />{tr('Late')}</span>
        <span className="dk-muted">{total ? tr('{n} finished in 12 weeks, {p}% on time', { n: total, p: Math.round(((total - late) / total) * 100) }) : tr('Nothing finished in the last 12 weeks.')}</span>
      </div>
      <div className="wo-cols" role="img" aria-label={tr('Work orders finished each week')} onMouseLeave={() => setHover(null)}>
        {weeks.map((w, i) => {
          const n = w.onTime + w.late;
          return (
            <div key={w.start} className={'wo-col' + (hover === i ? ' is-hover' : '')} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}>
              <div className="wo-col-stack" style={{ height: (n / max) * 100 + '%' }}>
                {w.late > 0 && <span className="wo-bit is-late" style={{ flexGrow: w.late }} />}
                {w.onTime > 0 && <span className="wo-bit is-ontime" style={{ flexGrow: w.onTime }} />}
              </div>
              {i === weeks.length - 1 && n > 0 && <span className="wo-col-label" style={{ bottom: (n / max) * 100 + '%' }}>{n}</span>}
              <span className="wo-col-x">{i % 3 === 2 || i === weeks.length - 1 ? short(w.start) : ''}</span>
              {hover === i && (
                <span className={'wo-tip' + (i > 8 ? ' is-left' : '')} role="tooltip">
                  <strong>{tr('Week of {date}', { date: short(w.start) })}</strong>
                  <span><i className="is-ontime" />{tr('On time')}: {w.onTime}</span>
                  <span><i className="is-late" />{tr('Late')}: {w.late}</span>
                </span>
              )}
            </div>
          );
        })}
      </div>
      {last && <p className="dk-muted wo-small">{tr('This week so far: {n} finished.', { n: last.onTime + last.late })}</p>}
    </div>
  );
}

// ── how long a WO takes, issued → completed, the last 90 days ─────────
export function Speed({ wos, today }) {
  const from = addDays(today, -90);
  const done = wos.filter((t) => t.status === 'completed' && t.completedAt && dayOf(t.completedAt) >= from && t.daysToClose !== null);
  const buckets = [
    [tr('Same day'), (d) => d === 0], [tr('1 day'), (d) => d === 1], [tr('2–3 days'), (d) => d >= 2 && d <= 3],
    [tr('4–7 days'), (d) => d >= 4 && d <= 7], [tr('8–14 days'), (d) => d >= 8 && d <= 14], [tr('15 days or more'), (d) => d >= 15]
  ].map(([label, test]) => ({ label, n: done.filter((t) => test(t.daysToClose)).length }));
  const max = Math.max(1, ...buckets.map((b) => b.n));
  const days = done.map((t) => t.daysToClose);
  const med = median(days);
  const withDue = done.filter((t) => t.onTime !== null);
  const onTime = withDue.length ? Math.round((withDue.filter((t) => t.onTime).length / withDue.length) * 100) : null;
  if (!done.length) return <p className="dk-muted wo-small">{tr('No work orders were completed in the last 90 days.')}</p>;
  return (
    <div className="wo-speed">
      <div className="wo-speed-heads">
        <div><strong>{med === null ? '—' : one(med)}</strong><span>{tr('days, the typical WO (median)')}</span></div>
        <div><strong>{onTime === null ? '—' : onTime + '%'}</strong><span>{tr('finished by the date due')}</span></div>
        <div><strong>{done.length}</strong><span>{tr('completed in 90 days')}</span></div>
      </div>
      <ul className="wo-bars is-speed">
        {buckets.map((b) => (
          <li key={b.label}>
            <div className="wo-bar-row is-static">
              <span className="wo-bar-name"><span className="wo-bar-text">{b.label}</span></span>
              <span className="wo-bar-track"><span className="wo-bar-fill" style={{ width: (b.n ? Math.max(3, (b.n / max) * 100) : 0) + '%' }} /></span>
              <span className="wo-bar-n"><strong>{b.n}</strong></span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the board ──────────────────────────────────────────────────────────
// The step a WO usually takes next from where it is, and what the button
// on its card says: "Start", "Ready for check", "Complete"…
export const NEXT = { discussing: 'not_started', not_started: 'in_progress', in_progress: 'under_review', awaiting_material: 'in_progress', waiting: 'in_progress', under_review: 'completed' };
const NEXT_LABEL = {
  discussing: msg('Issue it'), not_started: msg('Start'), in_progress: msg('Ready for check'),
  awaiting_material: msg('Material is here'), waiting: msg('Resume'), under_review: msg('Complete')
};
export function nextLabel(status) { return NEXT_LABEL[status] ? tr(NEXT_LABEL[status]) : ''; }
// What each column holds, in a few words, under its name.
const COL_HINT = {
  discussing: msg('Being talked over'), not_started: msg('Issued, not begun'), in_progress: msg('Being made'),
  awaiting_material: msg('Waiting for material'), waiting: msg('Stopped for now'), under_review: msg('Waiting to be checked'),
  completed: msg('Finished'), cancelled: msg('Called off')
};
export function colHint(status) { return COL_HINT[status] ? tr(COL_HINT[status]) : ''; }
const STATUS_GLYPH = {
  discussing: <><path d="M4.5 15.5 5.4 12.6A6 6 0 1 1 8 15" /><path d="M10 18.5a5.5 5.5 0 0 0 8.6 1.2l1.9.6-.6-1.9A5.5 5.5 0 0 0 16 10" /></>,
  not_started: <><rect x="6" y="4.5" width="12" height="16" rx="1.5" /><path d="M9.5 4.5v-1h5v1M9 10h6M9 13.5h6M9 17h3.5" /></>,
  in_progress: <><path d="m14 6 4 4-9.5 9.5H4.5v-4z" /><path d="m12.5 7.5 4 4" /></>,
  awaiting_material: <><path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" /><path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9" /></>,
  waiting: <><circle cx="12" cy="12" r="8" /><path d="M10 9v6M14 9v6" /></>,
  under_review: <><circle cx="10.5" cy="10.5" r="5.5" /><path d="m15 15 5 5" /><path d="m8.2 10.6 1.6 1.6 2.9-3" /></>,
  completed: <><path d="M12 3.5 14.4 6l3.4-.4.4 3.4L20.5 12l-2.3 2.6-.4 3.4-3.4-.4L12 20.5 9.6 18l-3.4.4-.4-3.4L3.5 12l2.3-2.6.4-3.4 3.4.4z" /><path d="m8.8 12.2 2.2 2.2 4.2-4.4" /></>,
  cancelled: <><circle cx="12" cy="12" r="8" /><path d="m9 9 6 6M15 9l-6 6" /></>
};
export function StatusGlyph({ status }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{STATUS_GLYPH[status]}</svg>;
}

function hueOf(name) { let h = 0; const v = String(name || ''); for (let i = 0; i < v.length; i++) h = (h * 31 + v.charCodeAt(i)) >>> 0; return h % 360; }
function initialsOf(name) { return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }

// From the date issued to the date due, how much of the time has gone:
// green while there is time, amber near the end, red once it is late;
// a finished WO says how long it took.
export function TimeBar({ t, today }) {
  const due = dueInfo(t, today);
  if (t.status === 'cancelled') return null;
  let frac = null, tone = due.tone || 'plain';
  if (t.status === 'completed') { frac = 1; tone = t.onTime === false ? 'warn' : 'good'; }
  else if (t.issuedOn && t.dueDate) {
    const planned = Math.max(1, daysBetween(t.issuedOn, t.dueDate));
    frac = Math.max(0.04, Math.min(1, daysBetween(t.issuedOn, today) / planned));
    tone = t.overdue ? 'bad' : frac >= 0.75 ? 'warn' : 'ok';
  }
  const text = t.status === 'completed' && t.daysToClose !== null
    ? (t.daysToClose === 0 ? tr('Done the same day') : t.onTime === false ? tr('Done in {n} days, late', { n: t.daysToClose }) : tr('Done in {n} days', { n: t.daysToClose }))
    : due.text;
  return (
    <div className={'wo-timebar is-' + tone}>
      <span className="wo-timebar-text">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></svg>
        {text}
      </span>
      {frac !== null && <span className="wo-timebar-track" aria-hidden="true"><span style={{ width: Math.round(frac * 100) + '%' }} /></span>}
    </div>
  );
}

// ── a card on the board ───────────────────────────────────────────────
export function WoCard({ t, today, onOpen, onCardClick, menu, dragging, onDragStart, onDragEnd, onNext, justDone }) {
  const who = forName(t);
  const next = NEXT[t.status];
  return (
    <article className={'wo-card is-' + t.status + (t.overdue ? ' is-overdue' : '') + (dragging ? ' is-dragging' : '') + (justDone ? ' is-just-done' : '')} draggable
      onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={onCardClick}>
      <div className="wo-card-top">
        <span className="wo-no">{t.number}</span>
        {t.priority === 'high' && (
          <span className="wo-flame" title={tr('{p} priority', { p: codeLabel('high') })}>
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.5 2.5c.6 3.2-1.2 4.9-2.6 6.5C8.4 10.7 7 12.4 7 15a5 5 0 0 0 10 0c0-1.9-.8-3.4-1.7-4.6-.2 1.3-.9 2.3-1.9 2.8.3-3.3-.1-7.6-.9-10.7z" /></svg>
            {codeLabel('high')}
          </span>
        )}
        {t.overdue && <span className="wo-alarm" title={tr('Overdue')} aria-label={tr('Overdue')} />}
        <span className="wo-card-menu"><RowMenu actions={menu} /></span>
      </div>
      <button type="button" className="wo-card-title" onClick={onOpen}>{t.title}</button>
      {(who || t.quantity) && (
        <div className="wo-card-for">
          <ForBadge name={who} />
          {who && <span className={'wo-for-name' + (t.forCompanyCode ? ' is-ours' : '')} title={who}>{who}</span>}
          {t.quantity && <span className="wo-qty-big" title={tr('Quantity')}>×{t.quantity}</span>}
        </div>
      )}
      {(t.process || t.itemCode) && <p className="wo-card-process">{t.itemCode && <b>{t.itemCode}</b>}{t.itemCode && t.process ? ' · ' : ''}{t.process}</p>}
      <TimeBar t={t} today={today} />
      <div className="wo-card-foot">
        <span className="wo-card-people">
          {pmOf(t) && (t.projectManager
            ? <span className="wo-card-pm" title={tr('Project manager: {name}', { name: pmOf(t) })}><Photo id={t.projectManager.id} name={t.projectManager.name} photo={t.projectManager.photo} size={24} /><b>{tr('PM')}</b></span>
            : <span className="wo-card-pm is-text" title={tr('Project manager: {name}', { name: pmOf(t) })}><b>{tr('PM')}</b> {pmOf(t)}</span>)}
          <Faces people={t.assignees} size={22} max={3} extra={t.teamNames} />
          {t.commentCount > 0 && <span className="wo-comments" title={tr('{n} comments', { n: t.commentCount })}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" /></svg>{t.commentCount}</span>}
        </span>
        {next && onNext && (
          <button type="button" className={'wo-next to-' + next} onClick={onNext} title={tr('Move to {status}', { status: woStatusLabel(next) })}>
            {nextLabel(t.status)}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        )}
      </div>
    </article>
  );
}

// ── the register ──────────────────────────────────────────────────────
// Who a WO is for, as a coloured square with their initials.
export function ForBadge({ name }) {
  if (!name) return null;
  return <span className="wo-for-badge" style={{ '--h': hueOf(name) }} aria-hidden="true">{initialsOf(name)}</span>;
}

// The status as a coloured pill that is also the way to change it.
export function StatusSelect({ status, onChange, label }) {
  return (
    <span className={'wo-st-select is-' + status}>
      <i aria-hidden="true" />
      <select value={status} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {WO_STATUSES.map((s) => <option key={s} value={s}>{woStatusLabel(s)}</option>)}
      </select>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </span>
  );
}

// Issued → due, with a small bar of the time gone between them: red past
// the date due, green (amber if late) once finished.
export function MiniTimeline({ t, today }) {
  const closed = t.completedAt || t.cancelledAt;
  const issued = t.issuedOn ? shortDate(t.issuedOn) : '—';
  const due = t.dueDate ? shortDate(t.dueDate) : '—';
  let frac = null, tone = 'ok';
  if (t.status === 'completed') { frac = 1; tone = t.onTime === false ? 'warn' : 'good'; }
  else if (t.status === 'cancelled') { frac = null; }
  else if (t.issuedOn && t.dueDate) {
    frac = Math.max(0.05, Math.min(1, daysBetween(t.issuedOn, today) / Math.max(1, daysBetween(t.issuedOn, t.dueDate))));
    tone = t.overdue ? 'bad' : frac >= 0.75 ? 'warn' : 'ok';
  }
  return (
    <span className={'wo-mini is-' + tone}>
      <span className="wo-mini-dates">{issued}<span aria-hidden="true">→</span><b>{due}</b></span>
      {frac !== null && <span className="wo-mini-track" aria-hidden="true"><span style={{ width: Math.round(frac * 100) + '%' }} /></span>}
      {closed ? <small>{t.status === 'cancelled' ? tr('cancelled {date}', { date: shortDate(dayOf(closed)) }) : tr('closed {date}', { date: shortDate(dayOf(closed)) })}</small>
        : t.overdue ? <small className="is-bad">{t.daysOverdue === 1 ? tr('1 day late') : tr('{n} days late', { n: t.daysOverdue })}</small> : null}
    </span>
  );
}

// The days a WO took (or has taken so far), coloured by how it went.
export function DaysChip({ t }) {
  if (t.daysToClose !== null && t.daysToClose !== undefined) {
    return <span className={'wo-days ' + (t.onTime === false ? 'is-bad' : 'is-good')} title={t.onTime === false ? tr('Finished after the date due') : tr('Finished by the date due')}>{t.daysToClose === 1 ? tr('1 day') : tr('{n} days', { n: t.daysToClose })}</span>;
  }
  if (t.daysOpen !== null && t.daysOpen !== undefined) {
    return <span className={'wo-days ' + (t.overdue ? 'is-late' : 'is-plain')} title={tr('Open for {n} days so far', { n: t.daysOpen })}>{tr('{n} so far', { n: t.daysOpen })}</span>;
  }
  return <span className="dk-muted">—</span>;
}

// The register as a spreadsheet: every WO shown, with the WO form's columns,
// for Excel or Google Sheets.
export function downloadCsv(rows) {
  const head = [tr('WO'), tr('Date issued'), tr('For'), tr('Description'), tr('Quantity'), tr('Item number'), tr('Specification'), tr('Material needed'),
    tr('Material quantity'), tr('Material specification'), tr('Process'), tr('Project manager'), tr('Team'), tr('Prepared by'), tr('Estimated date due'),
    tr('Status'), tr('Closed'), tr('Days to close'), tr('Project')];
  const cell = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const lines = rows.map((t) => [
    t.number, t.issuedOn, forName(t), t.title, t.quantity, t.itemCode, t.specification, t.materials, t.materialQuantity, t.materialSpec, t.process,
    pmOf(t), (t.assigneeNames || []).join(', '), t.createdByName, t.dueDate, woStatusLabel(t.status), dayOf(t.completedAt || t.cancelledAt) || '',
    t.daysToClose === null || t.daysToClose === undefined ? '' : t.daysToClose, t.projectName && t.projectName !== '—' ? t.projectName : ''
  ].map(cell).join(','));
  const blob = new Blob(['\ufeff' + [head.map(cell).join(',')].concat(lines).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'work-orders-' + isoDay(new Date()) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A burst of confetti over the Completed column when a WO lands there.
export function Confetti() {
  return (
    <span className="wo-confetti" aria-hidden="true">
      {Array.from({ length: 18 }, (_, i) => <i key={i} style={{ '--i': i }} />)}
    </span>
  );
}

// A process written as steps: "cut to size, assemble and polish" → three chips.
export function ProcessSteps({ text }) {
  const steps = String(text || '').split(/\s*(?:,|;|&|\bthen\b|\band\b|→|->)\s*/i).map((s) => s.trim()).filter(Boolean);
  if (steps.length < 2) return <span>{text}</span>;
  return (
    <span className="wo-steps-list">
      {steps.map((s, i) => <span key={i} className="wo-process-step"><b>{i + 1}</b>{s}</span>)}
    </span>
  );
}

// Text with its links made clickable (a specification may be a link).
export function Linked({ text }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s]+)/g);
  return <>{parts.map((p, i) => (/^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)}{p.length > 48 ? '…' : ''}</a> : p))}</>;
}

// ── bringing in the workshop's sheet ──────────────────────────────────
const ROLE = { pm: () => tr('project manager'), team: () => tr('team member'), prepared: () => tr('prepared by') };
const KIND = { form: () => tr('the form’s answers'), stage: () => tr('the working sheet (statuses)'), archive: () => tr('the archive') };

export function WoImport({ employees, onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [aliases, setAliases] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const staff = employees.slice().sort((a, b) => (a.firstName + a.lastName).localeCompare(b.firstName + b.lastName));

  function form(f) {
    const fd = new FormData();
    fd.append('file', f);
    const given = {};
    Object.keys(aliases).forEach((k) => { if (aliases[k]) given[k] = aliases[k]; });
    fd.append('aliases', JSON.stringify(given));
    return fd;
  }
  async function pick(f) {
    setFile(f); setPreview(null); setError(null);
    if (!f) return;
    setBusy(true);
    try { setPreview(await api.upload('/tasks/import/preview', form(f))); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setError(null);
    try { onDone(await api.upload('/tasks/import', form(file))); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const unknown = preview ? preview.people.filter((p) => !p.employeeId) : [];
  const known = preview ? preview.people.filter((p) => p.employeeId) : [];
  const statuses = preview ? Object.keys(preview.byStatus).sort((a, b) => preview.byStatus[b] - preview.byStatus[a]) : [];

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog wo-import" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Import work orders from the sheet')}</h2>
        <p className="dk-muted wo-small">{tr('The Google Sheet behind the WO form: in Google Sheets use File → Download → Microsoft Excel (.xlsx), then choose that file here. Its tabs are read together — the form’s answers, the working sheet with each status, and the archive — and matched by the form’s timestamp.')}</p>
        <label className="wo-drop">
          <input type="file" accept=".xlsx" onChange={(e) => pick(e.target.files && e.target.files[0])} />
          <span className="wo-drop-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" /></svg></span>
          <span>{file ? file.name : tr('Choose the .xlsx file')}</span>
        </label>
        {busy && !preview && <p className="dk-muted wo-small">{tr('Reading the workbook…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        {preview && (
          <div className="wo-import-body">
            <div className="wo-import-heads">
              <div><strong>{preview.toAdd}</strong><span>{tr('work orders to add')}</span></div>
              <div><strong>{preview.already}</strong><span>{tr('already in the OS, left as they are')}</span></div>
              <div><strong>{preview.from ? fmtDate(preview.from) : '—'}</strong><span>{preview.to ? tr('to {date}', { date: fmtDate(preview.to) }) : ''}</span></div>
            </div>
            <p className="wo-small">{tr('Tabs read:')} {preview.tabs.map((x) => tr('“{name}” — {kind}, {n} rows', { name: x.name, kind: (KIND[x.kind] || (() => x.kind))(), n: x.rows })).join(' · ')}</p>
            {statuses.length > 0 && <div className="wo-import-statuses">{statuses.map((s) => <span key={s} className="wo-import-status"><StatusPill status={s} /> {preview.byStatus[s]}</span>)}</div>}
            {preview.renumber && <p className="wo-note">{tr('Numbers are given in date order, oldest first, so the sheet’s first WO becomes WO-0001. Work orders already in the OS are numbered in with them.')}</p>}

            {preview.requestedFor.length > 0 && (
              <details className="wo-import-section">
                <summary>{tr('Who the work is for — {n} names', { n: preview.requestedFor.length })}</summary>
                <ul className="wo-import-list">
                  {preview.requestedFor.map((x) => (
                    <li key={x.name || '-'}><span>{x.name || tr('Not said')}</span><span className="dk-muted">{x.n}</span><span className={x.matched ? 'wo-match' : 'dk-muted'}>{x.matched ? '→ ' + x.matched : tr('kept as written')}</span></li>
                  ))}
                </ul>
              </details>
            )}

            {unknown.length > 0 && (
              <section className="wo-import-section is-open">
                <h3>{tr('Names to match — {n}', { n: unknown.length })}</h3>
                <p className="dk-muted wo-small">{tr('These names on the sheet aren’t one person in the directory. Pick who each one is, and the OS will know them next time; any left blank are kept as written on the work order.')}</p>
                <ul className="wo-import-list is-names">
                  {unknown.map((p) => (
                    <li key={p.name}>
                      <span><strong>{p.name}</strong> <span className="dk-muted">{p.roles.map((r) => (ROLE[r] || (() => r))()).join(', ')} · {tr('{n} WOs', { n: p.n })}</span></span>
                      <select className="input" value={aliases[p.name] || ''} onChange={(e) => setAliases({ ...aliases, [p.name]: e.target.value })} aria-label={tr('Who is {name}?', { name: p.name })}>
                        <option value="">{tr('Keep as written')}</option>
                        {staff.map((e) => <option key={e.id} value={e.id}>{e.firstName + ' ' + e.lastName}</option>)}
                      </select>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {known.length > 0 && (
              <details className="wo-import-section">
                <summary>{tr('Matched to staff — {n} names', { n: known.length })}</summary>
                <ul className="wo-import-list">
                  {known.map((p) => <li key={p.name}><span>{p.name}</span><span className="dk-muted">{tr('{n} WOs', { n: p.n })}</span><span className="wo-match">→ {p.employeeName}</span></li>)}
                </ul>
              </details>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!preview || !preview.toAdd || busy} onClick={run}>
            {busy && preview ? tr('Importing…') : preview && preview.toAdd ? tr('Import {n} work orders', { n: preview.toAdd }) : tr('Import')}
          </button>
        </div>
      </div>
    </div>
  );
}
