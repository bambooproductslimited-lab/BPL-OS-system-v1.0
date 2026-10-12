import Photo from '../components/Photo';
import { Icon, avatarColor, initials } from '../components/DashKit';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

// The Companies page's livelier pieces (DepartmentsPage.jsx): an org-chart
// banner with how many are in today as a ring, a tile per company with its
// team make-up, the 24-hour "who works when" of every shift time with the
// time now marked, and the department cards with their faces. Each company
// keeps one colour everywhere on the page (in a fixed order, Bamboo
// Products first), always with its name beside it. Styles in
// CompaniesFun.css (.cof-*).

// Categorical slots, light and dark (validated for colour blindness); a 5th
// company and on share the neutral grey.
const ACCENTS = [['#2a78d6', '#3987e5'], ['#eb6834', '#d95926'], ['#1baf7a', '#199e70'], ['#eda100', '#c98500']];
const OTHER = ['#8b929c', '#9ca3af'];
export function companyOrder(list) {
  return list.slice().sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
}
export function accentStyle(index) {
  const [light, dark] = ACCENTS[index] || OTHER;
  return { '--c': light, '--c-dark': dark };
}

export function years(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 });
}
export function joined(iso) {
  return iso ? new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

// The company's logo, or its initials on its colour.
export function CompanyMark({ company, size = 48 }) {
  const logo = restaurantLogoUrl(company.code);
  return logo
    ? <img className="cof-logo" src={logo} alt="" style={{ width: size, height: size }} />
    : <span className="cof-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.32), background: avatarColor(company.name) }} aria-hidden="true">{initials(company.name)}</span>;
}

// A small ring: value of max, the share in the middle.
export function MiniRing({ value, max, size = 46, label }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  const part = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className="cof-miniring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox={'0 0 ' + size + ' ' + size} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="cof-miniring-track" strokeWidth="5" />
        <circle cx={size / 2} cy={size / 2} r={r} className="cof-miniring-fill" strokeWidth="5" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - part)} transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'} />
      </svg>
      <b style={{ fontSize: Math.max(8, Math.round(size * 0.22)) }}>{max > 0 ? Math.round(part * 100) : 0}<small>%</small></b>
    </span>
  );
}

// Up to five faces, overlapping, and how many more.
export function Faces({ faces, total, size = 30 }) {
  const shown = faces.slice(0, 5);
  const more = Math.max(0, total - shown.length);
  return (
    <span className="cof-faces" aria-label={tr('{n} people', { n: total })}>
      {shown.map((f) => <span key={f.id} className="cof-face" title={f.name}><Photo id={f.id} name={f.name} photo={f.photo} size={size} /></span>)}
      {more > 0 && <span className="cof-face cof-face-more" style={{ width: size, height: size }}>+{more}</span>}
    </span>
  );
}

// ── the banner ─────────────────────────────────────────────────────────
export function CoBanner({ eyebrow, title, sub, actions, ring, tiles }) {
  return (
    <section className="cof-hero">
      <span className="cof-hero-glow" aria-hidden="true" />
      <svg className="cof-hero-art" viewBox="0 0 320 220" aria-hidden="true">
        <rect x="120" y="14" width="80" height="40" rx="12" />
        <path d="M160 54v26M60 80h200M60 80v24M160 80v24M260 80v24" />
        <rect x="22" y="104" width="76" height="36" rx="11" /><rect x="122" y="104" width="76" height="36" rx="11" /><rect x="222" y="104" width="76" height="36" rx="11" />
        <path d="M60 140v22M38 162h44M38 162v16M82 162v16M260 140v22M238 162h44M238 162v16M282 162v16" />
        <circle cx="38" cy="190" r="11" /><circle cx="82" cy="190" r="11" /><circle cx="238" cy="190" r="11" /><circle cx="282" cy="190" r="11" />
      </svg>
      <div className="cof-hero-main">
        <p className="cof-eyebrow"><span className="cof-eyebrow-dot" />{eyebrow}</p>
        <h1 className="cof-hero-title">{title}</h1>
        <p className="cof-hero-sub">{sub}</p>
        {actions && <div className="cof-hero-actions">{actions}</div>}
      </div>
      <div className="cof-hero-side">
        {ring && (
          <div className="cof-hero-ring">
            <span className="cof-bigring" style={{ '--p': ring.max > 0 ? Math.round(Math.min(1, ring.value / ring.max) * 100) : 0 }} role="img" aria-label={ring.caption}>
              <strong>{ring.big}</strong><small>{ring.small}</small>
            </span>
            <span className="cof-hero-ring-cap">{ring.caption}</span>
          </div>
        )}
        <div className="cof-tiles">
          {tiles.map((t, i) => (
            <button key={i} type="button" className={'cof-tile' + (t.tone ? ' is-' + t.tone : '')} onClick={t.onClick}>
              <span className="cof-tile-label"><Icon name={t.icon} /> {t.label}</span>
              <strong>{t.value}</strong>
              {t.note && <small>{t.note}</small>}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── a company at a glance ───────────────────────────────────────────────
export function GlanceTile({ company, index, seeAttendance, onOpen }) {
  const depts = company.departments.filter((d) => d.headcount > 0).sort((a, b) => b.headcount - a.headcount);
  const expected = Math.max(0, company.people - company.onLeave);
  return (
    <button type="button" className="cof-glance-tile" style={accentStyle(index)} onClick={onOpen}>
      <span className="cof-glance-top">
        <CompanyMark company={company} size={44} />
        <span className="cof-glance-name"><b>{company.name}</b><small>{company.code} · {company.departments.length === 1 ? tr('1 department') : tr('{n} departments', { n: company.departments.length })}</small></span>
      </span>
      <span className="cof-glance-mid">
        <span className="cof-glance-big"><strong>{company.people}</strong><small>{company.people === 1 ? tr('person') : tr('people')}</small></span>
        {seeAttendance && company.people > 0 && (
          <span className="cof-glance-in">
            <MiniRing value={company.inToday} max={expected} label={tr('{n} of {total} in today', { n: company.inToday, total: expected })} />
            <small>{tr('{n} of {total} in today', { n: company.inToday, total: expected })}</small>
          </span>
        )}
      </span>
      {depts.length > 0 ? (
        <>
          <span className="cof-makeup" aria-hidden="true">
            {depts.map((d, i) => <i key={d.id} title={d.name + ': ' + d.headcount} style={{ flexGrow: d.headcount, '--step': Math.max(28, 100 - i * 16) + '%' }} />)}
          </span>
          <span className="cof-makeup-legend">
            {depts.slice(0, 3).map((d, i) => <span key={d.id}><i style={{ '--step': Math.max(28, 100 - i * 16) + '%' }} />{d.name} <b>{d.headcount}</b></span>)}
            {depts.length > 3 && <span className="cof-muted">{tr('+{n} more', { n: depts.length - 3 })}</span>}
          </span>
        </>
      ) : <span className="cof-muted">{tr('Nobody here yet')}</span>}
      {company.newest && (
        <span className="cof-glance-new">
          <Photo id={company.newest.id} name={company.newest.name} photo={company.newest.photo} size={24} />
          <span>{tr('Newest: {name}, joined {date}', { name: company.newest.name, date: joined(company.newest.hireDate) })}</span>
        </span>
      )}
    </button>
  );
}

// ── who works when ──────────────────────────────────────────────────────
function minutes(t) { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
// A shift as bars on the day: an overnight one is two pieces.
function pieces(start, end) {
  const a = minutes(start), b = minutes(end);
  if (b > a) return [[a, b]];
  if (b === 0) return [[a, 1440]];
  return [[a, 1440], [0, b]];
}
export function ShiftClock({ companies, now }) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Within a company, departments working the same hours share one row.
  const groups = companies.map((c, i) => {
    const byTime = new Map();
    c.departments.forEach((d) => d.shifts.forEach((s) => {
      const k = s.startTime + '-' + s.endTime;
      if (!byTime.has(k)) byTime.set(k, { id: s.id, startTime: s.startTime, endTime: s.endTime, names: [], depts: [], assignedCount: 0 });
      const r = byTime.get(k);
      if (!r.names.some((x) => x.toLowerCase() === s.name.toLowerCase())) r.names.push(s.name);
      r.depts.push(d.name);
      r.assignedCount += s.assignedCount;
    }));
    return { c, i, rows: Array.from(byTime.values()).sort((a, b) => minutes(a.startTime) - minutes(b.startTime) || minutes(a.endTime) - minutes(b.endTime)) };
  }).filter((g) => g.rows.length);
  const nameOf = (r) => (r.names.length > 2 ? r.names.slice(0, 2).join(' / ') + ' …' : r.names.join(' / '));
  const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const on = (s) => pieces(s.startTime, s.endTime).some(([a, b]) => nowMin >= a && nowMin < b);
  return (
    <div className="cof-clock">
      <div className="cof-clock-row cof-clock-axisrow" aria-hidden="true">
        <span />
        <span className="cof-clock-axis">
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <i key={h} style={{ left: (h / 24) * 100 + '%' }}>{String(h % 24).padStart(2, '0')}</i>)}
          <b className="cof-clock-nowlabel" style={{ left: (nowMin / 1440) * 100 + '%' }}>{tr('now {time}', { time: hhmm(nowMin) })}</b>
        </span>
        <span />
      </div>
      {groups.map((g) => (
        <div key={g.c.id} className="cof-clock-group" style={accentStyle(g.i)}>
          <p className="cof-clock-co"><i />{g.c.name}</p>
          {g.rows.map((s) => (
            <div key={s.id} className={'cof-clock-row' + (on(s) ? ' is-on' : '')} title={tr('{shift}, {dept}: {start}–{end}, {n} people', { shift: s.names.join(' / '), dept: s.depts.join(', '), start: s.startTime, end: s.endTime, n: s.assignedCount })}>
              <span className="cof-clock-label"><b>{nameOf(s)}</b><small><span className="cof-clock-time">{s.startTime}–{s.endTime}</span> · {s.depts.join(', ')}</small></span>
              <span className="cof-clock-track">
                {[0, 6, 12, 18].map((h) => <u key={h} style={{ left: (h / 24) * 100 + '%' }} aria-hidden="true" />)}
                {pieces(s.startTime, s.endTime).map(([a, b], k) => <i key={k} style={{ left: (a / 1440) * 100 + '%', width: Math.max(0.6, ((b - a) / 1440) * 100) + '%' }} />)}
                <em className="cof-clock-now" style={{ left: (nowMin / 1440) * 100 + '%' }} aria-hidden="true" />
              </span>
              <span className="cof-clock-n">{on(s) && <span className="cof-live">{tr('on now')}</span>}{s.assignedCount === 1 ? tr('1 person') : tr('{n} people', { n: s.assignedCount })}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// A shift time as a chip with where it sits in the day.
export function ShiftChip({ shift }) {
  return (
    <span className="cof-shift" title={tr('{n} people on this shift', { n: shift.assignedCount })}>
      <span className="cof-shift-text"><b>{shift.name}</b> {shift.startTime}–{shift.endTime}</span>
      <span className="cof-shift-day" aria-hidden="true">{pieces(shift.startTime, shift.endTime).map(([a, b], k) => <i key={k} style={{ left: (a / 1440) * 100 + '%', width: Math.max(2, ((b - a) / 1440) * 100) + '%' }} />)}</span>
    </span>
  );
}
