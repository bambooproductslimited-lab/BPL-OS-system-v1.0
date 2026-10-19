import { API_ORIGIN } from '../api/client';
import Photo from '../components/Photo';
import { Icon } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { Ring } from './crm/crmFun';
import './RestaurantFun.css';

// The look of Menu & inventory (RestaurantsPage.jsx): a bistro banner with
// café lights and a steaming bowl, a ring for today against the same
// weekday last week, glass tiles; a weekday-by-hour heat map; a podium for
// the best sellers; a donut for how people pay; dish cards with their
// pictures; stock as jars that fill and empty; cash drawers as receipts
// with a stamp; the tables as a floor plan. Styles in RestaurantFun.css
// (.rsf-*). Chart colours are the validated categorical set (light and
// dark steps); every chart writes its names and figures beside the colour.

export function hourText(h) { return new Date(2000, 0, 1, h).toLocaleTimeString(activeIntlLocale(), { hour: 'numeric' }); }
// 0 is Monday — 1 January 2024 was one.
export function weekdayText(dow, short) { return new Date(2024, 0, 1 + dow).toLocaleDateString(activeIntlLocale(), { weekday: short ? 'short' : 'long' }); }

// Little drawings the DashKit icons don't have.
const GLYPH = {
  sales: <><path d="M4 19h16" /><path d="M6 15l4-4 3 3 5-6" /><path d="M15 8h3v3" /></>,
  report: <><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v4h4M10 12h5M10 16h5" /></>,
  menu: <><path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v5M9 3v5" /><path d="M17 21V3c-2 1.5-3 4-3 7 0 2 1 3 3 3" /></>,
  stock: <><path d="M8 3h8v3H8z" /><path d="M7 6h10a1 1 0 0 1 1 1v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1z" /><path d="M6 12h12" /></>,
  drawers: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 11h18M10 15h4" /></>,
  tables: <><ellipse cx="12" cy="9" rx="8" ry="3.5" /><path d="M12 12.5V20M8 20h8" /></>,
  kitchen: <><path d="M6.5 13.5h11V19a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" /><path d="M6.5 13.5A3.6 3.6 0 0 1 6 6.4 4 4 0 0 1 12 4a4 4 0 0 1 6 2.4 3.6 3.6 0 0 1-.5 7.1" /><path d="M10 17h4" /></>,
  fire: <><path d="M12 21c-4 0-6.5-2.6-6.5-6 0-3.5 3-5.5 3.5-9 2 1.3 3 3 3 5 1-.8 1.6-2 1.7-3.3C16.3 9.5 18.5 12 18.5 15c0 3.4-2.5 6-6.5 6z" /></>,
  snooze: <><path d="M4 8h5l-5 6h5M12 4h4l-4 5h4M15 13h5l-5 7h5" /></>,
  crown: <><path d="M4 18h16M5 18 3.5 8l5 4L12 5l3.5 7 5-4L19 18" /></>,
  star: <><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" /></>,
  bolt: <><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17.2v.1" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  minus: <><path d="M5 12h14" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>
};
export function Glyph({ name }) {
  return <svg className="rsf-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[name]}</svg>;
}

// Café lights strung across the top of the banner.
function Lights() {
  const bulbs = Array.from({ length: 23 }, (_, i) => { const x = 30 + i * 52; const t = x / 1200; return [x, 10 + 2 * (1 - t) * t * 70]; });
  return (
    <svg className="rsf-lights" viewBox="0 0 1200 90" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
      <path className="rsf-wire" d="M0 10 Q600 150 1200 10" />
      {bulbs.map(([x, y], i) => (
        <g key={i} className={'rsf-bulb is-' + (i % 3)}>
          <rect x={x - 2.5} y={y - 1} width="5" height="6" rx="1" className="rsf-bulb-cap" />
          <circle cx={x} cy={y + 11} r="6.5" />
        </g>
      ))}
    </svg>
  );
}
// A bowl in the corner, steaming.
function Bowl() {
  return (
    <svg className="rsf-bowl" viewBox="0 0 160 140" aria-hidden="true">
      <path className="rsf-steam is-1" d="M58 58c-8-10 8-16 0-28" />
      <path className="rsf-steam is-2" d="M80 54c-8-10 8-16 0-30" />
      <path className="rsf-steam is-3" d="M102 58c-8-10 8-16 0-28" />
      <path className="rsf-bowl-body" d="M18 74h124c0 30-26 50-62 50S18 104 18 74z" />
      <rect className="rsf-bowl-rim" x="12" y="68" width="136" height="10" rx="5" />
      <path className="rsf-bowl-sticks" d="M104 30l34 40M114 28l30 42" />
    </svg>
  );
}

// The banner. ring: { value, max, big, small, caption, tone };
// stats: [{ icon, value, label, note, tone, onClick }]; live: { on, text }.
export function RsfBanner({ logo, eyebrow, title, sub, live, actions, ring, stats }) {
  return (
    <section className="rsf-hero">
      <span className="rsf-hero-glow" aria-hidden="true" />
      <Lights />
      <Bowl />
      <div className="rsf-hero-main">
        <div className="rsf-brand">
          {logo ? <img className="rsf-logo" src={logo} alt="" /> : <span className="rsf-logo is-mark" aria-hidden="true"><Glyph name="menu" /></span>}
          <span className="rsf-brand-text">
            <span className="rsf-eyebrow">{eyebrow}</span>
            <h1 className="rsf-title">{title}</h1>
          </span>
        </div>
        {live && <p className={'rsf-live' + (live.on ? ' is-on' : '')}><i aria-hidden="true" />{live.text}</p>}
        {sub && <p className="rsf-sub">{sub}</p>}
        {actions && <div className="rsf-actions no-print">{actions}</div>}
      </div>
      <div className="rsf-side">
        {ring && (
          <div className="rsf-ring">
            <Ring value={ring.value} max={ring.max || 1} size={136} stroke={13} tone={ring.tone || ''}>
              <strong>{ring.big}</strong>
              {ring.small && <small>{ring.small}</small>}
            </Ring>
            {ring.caption && <span className="rsf-ring-cap">{ring.caption}</span>}
          </div>
        )}
        <div className="rsf-tiles">
          {stats.map((s, i) => {
            const Tag = s.onClick ? 'button' : 'div';
            return (
              <Tag key={i} type={s.onClick ? 'button' : undefined} onClick={s.onClick} className={'rsf-tile' + (s.tone ? ' is-' + s.tone : '')}>
                <span className="rsf-tile-label"><Icon name={s.icon} /> {s.label}</span>
                <span className={'rsf-tile-value' + (String(s.value).length > 12 ? ' is-long' : '')}>{s.value}</span>
                {s.note && <span className="rsf-tile-note">{s.note}</span>}
              </Tag>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// The views, as big pills with a drawing each. views: [[key, label, count, glyph]].
export function ViewTabs({ views, view, onPick }) {
  return (
    <div id="rs-views" className="rsf-views" role="tablist" aria-label={tr('Show')}>
      {views.map(([k, label, n, glyph]) => (
        <button key={k} type="button" role="tab" aria-selected={view === k} className={'rsf-view' + (view === k ? ' is-on' : '')} onClick={() => onPick(k)}>
          <span className="rsf-view-icon"><Glyph name={glyph} /></span>
          <span>{label}</span>
          {n ? <span className="rsf-view-n">{n}</span> : null}
        </button>
      ))}
    </div>
  );
}

// Weekday by hour over four weeks: the darker, the busier. One hue, light
// to dark; the figures are in each cell's tooltip and the busiest is named.
export function HeatGrid({ heat }) {
  const hours = heat.map((h) => h.hour);
  const lo = Math.min(...hours), hi = Math.max(...hours);
  const max = Math.max(1, ...heat.map((h) => h.orders));
  const at = {};
  heat.forEach((h) => { at[h.dow + ':' + h.hour] = h.orders; });
  const range = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const top = heat.slice().sort((a, b) => b.orders - a.orders)[0];
  const tip = (d, h) => {
    const n = Math.round((at[d + ':' + h] || 0) / 4);
    return tr('{day} at {hour}: about {n} orders', { day: weekdayText(d), hour: hourText(h), n });
  };
  return (
    <div className="rsf-heat">
      <p className="rsf-heat-top"><Glyph name="fire" /> {tr('Busiest: {day} around {hour}, about {n} orders in that hour.', { day: weekdayText(top.dow), hour: hourText(top.hour), n: Math.round(top.orders / 4) })}</p>
      <div className="rsf-heat-scroll">
        <div className="rsf-heat-grid" style={{ gridTemplateColumns: 'auto repeat(' + range.length + ', minmax(18px, 1fr))' }} role="img"
          aria-label={tr('Orders by weekday and hour')}>
          <span />
          {range.map((h) => <span key={'h' + h} className="rsf-heat-hour">{(h - lo) % 3 === 0 ? hourText(h) : ''}</span>)}
          {[0, 1, 2, 3, 4, 5, 6].map((d) => [
            <span key={'d' + d} className="rsf-heat-day">{weekdayText(d, true)}</span>,
            ...range.map((h) => {
              const v = (at[d + ':' + h] || 0) / max;
              return <span key={d + ':' + h} className={'rsf-heat-cell' + (top.dow === d && top.hour === h ? ' is-top' : '')} title={tip(d, h)}
                style={{ background: v ? 'color-mix(in srgb, var(--rsf-heat) ' + Math.round(12 + v * 88) + '%, var(--rsf-soft))' : undefined }} />;
            })
          ])}
        </div>
      </div>
      <div className="rsf-heat-legend" aria-hidden="true">
        <span>{tr('quiet')}</span>
        {[12, 34, 56, 78, 100].map((p) => <i key={p} style={{ background: 'color-mix(in srgb, var(--rsf-heat) ' + p + '%, var(--rsf-soft))' }} />)}
        <span>{tr('busy')}</span>
      </div>
    </div>
  );
}

// A dish's picture, or a plate with its first letter when it has none.
export function DishArt({ m, hue, small }) {
  if (m && m.photoUrl) return <img className={'rsf-art' + (small ? ' is-small' : '')} src={API_ORIGIN + m.photoUrl} alt="" loading="lazy" />;
  return (
    <span className={'rsf-art is-empty' + (small ? ' is-small' : '')} style={{ '--cat': hue }} aria-hidden="true">
      <span className="rsf-art-plate"><b>{String((m && m.name) || '?').trim().charAt(0).toUpperCase()}</b></span>
    </span>
  );
}

// The three best sellers on a podium, the first in the middle.
// rows: [{ key, name, qty, revenue, dish, hue }].
export function Podium({ rows }) {
  const order = [rows[1], rows[0], rows[2]].filter(Boolean);
  return (
    <ol className="rsf-podium">
      {order.map((r) => {
        const place = rows.indexOf(r) + 1;
        return (
          <li key={r.key} className={'rsf-step is-' + place}>
            <span className="rsf-step-art"><DishArt m={r.dish || { name: r.name }} hue={r.hue} /><span className="rsf-medal">{place}</span></span>
            <strong className="rsf-step-name">{r.name}</strong>
            <span className="rsf-step-money">{money(r.revenue)}</span>
            <span className="rsf-step-qty">{tr('{qty} sold', { qty: r.qtyText })}</span>
            <span className="rsf-step-block" aria-hidden="true">{place}</span>
          </li>
        );
      })}
    </ol>
  );
}

// Places 4 onwards, numbered on from the podium.
export function MoreRanks({ rows, start }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="dk-rank rsf-ranks">
      {rows.map((r, i) => (
        <li key={r.key}>
          <span className="dk-rank-n">{start + i}</span>
          <div className="dk-rank-main">
            <div className="dk-rank-row"><span className="dk-rank-name">{r.name}</span><span className="dk-rank-amount">{r.amount}</span></div>
            <div className="dk-track" aria-hidden="true"><span style={{ width: Math.max(2, Math.round((r.value / max) * 100)) + '%' }} /></div>
            {r.meta && <div className="dk-muted dk-rank-meta">{r.meta}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// A donut and its legend; a 2px gap between the parts. parts: [{ key, name, value, color, meta }].
export function Donut({ parts, center, caption }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const r = 40, c = 2 * Math.PI * r;
  let at = 0;
  return (
    <div className="rsf-donut">
      <span className="rsf-donut-chart">
        <svg viewBox="0 0 100 100" role="img" aria-label={parts.map((p) => p.name + ': ' + Math.round((p.value / total) * 100) + '%').join('; ')}>
          <circle cx="50" cy="50" r={r} className="rsf-donut-track" />
          {parts.map((p) => {
            const len = (p.value / total) * c;
            const seg = <circle key={p.key} cx="50" cy="50" r={r} className="rsf-donut-part" style={{ stroke: p.color }}
              strokeDasharray={Math.max(0, len - (parts.length > 1 ? 1.6 : 0)) + ' ' + c} strokeDashoffset={-at} transform="rotate(-90 50 50)"><title>{p.name}</title></circle>;
            at += len;
            return seg;
          })}
        </svg>
        <span className="rsf-donut-in"><strong>{center}</strong><small>{caption}</small></span>
      </span>
      <ul className="rsf-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <i style={{ background: p.color }} aria-hidden="true" />
            <span className="rsf-legend-name">{p.name}<small>{p.meta}</small></span>
            <span className="rsf-legend-pct">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Who sells, with faces; a crown for the first. rows: [{ id, name, photo, sales, orders }].
export function Leaderboard({ rows }) {
  const max = Math.max(1, ...rows.map((r) => r.sales));
  return (
    <ol className="rsf-leaders">
      {rows.map((r, i) => (
        <li key={r.id} className={i === 0 ? 'is-first' : ''}>
          <span className="rsf-leader-face">
            <Photo id={r.id} name={r.name} photo={r.photo} size={38} />
            {i === 0 && <span className="rsf-crown"><Glyph name="crown" /></span>}
          </span>
          <span className="rsf-leader-main">
            <span className="rsf-leader-top"><strong>{r.name}</strong><span className="rsf-leader-money">{money(r.sales)}</span></span>
            <span className="rsf-leader-bar"><i style={{ width: Math.max(3, Math.round((r.sales / max) * 100)) + '%' }} /></span>
            <span className="rsf-leader-meta">{r.orders === 1 ? tr('1 order') : tr('{n} orders', { n: r.orders })}{r.orders ? ' · ' + tr('{amount} an order', { amount: money(r.sales / r.orders) }) : ''}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// A jar that fills and empties, with a line at the reorder level.
export function Jar({ qty, reorder, tone }) {
  const full = Math.max(reorder * 2, qty, 1);
  return (
    <span className={'rsf-jar is-' + tone} aria-hidden="true">
      <span className="rsf-jar-lid" />
      <span className="rsf-jar-glass">
        <span className="rsf-jar-fill" style={{ height: Math.min(100, Math.round((qty / full) * 100)) + '%' }} />
        {reorder > 0 && <span className="rsf-jar-line" style={{ bottom: Math.round((reorder / full) * 100) + '%' }} />}
      </span>
    </span>
  );
}

// The tables as seen from above: round tables with four chairs, bar
// stools, the patio in green.
export function tableShape(name) {
  if (/bar|counter|comptoir|吧/i.test(name)) return 'stool';
  if (/patio|terrace|garden|outside|terrasse|jardin|露台|花园/i.test(name)) return 'patio';
  return 'round';
}
