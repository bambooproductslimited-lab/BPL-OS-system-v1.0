import Photo from '../components/Photo';
import { Icon, avatarColor, fmtDate, initials } from '../components/DashKit';
import { CompanyMark } from './CompaniesFun';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

// The OS overview's livelier pieces (DashboardPage.jsx): a banner whose sky
// follows the time of day over a little skyline of the business, with
// today's people as a ring (on time, late, away, not in yet); number tiles;
// how the morning's arrivals went with who was in first; the last seven
// days; a card per group; the people boards; birthdays, work anniversaries
// and new joiners; each restaurant's takings through the day against the
// same day last week; what is waiting; and the latest activity. Styles in
// DashboardFun.css (.ovx-*).

export function skyOf(now) {
  const h = now.getHours();
  return h >= 5 && h < 11 ? 'dawn' : h >= 11 && h < 16 ? 'day' : h >= 16 && h < 20 ? 'dusk' : 'night';
}
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const weekday = (iso, style = 'short') => new Date(iso + 'T12:00').toLocaleDateString(activeIntlLocale(), { weekday: style });

const SKY = {
  dawn: <><circle cx="250" cy="96" r="34" className="ovx-sun" /><path d="M250 44V30M204 96h-14M310 96h-14M218 64l-10-10M282 64l10-10" className="ovx-rays" /></>,
  day: <><circle cx="268" cy="54" r="28" className="ovx-sun" /><path d="M268 14V4M228 54h-10M318 54h-10M240 26l-7-7M296 26l7-7M240 82l-7 7M296 82l7 7" className="ovx-rays" /><path d="M120 62c0-10 9-18 19-18 5-10 22-12 29 0 10 0 18 8 18 18z" className="ovx-cloud" /></>,
  dusk: <><circle cx="240" cy="112" r="38" className="ovx-sun" /><path d="M150 80h40M280 70h40M180 58h26" className="ovx-rays" /></>,
  night: <><path d="M262 30a34 34 0 1 0 26 55 29 29 0 1 1-26-55z" className="ovx-moon" /><circle cx="140" cy="30" r="2.5" className="ovx-star" /><circle cx="190" cy="66" r="2" className="ovx-star" /><circle cx="96" cy="56" r="2" className="ovx-star" /><circle cx="330" cy="40" r="2.5" className="ovx-star" /><circle cx="60" cy="24" r="2" className="ovx-star" /></>
};
// A factory, a restaurant and an office: the business, drawn.
const SKYLINE = (
  <g className="ovx-skyline">
    <path d="M10 150v-46l26 16v-16l26 16v-16l26 16V84h14v66z" />
    <rect x="96" y="60" width="10" height="26" />
    <path d="M128 150v-40h70v40z" /><path d="M122 112l12-18h58l12 18z" className="ovx-awning" />
    <path d="M222 150V70h44v80z" /><path d="M276 150v-52h32v52z" />
    <g className="ovx-windows">
      <rect x="230" y="80" width="8" height="8" /><rect x="250" y="80" width="8" height="8" /><rect x="230" y="98" width="8" height="8" /><rect x="250" y="98" width="8" height="8" />
      <rect x="230" y="116" width="8" height="8" /><rect x="284" y="108" width="7" height="7" /><rect x="296" y="108" width="7" height="7" /><rect x="142" y="122" width="14" height="16" /><rect x="170" y="122" width="14" height="16" />
    </g>
  </g>
);

// ── the banner ─────────────────────────────────────────────────────────
// pulse: { total, parts: [{ key, label, n }], center, caption } or null;
// me: { id, name, photo }; side: what shows when there is no pulse.
export function OvBanner({ sky, now, eyebrow, title, sub, me, online, onOnline, announcement, onAnnouncement, pulse, side }) {
  return (
    <section className={'ovx-hero is-' + sky}>
      <svg className="ovx-hero-art" viewBox="0 0 340 150" aria-hidden="true">{SKY[sky]}{SKYLINE}</svg>
      <div className="ovx-hero-main">
        <div className="ovx-hero-who">
          {me && <span className="ovx-avatar"><Photo id={me.id} name={me.name} photo={me.photo} size={64} /></span>}
          <div className="ovx-hero-head">
            <p className="ovx-eyebrow">{eyebrow}</p>
            <h1 className="ovx-hero-title">{title}</h1>
          </div>
        </div>
        <p className="ovx-hero-sub">{sub}</p>
        <div className="ovx-hero-chips">
          {online && online.count > 0 && (
            <button type="button" className="ovx-chip" onClick={onOnline}>
              <span className="ovx-faces">{online.people.slice(0, 4).map((p) => <span key={p.id} title={p.name}><Photo id={p.id} name={p.name} photo={p.photo} size={24} /></span>)}</span>
              <i className="ovx-live-dot" />{online.count === 1 ? tr('1 other person is online now') : tr('{n} others are online now', { n: online.count })}
            </button>
          )}
          {announcement && (
            <button type="button" className="ovx-chip is-news" onClick={onAnnouncement}>
              <Icon name="send" /><span className="ovx-chip-text"><b>{tr('Latest announcement')}</b> {announcement}</span><Icon name="arrow" />
            </button>
          )}
        </div>
      </div>
      <div className="ovx-pulse">
        <div className="ovx-pulse-top">
          <span className="ovx-pill"><i />{tr('Live')}</span>
          <span className="ovx-pulse-time">{now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        {pulse ? <Donut pulse={pulse} /> : side}
      </div>
    </section>
  );
}

function Donut({ pulse }) {
  const size = 150, r = 60, c = 2 * Math.PI * r, gap = pulse.total > 1 ? 3 : 0;
  let at = 0;
  return (
    <div className="ovx-donut-wrap">
      <span className="ovx-donut" role="img" aria-label={pulse.caption + ': ' + pulse.parts.map((p) => p.label + ' ' + p.n).join(', ')}>
        <svg viewBox={'0 0 ' + size + ' ' + size} width={size} height={size} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} className="ovx-donut-track" />
          {pulse.total > 0 && pulse.parts.filter((p) => p.n > 0).map((p) => {
            const len = (p.n / pulse.total) * c;
            const el = <circle key={p.key} cx={size / 2} cy={size / 2} r={r} className={'ovx-donut-seg is-' + p.key}
              strokeDasharray={Math.max(0, len - gap) + ' ' + c} strokeDashoffset={-at} transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'} />;
            at += len;
            return el;
          })}
        </svg>
        <span className="ovx-donut-mid"><strong>{pulse.center}</strong><small>{pulse.caption}</small></span>
      </span>
      <ul className="ovx-donut-legend">
        {pulse.parts.map((p) => (
          <li key={p.key} className={p.n ? '' : 'is-zero'}>
            <i className={'is-' + p.key} /><span>{p.label}</span><b>{p.n}</b>
            {p.onClick && p.n > 0 && <button type="button" className="ovx-legend-go" onClick={p.onClick} aria-label={tr('See who')}><Icon name="arrow" /></button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A number tile, with a ring when it is a share.
export function OvTile({ icon, value, label, note, ring, tone, onClick }) {
  const r = 24, c = 2 * Math.PI * r;
  return (
    <button type="button" className={'ovx-tile is-' + (tone || 'info')} onClick={onClick}>
      {ring !== undefined && ring !== null ? (
        <span className="ovx-tile-ring" aria-hidden="true">
          <svg viewBox="0 0 60 60" width="60" height="60"><circle cx="30" cy="30" r={r} className="ovx-ring-track" /><circle cx="30" cy="30" r={r} className="ovx-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, ring)))} transform="rotate(-90 30 30)" /></svg>
          <span className="ovx-tile-icon"><Icon name={icon} /></span>
        </span>
      ) : <span className="ovx-tile-icon is-solo"><Icon name={icon} /></span>}
      <span className="ovx-tile-body">
        <strong>{value}</strong>
        <span className="ovx-tile-label">{label}</span>
        {note && <small>{note}</small>}
      </span>
    </button>
  );
}

// ── the morning's arrivals ─────────────────────────────────────────────
// arrivals: [{ time, late }] (each person's first clock-in, sorted).
export function Arrivals({ arrivals, lateAfter, firstIn }) {
  if (!arrivals.length) return <p className="ovx-muted">{tr('Nobody has clocked in yet today.')}</p>;
  const mins = arrivals.map((a) => toMin(a.time));
  const span = mins[mins.length - 1] - mins[0];
  const step = span > 360 ? 60 : 30;
  let from = Math.floor(mins[0] / step) * step, to = Math.floor(mins[mins.length - 1] / step) * step;
  for (let k = 0; (to - from) / step + 1 < 6; k++) { if (k % 2 === 0 && from - step >= 0) from -= step; else if (to + step < 1440) to += step; else from -= step; }
  const buckets = [];
  for (let m = from; m <= to; m += step) buckets.push({ m, onTime: 0, late: 0 });
  arrivals.forEach((a) => { const b = buckets[Math.floor((toMin(a.time) - from) / step)]; if (b) b[a.late ? 'late' : 'onTime']++; });
  const max = Math.max(...buckets.map((b) => b.onTime + b.late));
  const busiest = buckets.reduce((x, b) => (b.onTime + b.late > x.onTime + x.late ? b : x), buckets[0]);
  const median = arrivals[Math.floor((arrivals.length - 1) / 2)].time;
  const lateAt = lateAfter ? toMin(lateAfter) : null;
  const markAt = lateAt !== null && lateAt >= from && lateAt <= to + step ? ((lateAt - from) / (buckets.length * step)) * 100 : null;
  const lateN = arrivals.filter((a) => a.late).length;
  return (
    <div className="ovx-arrivals">
      <div className="ovx-facts">
        {firstIn && (
          <div className="ovx-fact is-bird">
            <span className="ovx-fact-photo"><Photo id={firstIn.id} name={firstIn.name} photo={firstIn.photo} size={44} /><i aria-hidden="true">☀</i></span>
            <span><small>{tr('First in today')}</small><b>{firstIn.name}</b><em>{tr('at {time}', { time: firstIn.time })}{firstIn.department ? ' · ' + firstIn.department : ''}</em></span>
          </div>
        )}
        <div className="ovx-fact"><small>{tr('Half were in by')}</small><b>{median}</b></div>
        <div className="ovx-fact"><small>{tr('Busiest {mins} minutes', { mins: step })}</small><b>{hhmm(busiest.m)}–{hhmm(busiest.m + step)}</b><em>{tr('{n} people', { n: busiest.onTime + busiest.late })}</em></div>
      </div>
      <div className="ovx-cols" role="img" aria-label={buckets.map((b) => hhmm(b.m) + ': ' + tr('{a} on time, {b} late', { a: b.onTime, b: b.late })).join('; ')}>
        {markAt !== null && <span className="ovx-mark" style={{ left: markAt + '%' }}><em>{tr('late after {time}', { time: lateAfter })}</em></span>}
        {buckets.map((b, i) => (
          <div key={b.m} className="ovx-col" title={hhmm(b.m) + '–' + hhmm(b.m + step) + ': ' + tr('{a} on time, {b} late', { a: b.onTime, b: b.late })}>
            <span className="ovx-col-n">{b.onTime + b.late || ''}</span>
            <span className="ovx-col-track">
              {b.onTime > 0 && <i className="is-ontime" style={{ height: (b.onTime / max) * 100 + '%' }} />}
              {b.late > 0 && <i className="is-late" style={{ height: (b.late / max) * 100 + '%' }} />}
            </span>
            <small>{i % (buckets.length > 10 ? 2 : 1) === 0 ? hhmm(b.m) : ''}</small>
          </div>
        ))}
      </div>
      <div className="ovx-legend"><span><i className="is-ontime" />{tr('On time')} · {arrivals.length - lateN}</span><span><i className="is-late" />{tr('Late')} · {lateN}</span></div>
    </div>
  );
}

// ── the last seven days ────────────────────────────────────────────────
export function WeekTrend({ week, headcount, today }) {
  const days = week.map((d) => ({ ...d, rate: headcount ? Math.round((d.present / headcount) * 100) : 0 }));
  const worked = days.filter((d) => d.present > 0 && d.date !== today);
  const best = worked.reduce((x, d) => (!x || d.rate > x.rate ? d : x), null);
  const avg = worked.length ? Math.round(worked.reduce((s, d) => s + d.rate, 0) / worked.length) : null;
  return (
    <div className="ovx-week">
      <div className="ovx-facts">
        {best && <div className="ovx-fact is-best"><small>{tr('Best day')}</small><b>{weekday(best.date, 'long')}</b><em>{tr('{n}% came in', { n: best.rate })}</em></div>}
        {avg !== null && <div className="ovx-fact"><small>{tr('Average of the other days')}</small><b>{avg}%</b></div>}
      </div>
      <div className="ovx-days" role="img" aria-label={days.map((d) => weekday(d.date) + ': ' + d.rate + '%').join(', ')}>
        {days.map((d) => (
          <div key={d.date} className={'ovx-day' + (d.date === today ? ' is-today' : '') + (d.present ? '' : ' is-off')} title={fmtDate(d.date) + ': ' + tr('{present} of {headcount} in', { present: d.present, headcount }) + (d.late ? ' · ' + tr('{n} late', { n: d.late }) : '')}>
            <span className="ovx-day-n">{d.present ? d.rate + '%' : '—'}</span>
            <span className="ovx-day-track">
              {d.present > d.late && <i className="is-ontime" style={{ height: ((d.present - d.late) / Math.max(1, headcount)) * 100 + '%' }} />}
              {d.late > 0 && <i className="is-late" style={{ height: (d.late / Math.max(1, headcount)) * 100 + '%' }} />}
            </span>
            <small>{d.date === today ? tr('Today') : weekday(d.date)}</small>
          </div>
        ))}
      </div>
      <p className="ovx-muted">{tr('Share of everyone you can see who clocked in each day; today so far. Amber, on top, is the part that came in late.')}</p>
    </div>
  );
}

// ── a group today ──────────────────────────────────────────────────────
export function GroupCard({ g, accent, showCompany, onOpen }) {
  const tone = g.rate < 70 ? 'bad' : g.rate < 90 ? 'warn' : 'good';
  const r = 22, c = 2 * Math.PI * r;
  const notIn = Math.max(0, g.headcount - g.present - g.onLeave);
  return (
    <button type="button" className={'ovx-group is-' + tone} style={accent} onClick={onOpen}>
      <span className="ovx-group-ring" role="img" aria-label={tr('{present} of {headcount} in', { present: g.present, headcount: g.headcount })}>
        <svg viewBox="0 0 54 54" width="54" height="54" aria-hidden="true"><circle cx="27" cy="27" r={r} className="ovx-ring-track" /><circle cx="27" cy="27" r={r} className="ovx-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - g.rate / 100)} transform="rotate(-90 27 27)" /></svg>
        <b>{g.rate}<small>%</small></b>
      </span>
      <span className="ovx-group-body">
        <strong>{g.name}</strong>
        {showCompany && <span className="ovx-group-co"><i />{g.company}</span>}
        <span className="ovx-group-chips">
          <em className="is-here">{tr('{present} of {headcount} in', { present: g.present, headcount: g.headcount })}</em>
          {g.late > 0 && <em className="is-late">{tr('{n} late', { n: g.late })}</em>}
          {g.onLeave > 0 && <em className="is-away">{tr('{n} away', { n: g.onLeave })}</em>}
          {notIn > 0 && <em>{tr('{n} not in', { n: notIn })}</em>}
        </span>
      </span>
    </button>
  );
}

// ── a board of people ──────────────────────────────────────────────────
// rows: [{ id, name, photo, meta, side, sideTone }]
export function PeopleCard({ id, tone, icon, title, sub, rows, more, empty }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className={'ovx-board is-' + tone}>
      <header>
        <span className="ovx-board-icon"><Icon name={icon} /></span>
        <span className="ovx-board-title"><b>{title}</b><small>{sub}</small></span>
        <span className="ovx-board-n">{rows.length + (more || 0)}</span>
      </header>
      {rows.length ? (
        <ul>
          {rows.map((p, i) => (
            <li key={p.id || i}>
              <Photo id={p.id} name={p.name} photo={p.photo} size={36} />
              <span className="ovx-board-who"><b>{p.name}</b><small>{p.meta}</small></span>
              {p.side && <span className={'ovx-board-side' + (p.sideTone ? ' is-' + p.sideTone : '')}>{p.side}</span>}
            </li>
          ))}
          {more > 0 && <li className="ovx-board-more">{tr('and {n} more', { n: more })}</li>}
        </ul>
      ) : <p className="ovx-board-empty"><Icon name="check" /> {empty}</p>}
    </section>
  );
}

// ── celebrations and new faces ─────────────────────────────────────────
const GLYPH = {
  cake: <><path d="M4 20h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z" /><path d="M4 15c2 1.5 4 1.5 5.3 0 1.4 1.5 4 1.5 5.4 0 1.3 1.5 3.3 1.5 5.3 0M12 11V8M12 6.5c-1 0-1.5-.8-1.5-1.5S12 3 12 3s1.5 1.3 1.5 2-.5 1.5-1.5 1.5z" /></>,
  medal: <><circle cx="12" cy="15" r="5" /><path d="M8.5 11 6 3h4l2 5 2-5h4l-2.5 8M12 13v4" /></>,
  wave: <><path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V12M16 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-12.6 4.2L4 15a1.6 1.6 0 0 1 2.4-2.1L7 13.5" /></>
};
// items: [{ key, glyph, tone, person, title, when, days }]
export function Celebrations({ items }) {
  return (
    <div className="ovx-cele">
      {items.map((it) => (
        <div key={it.key} className={'ovx-cele-card is-' + it.tone + (it.days === 0 ? ' is-today' : '')}>
          {it.days === 0 && <span className="ovx-confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} />)}</span>}
          <span className="ovx-cele-photo">
            <Photo id={it.person.id} name={it.person.name} photo={it.person.photo} size={52} />
            <span className="ovx-cele-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[it.glyph]}</svg></span>
          </span>
          <span className="ovx-cele-body">
            <b>{it.person.name}</b>
            <span>{it.title}</span>
            <small>{it.when}</small>
          </span>
          <span className="ovx-cele-days">{it.days === 0 ? <b>{tr('Today!')}</b> : it.days === null ? null : <><b>{it.days}</b><small>{it.days === 1 ? tr('day') : tr('days')}</small></>}</span>
        </div>
      ))}
    </div>
  );
}

// ── a restaurant today ─────────────────────────────────────────────────
// Takings added up hour by hour: today (so far) against the same day last
// week, so "are we ahead?" reads at a glance.
export function RestaurantCard({ r, currency, lastDay, nowHour, change, onOpen }) {
  const rows = r.byHour || [];
  const hours = rows.map((h) => h.hour);
  const first = hours.length ? Math.min(...hours) : nowHour;
  const last = Math.max(hours.length ? Math.max(...hours) : nowHour, Math.min(23, nowHour));
  const span = Math.max(1, last - first + 1);
  const at = {}; rows.forEach((h) => { at[h.hour] = h; });
  let a = 0, b = 0;
  const today = [], before = [];
  for (let h = first; h <= last; h++) {
    a += at[h] ? at[h].today : 0; b += at[h] ? at[h].lastWeek : 0;
    if (h <= nowHour) today.push([h, a]);
    before.push([h, b]);
  }
  const max = Math.max(1, a, b);
  const W = 300, H = 120, base = H - 18, x = (h) => 8 + ((h - first + 1) / span) * (W - 16), y = (v) => base - (v / max) * (base - 10);
  const line = (pts) => 'M' + x(first - 1) + ' ' + y(0) + pts.map((p) => ' L' + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join('');
  const pct = change;
  return (
    <button type="button" className="ovx-rest" onClick={onOpen}>
      <span className="ovx-rest-head">
        <CompanyMark company={{ code: r.code, name: r.name }} size={40} />
        <span className="ovx-rest-name"><b>{r.name}</b><small>{r.ordersToday === 1 ? tr('1 order today') : tr('{n} orders today', { n: r.ordersToday })}</small></span>
        <span className={'ovx-delta' + (pct === null ? '' : pct >= 0 ? ' is-up' : ' is-down')}>{pct === null ? tr('new') : (pct > 0 ? '+' : '') + pct + '%'}</span>
      </span>
      <strong className="ovx-rest-sales">{money(r.salesToday, currency)}</strong>
      <svg className="ovx-rest-chart" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label={tr('Takings through the day: {a} today, {b} last {day}', { a: money(a, currency), b: money(b, currency), day: lastDay })}>
        <path d={'M8 ' + base + 'H' + (W - 8)} className="ovx-rest-axis" />
        {before.length > 0 && <path d={line(before)} className="ovx-rest-before" />}
        {today.length > 0 && <path d={line(today) + ' L' + x(today[today.length - 1][0]).toFixed(1) + ' ' + y(0) + ' L' + x(first - 1) + ' ' + y(0) + 'Z'} className="ovx-rest-area" />}
        {today.length > 0 && <path d={line(today)} className="ovx-rest-today" />}
        {today.length > 0 && <circle cx={x(today[today.length - 1][0])} cy={y(today[today.length - 1][1])} r="4.5" className="ovx-rest-dot" />}
        {before.map((p, i) => (
          <rect key={p[0]} x={x(p[0]) - (W - 16) / span} y="0" width={(W - 16) / span} height={base} className="ovx-rest-hit">
            <title>{tr('By {time}', { time: hhmm(p[0] * 60 + 60) }) + ': ' + tr('{a} today, {b} last {day}', { a: today[i] ? money(today[i][1], currency) : '—', b: money(p[1], currency), day: lastDay })}</title>
          </rect>
        ))}
        <text x="8" y={H - 2} className="ovx-rest-tick">{hhmm(first * 60)}</text>
        <text x={W - 8} y={H - 2} textAnchor="end" className="ovx-rest-tick">{hhmm(Math.min(24, last + 1) * 60)}</text>
      </svg>
      <span className="ovx-legend"><span><i className="is-today" />{tr('Today')}</span><span><i className="is-before" />{tr('Last {day}', { day: lastDay })} · {money(b, currency)}</span></span>
      {(r.lowStock > 0 || r.expiringSoon > 0) && (
        <span className="ovx-rest-warn"><Icon name="warn" /> {[r.lowStock ? tr('{n} to reorder', { n: r.lowStock }) : '', r.expiringSoon ? tr('{n} expiring soon', { n: r.expiringSoon }) : ''].filter(Boolean).join(' · ')}</span>
      )}
    </button>
  );
}

// ── what is waiting ────────────────────────────────────────────────────
export function WaitTile({ t, onOpen }) {
  return (
    <button type="button" className={'ovx-wait' + (t.alert ? ' is-alert' : ' is-calm')} onClick={onOpen}>
      <span className="ovx-wait-icon"><Icon name={t.icon} /></span>
      <span className="ovx-wait-body"><strong>{t.value}</strong><b>{t.label}</b><small>{t.help}</small></span>
      <span className="ovx-wait-go"><Icon name="arrow" /></span>
    </button>
  );
}

// ── latest activity ────────────────────────────────────────────────────
const ACTION_ICON = [
  [/^(invoice|payment|quotation|estimate|salesorder|credit)/, 'receipt'], [/^(employee|user|role|shift)/, 'people'], [/^leave/, 'calendar'],
  [/^attendance/, 'clock'], [/^(expense|payroll|procurement)/, 'cash'], [/^(product|catalog|warehouse|rawbatch|production|restaurant|inventory)/, 'bag'],
  [/^(task|project)/, 'doc'], [/^(toolroom|itdevice|maintenance|asset|waybill)/, 'wrench'], [/^(settings|auth)/, 'key'],
  [/^(announcement|chat|message|mail|whatsapp|marketing|crm|customer|supplier)/, 'send'], [/^poki/, 'building']
];
export function Activity({ logs, ago }) {
  return (
    <ol className="ovx-activity">
      {logs.map((log) => {
        const icon = (ACTION_ICON.find(([re]) => re.test(log.action || '')) || [null, 'spark'])[1];
        const who = log.actorName || tr('System');
        return (
          <li key={log.id}>
            <span className="ovx-act-avatar" style={{ background: avatarColor(who) }} aria-hidden="true">{initials(who)}<i><Icon name={icon} /></i></span>
            <span className="ovx-act-body"><span>{log.summary}</span><small>{who} · {ago(log.at)}</small></span>
          </li>
        );
      })}
    </ol>
  );
}
