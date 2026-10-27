import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './CashFlowPage.css';

// Cash flow forecast (Finance → Cash flow forecast; backend
// cashflow.service.js, migration 0197): the next 13 weeks, week by week —
// the cash a company has today, what comes in (invoices by their due date,
// recurring invoices, the restaurants' takings at their recent pace) and
// what goes out (supplier bills, payroll on pay day, salary advances), plus
// anything added by hand: a loan, rent, a big order expected. The weeks
// that dip under the minimum to keep are flagged.

function dayText(d, opts) { return d ? new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function short(n) {
  const a = Math.abs(n);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(a));
  return (n < 0 ? '−' : '') + s;
}
const SOURCE = {
  invoice: ['🧾', msg('Invoices')], recurring: ['🔁', msg('Recurring invoices')], takings: ['🍴', msg('Till takings')],
  bill: ['📑', msg('Supplier bills')], payroll: ['👥', msg('Payroll')], advance: ['💵', msg('Salary advances')], manual: ['✍️', msg('Added by hand')]
};
const REPEAT = { once: msg('Once'), weekly: msg('Every week'), monthly: msg('Every month') };
function itemText(x) {
  if (x.source === 'takings') return tr('Till takings (the last 4 weeks\' pace)');
  if (x.source === 'payroll') return tr('Payroll and SSNIT, about ({n} staff)', { n: x.staff });
  if (x.source === 'advance') return tr('Salary advance {ref} · {who}', { ref: x.ref, who: x.who });
  if (x.source === 'bill') return x.ref + ' · ' + x.who + (x.toApprove ? ' (' + tr('to approve') + ')' : '');
  return x.label;
}
function today() { return new Date().toISOString().slice(0, 10); }

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(720);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth || 720);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// The running balance (one line, the minimum dashed) over the weeks, and
// below it on its own scale what comes in and goes out each week. Hover
// or tap a week for its numbers; the week list below is the table view.
function Chart({ d, pick, onPick }) {
  const [ref, w] = useWidth();
  const [hover, setHover] = useState(null);
  const weeks = d.weeks;
  const padL = 46, padR = 12, top = 14, h1 = 170, gap = 26, h2 = 92;
  const iw = Math.max(200, w - padL - padR);
  const step = iw / weeks.length;
  const xs = (i) => padL + step * i;
  // Round ticks, from zero unless the cash goes below it.
  const vals = [d.opening.amount, d.floor, ...weeks.map((x) => x.closing)];
  const min = Math.min(0, ...vals), max = Math.max(1, ...vals);
  const raw = (max - min) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const tick = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  const lo = Math.floor(min / tick) * tick, hi = Math.ceil(max * 1.04 / tick) * tick;
  const y = (v) => top + h1 - (v - lo) / (hi - lo) * h1;
  const pts = [[xs(0), y(d.opening.amount)], ...weeks.map((x, i) => [xs(i + 1), y(x.closing)])];
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ' L' + xs(weeks.length).toFixed(1) + ' ' + (top + h1) + ' L' + xs(0).toFixed(1) + ' ' + (top + h1) + ' Z';
  const ticks = [];
  for (let t = lo; t <= hi + tick / 2; t += tick) ticks.push(t);
  const flowMax = Math.max(1, ...weeks.map((x) => Math.max(x.in, x.out)));
  const b0 = top + h1 + gap, mid = b0 + h2 / 2;
  const bh = (v) => v / flowMax * (h2 / 2 - 2);
  const bw = Math.max(4, Math.min(22, step / 2 - 4));
  const shown = hover != null ? weeks[hover] : null;
  return (
    <div className="cf-chart" ref={ref}>
      <svg width={w} height={b0 + h2 + 22} role="img" aria-label={tr('Cash at the end of each week, and money in and out')}>
        <defs>
          <linearGradient id="cf-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="var(--cf-line)" stopOpacity=".28" /><stop offset="1" stopColor="var(--cf-line)" stopOpacity="0" /></linearGradient>
        </defs>
        {ticks.map((t, i) => <g key={i}><line x1={padL} x2={padL + iw} y1={y(t)} y2={y(t)} className="cf-grid" /><text x={padL - 6} y={y(t) + 4} className="cf-axis" textAnchor="end">{short(t)}</text></g>)}
        {lo < 0 && <line x1={padL} x2={padL + iw} y1={y(0)} y2={y(0)} className="cf-zero" />}
        {d.floor > 0 && <g><line x1={padL} x2={padL + iw} y1={y(d.floor)} y2={y(d.floor)} className="cf-floor" /><text x={padL + iw - 4} y={y(d.floor) - 6} textAnchor="end" className="cf-floor-text">{tr('Minimum {amount}', { amount: short(d.floor) })}</text></g>}
        <path d={area} fill="url(#cf-area)" />
        <path d={line} className="cf-line" />
        {pts.map((p, i) => {
          const wk = i ? weeks[i - 1] : null;
          return <circle key={i} cx={p[0]} cy={p[1]} r={wk && (wk.short || wk.negative) ? 5 : 4} className={'cf-dot' + (wk && wk.negative ? ' is-neg' : wk && wk.short ? ' is-short' : '') + (wk && pick === wk.n ? ' is-on' : '')} />;
        })}
        {d.lowest && <text x={xs(d.lowest.n)} y={y(d.lowest.closing) + 18} textAnchor="middle" className="cf-label">{tr('Lowest')} {short(d.lowest.closing)}</text>}
        <text x={xs(weeks.length)} y={y(weeks[weeks.length - 1].closing) - 10} textAnchor="end" className="cf-label is-strong">{short(weeks[weeks.length - 1].closing)}</text>
        <line x1={padL} x2={padL + iw} y1={mid} y2={mid} className="cf-zero" />
        <text x={padL - 6} y={b0 + 10} className="cf-axis" textAnchor="end">+{short(flowMax)}</text>
        <text x={padL - 6} y={b0 + h2} className="cf-axis" textAnchor="end">−{short(flowMax)}</text>
        {weeks.map((x, i) => {
          const cx = padL + step * i + step / 2;
          const hi2 = bh(x.in), ho = bh(x.out);
          return (
            <g key={x.n} className={pick === x.n ? 'is-on' : ''}>
              {x.in > 0 && <path className="cf-in" d={'M' + (cx - bw - 1) + ' ' + mid + ' V' + (mid - hi2 + 3) + ' q0 -3 3 -3 h' + (bw - 6) + ' q3 0 3 3 V' + mid + ' Z'} />}
              {x.out > 0 && <path className="cf-out" d={'M' + (cx + 1) + ' ' + mid + ' V' + (mid + ho - 3) + ' q0 3 3 3 h' + (bw - 6) + ' q3 0 3 -3 V' + mid + ' Z'} />}
              {(i % (step < 40 ? 2 : 1) === 0) && <text x={cx} y={b0 + h2 + 16} textAnchor="middle" className="cf-axis">{dayText(x.start)}</text>}
              <rect x={padL + step * i} y={top} width={step} height={b0 + h2 - top} className="cf-hit"
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onPick(x.n)}>
                <title>{tr('Week {n}', { n: x.n })}: +{money(x.in, 'GHS')} / −{money(x.out, 'GHS')} → {money(x.closing, 'GHS')}</title>
              </rect>
            </g>
          );
        })}
        {hover != null && <line x1={xs(hover + 1)} x2={xs(hover + 1)} y1={top} y2={top + h1} className="cf-cross" />}
      </svg>
      {shown && (
        <div className="cf-tip" style={{ left: Math.min(w - 220, Math.max(0, xs(hover + 1) - 105)) }}>
          <b>{tr('Week {n}', { n: shown.n })} · {dayText(shown.start)} – {dayText(shown.end)}</b>
          <span><i className="cf-key is-in" />{tr('In')} <b>{money(shown.in, 'GHS')}</b></span>
          <span><i className="cf-key is-out" />{tr('Out')} <b>{money(shown.out, 'GHS')}</b></span>
          <span><i className="cf-key is-line" />{tr('At the end')} <b>{money(shown.closing, 'GHS')}</b></span>
        </div>
      )}
      <div className="cf-legend">
        <span><i className="cf-key is-line" />{tr('Cash at the end of the week')}</span>
        {d.floor > 0 && <span><i className="cf-key is-floor" />{tr('Minimum to keep')}</span>}
        <span><i className="cf-key is-in" />{tr('Money in')}</span>
        <span><i className="cf-key is-out" />{tr('Money out')}</span>
      </div>
    </div>
  );
}

function BalanceDialog({ d, onClose, onSaved }) {
  const pickable = d.companies;
  const first = d.company === 'all' ? pickable[0] : pickable.find((c) => c.id === d.company);
  const [companyId, setCompanyId] = useState(first.id);
  const co = pickable.find((c) => c.id === companyId);
  const [amount, setAmount] = useState(co.balance ? String(co.balance.amount) : '');
  const [asOf, setAsOf] = useState(today());
  const [floor, setFloor] = useState(String(co.floor || ''));
  const [payDay, setPayDay] = useState(String(d.payDay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function choose(id) {
    const c = pickable.find((x) => x.id === id);
    setCompanyId(id); setAmount(c.balance ? String(c.balance.amount) : ''); setFloor(String(c.floor || ''));
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.put('/cashflow/balance', { companyId, amount: Number(amount), asOf, floor: floor === '' ? 0 : Number(floor), payDay: Number(payDay) }), companyId); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog cf-dlg" role="dialog" aria-modal="true" aria-labelledby="cf-bal-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="cf-dlg-head"><span className="cf-dlg-art" aria-hidden="true">🏦</span><div><h2 id="cf-bal-title">{tr('Cash today')}</h2><p>{tr('In the bank, Mobile Money and in hand, all together.')}</p></div></div>
        {d.company === 'all' && (
          <div className="cf-chips" role="group" aria-label={tr('Company')}>
            {pickable.map((c) => <button key={c.id} type="button" className={c.id === companyId ? 'is-on' : ''} onClick={() => choose(c.id)}>{c.code}</button>)}
          </div>
        )}
        <label className="cf-big"><span>{tr('{company} has today', { company: co.name })}</span><input className="input" type="number" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></label>
        <div className="cf-grid2">
          <label><span>{tr('As of')}</span><input className="input" type="date" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)} /></label>
          <label><span>{tr('Minimum to keep')}</span><input className="input" type="number" min="0" step="1" value={floor} onChange={(e) => setFloor(e.target.value)} placeholder="0" /><small>{tr('Weeks under it are flagged.')}</small></label>
          <label><span>{tr('Pay day (each month)')}</span><input className="input" type="number" min="1" max="28" value={payDay} onChange={(e) => setPayDay(e.target.value)} /><small>{tr('For every company.')}</small></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
        </div>
      </form>
    </div>
  );
}

function ItemDialog({ d, onClose, onSaved }) {
  const [f, setF] = useState({ companyId: d.company === 'all' ? d.companies[0].id : d.company, direction: 'out', label: '', amount: '', startsOn: today(), repeat: 'once', endsOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.post('/cashflow/items', { ...f, amount: Number(f.amount), endsOn: f.repeat === 'once' ? null : f.endsOn || null }), f.companyId); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog cf-dlg" role="dialog" aria-modal="true" aria-labelledby="cf-item-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="cf-dlg-head"><span className="cf-dlg-art" aria-hidden="true">✍️</span><div><h2 id="cf-item-title">{tr('Add money in or out')}</h2><p>{tr('A loan, rent, a big order expected: anything the forecast cannot see.')}</p></div></div>
        <div className="cf-dir" role="group" aria-label={tr('Money in or out')}>
          <button type="button" className={'is-in' + (f.direction === 'in' ? ' is-on' : '')} onClick={() => setF({ ...f, direction: 'in' })}>⬆️ {tr('Money in')}</button>
          <button type="button" className={'is-out' + (f.direction === 'out' ? ' is-on' : '')} onClick={() => setF({ ...f, direction: 'out' })}>⬇️ {tr('Money out')}</button>
        </div>
        {d.company === 'all' && (
          <div className="cf-chips" role="group" aria-label={tr('Company')}>
            {d.companies.map((c) => <button key={c.id} type="button" className={c.id === f.companyId ? 'is-on' : ''} onClick={() => setF({ ...f, companyId: c.id })}>{c.code}</button>)}
          </div>
        )}
        <div className="cf-grid2">
          <label><span>{tr('What is it?')}</span><input className="input" required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder={tr('e.g. Loan repayment')} /></label>
          <label><span>{tr('Amount')}</span><input className="input" type="number" min="0.01" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label><span>{tr('When')}</span><input className="input" type="date" required value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value })} /></label>
          <label><span>{tr('Repeats')}</span><select className="input" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })}>{Object.entries(REPEAT).map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}</select></label>
          {f.repeat !== 'once' && <label><span>{tr('Until')}</span><input className="input" type="date" value={f.endsOn} min={f.startsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} /><small>{tr('Empty: no end.')}</small></label>}
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Add')}</button>
        </div>
      </form>
    </div>
  );
}

export default function CashFlowPage() {
  const [company, setCompany] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [dlg, setDlg] = useState('');
  const load = useCallback(() => api.get('/cashflow' + (company ? '?company=' + encodeURIComponent(company) : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company]);
  useEffect(() => { load(); }, [load]);
  // Saving answers with that company's forecast: shown, unless all are.
  function saved(x, companyId) { setDlg(''); if (d.company === 'all') load(); else { setCompany(companyId); setD(x); } }
  async function remove(id) {
    try { await api.del('/cashflow/items/' + id); load(); } catch (e) { setError(e.message); }
  }
  if (!d) return <div className="cf"><p className="cf-wait">{error || tr('Loading…')}</p></div>;
  const co = d.company === 'all' ? null : d.companies.find((c) => c.id === d.company);
  const end = d.totals.end, change = end - d.opening.amount;
  const sources = (dir) => Object.entries(d.bySource).filter(([k]) => k.startsWith(dir + ':')).map(([k, v]) => [k.slice(dir.length + 1), v]).sort((a, b) => b[1] - a[1]);
  const ins = sources('in'), outs = sources('out');
  const maxSrc = Math.max(1, ...ins.map((x) => x[1]), ...outs.map((x) => x[1]));
  return (
    <div className="cf">
      <header className="cf-head">
        <div>
          <h1>🌊 {tr('Cash flow forecast')}</h1>
          <p>{tr('The next 13 weeks: the cash we have today, what comes in and what goes out, week by week.')}</p>
        </div>
        {d.canManage && (
          <div className="cf-head-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setDlg('balance')}>🏦 {tr('Cash today')}</button>
            <button type="button" className="btn btn-primary" onClick={() => setDlg('item')}>✍️ {tr('Add money in or out')}</button>
          </div>
        )}
      </header>
      <div className="cf-chips" role="tablist" aria-label={tr('Company')}>
        {d.companies.map((c) => <button key={c.id} type="button" role="tab" aria-selected={d.company === c.id} className={d.company === c.id ? 'is-on' : ''} onClick={() => setCompany(c.id)}>{c.restaurant ? '🍴 ' : '🏭 '}{c.name}</button>)}
        <button type="button" role="tab" aria-selected={d.company === 'all'} className={d.company === 'all' ? 'is-on' : ''} onClick={() => setCompany('all')}>🌍 {tr('All together')}</button>
      </div>
      {!d.opening.set && (
        <div className="cf-start">
          <span aria-hidden="true">🏦</span>
          <p><b>{co ? tr('How much cash does {company} have today?', { company: co.name }) : tr('Some companies have no cash today set yet.')}</b> {tr('The forecast starts from it; until then it starts from zero.')}</p>
          {d.canManage && <button type="button" className="btn btn-primary" onClick={() => setDlg('balance')}>{tr('Set it')}</button>}
        </div>
      )}
      <section className={'cf-hero' + (d.totals.end < 0 ? ' is-neg' : d.shortWeeks ? ' is-short' : '')}>
        <div><small>{tr('Cash today')}</small><b>{money(d.opening.amount, 'GHS')}</b><span>{d.opening.asOf ? tr('as of {date}', { date: dayText(d.opening.asOf, { year: 'numeric' }) }) : tr('not set')}</span></div>
        <div><small>{tr('In 13 weeks')}</small><b>{money(end, 'GHS')}</b><span className={change < 0 ? 'is-down' : 'is-up'}>{change < 0 ? '▼ ' : '▲ '}{money(Math.abs(change), 'GHS')}</span></div>
        <div><small>{tr('Lowest point')}</small><b>{d.lowest ? money(d.lowest.closing, 'GHS') : '—'}</b><span>{d.lowest ? tr('week {n}, from {date}', { n: d.lowest.n, date: dayText(d.lowest.start) }) : ''}</span></div>
        <div><small>{d.shortWeeks ? '⚠️ ' + tr('Weeks under the minimum') : '✅ ' + tr('Weeks under the minimum')}</small><b>{d.shortWeeks}</b><span>{d.floor > 0 ? tr('minimum {amount}', { amount: money(d.floor, 'GHS') }) : tr('no minimum set')}</span></div>
      </section>
      <section className="cf-card">
        <Chart d={d} pick={open} onPick={(n) => setOpen(open === n ? null : n)} />
      </section>
      <div className="cf-split">
        {[['in', ins, tr('Where the money comes from'), d.totals.in], ['out', outs, tr('Where it goes'), d.totals.out]].map(([dir, list, title, total]) => (
          <section key={dir} className="cf-card cf-sources">
            <h2>{dir === 'in' ? '⬆️' : '⬇️'} {title} <small>{money(total, 'GHS')}</small></h2>
            {!list.length ? <p className="cf-none">{tr('Nothing in the next 13 weeks.')}</p> : list.map(([k, v]) => (
              <div key={k} className="cf-src">
                <span><em aria-hidden="true">{SOURCE[k][0]}</em>{tr(SOURCE[k][1])}</span>
                <i className={'is-' + dir} style={{ width: Math.max(2, v / maxSrc * 100) + '%' }} />
                <b>{money(v, 'GHS')}</b>
              </div>
            ))}
            {dir === 'in' && d.totals.late > 0 && <p className="cf-late">⏰ {tr('{amount} of it is already overdue — counted this week, if it comes.', { amount: money(d.totals.late, 'GHS') })}</p>}
          </section>
        ))}
      </div>
      <section className="cf-weeks">
        <h2>{tr('Week by week')}</h2>
        {d.weeks.map((w) => (
          <div key={w.n} className={'cf-week' + (w.negative ? ' is-neg' : w.short ? ' is-short' : '') + (open === w.n ? ' is-open' : '')}>
            <button type="button" className="cf-week-row" onClick={() => setOpen(open === w.n ? null : w.n)} aria-expanded={open === w.n}>
              <span className="cf-wk"><b>{tr('Week {n}', { n: w.n })}</b><small>{dayText(w.start)} – {dayText(w.end)}</small></span>
              <span className="cf-num is-in">+{money(w.in, 'GHS')}</span>
              <span className="cf-num is-out">−{money(w.out, 'GHS')}</span>
              <span className="cf-close"><b>{money(w.closing, 'GHS')}</b>{w.negative ? <i className="is-neg">🔴 {tr('Below zero')}</i> : w.short ? <i className="is-short">⚠️ {tr('Under the minimum')}</i> : null}</span>
              <span className="cf-chev" aria-hidden="true">{open === w.n ? '▴' : '▾'}</span>
            </button>
            {open === w.n && (
              <ul className="cf-items">
                {!w.items.length && <li className="cf-none">{tr('Nothing this week.')}</li>}
                {w.items.map((x, i) => (
                  <li key={i} className={'is-' + x.direction}>
                    <em aria-hidden="true">{SOURCE[x.source][0]}</em>
                    <span><b>{itemText(x)}</b><small>{dayText(x.date)}{d.company === 'all' ? ' · ' + x.company : ''}{x.late ? ' · ⏰ ' + tr('overdue since {date}', { date: dayText(x.dueDate) }) : ''}{x.estimate ? ' · ' + tr('estimate') : ''}</small></span>
                    <b className="cf-amt">{x.direction === 'in' ? '+' : '−'}{money(x.amount, 'GHS')}</b>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </section>
      {d.manual.length > 0 && (
        <section className="cf-card cf-manual">
          <h2>✍️ {tr('Added by hand')}</h2>
          {d.manual.map((m) => (
            <div key={m.id} className={'cf-man is-' + m.direction}>
              <span><b>{m.label}</b><small>{tr(REPEAT[m.repeat])} · {tr('from {date}', { date: dayText(m.startsOn, { year: 'numeric' }) })}{m.endsOn ? ' · ' + tr('until {date}', { date: dayText(m.endsOn, { year: 'numeric' }) }) : ''}</small></span>
              <b className="cf-amt">{m.direction === 'in' ? '+' : '−'}{money(m.amount, 'GHS')}</b>
              {d.canManage && <button type="button" className="cf-del" onClick={() => remove(m.id)} aria-label={tr('Remove {name}', { name: m.label })}>✕</button>}
            </div>
          ))}
        </section>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {dlg === 'balance' && <BalanceDialog d={d} onClose={() => setDlg('')} onSaved={saved} />}
      {dlg === 'item' && <ItemDialog d={d} onClose={() => setDlg('')} onSaved={saved} />}
    </div>
  );
}
