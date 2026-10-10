import { Icon, fmtDate } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { Ring } from './crm/crmFun';
import './PokiFun.css';

// The look every Poki Properties screen shares (PokiDashboardPage.jsx and
// the six beside it): a sunset banner with a skyline, a ring for the page's
// one number and glass tiles for the rest; every unit as a coloured tile;
// a lease as a bar running to its end; the next 90 days as a strip; a
// pipeline for the letting offers. Styles in PokiFun.css (.pkf-*).

function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}

// Buildings along the bottom of the banner, lit windows and all.
function Skyline() {
  return (
    <svg className="pkf-skyline" viewBox="0 0 520 120" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <g className="pkf-sky-b">
        <rect x="20" y="52" width="58" height="68" rx="3" /><rect x="86" y="24" width="44" height="96" rx="3" /><rect x="138" y="64" width="70" height="56" rx="3" />
        <rect x="216" y="38" width="52" height="82" rx="3" /><path d="M276 120V58l34-22 34 22v62z" /><rect x="352" y="14" width="40" height="106" rx="3" />
        <rect x="400" y="48" width="64" height="72" rx="3" /><rect x="472" y="70" width="44" height="50" rx="3" />
      </g>
      <g className="pkf-sky-w">
        {[[30, 62], [52, 62], [30, 80], [52, 80], [96, 34], [112, 34], [96, 54], [112, 54], [96, 74], [148, 74], [170, 74], [188, 74], [226, 50], [246, 50], [226, 70], [292, 70], [314, 70], [362, 26], [376, 26], [362, 46], [376, 66], [410, 58], [432, 58], [450, 78], [482, 80]]
          .map(([x, y], i) => <rect key={i} x={x} y={y} width="9" height="11" rx="1.5" className={i % 3 === 0 ? 'is-off' : ''} />)}
      </g>
    </svg>
  );
}

// The banner. stats: [{ icon, value, label, note, tone, onClick }];
// ring: { value, max, big, small, caption, tone }.
export function PkBanner({ eyebrow, title, sub, actions, stats, ring }) {
  return (
    <section className="pkf-hero">
      <span className="pkf-hero-glow" aria-hidden="true" />
      <Skyline />
      <div className="pkf-hero-main">
        <p className="pkf-eyebrow"><span className="pkf-logo" aria-hidden="true"><Icon name="building" /></span>{eyebrow}</p>
        <h1 className="pkf-hero-title">{title}</h1>
        {sub && <p className="pkf-hero-sub">{sub}</p>}
        {actions && <div className="pkf-hero-actions no-print">{actions}</div>}
      </div>
      <div className={'pkf-hero-side' + (ring ? '' : ' no-ring')}>
        {ring && (
          <div className="pkf-ring">
            <Ring value={ring.value} max={ring.max || 1} size={132} stroke={13} tone={ring.tone || ''}>
              <strong>{ring.big}</strong>
              {ring.small && <small>{ring.small}</small>}
            </Ring>
            {ring.caption && <span className="pkf-ring-cap">{ring.caption}</span>}
          </div>
        )}
        <div className="pkf-tiles">
          {(stats || []).map((s, i) => {
            const Tag = s.onClick ? 'button' : 'div';
            return (
              <Tag key={i} type={s.onClick ? 'button' : undefined} onClick={s.onClick} className={'pkf-tile' + (s.tone ? ' is-' + s.tone : '')}>
                <span className="pkf-tile-label"><Icon name={s.icon} /> {s.label}</span>
                <span className={'pkf-tile-value' + (String(s.value).length > 12 ? ' is-long' : '')}>{s.value}</span>
                {s.note && <span className="pkf-tile-note">{s.note}</span>}
              </Tag>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ── every unit as a tile ────────────────────────────────────────────
export function unitState(u) {
  if (u.status === 'occupied') {
    const d = daysUntil(u.bookingEnd);
    return d !== null && d <= 30 ? 'ending' : 'let';
  }
  if (u.status === 'vacant') return u.nextBookingStart ? 'booked' : 'empty';
  if (u.status === 'reserved') return 'booked';
  return 'held';
}
const STATE_WORD = {
  let: () => tr('Let'), ending: () => tr('Let, ending within 30 days'), booked: () => tr('Empty, booked'),
  empty: () => tr('Empty'), held: () => tr('Held back')
};
function unitTitle(u) {
  const s = unitState(u);
  const bits = [u.code + (u.name ? ' · ' + u.name : ''), STATE_WORD[s]()];
  if (u.tenantName) bits.push(u.tenantName + (u.bookingEnd ? ' — ' + tr('until {date}', { date: fmtDate(u.bookingEnd) }) : ''));
  if (s === 'booked' && u.nextBookingStart) bits.push(tr('booked from {date}', { date: fmtDate(u.nextBookingStart) }));
  return bits.join(' · ');
}

export function UnitMosaic({ units, onPick }) {
  const groups = new Map();
  units.filter((u) => u.active !== false).forEach((u) => {
    const k = u.propertyName || '—';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(u);
  });
  const counts = { let: 0, ending: 0, booked: 0, empty: 0, held: 0 };
  units.filter((u) => u.active !== false).forEach((u) => { counts[unitState(u)]++; });
  return (
    <div className="pkf-mosaic">
      <div className="pkf-mosaic-props">
        {Array.from(groups.entries()).map(([name, list]) => {
          const let_ = list.filter((u) => u.status === 'occupied').length;
          return (
            <section key={name} className="pkf-mosaic-prop">
              <header>
                <strong>{name}</strong>
                <span className="dk-muted tl-small">{tr('{a} of {b} let', { a: let_, b: list.length })}</span>
                <span className="pkf-mosaic-bar" aria-hidden="true"><span style={{ width: (list.length ? let_ / list.length * 100 : 0) + '%' }} /></span>
              </header>
              <div className="pkf-tiles-grid">
                {list.slice().sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true })).map((u) => (
                  <button key={u.id} type="button" className={'pkf-unit is-' + unitState(u)} title={unitTitle(u)} aria-label={unitTitle(u)} onClick={onPick ? () => onPick(u) : undefined}>
                    <span>{u.code}</span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="pkf-legend">
        {['let', 'ending', 'booked', 'empty', 'held'].filter((k) => counts[k]).map((k) => <span key={k}><i className={'pkf-unit-key is-' + k} />{STATE_WORD[k]()} <strong>{counts[k]}</strong></span>)}
      </p>
    </div>
  );
}

// ── a lease running to its end ──────────────────────────────────────
export function LeaseBar({ start, end }) {
  if (!start || !end) return null;
  const s = new Date(String(start).slice(0, 10) + 'T00:00').getTime(), e = new Date(String(end).slice(0, 10) + 'T00:00').getTime();
  const now = Date.now();
  const pct = e > s ? Math.max(0, Math.min(100, (now - s) / (e - s) * 100)) : 100;
  const left = daysUntil(end);
  const tone = left < 0 ? 'past' : left <= 30 ? 'soon' : 'ok';
  const text = left < 0 ? tr('ended {date}', { date: fmtDate(end) }) : now < s ? tr('starts {date}', { date: fmtDate(start) }) : left === 0 ? tr('ends today') : left === 1 ? tr('1 day left') : tr('{n} days left', { n: left });
  return (
    <span className={'pkf-lease is-' + tone} title={fmtDate(start) + ' – ' + fmtDate(end)}>
      <span className="pkf-lease-track"><span className="pkf-lease-fill" style={{ width: pct + '%' }} /></span>
      <span className="pkf-lease-text">{text}</span>
    </span>
  );
}

// ── the next 90 days as a strip ─────────────────────────────────────
// items: [{ date, kind: 'in' | 'out', label, title }]
export function NextDays({ items, days = 90 }) {
  const ticks = [];
  for (let i = 0; i <= days; i += 30) {
    const d = new Date(); d.setDate(d.getDate() + i);
    ticks.push({ i, label: i === 0 ? tr('Today') : d.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) });
  }
  const shown = items.map((x) => ({ ...x, d: daysUntil(x.date) })).filter((x) => x.d !== null && x.d >= 0 && x.d <= days).sort((a, b) => a.d - b.d);
  // Markers on the same few days stack instead of covering each other.
  const lanes = [];
  shown.forEach((x) => {
    let lane = lanes.findIndex((last) => x.d - last >= 6);
    if (lane < 0) { lanes.push(x.d); lane = lanes.length - 1; } else lanes[lane] = x.d;
    x.lane = Math.min(lane, 3);
  });
  return (
    <div className="pkf-next">
      <div className="pkf-next-strip" style={{ '--lanes': Math.max(1, Math.min(4, lanes.length)) }}>
        <span className="pkf-next-axis" aria-hidden="true" />
        {ticks.map((t) => <span key={t.i} className="pkf-next-tick" style={{ left: (t.i / days * 100) + '%' }}><i />{t.label}</span>)}
        {shown.map((x, i) => (
          <span key={i} className={'pkf-next-mark is-' + x.kind} style={{ left: (x.d / days * 100) + '%', '--lane': x.lane }} title={x.title}>
            <i aria-hidden="true">{x.kind === 'in' ? '↘' : '↗'}</i><span>{x.label}</span>
          </span>
        ))}
      </div>
      <p className="pkf-legend"><span><i className="pkf-next-key is-in" />{tr('Moving in')}</span><span><i className="pkf-next-key is-out" />{tr('Booking ending')}</span></p>
    </div>
  );
}

// ── the letting offers' pipeline ────────────────────────────────────
// steps: [{ key, label, n, note, onClick, on }]
export function Pipeline({ steps }) {
  return (
    <ol className="pkf-pipe">
      {steps.map((s, i) => (
        <li key={s.key} className={'pkf-pipe-step is-' + s.key + (s.on ? ' is-on' : '')}>
          <button type="button" onClick={s.onClick} disabled={!s.onClick}>
            <span className="pkf-pipe-n">{s.n}</span>
            <span className="pkf-pipe-l">{s.label}</span>
            {s.note && <span className="pkf-pipe-note">{s.note}</span>}
          </button>
          {i < steps.length - 1 && <span className="pkf-pipe-arrow" aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}

export { daysUntil };
