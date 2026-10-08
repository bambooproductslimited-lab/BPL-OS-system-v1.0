import { useState } from 'react';
import { Icon, avatarColor, initials } from '../components/DashKit';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';

// The attendance screen's livelier pieces (AttendancePage.jsx, styles in
// AttendanceFun.css): the gradient banner with the day's ring and the
// 14-day trend, who is in right now as a wall of faces, how the morning's
// arrivals went on a time line, the early birds' podium, on-time streaks,
// the rhythm of the week and the perfect-attendance club
// (GET /api/attendance/highlights, attendance.service.js highlights()).
// Status colours are the OS's status colours (on time, late, no record,
// leave, rest day), always with their name written beside them.

export const STATUS = {
  present: msg('On time'), late: msg('Late'), absent: msg('No record'), leave: msg('On leave'), off: msg('Rest day'), half_day: msg('Half day')
};

function hm(t) { return t ? String(t).slice(0, 5) : null; }
function minutesOf(t) { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return h * 60 + m; }
function clock(min) { const m = ((min % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function weekdayName(w, long) { return new Date(Date.UTC(2024, 0, 7 + w)).toLocaleDateString(activeIntlLocale(), { weekday: long ? 'long' : 'short', timeZone: 'UTC' }); }
function dayLabel(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
// The name people use: the first word (two when the first is an initial or a prefix).
function firstName(name) { const w = String(name || '').split(/\s+/); return w[0].length <= 2 && w[1] ? w[0] + ' ' + w[1] : w[0]; }

export function Face({ name, size, ring }) {
  return (
    <span className={'atf-face' + (ring ? ' is-' + ring : '')} style={{ background: avatarColor(name), width: size, height: size, fontSize: size ? Math.round(size * 0.36) : undefined }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

// A panel's heading with its icon.
const GLYPH = {
  sunrise: <><path d="M4 18h16M7 14a5 5 0 0 1 10 0M12 4v4M5.6 7.6l1.8 1.8M18.4 7.6l-1.8 1.8M2.5 14h2M19.5 14h2" /></>,
  bird: <><path d="M4 13c3 0 5-2 6-5 1 3 3.5 4.5 6 4.5h4l-3 2.5c-1.5 3-4 4.5-7 4.5-3.5 0-6-2.5-6-6.5z" /><circle cx="15.5" cy="10" r=".8" fill="currentColor" /></>,
  flame: <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.4 3.6-8.3.5 1.7 1.5 2.8 2.6 3.2C11.6 6.6 13 4.4 15 3c-.3 2.9 3.5 5.6 3.5 11.1 0 4-2.7 6.9-6.5 6.9z" />,
  wave: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M7.5 15l2-2 2 2.5 2-3 2 2.5 1.5-1.5" /></>,
  star: <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />,
  faces: <><circle cx="8" cy="9" r="2.6" /><circle cx="16" cy="9" r="2.6" /><path d="M3.5 19c.6-2.8 2.4-4.4 4.5-4.4s3.9 1.6 4.5 4.4M11.5 19c.6-2.8 2.4-4.4 4.5-4.4s3.9 1.6 4.5 4.4" /></>
};
export function PanelHead({ icon, title, sub }) {
  return (
    <header className="atf-panel-head">
      <h3><span className={'atf-panel-icon is-' + icon}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[icon]}</svg></span>{title}</h3>
      {sub && <p>{sub}</p>}
    </header>
  );
}

// ── the banner ────────────────────────────────────────────────────────
function Ring({ pct }) {
  const r = 46, c = 2 * Math.PI * r, part = Math.max(0, Math.min(100, pct || 0)) / 100;
  return (
    <svg className="atf-ring" viewBox="0 0 108 108" aria-hidden="true">
      <circle cx="54" cy="54" r={r} className="atf-ring-track" />
      <circle cx="54" cy="54" r={r} className={'atf-ring-fill' + (part >= 1 ? ' is-full' : '')} strokeDasharray={(c * part) + ' ' + c} transform="rotate(-90 54 54)" />
    </svg>
  );
}

// The last 14 days' attendance as one line, the day picked marked.
function Trend({ trend }) {
  const pts = (trend || []).filter((t) => t.rate !== null);
  if (pts.length < 2) return null;
  const w = 220, h = 54, lo = Math.max(0, Math.min(...pts.map((t) => t.rate)) - 10);
  const x = (i) => Math.round(i / (trend.length - 1) * w * 10) / 10;
  const y = (v) => Math.round((h - 6 - (v - lo) / Math.max(1, 100 - lo) * (h - 14)) * 10) / 10;
  const line = trend.map((t, i) => (t.rate === null ? null : [x(i), y(t.rate), t])).filter(Boolean);
  const d = line.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join(' ');
  const last = line[line.length - 1];
  return (
    <div className="atf-trend">
      <span className="atf-trend-label">{tr('Last 14 days')}</span>
      <svg viewBox={'0 0 ' + w + ' ' + h} preserveAspectRatio="none" role="img" aria-label={trend.map((t) => dayLabel(t.date) + ': ' + (t.rate === null ? '—' : t.rate + '%')).join('; ')}>
        <path className="atf-trend-area" d={d + ' L' + last[0] + ' ' + h + ' L' + line[0][0] + ' ' + h + ' Z'} />
        <path className="atf-trend-line" d={d} vectorEffect="non-scaling-stroke" />
        {line.map((p) => <circle key={p[2].date} cx={p[0]} cy={p[1]} r={p === last ? 4 : 2.4} className={'atf-trend-dot' + (p === last ? ' is-last' : '')} vectorEffect="non-scaling-stroke"><title>{dayLabel(p[2].date) + ': ' + p[2].rate + '% (' + tr('{came} of {expected}', { came: p[2].came, expected: p[2].expected }) + ')'}</title></circle>)}
      </svg>
      <span className="atf-trend-range"><span>{dayLabel(trend[0].date)}</span><span>{dayLabel(trend[trend.length - 1].date)}</span></span>
    </div>
  );
}

export function Banner({ eyebrow, title, sub, actions, ringPct, ringValue, ringLabel, live, full, tiles, trend, onTime }) {
  return (
    <header className="atf-hero">
      <span className="atf-hero-glow" aria-hidden="true" />
      <div className="atf-hero-main">
        <p className="atf-eyebrow">{live && <span className="atf-live"><i aria-hidden="true" />{tr('Live')}</span>}{eyebrow}</p>
        <h2 className="atf-hero-title">{title}</h2>
        <p className="atf-hero-sub">{sub}</p>
        {actions && <div className="atf-hero-actions no-print">{actions}</div>}
      </div>
      <div className="atf-hero-side">
        <div className={'atf-ringbox' + (full ? ' is-full' : '')}>
          <Ring pct={ringPct} />
          <span className="atf-ring-center"><strong>{ringValue}</strong><small>{ringLabel}</small></span>
          {full && <span className="atf-fullhouse"><Icon name="spark" />{tr('Full house!')}</span>}
        </div>
        <div className="atf-tiles">
          {tiles.map((t) => (
            <button key={t.key} type="button" onClick={t.onClick} className={'atf-tile' + (t.tone ? ' is-' + t.tone : '') + (t.active ? ' is-on' : '')} aria-pressed={!!t.active}>
              <span className="atf-tile-top"><span className="atf-tile-icon"><Icon name={t.icon} /></span><span className="atf-cap">{t.label}</span></span>
              <strong>{t.value}</strong>
              {t.note && <small>{t.note}</small>}
            </button>
          ))}
        </div>
        <div className="atf-hero-foot">
          <Trend trend={trend} />
          {onTime !== null && onTime !== undefined && (
            <div className="atf-ontime">
              <strong>{onTime}%</strong>
              <span>{tr('on time over 30 days')}</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ── who is in, as faces ───────────────────────────────────────────────
const WALL = [
  ['now', msg('In now'), msg('Clocked in, not out yet')],
  ['done', msg('Done for the day'), msg('Clocked in and out')],
  ['missing', msg('Not in yet'), msg('Expected, no clock-in')],
  ['away', msg('Away'), msg('On leave or a rest day')]
];
const WALL_PAST = { missing: [msg('No record'), msg('Expected, no clock-in, no leave')] };
const WALL_MAX = 36;

export function PresenceWall({ rows, isToday, onPick }) {
  const [open, setOpen] = useState({});
  const groups = { now: [], done: [], missing: [], away: [] };
  rows.forEach((r) => {
    if (r.status === 'leave' || r.status === 'off') groups.away.push(r);
    else if (r.status === 'absent') groups.missing.push(r);
    else if (r.clockIn && !r.clockOut) groups.now.push(r);
    else groups.done.push(r);
  });
  const byTime = (a, b) => String(a.clockIn || '99').localeCompare(String(b.clockIn || '99')) || a.name.localeCompare(b.name);
  Object.keys(groups).forEach((k) => groups[k].sort(k === 'missing' || k === 'away' ? (a, b) => a.name.localeCompare(b.name) : byTime));
  return (
    <div className="atf-wall">
      {WALL.map(([k, title, sub]) => {
        const list = groups[k];
        const [t, s] = !isToday && WALL_PAST[k] ? WALL_PAST[k] : [title, sub];
        const shown = open[k] ? list : list.slice(0, WALL_MAX);
        return (
          <section key={k} className={'atf-wall-group is-' + k}>
            <header>
              <span className="atf-wall-dot" aria-hidden="true" />
              <h4>{tr(t)}</h4>
              <span className="atf-count">{list.length}</span>
              <small>{tr(s)}</small>
            </header>
            {list.length ? (
              <ul>
                {shown.map((r) => (
                  <li key={r.employeeId}>
                    <button type="button" onClick={() => onPick(r)} title={r.name + (r.clockIn ? ' · ' + hm(r.clockIn) : '') + (r.status === 'late' && r.minutesLate != null ? ' · ' + tr('{n} min late', { n: r.minutesLate }) : '') + ' · ' + tr(STATUS[r.status] || r.status)}>
                      <Face name={r.name} ring={r.status === 'late' ? 'late' : k} />
                      <span className="atf-wall-name">{firstName(r.name)}</span>
                      {r.clockIn && k !== 'away' && <span className="atf-wall-time">{hm(r.clockIn)}</span>}
                    </button>
                  </li>
                ))}
                {list.length > WALL_MAX && (
                  <li><button type="button" className="atf-more" onClick={() => setOpen({ ...open, [k]: !open[k] })}>{open[k] ? tr('Show fewer') : tr('+{n} more', { n: list.length - WALL_MAX })}</button></li>
                )}
              </ul>
            ) : <p className="atf-none">{tr('Nobody')}</p>}
          </section>
        );
      })}
    </div>
  );
}

// ── the morning's arrivals on a time line ─────────────────────────────
export function ArrivalLine({ rows }) {
  const arrivals = rows.filter((r) => r.clockIn && (r.status === 'present' || r.status === 'late')).map((r) => ({ r, m: minutesOf(r.clockIn) })).sort((a, b) => a.m - b.m);
  if (!arrivals.length) return <p className="atf-none">{tr('Nobody has clocked in on this day.')}</p>;
  const min = arrivals[0].m, max = arrivals[arrivals.length - 1].m;
  const lo = Math.max(0, Math.floor((min - 15) / 60) * 60);
  let hi = Math.min(1440, Math.ceil((max + 15) / 60) * 60);
  if (hi - lo < 180) hi = Math.min(1440, lo + 180);
  const BIN = hi - lo > 600 ? 30 : 10;
  const bins = Array.from({ length: Math.ceil((hi - lo) / BIN) }, () => []);
  arrivals.forEach((a) => bins[Math.min(bins.length - 1, Math.floor((a.m - lo) / BIN))].push(a));
  const tallest = Math.max(...bins.map((b) => b.length));
  const STACK = 8;
  const busiest = bins.indexOf(bins.reduce((a, b) => (b.length > a.length ? b : a), bins[0]));
  const median = arrivals[Math.floor((arrivals.length - 1) / 2)].m;
  const late = arrivals.filter((a) => a.r.status === 'late').length;
  const hours = [];
  for (let h = lo; h <= hi; h += 60) hours.push(h);
  return (
    <div className="atf-arrivals">
      <div className="atf-arrivals-facts">
        <span><Icon name="clock" />{tr('First in: {name} at {time}', { name: arrivals[0].r.name, time: clock(arrivals[0].m) })}</span>
        <span><Icon name="people" />{tr('Busiest: {from}–{to} ({n} people)', { from: clock(lo + busiest * BIN), to: clock(lo + (busiest + 1) * BIN), n: bins[busiest].length })}</span>
        <span><Icon name="layers" />{tr('Half were in by {time}', { time: clock(median) })}</span>
      </div>
      <div className="atf-arrivals-plot" style={{ '--rows': Math.min(STACK, tallest) + (tallest > STACK ? 1 : 0) }} role="img"
        aria-label={tr('{n} arrivals between {from} and {to}, {late} late', { n: arrivals.length, from: clock(min), to: clock(max), late })}>
        {bins.map((b, i) => (
          <div key={i} className="atf-bin">
            {b.length > STACK && <span className="atf-bin-more">+{b.length - STACK + 1}</span>}
            {b.slice(0, b.length > STACK ? STACK - 1 : STACK).map((a) => (
              <span key={a.r.employeeId} className={'atf-dot is-' + a.r.status} title={a.r.name + ' · ' + hm(a.r.clockIn) + (a.r.status === 'late' && a.r.minutesLate != null ? ' · ' + tr('{n} min late', { n: a.r.minutesLate }) : '')} />
            ))}
          </div>
        ))}
      </div>
      <div className="atf-axis" aria-hidden="true">
        {hours.map((h) => <span key={h} style={{ left: ((h - lo) / (hi - lo) * 100) + '%' }}>{clock(h)}</span>)}
      </div>
      <ul className="atf-legend">
        <li className="is-present"><i />{tr('On time')} <b>{arrivals.length - late}</b></li>
        <li className="is-late"><i />{tr('Late')} <b>{late}</b></li>
      </ul>
    </div>
  );
}

// ── the early birds' podium ───────────────────────────────────────────
export function EarlyBirds({ birds }) {
  if (!birds || !birds.length) return <p className="atf-none">{tr('No on-time arrivals with a shift to measure against yet.')}</p>;
  const order = [birds[1], birds[0], birds[2]];
  return (
    <ol className="atf-podium">
      {order.map((b, i) => {
        if (!b) return <li key={i} className="atf-step is-empty" aria-hidden="true" />;
        const place = birds.indexOf(b) + 1;
        return (
          <li key={b.employeeId} className={'atf-step is-' + place}>
            <Face name={b.name} size={place === 1 ? 64 : 50} />
            <strong>{b.name}</strong>
            <span className="atf-step-time">{b.clockIn}</span>
            <small>{b.early === 0 ? tr('right on time') : tr('{n} min early', { n: b.early })}</small>
            <span className="atf-block"><span className="atf-medal">{place}</span></span>
          </li>
        );
      })}
    </ol>
  );
}

// ── on-time streaks ───────────────────────────────────────────────────
export function Streaks({ streaks, onStreak }) {
  if (!streaks || !streaks.length) return <p className="atf-none">{tr('No streaks yet. Three workdays in a row on time starts one.')}</p>;
  const top = Math.max(...streaks.map((s) => s.days));
  return (
    <>
      <ol className="atf-streaks">
        {streaks.map((s, i) => (
          <li key={s.employeeId}>
            <span className="atf-streak-rank">{i + 1}</span>
            <Face name={s.name} size={32} />
            <span className="atf-streak-who"><strong>{s.name}</strong><small>{s.department}</small></span>
            <span className="atf-streak-bar" aria-hidden="true"><i style={{ width: Math.max(8, s.days / top * 100) + '%' }} /></span>
            <span className={'atf-flame' + (s.days >= 10 ? ' is-big' : '')}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.4 3.6-8.3.5 1.7 1.5 2.8 2.6 3.2C11.6 6.6 13 4.4 15 3c-.3 2.9 3.5 5.6 3.5 11.1 0 4-2.7 6.9-6.5 6.9z" /></svg>
              {s.wholeWindow ? tr('{n}+ days', { n: s.days }) : s.days === 1 ? tr('1 day') : tr('{n} days', { n: s.days })}
            </span>
          </li>
        ))}
      </ol>
      {onStreak > 0 && <p className="atf-foot">{onStreak === 1 ? tr('1 person is on a run of 5 days or more.') : tr('{n} people are on a run of 5 days or more.', { n: onStreak })}</p>}
    </>
  );
}

// ── the rhythm of the week ────────────────────────────────────────────
export function WeekRhythm({ weekdays }) {
  const known = (weekdays || []).filter((w) => w.rate !== null && w.expected > 0);
  if (!known.length) return <p className="atf-none">{tr('Not enough days yet.')}</p>;
  const best = known.reduce((a, b) => (b.rate > a.rate ? b : a));
  const worst = known.reduce((a, b) => (b.rate < a.rate ? b : a));
  return (
    <>
      <div className="atf-week" role="img" aria-label={weekdays.map((w) => weekdayName(w.weekday, true) + ': ' + (w.rate === null ? '—' : w.rate + '%')).join('; ')}>
        {weekdays.map((w) => (
          <div key={w.weekday} className={'atf-weekday' + (w === best ? ' is-best' : '') + (w === worst && best !== worst ? ' is-worst' : '')} title={weekdayName(w.weekday, true) + ': ' + (w.rate === null ? '—' : tr('{came} of {expected} days', { came: w.came, expected: w.expected }))}>
            <span className="atf-weekday-cell" style={{ '--v': w.rate === null ? 0 : Math.max(0.12, (w.rate - 50) / 50) }}><strong>{w.rate === null ? '—' : w.rate + '%'}</strong></span>
            <small>{weekdayName(w.weekday)}</small>
          </div>
        ))}
      </div>
      {best !== worst && <p className="atf-foot">{tr('Best: {best} ({b}%). Hardest: {worst} ({w}%).', { best: weekdayName(best.weekday, true), b: best.rate, worst: weekdayName(worst.weekday, true), w: worst.rate })}</p>}
    </>
  );
}

// ── the perfect-attendance club ───────────────────────────────────────
export function PerfectClub({ perfect }) {
  if (!perfect || !perfect.count) return <p className="atf-none">{tr('Nobody yet: 10 days or more worked, none late or missed.')}</p>;
  return (
    <>
      <ul className="atf-club">
        {perfect.people.map((p) => (
          <li key={p.employeeId} title={p.name + ' · ' + p.department}>
            <Face name={p.name} size={42} />
            <span className="atf-star" aria-hidden="true">★</span>
            <small>{firstName(p.name)}</small>
          </li>
        ))}
      </ul>
      <p className="atf-foot">{perfect.count === 1 ? tr('1 person: every expected day, on time, for 30 days.') : tr('{n} people: every expected day, on time, for 30 days.', { n: perfect.count })}{perfect.count > perfect.people.length ? ' ' + tr('{n} more not shown.', { n: perfect.count - perfect.people.length }) : ''}</p>
    </>
  );
}

// ── a person's days over the period, as squares ───────────────────────
export function DayStrip({ days }) {
  return (
    <span className="atf-strip" role="img" aria-label={days.map((d) => dayLabel(d.date) + ': ' + tr(STATUS[d.status] || d.status)).join('; ')}>
      {days.map((d) => <i key={d.date} className={'is-' + d.status} title={dayLabel(d.date) + ': ' + tr(STATUS[d.status] || d.status)} />)}
    </span>
  );
}
export function StatusPill({ status, children }) {
  return <span className={'atf-pill is-' + status}><i aria-hidden="true" />{children || tr(STATUS[status] || status)}</span>;
}
export function StatusLegend() {
  return (
    <ul className="atf-legend is-wide">
      {['present', 'late', 'absent', 'leave', 'off'].map((k) => <li key={k} className={'is-' + k}><i />{tr(STATUS[k])}</li>)}
    </ul>
  );
}
