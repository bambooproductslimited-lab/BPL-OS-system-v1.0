import { Icon } from '../../components/DashKit';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './FinFun.css';

// The finance pages' fun, modern look (prefix fnx-): a colourful banner with
// glass number tiles and a ring, tiles of lighter facts, a money chart with
// the net of each month on top, and how late money owed is as one bar. A
// page puts `fnx` beside `dk` on its root, which also rounds and lifts the
// shared DashKit cards, lists and "what stands out".
//
// Themes (the banner's colours): money (finance dashboard), till
// (restaurants), payroll, chase (payment reminders), reports, statements
// (financial reports), commission.

// A short form of a number for tight spots: 20,448 → 20.4K.
export function compact(n) {
  try { return new Intl.NumberFormat(activeIntlLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch { return String(Math.round(n)); }
}

// One number tile on the banner: { icon, value, label, note, tone, onClick }.
// tone: 'bad' | 'warn' | 'good'.
function FxStat({ s }) {
  const Tag = s.onClick ? 'button' : 'div';
  return (
    <Tag type={s.onClick ? 'button' : undefined} onClick={s.onClick} className={'fnx-stat' + (s.onClick ? ' is-link' : '') + (s.tone ? ' is-' + s.tone : '')}>
      <span className="fnx-stat-top"><span className="fnx-stat-icon"><Icon name={s.icon} /></span><span className="fnx-stat-label">{s.label}</span></span>
      <strong className="fnx-stat-value">{s.value}</strong>
      {s.note && <small className="fnx-stat-note">{s.note}</small>}
    </Tag>
  );
}

// Decorative shapes in the banner's corner (no meaning, hidden from screen readers).
function FxArt({ kind }) {
  return (
    <svg className={'fnx-art is-' + kind} viewBox="0 0 240 200" aria-hidden="true" focusable="false">
      <circle cx="190" cy="40" r="120" className="fnx-art-glow" />
      {kind === 'coins' && <>
        <ellipse cx="150" cy="150" rx="34" ry="11" className="fnx-art-a" /><rect x="116" y="128" width="68" height="22" className="fnx-art-a" /><ellipse cx="150" cy="128" rx="34" ry="11" className="fnx-art-b" />
        <ellipse cx="150" cy="122" rx="34" ry="11" className="fnx-art-a" /><rect x="116" y="100" width="68" height="22" className="fnx-art-a" /><ellipse cx="150" cy="100" rx="34" ry="11" className="fnx-art-b" />
        <circle cx="205" cy="128" r="22" className="fnx-art-b" /><circle cx="205" cy="128" r="14" className="fnx-art-a" />
      </>}
      {kind === 'till' && <>
        <rect x="120" y="70" width="70" height="96" rx="8" className="fnx-art-b" /><path d="M128 92h54M128 108h40M128 124h48M128 140h30" className="fnx-art-line" />
        <circle cx="206" cy="80" r="16" className="fnx-art-a" />
      </>}
      {kind === 'payroll' && <>
        <rect x="110" y="88" width="96" height="62" rx="10" className="fnx-art-b" /><path d="M110 98l48 30 48-30" className="fnx-art-line" />
        <rect x="128" y="62" width="64" height="40" rx="6" className="fnx-art-a" /><circle cx="160" cy="82" r="9" className="fnx-art-b" />
      </>}
      {kind === 'chase' && <>
        <path d="M158 70c-22 0-34 16-34 38v22l-10 12h88l-10-12v-22c0-22-12-38-34-38z" className="fnx-art-b" /><circle cx="158" cy="152" r="9" className="fnx-art-a" />
        <path d="M206 82c8 8 8 30 0 38M216 72c14 14 14 44 0 58" className="fnx-art-line" />
      </>}
      {kind === 'chart' && <>
        <rect x="112" y="122" width="18" height="40" rx="4" className="fnx-art-a" /><rect x="138" y="102" width="18" height="60" rx="4" className="fnx-art-b" />
        <rect x="164" y="84" width="18" height="78" rx="4" className="fnx-art-a" /><rect x="190" y="62" width="18" height="100" rx="4" className="fnx-art-b" />
        <path d="M108 112l34-26 24 14 44-36" className="fnx-art-line" />
      </>}
      {kind === 'scale' && <>
        <path d="M160 64v96M126 160h68M118 84h84" className="fnx-art-line" /><path d="M118 84l-16 34h32zM202 84l-16 34h32z" className="fnx-art-b" />
        <circle cx="160" cy="64" r="8" className="fnx-art-a" />
      </>}
      {kind === 'trophy' && <>
        <path d="M132 64h56v24c0 18-12 30-28 30s-28-12-28-30z" className="fnx-art-b" /><rect x="150" y="118" width="20" height="18" className="fnx-art-a" /><rect x="136" y="136" width="48" height="12" rx="4" className="fnx-art-b" />
        <path d="M132 72h-14c0 14 8 22 18 22M188 72h14c0 14-8 22-18 22" className="fnx-art-line" />
      </>}
      <path d="M34 150l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" className="fnx-art-spark" />
      <path d="M222 166l3 7 7 3-7 3-3 7-3-7-7-3 7-3z" className="fnx-art-spark" />
    </svg>
  );
}

export function FxHero({ theme = 'money', art = 'coins', eyebrow, title, sub, actions, stats = [], side, below }) {
  return (
    <header className={'fnx-hero fnx-t-' + theme}>
      <FxArt kind={art} />
      <div className="fnx-hero-main">
        {eyebrow && <p className="fnx-eyebrow">{eyebrow}</p>}
        <h2 className="fnx-hero-title">{title}</h2>
        {sub && <p className="fnx-hero-sub">{sub}</p>}
        {actions && <div className="fnx-hero-actions no-print">{actions}</div>}
      </div>
      {side && <div className="fnx-hero-side">{side}</div>}
      {stats.length > 0 && <div className={'fnx-hero-stats is-' + Math.min(stats.length, 4)}>{stats.map((s, i) => <FxStat key={i} s={s} />)}</div>}
      {below}
    </header>
  );
}

// A ring: value 0–1 (null shows an empty ring), with words in the middle.
// onCard: drawn for a white card rather than the banner.
export function FxRing({ value, size = 150, big, label, sub, onCard, tone }) {
  const r = size / 2 - 10, c = 2 * Math.PI * r;
  const part = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value));
  const len = big === undefined ? 0 : String(big).length;
  return (
    <span className={'fnx-ring' + (onCard ? ' is-card' : '') + (tone ? ' is-' + tone : '') + (len > 9 ? ' is-longest' : len > 7 ? ' is-longer' : len > 5 ? ' is-long' : '')} style={{ width: size, height: size }}>
      <svg viewBox={'0 0 ' + size + ' ' + size} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="fnx-ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="fnx-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - part)} transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'} />
      </svg>
      <span className="fnx-ring-mid">
        {big !== undefined && <strong>{big}</strong>}
        {label && <small>{label}</small>}
        {sub && <em>{sub}</em>}
      </span>
    </span>
  );
}

// Lighter facts as colourful tiles: [{ icon, tone, label, value, note }].
// tone: mint | sky | sun | rose | violet | teal | coral.
export function FxFacts({ items, label }) {
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return (
    <section className="fnx-facts" aria-label={label || tr('Did you know?')}>
      {list.map((f, i) => (
        <div key={i} className={'fnx-fact is-' + (f.tone || 'mint')} style={{ animationDelay: i * 60 + 'ms' }}>
          <span className="fnx-fact-icon"><Icon name={f.icon} /></span>
          <span className="fnx-fact-label">{f.label}</span>
          <strong className="fnx-fact-value">{f.value}</strong>
          {f.note && <small className="fnx-fact-note">{f.note}</small>}
        </div>
      ))}
    </section>
  );
}

// Money in and out per period: [{ label, a, b }], the net of each on top,
// the best "in" period marked (noNet: no net on top, when a minus b means
// nothing). Exact figures on hover and for screen readers.
export function FxMoneyChart({ rows, aLabel, bLabel, format, netLabel, bestLabel, noNet }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  const best = rows.reduce((b, r, i) => (r.a > (b < 0 ? 0 : rows[b].a) ? i : b), -1);
  return (
    <div className="fnx-mchart">
      <div className="fnx-mchart-plot" role="img" aria-label={rows.map((r) => r.label + ': ' + aLabel + ' ' + format(r.a) + ', ' + bLabel + ' ' + format(r.b)).join('; ')}>
        {[0.25, 0.5, 0.75].map((g) => <span key={g} className="fnx-mchart-grid" style={{ bottom: g * 100 + '%' }} />)}
        {rows.map((r, i) => {
          const net = r.a - r.b;
          return (
            <div key={r.label} className={'fnx-mchart-col' + (i === best ? ' is-best' : '') + (i === rows.length - 1 ? ' is-now' : '')}
              title={r.label + '\n' + aLabel + ': ' + format(r.a) + '\n' + bLabel + ': ' + format(r.b) + (noNet ? '' : '\n' + (netLabel || tr('Difference')) + ': ' + format(net))}>
              {!noNet && <span className={'fnx-net' + (net < 0 ? ' is-neg' : '')}>{(net < 0 ? '−' : '+') + compact(Math.abs(net))}</span>}
              <div className="fnx-mchart-bars">
                <span className="fnx-mbar is-a" style={{ height: Math.max(r.a ? 2 : 0, (r.a / max) * 100) + '%' }} />
                <span className="fnx-mbar is-b" style={{ height: Math.max(r.b ? 2 : 0, (r.b / max) * 100) + '%' }} />
              </div>
              <span className="fnx-mchart-label">{i === best && <Icon name="spark" />}{r.label}</span>
            </div>
          );
        })}
      </div>
      <div className="fnx-legend">
        <span><i className="is-a" />{aLabel}</span>
        <span><i className="is-b" />{bLabel}</span>
        {best >= 0 && <span><Icon name="spark" />{bestLabel || tr('the best month')}</span>}
      </div>
    </div>
  );
}

// How late money owed is, as one thick bar: [{ key, label, value }] from
// fresh to oldest, with the share of each and a chip per band.
export function FxAge({ bands, format }) {
  const total = bands.reduce((t, b) => t + b.value, 0);
  return (
    <div className="fnx-age">
      <div className="fnx-age-bar" role="img" aria-label={bands.map((b) => b.label + ': ' + format(b.value)).join(', ')}>
        {bands.map((b, i) => b.value > 0 && (
          <span key={b.key} className={'fnx-age-seg is-' + i} style={{ flexGrow: b.value / total }}>
            {b.value / total >= 0.1 && <b>{Math.round((b.value / total) * 100)}%</b>}
          </span>
        ))}
      </div>
      <div className="fnx-age-scale"><span>{tr('fresh')}</span><span>{tr('hard to collect')}</span></div>
      <ul className="fnx-age-chips">
        {bands.map((b, i) => (
          <li key={b.key} className={'is-' + i + (b.value ? '' : ' is-zero')}><i />{b.label}<b>{format(b.value)}</b></li>
        ))}
      </ul>
    </div>
  );
}

// How a total is built up, step by step: [{ label, value, kind, note }] with
// kind 'start' (a first total), 'down' (taken off), 'up' (added) or 'total'
// (where it lands). Each step floats where the running total is, so a
// loss falls below the zero line.
export function FxWaterfall({ steps, format }) {
  let run = 0;
  const rows = steps.map((s) => {
    const from = s.kind === 'down' ? run : s.kind === 'up' ? run : 0;
    const to = s.kind === 'down' ? run - s.value : s.kind === 'up' ? run + s.value : s.value;
    run = to;
    return { ...s, from, to };
  });
  const lo = Math.min(0, ...rows.flatMap((r) => [r.from, r.to]));
  const hi = Math.max(0, ...rows.flatMap((r) => [r.from, r.to]));
  const span = hi - lo || 1;
  const pos = (v) => ((v - lo) / span) * 100;
  return (
    <ol className="fnx-wf" aria-label={rows.map((r) => r.label + ': ' + format(r.kind === 'down' ? -r.value : r.kind === 'up' ? r.value : r.to)).join('; ')}>
      {rows.map((r, i) => {
        const a = Math.min(r.from, r.to), b = Math.max(r.from, r.to);
        const total = r.kind === 'start' || r.kind === 'total';
        return (
          <li key={i} className={'fnx-wf-row is-' + r.kind + (total && r.to < 0 ? ' is-neg' : '')}>
            <span className="fnx-wf-label">{r.label}{r.note && <small>{r.note}</small>}</span>
            <span className="fnx-wf-track">
              {lo < 0 && <i className="fnx-wf-zero" style={{ left: pos(0) + '%' }} />}
              <span className="fnx-wf-seg" style={{ left: pos(a) + '%', width: Math.max(0.6, pos(b) - pos(a)) + '%', animationDelay: i * 90 + 'ms' }} />
            </span>
            <b className="fnx-wf-amount">{r.kind === 'down' ? '−' + format(r.value) : r.kind === 'up' ? '+' + format(r.value) : format(r.to)}</b>
          </li>
        );
      })}
    </ol>
  );
}

// Totals side by side as bars: [{ label, value, tone, note }] (tone: in |
// out | equity). A badge says whether the two sides meet.
export function FxCompare({ rows, format, badge }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="fnx-cmp">
      {badge}
      {rows.map((r) => (
        <div key={r.label} className={'fnx-cmp-row is-' + (r.tone || 'in') + (r.value < 0 ? ' is-neg' : '')}>
          <span className="fnx-cmp-label">{r.label}{r.note && <small>{r.note}</small>}</span>
          <span className="fnx-cmp-track"><span style={{ width: Math.max(r.value ? 1 : 0, (Math.abs(r.value) / max) * 100) + '%' }} /></span>
          <b className="fnx-cmp-amount">{format(r.value)}</b>
        </div>
      ))}
    </div>
  );
}
