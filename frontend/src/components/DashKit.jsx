import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import './DashKit.css';

// Shared pieces of the "explains itself" dashboards (finance, quotations &
// invoicing): the company switcher, the header with its key numbers, the
// "what stands out" list, bar charts, ranked lists and the glossary. Same
// visual language as the social tracker and the marketing dashboard.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
export function pctChange(now, before) {
  if (!before) return null;
  return Math.round(((now - before) / before) * 100);
}
export function jump(id) {
  const el = document.getElementById(id);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.focus({ preventScroll: true }); }
}

const PATHS = {
  cash: <><rect x="3" y="6.5" width="18" height="11" rx="1.5" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 9.5v.1M17.5 14.5v.1" /></>,
  owed: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  warn: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.5M12 17v.1" /></>,
  scale: <><path d="M12 4v16M6 20h12M4.5 8h15M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z" /></>,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  spark: <path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.6L12 17.5l-1.8-5.4-5.7-1.6L10.2 9zM18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  doc: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></>,
  receipt: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" /></>,
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a10 10 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />,
  bag: <><path d="M5.5 8h13l-1 12h-11z" /><path d="M9 8V6.5a3 3 0 0 1 6 0V8" /></>,
  drawer: <><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><path d="M3.5 12h17M10 15.5h4" /></>,
  void: <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5 17.5 6.5" /></>,
  calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  percent: <><path d="M6 18 18 6" /><circle cx="7.5" cy="7.5" r="2" /><circle cx="16.5" cy="16.5" r="2" /></>,
  clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
  people: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="1.5" /><path d="M3 10h18M6.5 15h4" /></>,
  send: <path d="m4 12 16-7-6 16-2.5-6.5z" />
};
export function Icon({ name }) {
  return (
    <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

// ?company= in the address, else the last one picked on this device, else
// Bamboo Products.
function initialCompany(storageKey) {
  const q = new URLSearchParams(window.location.search).get('company');
  if (q) return q.toUpperCase();
  try { return localStorage.getItem(storageKey) || 'BPL'; } catch { return 'BPL'; }
}

// The chosen company and the list for the switcher: { company, companies,
// switchTo }. A remembered company that no longer has a dashboard falls
// back to the first one.
export function useCompany(storageKey, listUrl) {
  const [company, setCompany] = useState(() => initialCompany(storageKey));
  const [companies, setCompanies] = useState([]);
  useEffect(() => { api.get(listUrl).then(setCompanies).catch(() => setCompanies([])); }, [listUrl]);
  useEffect(() => {
    if (companies.length && !companies.some((c) => c.code === company)) setCompany(companies[0].code);
  }, [companies, company]);
  function switchTo(code) {
    if (code === company) return;
    setCompany(code);
    try { localStorage.setItem(storageKey, code); } catch { /* remembered for this visit only */ }
    window.history.replaceState({}, '', window.location.pathname + (code !== 'BPL' ? '?company=' + code : ''));
  }
  return { company, companies, switchTo };
}

export function CompanySwitcher({ companies, company, onPick, describe }) {
  if (companies.length < 2) return null;
  return (
    <div className="dk-companies" role="radiogroup" aria-label={tr('Company')}>
      {companies.map((co) => {
        const logo = restaurantLogoUrl(co.code);
        return (
          <button key={co.code} type="button" role="radio" aria-checked={co.code === company}
            className={'dk-company' + (co.code === company ? ' is-current' : '')} onClick={() => onPick(co.code)}>
            {logo
              ? <img className="dk-company-logo" src={logo} alt="" />
              : <span className="dk-company-mark" style={{ background: avatarColor(co.name) }} aria-hidden="true">{initials(co.name)}</span>}
            <span className="dk-company-text">
              <span className="dk-company-name">{co.name}</span>
              {describe && <span className="dk-company-sub">{describe(co)}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// The header: company name, a title and a line on what the page is for,
// actions, and up to four key numbers ({ icon, value, label, note, tone,
// onClick }). tone: 'alert' | 'bad' | 'good'.
export function Hero({ eyebrow, title, sub, actions, stats }) {
  return (
    <header className="dk-hero">
      <div className="dk-hero-text">
        <p className="dk-eyebrow">{eyebrow}</p>
        <h2 className="dk-hero-title">{title}</h2>
        <p className="dk-hero-sub">{sub}</p>
        {actions && <div className="dk-hero-actions no-print">{actions}</div>}
      </div>
      <div className="dk-hero-stats">
        {stats.map((s, i) => {
          const Tag = s.onClick ? 'button' : 'div';
          return (
            <Tag key={i} type={s.onClick ? 'button' : undefined} onClick={s.onClick}
              className={'dk-hero-stat' + (s.onClick ? ' is-link' : '') + (s.tone ? ' is-' + s.tone : '')}>
              <span className="dk-hero-stat-icon"><Icon name={s.icon} /></span>
              <strong>{s.value}</strong>
              <span className="dk-hero-stat-label">{s.label}</span>
              {s.note && <small>{s.note}</small>}
            </Tag>
          );
        })}
      </div>
    </header>
  );
}

// A change against an earlier period, as a small coloured line. upIsGood
// false for costs (spending more is not good news).
export function Change({ now, before, upIsGood = true, label }) {
  const pct = pctChange(now, before);
  if (pct === null) return <span className="dk-change is-none">{now ? tr('nothing to compare with yet') : ''}</span>;
  if (pct === 0) return <span className="dk-change">{tr('the same as {label}', { label })}</span>;
  const good = (pct > 0) === upIsGood;
  return (
    <span className={'dk-change ' + (good ? 'is-good' : 'is-bad')}>
      <Icon name={pct > 0 ? 'up' : 'down'} /> {(pct > 0 ? '+' : '−') + Math.abs(pct) + '%'} <span className="dk-muted">{tr('vs {label}', { label })}</span>
    </span>
  );
}

// items: [{ tone: 'good'|'warn'|'info'|'bad', icon, text, action: { label, run } }]
export function Insights({ items }) {
  if (!items.length) return null;
  return (
    <section className="dk-insights" aria-label={tr('What stands out')}>
      <h3 className="dk-h3"><Icon name="spark" /> {tr('What stands out')}</h3>
      <ul>
        {items.map((it, i) => (
          <li key={i} className={'dk-insight is-' + it.tone}>
            <span className="dk-insight-icon"><Icon name={it.icon} /></span>
            <span className="dk-insight-text">{it.text}</span>
            {it.action && <button type="button" className="dk-link no-print" onClick={it.action.run}>{it.action.label} <Icon name="arrow" /></button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Section({ id, title, sub, action, card, children }) {
  return (
    <section id={id} tabIndex={id ? -1 : undefined} className={'dk-section' + (card ? ' dk-card' : '')}>
      <div className="dk-section-head">
        <div>
          <h3 className="dk-h3">{title}</h3>
          {sub && <p className="dk-muted">{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ icon, children }) {
  return <div className="dk-empty"><Icon name={icon || 'check'} /><p>{children}</p></div>;
}

export function LinkButton({ onClick, children }) {
  return <button type="button" className="dk-link no-print" onClick={onClick}>{children} <Icon name="arrow" /></button>;
}

// Two series side by side per period: [{ label, a, b }], with a legend and
// the exact figures on hover and for screen readers.
export function PairBars({ rows, aLabel, bLabel, format, aClass = 'is-in', bClass = 'is-out' }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  return (
    <div className="dk-pairs">
      <div className="dk-pairs-chart" role="img" aria-label={rows.map((r) => r.label + ': ' + aLabel + ' ' + format(r.a) + ', ' + bLabel + ' ' + format(r.b)).join('; ')}>
        {rows.map((r) => (
          <div key={r.label} className="dk-pairs-col" title={r.label + '\n' + aLabel + ': ' + format(r.a) + '\n' + bLabel + ': ' + format(r.b)}>
            <div className="dk-pairs-bars">
              <span className={'dk-pairs-bar ' + aClass} style={{ height: Math.max(r.a ? 2 : 0, Math.round((r.a / max) * 100)) + '%' }} />
              <span className={'dk-pairs-bar ' + bClass} style={{ height: Math.max(r.b ? 2 : 0, Math.round((r.b / max) * 100)) + '%' }} />
            </div>
            <span className="dk-pairs-label">{r.label}</span>
          </div>
        ))}
      </div>
      <div className="dk-legend">
        <span><i className={'dk-swatch ' + aClass} />{aLabel}</span>
        <span><i className={'dk-swatch ' + bClass} />{bLabel}</span>
      </div>
    </div>
  );
}

// A ranked list with a bar each: [{ key, name, value, amount, meta }].
export function RankList({ rows, barClass }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="dk-rank">
      {rows.map((r, i) => (
        <li key={r.key || r.name}>
          <span className={'dk-rank-n' + (i === 0 ? ' is-first' : '')}>{i + 1}</span>
          <div className="dk-rank-main">
            <div className="dk-rank-row">
              <span className="dk-rank-name">{r.name}</span>
              <span className="dk-rank-amount">{r.amount}</span>
            </div>
            <div className={'dk-track' + (barClass ? ' ' + barClass : '')} aria-hidden="true"><span style={{ width: Math.round((r.value / max) * 100) + '%' }} /></div>
            {r.meta && <div className="dk-muted dk-rank-meta">{r.meta}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// A document or money line: icon/avatar, title and meta on the left,
// amount and a status or note on the right.
export function Row({ lead, title, meta, amount, side, sideClass, extra }) {
  return (
    <li className="dk-row">
      {lead}
      <div className="dk-row-main">
        <div className="dk-row-title">{title}</div>
        {meta && <div className="dk-muted dk-row-meta">{meta}</div>}
        {extra}
      </div>
      <div className="dk-row-side">
        {amount && <div className="dk-row-amount">{amount}</div>}
        {side && <div className={'dk-row-note ' + (sideClass || '')}>{side}</div>}
      </div>
    </li>
  );
}

export function Status({ tone, children }) {
  return <span className={'dk-status is-' + (tone || 'muted')}>{children}</span>;
}

export function Phone({ number }) {
  if (!number) return null;
  return <a className="dk-tel" href={'tel:' + number.replace(/\s+/g, '')}><Icon name="phone" /> {number}</a>;
}

// items: [[term, meaning], …]
export function Glossary({ items }) {
  return (
    <details className="dk-glossary">
      <summary><Icon name="info" /> {tr('What do these words mean?')}</summary>
      <dl>
        {items.map(([term, meaning]) => <div key={term}><dt>{term}</dt><dd>{meaning}</dd></div>)}
      </dl>
    </details>
  );
}
