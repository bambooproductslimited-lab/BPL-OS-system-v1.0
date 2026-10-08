import { useMemo, useState } from 'react';
import Photo from '../components/Photo';
import { Icon, fmtDate } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';

// The Projects page's livelier pieces (ProjectsPage.jsx): a blueprint
// banner with the portfolio's work done as a ring, the life-cycle a project
// moves through with how many are at each step, the road to each deadline
// (every open project from its start to its deadline, filled with the work
// done, today marked), who the projects are for, the owners' load and the
// projects closed lately; and each card's double ring — work done inside,
// time used outside. Each status and health has its own colour, always
// written beside it.

function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayNum(iso) { return Math.round(new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000); }
function short(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
function month(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00').toLocaleDateString(activeIntlLocale(), { month: 'short' }); }
const OPEN = (p) => p.status !== 'completed' && p.status !== 'cancelled';

const GLYPH = {
  road: <><path d="M4 20 9 4M20 20 15 4" /><path d="M12 5v2M12 10.5v2.5M12 16.5V19" /></>,
  for: <><path d="M4 20V9l8-5 8 5v11" /><path d="M9.5 20v-6h5v6" /></>,
  owner: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6" /></>,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4" /></>
};
export function PanelHead({ icon, title, sub }) {
  return (
    <header className="pjx-panel-head">
      <h3><span className={'pjx-panel-icon is-' + icon}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[icon]}</svg></span>{title}</h3>
      {sub && <p>{sub}</p>}
    </header>
  );
}

// Work done (inside) and time used (outside), one ring in another.
export function Ring({ work, time, tone, size = 64, label }) {
  const c = size / 2;
  const ro = c - 4, ri = c - 12;
  const lo = 2 * Math.PI * ro, li = 2 * Math.PI * ri;
  return (
    <span className={'pjx-ring is-' + tone} style={{ width: size, height: size }} role="img"
      aria-label={label || tr('{w}% of the work done, {t}% of the time used', { w: Math.round(work * 100), t: Math.round(time * 100) })}>
      <svg viewBox={'0 0 ' + size + ' ' + size} width={size} height={size} aria-hidden="true">
        <circle cx={c} cy={c} r={ro} className="pjx-ring-track" strokeWidth="4" />
        <circle cx={c} cy={c} r={ro} className="pjx-ring-time" strokeWidth="4" strokeDasharray={lo} strokeDashoffset={lo * (1 - Math.min(1, time))} transform={'rotate(-90 ' + c + ' ' + c + ')'} />
        <circle cx={c} cy={c} r={ri} className="pjx-ring-track" strokeWidth="7" />
        <circle cx={c} cy={c} r={ri} className="pjx-ring-work" strokeWidth="7" strokeDasharray={li} strokeDashoffset={li * (1 - Math.min(1, work))} transform={'rotate(-90 ' + c + ' ' + c + ')'} />
      </svg>
      <span className="pjx-ring-n">{Math.round(work * 100)}<small>%</small></span>
    </span>
  );
}

// ── the banner ─────────────────────────────────────────────────────────
export function PjBanner({ eyebrow, title, sub, actions, tiles, work, workText }) {
  return (
    <section className="pjx-hero">
      <div className="pjx-hero-grid" aria-hidden="true" />
      <div className="pjx-hero-main">
        <p className="pjx-eyebrow">{eyebrow}</p>
        <h1 className="pjx-hero-title">{title}</h1>
        <p className="pjx-hero-sub">{sub}</p>
        {actions && <div className="pjx-hero-actions">{actions}</div>}
      </div>
      <div className="pjx-hero-side">
        <div className="pjx-portfolio">
          <span className="pjx-portfolio-ring" style={{ '--p': Math.round((work || 0) * 100) }} role="img" aria-label={workText}>
            <strong>{work === null ? '—' : Math.round(work * 100) + '%'}</strong>
          </span>
          <span className="pjx-portfolio-text"><b>{tr('of the work done')}</b><span>{workText}</span></span>
        </div>
        <div className="pjx-tiles">
          {tiles.map((t, i) => (
            <button key={i} type="button" onClick={t.onClick} className={'pjx-tile' + (t.tone ? ' is-' + t.tone : '') + (t.active ? ' is-on' : '')}>
              <span className="pjx-tile-top"><span className="pjx-tile-icon"><Icon name={t.icon} /></span><span className="pjx-cap">{t.label}</span></span>
              <strong>{t.value}</strong>
              <small>{t.note}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── the life-cycle ─────────────────────────────────────────────────────
export function PjFlow({ counts, active, onPick }) {
  const steps = [
    ['planning', codeLabel('planning')], ['active', codeLabel('active')], ['held', tr('On hold or delayed')],
    ['ready', tr('Ready to close')], ['completed', codeLabel('completed')]
  ];
  return (
    <nav className="pjx-flow" aria-label={tr('Projects by step')}>
      {steps.map(([k, label], i) => (
        <span key={k} className="pjx-flow-step">
          <button type="button" className={'pjx-flow-node is-' + k + (active === k ? ' is-on' : '') + (counts[k] ? '' : ' is-zero')} onClick={() => onPick(k)} aria-pressed={active === k}>
            <span className="pjx-flow-n">{counts[k] || 0}</span>
            <span className="pjx-flow-label">{label}</span>
          </button>
          {i < steps.length - 1 && <span className="pjx-flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg></span>}
        </span>
      ))}
    </nav>
  );
}

// ── the road to each deadline ──────────────────────────────────────────
export function Timeline({ rows, today, onOpen, max = 8 }) {
  const [hover, setHover] = useState(null);
  const shown = rows.filter(({ p }) => p.startDate && p.deadline).slice().sort((a, b) => String(a.p.deadline).localeCompare(String(b.p.deadline))).slice(0, max);
  const span = useMemo(() => {
    if (!shown.length) return null;
    const t = dayNum(today);
    let from = Math.min(...shown.map(({ p }) => dayNum(p.startDate)), t);
    const to = Math.max(...shown.map(({ p }) => dayNum(p.deadline)), t) + 3;
    if (to - from > 400) from = Math.max(from, t - 200);
    return { from: from - 3, to, t };
  }, [shown, today]);
  if (!shown.length) return <p className="dk-muted pjx-small">{tr('No open project has both a start date and a deadline.')}</p>;
  const x = (d) => Math.max(0, Math.min(100, ((d - span.from) / (span.to - span.from)) * 100));
  // A label at the first of each month in the window, at most eight.
  const ticks = [];
  const d0 = new Date((span.from + 1) * 86400000);
  for (let m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1)); m.getTime() / 86400000 < span.to; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    ticks.push({ at: x(m.getTime() / 86400000), label: month(m.toISOString()) });
  }
  const step = Math.ceil(ticks.length / 8) || 1;
  const more = rows.filter(({ p }) => p.startDate && p.deadline).length - shown.length;
  return (
    <div className="pjx-road">
      <div className="pjx-legend">
        <span><i className="is-span" />{tr('Start to deadline')}</span>
        <span><i className="is-work" />{tr('Work done')}</span>
        <span><i className="is-late" />{tr('Past the deadline')}</span>
        <span><i className="is-today" />{tr('Today')}</span>
      </div>
      <div className="pjx-road-grid">
        <div className="pjx-road-head" aria-hidden="true">
          <span />
          <div className="pjx-road-ticks">
            {ticks.filter((_, i) => i % step === 0).map((tk) => <span key={tk.at} style={{ left: tk.at + '%' }}>{tk.label}</span>)}
          </div>
          <span />
        </div>
        {shown.map(({ p, h }, i) => {
          const s = dayNum(p.startDate), e = dayNum(p.deadline);
          const left = x(s), width = Math.max(1.5, x(e) - x(s));
          const late = span.t > e ? x(span.t) - x(e) : 0;
          return (
            <button key={p.id} type="button" className={'pjx-road-row is-' + h.key + (hover === i ? ' is-hover' : '')} onClick={() => onOpen(p)}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              aria-label={tr('{name}: {w}% of the work done, {start} to {end}', { name: p.name, w: Math.round(h.done * 100), start: fmtDate(p.startDate), end: fmtDate(p.deadline) })}>
              <span className="pjx-road-name"><b>{p.name}</b><small>{p.code}</small></span>
              <span className="pjx-road-track">
                <span className="pjx-road-today" style={{ left: x(span.t) + '%' }} aria-hidden="true" />
                <span className="pjx-road-span" style={{ left: left + '%', width: width + '%', '--i': i }}>
                  <span className="pjx-road-fill" style={{ width: Math.round(h.done * 100) + '%' }} />
                </span>
                {late > 0 && <span className="pjx-road-late" style={{ left: x(e) + '%', width: late + '%' }} />}
                {hover === i && (
                  <span className={'pjx-tip' + (left > 60 ? ' is-left' : '')} role="tooltip" style={{ left: (left > 60 ? left + width : left) + '%' }}>
                    <strong>{p.name}</strong>
                    <span>{short(p.startDate)} → {short(p.deadline)}</span>
                    <span>{tr('{w}% of the work done, {t}% of the time used', { w: Math.round(h.done * 100), t: Math.round(h.time * 100) })}</span>
                  </span>
                )}
              </span>
              <span className={'pjx-road-n is-' + h.key}>{h.work ? Math.round(h.done * 100) + '%' : '—'}</span>
            </button>
          );
        })}
      </div>
      {more > 0 && <p className="dk-muted pjx-small">{tr('The {n} with the nearest deadlines; {m} more further out.', { n: shown.length, m: more })}</p>}
    </div>
  );
}

// ── who the projects are for ───────────────────────────────────────────
export function ForWhom({ projects, onPick, active }) {
  const rows = useMemo(() => {
    const m = new Map();
    projects.forEach((p) => {
      const k = p.requestedFor || '';
      if (!m.has(k)) m.set(k, { name: k, n: 0, open: 0 });
      const r = m.get(k);
      r.n++;
      if (OPEN(p)) r.open++;
    });
    return Array.from(m.values()).sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || b.n - a.n).slice(0, 6);
  }, [projects]);
  if (!rows.length) return <p className="dk-muted pjx-small">{tr('No projects yet.')}</p>;
  const max = Math.max(...rows.map((r) => r.n));
  return (
    <ul className="pjx-bars">
      {rows.map((r) => (
        <li key={r.name || '-'}>
          <button type="button" className={'pjx-bar-row' + (active && active === r.name ? ' is-on' : '')} disabled={!r.name} onClick={() => onPick(r.name)}>
            <span className="pjx-bar-name" title={r.name}>{r.name || tr('Not said')}</span>
            <span className="pjx-bar-track"><span className="pjx-bar-fill" style={{ width: Math.max(4, (r.n / max) * 100) + '%' }} /></span>
            <span className="pjx-bar-n"><strong>{r.n}</strong>{r.open ? <small>{tr('{n} open', { n: r.open })}</small> : null}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── the owners ─────────────────────────────────────────────────────────
export function Owners({ rows, onPick, active }) {
  const owners = useMemo(() => {
    const m = new Map();
    rows.filter(({ p }) => OPEN(p)).forEach(({ p, h }) => {
      if (!m.has(p.ownerId)) m.set(p.ownerId, { id: p.ownerId, name: p.ownerName, photo: p.ownerPhoto, open: 0, late: 0, ready: 0 });
      const o = m.get(p.ownerId);
      o.open++;
      if (h.key === 'overdue' || h.key === 'behind') o.late++;
      if (h.key === 'ready') o.ready++;
    });
    return Array.from(m.values()).sort((a, b) => b.open - a.open || b.late - a.late).slice(0, 6);
  }, [rows]);
  if (!owners.length) return <p className="dk-muted pjx-small">{tr('No open projects.')}</p>;
  return (
    <ul className="pjx-owners">
      {owners.map((o) => (
        <li key={o.id}>
          <button type="button" className={'pjx-owner' + (active === o.name ? ' is-on' : '')} onClick={() => onPick(o.name)}>
            <Photo id={o.id} name={o.name} photo={o.photo} size={36} />
            <span className="pjx-owner-main"><strong>{o.name}</strong>
              <span className="dk-muted">{[o.late ? tr('{n} behind or late', { n: o.late }) : null, o.ready ? tr('{n} ready to close', { n: o.ready }) : null].filter(Boolean).join(' · ') || tr('all on track')}</span>
            </span>
            <span className="pjx-owner-n"><strong>{o.open}</strong> {tr('open')}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ── closed lately ──────────────────────────────────────────────────────
export function RecentlyClosed({ projects, today, onOpen }) {
  const since = isoDay(new Date(new Date(today + 'T00:00').getTime() - 120 * 86400000));
  const rows = projects.filter((p) => p.status === 'completed' && p.closedAt && String(p.closedAt).slice(0, 10) >= since)
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt))).slice(0, 5);
  if (!rows.length) return <p className="dk-muted pjx-small">{tr('No project was completed in the last four months.')}</p>;
  return (
    <ul className="pjx-closed">
      {rows.map((p, i) => {
        const day = String(p.closedAt).slice(0, 10);
        const late = p.deadline ? dayNum(day) - dayNum(p.deadline) : null;
        return (
          <li key={p.id}>
            <button type="button" className={'pjx-closed-row' + (i === 0 && dayNum(today) - dayNum(day) <= 7 ? ' is-fresh' : '')} onClick={() => onOpen(p)}>
              <span className="pjx-trophy" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{GLYPH.trophy}</svg></span>
              <span className="pjx-closed-main">
                <strong>{p.name}</strong>
                <span className="dk-muted">{p.closedAuto ? tr('closed itself {date}', { date: short(day) }) : p.closedByName ? tr('closed {date} by {name}', { date: short(day), name: p.closedByName }) : tr('closed {date}', { date: short(day) })}{p.taskCount ? ' · ' + tr('{n} work orders', { n: p.taskCount }) : ''}</span>
              </span>
              {late !== null && (late <= 0
                ? <span className="pjx-badge is-good">{tr('On time')}</span>
                : <span className="pjx-badge is-late">{late === 1 ? tr('1 day late') : tr('{n} days late', { n: late })}</span>)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
