import { Icon } from '../components/DashKit';
import Photo from '../components/Photo';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';

// The employee directory's livelier pieces (EmployeesPage.jsx, styles in
// PeopleFun.css): a banner with a mosaic of faces, who is online and in
// today, this month's work anniversaries and new joiners, and the make-up
// of the team — where everyone works, how long they have been here, the
// kinds of employment and the biggest teams. Chart colours are a
// validated categorical set, each with its name and count written beside it.

export function fullName(e) { return e.firstName + ' ' + e.lastName; }
export function tenureYears(hireDate, now) {
  if (!hireDate) return null;
  const h = new Date(String(hireDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(h.getTime())) return null;
  const n = now || new Date();
  let y = n.getUTCFullYear() - h.getUTCFullYear();
  if (n.getUTCMonth() < h.getUTCMonth() || (n.getUTCMonth() === h.getUTCMonth() && n.getUTCDate() < h.getUTCDate())) y--;
  return Math.max(0, y);
}
export function tenureText(hireDate) {
  const y = tenureYears(hireDate);
  if (y === null) return null;
  if (y >= 1) return y === 1 ? tr('1 year') : tr('{n} years', { n: y });
  const days = Math.max(0, Math.floor((Date.now() - new Date(String(hireDate).slice(0, 10) + 'T00:00:00Z').getTime()) / 86400000));
  const months = Math.floor(days / 30.4);
  return months >= 1 ? (months === 1 ? tr('1 month') : tr('{n} months', { n: months })) : tr('new');
}
function dayMonth(iso) { return new Date(String(iso).slice(0, 10) + 'T00:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }); }
// Each group keeps a hue of its own, from its name.
export function hueOf(name) { let h = 0; const s = String(name || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }

// Where someone is today: in, done for the day, late, on leave — from the
// directory's facts (today is only there for those who may see attendance).
export function todayState(p) {
  if (p.today && (p.today.status === 'present' || p.today.status === 'late' || p.today.status === 'half_day')) return p.today.clockOut ? 'done' : p.today.status === 'late' ? 'late' : 'in';
  if (p.onLeaveUntil) return 'leave';
  return null;
}
const STATE = { in: msg('In today'), late: msg('In today, late'), done: msg('Done for the day'), leave: msg('On leave') };

// A photo with a ring for today and a dot when they have the OS open.
export function Face({ p, size }) {
  const st = todayState(p);
  const title = [p.online ? tr('Online now') : null, st ? tr(STATE[st]) + (p.today && p.today.clockIn ? ' · ' + p.today.clockIn : '') : null].filter(Boolean).join(' · ');
  return (
    <span className={'pf-face' + (st ? ' is-' + st : '') + (p.online ? ' is-online' : '')} title={title || undefined}>
      <Photo id={p.id} name={fullName(p)} photo={p.photo} size={size} />
      {p.online && <i className="pf-dot" aria-label={tr('Online now')} />}
    </span>
  );
}

// ── the banner ────────────────────────────────────────────────────────
export function PeopleBanner({ eyebrow, title, sub, actions, people, tiles, online, inToday, hasToday }) {
  const faces = people.slice().sort((a, b) => (b.photo ? 1 : 0) - (a.photo ? 1 : 0) || (b.online ? 1 : 0) - (a.online ? 1 : 0)).slice(0, 14);
  return (
    <header className="pf-hero">
      <span className="pf-hero-glow" aria-hidden="true" />
      <div className="pf-hero-main">
        <p className="pf-eyebrow">{eyebrow}</p>
        <h2 className="pf-hero-title">{title}</h2>
        <p className="pf-hero-sub">{sub}</p>
        {actions && <div className="pf-hero-actions no-print">{actions}</div>}
      </div>
      <div className="pf-hero-side">
        <div className="pf-mosaic">
          <div className="pf-mosaic-faces" aria-hidden="true">
            {faces.map((p, i) => <span key={p.id} className="pf-mosaic-face" style={{ '--i': i }}><Face p={p} size={42} /></span>)}
          </div>
          <div className="pf-mosaic-text">
            <strong>{people.length}</strong>
            <span>{people.length === 1 ? tr('person') : tr('people')}</span>
            <span className="pf-live-row">
              <span className="pf-live"><i aria-hidden="true" />{tr('{n} online now', { n: online })}</span>
              {hasToday && <span className="pf-live is-in"><i aria-hidden="true" />{tr('{n} in today', { n: inToday })}</span>}
            </span>
          </div>
        </div>
        <div className="pf-tiles">
          {tiles.map((t, i) => {
            const Tag = t.onClick ? 'button' : 'div';
            return (
              <Tag key={i} type={t.onClick ? 'button' : undefined} onClick={t.onClick} className={'pf-tile' + (t.tone ? ' is-' + t.tone : '') + (t.active ? ' is-on' : '')}>
                <span className="pf-tile-top"><span className="pf-tile-icon"><Icon name={t.icon} /></span><span className="pf-cap">{t.label}</span></span>
                <strong>{t.value}</strong>
                {t.note && <small>{t.note}</small>}
              </Tag>
            );
          })}
        </div>
      </div>
    </header>
  );
}

// ── a panel ───────────────────────────────────────────────────────────
const GLYPH = {
  party: <><path d="M4 20 9 7l8 8z" /><path d="M14 4.5c.5 1.5 0 2.5-1 3M19.5 10c-1.5-.5-2.5 0-3 1M18 4l.5 1.5M20.5 6.5 19 7" /></>,
  pie: <><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5H12z" /><path d="M15 3.8A8.5 8.5 0 0 1 20.2 9H15z" /></>,
  hourglass: <><path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 8 5 8 8.5s-8 4.5-8 8.5M16 3.5c0 4-8 5-8 8.5s8 4.5 8 8.5" /></>,
  badge: <><rect x="4.5" y="5" width="15" height="14" rx="2" /><circle cx="12" cy="10.5" r="2.4" /><path d="M8.5 16c.7-1.6 2-2.4 3.5-2.4s2.8.8 3.5 2.4" /></>,
  tree: <><rect x="9" y="3.5" width="6" height="4.5" rx="1" /><rect x="3.5" y="15.5" width="6" height="4.5" rx="1" /><rect x="14.5" y="15.5" width="6" height="4.5" rx="1" /><path d="M12 8v3.5M6.5 15.5v-2h11v2" /></>
};
export function PanelHead({ icon, title, sub }) {
  return (
    <header className="pf-panel-head">
      <h3><span className={'pf-panel-icon is-' + icon}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[icon]}</svg></span>{title}</h3>
      {sub && <p>{sub}</p>}
    </header>
  );
}

// ── this month: work anniversaries and new joiners ────────────────────
export function ThisMonth({ people, onOpen, newDays }) {
  const now = new Date();
  const m = now.getUTCMonth();
  // Hired in this month of an earlier year: this month they complete another year.
  const anniversaries = people.filter((p) => p.hireDate && Number(String(p.hireDate).slice(5, 7)) === m + 1 && Number(String(p.hireDate).slice(0, 4)) < now.getUTCFullYear())
    .map((p) => ({ p, years: now.getUTCFullYear() - Number(String(p.hireDate).slice(0, 4)), day: Number(String(p.hireDate).slice(8, 10)) }))
    .sort((a, b) => a.day - b.day);
  const joiners = people.filter((p) => { const d = p.hireDate ? Math.floor((Date.now() - new Date(String(p.hireDate).slice(0, 10) + 'T00:00:00Z').getTime()) / 86400000) : null; return d !== null && d >= 0 && d <= newDays; })
    .sort((a, b) => String(b.hireDate).localeCompare(String(a.hireDate)));
  if (!anniversaries.length && !joiners.length) return null;
  const today = now.getUTCDate();
  return (
    <section className="pf-panel is-wide pf-month">
      <PanelHead icon="party" title={tr('This month')} sub={tr('Work anniversaries in {month}, and the people who joined in the last {n} days. A good time to say congratulations, or welcome.', { month: now.toLocaleDateString(activeIntlLocale(), { month: 'long', timeZone: 'UTC' }), n: newDays })} />
      <ul className="pf-cele">
        {anniversaries.map(({ p, years, day }) => (
          <li key={'a' + p.id} className={'pf-cele-card is-anniv' + (day === today ? ' is-today' : day < today ? ' is-past' : '')}>
            <button type="button" onClick={() => onOpen(p)}>
              <span className="pf-cele-badge">{years}</span>
              <Face p={p} size={52} />
              <strong>{fullName(p)}</strong>
              <small>{years === 1 ? tr('1 year on {date}', { date: dayMonth(p.hireDate) }) : tr('{n} years on {date}', { n: years, date: dayMonth(p.hireDate) })}</small>
              {day === today && <span className="pf-cele-today">{tr('Today!')}</span>}
            </button>
          </li>
        ))}
        {joiners.map((p) => (
          <li key={'j' + p.id} className="pf-cele-card is-new">
            <button type="button" onClick={() => onOpen(p)}>
              <span className="pf-cele-badge is-new">{tr('New')}</span>
              <Face p={p} size={52} />
              <strong>{fullName(p)}</strong>
              <small>{tr('Joined {date}', { date: dayMonth(p.hireDate) })}{p.positionTitle ? ' · ' + p.positionTitle : ''}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── where everyone works ──────────────────────────────────────────────
export function Composition({ slices, total, title, onPick }) {
  const sorted = slices.slice().sort((a, b) => b.value - a.value);
  const parts = sorted.length > 5 ? sorted.slice(0, 4).concat([{ key: 'rest', name: tr('Other'), value: sorted.slice(4).reduce((a, x) => a + x.value, 0), rest: true }]) : sorted;
  const r = 40, c = 2 * Math.PI * r, gap = parts.length > 1 ? 2.5 : 0;
  let at = 0;
  return (
    <div className="pf-donut">
      <div className="pf-donut-chart">
        <svg viewBox="0 0 100 100" role="img" aria-label={parts.map((p) => p.name + ': ' + p.value).join(', ')}>
          <circle cx="50" cy="50" r={r} className="pf-donut-track" />
          {parts.map((p, i) => {
            const len = Math.max(0, c * p.value / total - gap);
            const el = <circle key={p.key} cx="50" cy="50" r={r} className={'pf-donut-seg is-s' + (i + 1)} strokeDasharray={len + ' ' + (c - len)} strokeDashoffset={-at} transform="rotate(-90 50 50)"><title>{p.name + ': ' + p.value}</title></circle>;
            at += c * p.value / total;
            return el;
          })}
        </svg>
        <span className="pf-donut-center"><strong>{total}</strong><small>{title}</small></span>
      </div>
      <ul className="pf-legend">
        {parts.map((p, i) => (
          <li key={p.key}>
            <button type="button" disabled={p.rest || !onPick} onClick={() => onPick && !p.rest && onPick(p)}>
              <i className={'pf-swatch is-s' + (i + 1)} />
              <span className="pf-legend-name">{p.name}</span>
              <span className="pf-legend-n">{p.value}</span>
              <span className="pf-legend-pct">{Math.round(p.value / total * 100)}%</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── how long people have been with us ─────────────────────────────────
const BUCKETS = [[0, 1, msg('Under a year')], [1, 2, msg('1–2 years')], [2, 5, msg('2–5 years')], [5, 10, msg('5–10 years')], [10, 999, msg('10 years and more')]];
export function Tenure({ people, onOpen }) {
  const known = people.map((p) => ({ p, y: tenureYears(p.hireDate) })).filter((x) => x.y !== null);
  if (!known.length) return <p className="pf-none">{tr('No hire dates on record yet.')}</p>;
  const counts = BUCKETS.map(([lo, hi]) => known.filter((x) => x.y >= lo && x.y < hi).length);
  const max = Math.max(1, ...counts);
  const months = known.map((x) => (Date.now() - new Date(String(x.p.hireDate).slice(0, 10) + 'T00:00:00Z').getTime()) / (86400000 * 30.44));
  const avg = months.reduce((a, n) => a + n, 0) / months.length;
  const veterans = known.slice().sort((a, b) => String(a.p.hireDate).localeCompare(String(b.p.hireDate))).slice(0, 3);
  return (
    <>
      <ul className="pf-bars">
        {BUCKETS.map(([, , label], i) => (
          <li key={label}>
            <span className="pf-bar-label">{tr(label)}</span>
            <span className="pf-bar-track"><i style={{ width: Math.max(counts[i] ? 4 : 0, counts[i] / max * 100) + '%' }} /></span>
            <b>{counts[i]}</b>
          </li>
        ))}
      </ul>
      <p className="pf-foot">{avg >= 12 ? tr('On average, {n} years with the company.', { n: (Math.round(avg / 12 * 10) / 10).toLocaleString(activeIntlLocale()) }) : tr('On average, {n} months with the company.', { n: Math.round(avg) })}</p>
      <h4 className="pf-sub">{tr('Longest serving')}</h4>
      <ol className="pf-veterans">
        {veterans.map(({ p, y }, i) => (
          <li key={p.id}>
            <button type="button" onClick={() => onOpen(p)}>
              <span className={'pf-medal is-' + (i + 1)}>{i + 1}</span>
              <Face p={p} size={36} />
              <span className="pf-who"><strong>{fullName(p)}</strong><small>{tr('Since {date}', { date: new Date(String(p.hireDate).slice(0, 10) + 'T00:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }) })}</small></span>
              <span className="pf-years">{y >= 1 ? (y === 1 ? tr('1 year') : tr('{n} years', { n: y })) : tenureText(p.hireDate)}</span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

// ── the kinds of employment ───────────────────────────────────────────
const KINDS = [['permanent', msg('Permanent')], ['contract', msg('Contract')], ['casual', msg('Casual')], ['day_rate', msg('Paid by the day')]];
export function Kinds({ people }) {
  const total = people.length;
  if (!total) return <p className="pf-none">{tr('Nobody here yet.')}</p>;
  const rows = KINDS.map(([k, label], i) => ({ k, label, n: people.filter((p) => p.employmentType === k).length, slot: i + 1 })).filter((r) => r.n);
  return (
    <>
      <div className="pf-stack" role="img" aria-label={rows.map((r) => tr(r.label) + ': ' + r.n).join(', ')}>
        {rows.map((r) => <i key={r.k} className={'is-s' + r.slot} style={{ flexGrow: r.n }} title={tr(r.label) + ': ' + r.n} />)}
      </div>
      <ul className="pf-legend is-row">
        {rows.map((r) => <li key={r.k}><span><i className={'pf-swatch is-s' + r.slot} /><span className="pf-legend-name">{tr(r.label)}</span><span className="pf-legend-n">{r.n}</span><span className="pf-legend-pct">{Math.round(r.n / total * 100)}%</span></span></li>)}
      </ul>
    </>
  );
}

// ── the biggest teams ─────────────────────────────────────────────────
export function Teams({ people, byId, onOpen }) {
  const by = new Map();
  people.forEach((p) => { if (p.managerId && byId[p.managerId]) by.set(p.managerId, [...(by.get(p.managerId) || []), p]); });
  const teams = [...by.entries()].map(([id, team]) => ({ lead: byId[id], team })).sort((a, b) => b.team.length - a.team.length || fullName(a.lead).localeCompare(fullName(b.lead))).slice(0, 5);
  if (!teams.length) return <p className="pf-none">{tr('Nobody reports to anyone yet. Set each person\'s manager to see the teams.')}</p>;
  const max = teams[0].team.length;
  return (
    <ol className="pf-teams">
      {teams.map(({ lead, team }) => (
        <li key={lead.id}>
          <button type="button" onClick={() => onOpen(lead)} className="pf-team-lead">
            <Face p={lead} size={40} />
            <span className="pf-who"><strong>{fullName(lead)}</strong><small>{lead.positionTitle || '—'}</small></span>
          </button>
          <span className="pf-team-faces" aria-hidden="true">
            {team.slice(0, 5).map((p) => <Photo key={p.id} id={p.id} name={fullName(p)} photo={p.photo} size={28} />)}
            {team.length > 5 && <span className="pf-more">+{team.length - 5}</span>}
          </span>
          <span className="pf-team-bar"><i style={{ width: (team.length / max * 100) + '%' }} /></span>
          <b>{team.length === 1 ? tr('1 person') : tr('{n} people', { n: team.length })}</b>
        </li>
      ))}
    </ol>
  );
}
