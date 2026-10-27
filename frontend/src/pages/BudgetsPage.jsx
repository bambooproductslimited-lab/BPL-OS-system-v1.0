import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';

// Budgets (Finance → Budgets; backend budgets.service.js, migration 0198):
// what each company means to spend each month by category, against what it
// did — supplier bills, payroll and SSNIT, the expense sheets, fuel — with
// how far into the month we are, the year month by month, and what makes up
// each category's spending.

const CAT = {
  payroll: ['👥', msg('Payroll and SSNIT')], stock: ['📦', msg('Stock and materials')], utilities: ['💡', msg('Power, water, gas')], rent: ['🏠', msg('Rent')], services: ['🧰', msg('Services')],
  equipment: ['🛠️', msg('Equipment and repairs')], transport: ['🚚', msg('Transport')], fuel: ['⛽', msg('Fuel')], expenses: ['🧾', msg('Expense sheets')], staff: ['🧑‍🍳', msg('Staff costs')], other: ['📎', msg('Other')]
};
const STATE = { ok: ['✅', msg('On track')], near: ['⚠️', msg('Close to the budget')], over: ['🚨', msg('Over budget')], none: ['❔', msg('No budget')], empty: ['', ''] };
function monthText(m, long, narrow) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: long ? 'long' : narrow ? 'narrow' : 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' }); }
function shift(m, n) { const d = new Date(m + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function short(n) { const a = Math.abs(n); return a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a)); }
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }) : ''; }

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

// The year: what was spent each month (bars), the budget as a mark across
// each (dashed for months to come). One scale, in cedis.
function YearChart({ year, month, onPick }) {
  const [ref, w] = useWidth();
  const padL = 42, top = 12, h = 150, iw = Math.max(240, w - padL - 8);
  const max = Math.max(1, ...year.map((y) => Math.max(y.actual, y.budget)));
  const raw = max / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const tick = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  const hi = Math.ceil(max / tick) * tick;
  const y = (v) => top + h - v / hi * h;
  const step = iw / 12, bw = Math.min(30, step * 0.55);
  const ticks = []; for (let t = 0; t <= hi + tick / 2; t += tick) ticks.push(t);
  return (
    <div className="bg-year" ref={ref}>
      <svg width={w} height={top + h + 22} role="img" aria-label={tr('Spent each month against the budget')}>
        {ticks.map((t) => <g key={t}><line x1={padL} x2={padL + iw} y1={y(t)} y2={y(t)} className="bg-grid" /><text x={padL - 6} y={y(t) + 4} textAnchor="end" className="bg-axis">{short(t)}</text></g>)}
        {year.map((m, i) => {
          const cx = padL + step * i + step / 2, over = m.budget > 0 && m.actual > m.budget;
          const hgt = Math.max(0, top + h - y(m.actual));
          return (
            <g key={m.month}>
              {m.actual > 0 && <path className={'bg-act' + (over ? ' is-over' : '')} d={'M' + (cx - bw / 2) + ' ' + (top + h) + ' V' + (top + h - hgt + Math.min(4, hgt)) + ' q0 -' + Math.min(4, hgt) + ' ' + Math.min(4, hgt) + ' -' + Math.min(4, hgt) + ' h' + (bw - 2 * Math.min(4, hgt)) + ' q' + Math.min(4, hgt) + ' 0 ' + Math.min(4, hgt) + ' ' + Math.min(4, hgt) + ' V' + (top + h) + ' Z'} opacity={m.month === month ? 1 : 0.75} />}
              {m.budget > 0 && <line className={'bg-bud' + (m.future ? ' is-future' : '')} x1={cx - bw / 2 - 4} x2={cx + bw / 2 + 4} y1={y(m.budget)} y2={y(m.budget)} />}
              <text x={cx} y={top + h + 16} textAnchor="middle" className="bg-axis" fontWeight={m.month === month ? 800 : 400}>{monthText(m.month, false, step < 36)}</text>
              <rect className="bg-hit" x={padL + step * i} y={top} width={step} height={h + 18} onClick={() => onPick(m.month)}>
                <title>{monthText(m.month, true)}: {money(m.actual, 'GHS')}{m.budget ? ' / ' + money(m.budget, 'GHS') : ''}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="bg-legend"><span><i className="bg-key" />{tr('Spent')}</span><span><i className="bg-key is-bud" />{tr('Budget')}</span><span><i className="bg-key" style={{ background: 'var(--x7-bad)' }} />{tr('Over the budget')}</span></div>
    </div>
  );
}

function EditDialog({ d, onClose, onSaved }) {
  const [vals, setVals] = useState(() => Object.fromEntries(d.rows.map((r) => [r.category, r.budget ? String(r.budget) : ''])));
  const [toYearEnd, setToYearEnd] = useState(!d.hasBudget);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function fromLast() { setVals(Object.fromEntries(d.rows.map((r) => [r.category, r.lastMonth ? String(Math.ceil(r.lastMonth / 100) * 100) : vals[r.category]]))); }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      onSaved(await api.put('/budgets', { companyId: d.company, month: d.month, through: toYearEnd ? d.month.slice(0, 4) + '-12' : d.month, amounts: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v === '' ? null : Number(v)])) }));
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const total = Object.values(vals).reduce((a, v) => a + (Number(v) || 0), 0);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(680px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="bg-ed-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🎯</span><div><h2 id="bg-ed-t">{tr('Budget for {month}', { month: monthText(d.month, true) })}</h2><p>{tr('What the company means to spend, by category. Empty: no budget for it.')}</p></div></div>
        <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={fromLast}>↺ {tr('Start from last month\'s spending')}</button>
        <div className="bg-edit">
          {d.rows.map((r) => (
            <label key={r.category}><span>{CAT[r.category][0]} {tr(CAT[r.category][1])}</span>
              <input className="input" type="number" min="0" step="50" value={vals[r.category]} onChange={(e) => setVals({ ...vals, [r.category]: e.target.value })} placeholder="—" />
              {r.lastMonth > 0 && <small>{tr('last month: {amount}', { amount: money(r.lastMonth, 'GHS') })}</small>}
            </label>
          ))}
        </div>
        <label className="x7-check"><input type="checkbox" checked={toYearEnd} onChange={(e) => setToYearEnd(e.target.checked)} /><span>{tr('The same every month until December')}<small>{tr('Change any month on its own afterwards.')}</small></span></label>
        <p className="x7-note">🎯 {tr('{amount} a month', { amount: money(total, 'GHS') })}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

function SpentSheet({ d, row, onClose }) {
  const [x, setX] = useState(null);
  useEffect(() => { api.get('/budgets/spent?company=' + d.company + '&month=' + d.month + '&category=' + row.category).then(setX).catch(() => setX({ items: [], total: 0 })); }, [d.company, d.month, row.category]);
  const st = STATE[row.state];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="bg-sp-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={row.state === 'over' ? { '--g1': '#b91c1c', '--g2': '#db2777' } : row.state === 'near' ? { '--g1': '#b45309', '--g2': '#c2410c' } : { '--g1': '#1d4ed8', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">{CAT[row.category][0]}</span>
          <div>
            <small>{monthText(d.month, true)}</small>
            <h2 id="bg-sp-t">{tr(CAT[row.category][1])}</h2>
            <p><b>{money(row.actual, 'GHS')}</b>{row.budget ? <span className="x7-pill">{tr('of {amount}', { amount: money(row.budget, 'GHS') })} · {row.pct}%</span> : null}{st[0] && <span className="x7-pill">{st[0]} {tr(st[1])}</span>}</p>
          </div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {!x ? <p className="x7-muted">{tr('Loading…')}</p> : !x.items.length ? <p className="x7-note">{tr('Nothing spent on this yet this month.')}</p> : (
          <div className="x7-list">
            {x.items.map((it) => (
              <div key={it.kind + it.id} className="bk-matchline">
                <em aria-hidden="true">{it.kind === 'bill' ? '📑' : it.kind === 'pay_run' ? '👥' : it.kind === 'fuel' ? '⛽' : '🧾'}</em>
                <span className="x7-who"><b>{it.who}</b><small>{[it.ref, it.what, dayText(it.day)].filter(Boolean).join(' · ')}</small></span>
                <span className="x7-money"><b>{money(it.amount, 'GHS')}</b></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function BudgetsPage() {
  const [company, setCompany] = useState('');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [row, setRow] = useState(null);
  const load = useCallback(() => api.get('/budgets?month=' + month + (company ? '&company=' + company : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company, month]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const t = d.totals;
  const shown = d.rows.filter((r) => r.state !== 'empty');
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🎯 {tr('Budgets')}</h1>
          <p>{tr('What each company means to spend each month, against what it did: bills, payroll, expense sheets and fuel.')}</p>
        </div>
        {d.canManage && <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>✏️ {d.hasBudget ? tr('Change the budget') : tr('Set the budget')}</button>}
      </header>
      <div className="x7-bar">
        <div className="x7-chips" role="tablist" aria-label={tr('Company')}>
          {d.companies.map((c) => <button key={c.id} type="button" role="tab" aria-selected={d.company === c.id} className={d.company === c.id ? 'is-on' : ''} onClick={() => setCompany(c.id)}>{c.name}</button>)}
        </div>
        <div className="bg-month">
          <button type="button" onClick={() => setMonth(shift(month, -1))} aria-label={tr('Month before')}>‹</button>
          <b>{monthText(month, true)}</b>
          <button type="button" onClick={() => setMonth(shift(month, 1))} aria-label={tr('Month after')}>›</button>
        </div>
      </div>
      <div className="x7-tiles">
        <div className="x7-tile is-calm"><small>🎯 {tr('Budget')}</small><b>{money(t.budget, 'GHS')}</b><span>{d.elapsed > 0 && d.elapsed < 100 ? tr('{n}% of the month gone', { n: d.elapsed }) : tr('for the month')}</span></div>
        <div className={'x7-tile ' + (t.pct > 100 ? 'is-bad' : t.pct >= d.settings.warnAt ? 'is-warn' : 'is-teal')}><small>💸 {tr('Spent')}</small><b>{money(t.actual, 'GHS')}</b><span>{t.pct == null ? tr('no budget yet') : tr('{n}% of the budget', { n: t.pct })}</span></div>
        <div className={'x7-tile ' + (t.left < 0 ? 'is-bad' : 'is-good')}><small>{t.left < 0 ? '🚨 ' + tr('Over by') : '🪙 ' + tr('Left')}</small><b>{money(Math.abs(t.left), 'GHS')}</b><span>{t.unbudgeted > 0 ? tr('{amount} spent without a budget', { amount: money(t.unbudgeted, 'GHS') }) : '—'}</span></div>
        <div className="x7-tile is-violet"><small>⚠️ {tr('Categories to watch')}</small><b>{t.over + t.near}</b><span>{tr('{o} over, {n} close', { o: t.over, n: t.near })}</span></div>
      </div>
      <section className="x7-card">
        <h2>📅 {tr('The year')} <small>{tr('So far: {spent} of {budget}', { spent: money(d.ytd.actual, 'GHS'), budget: money(d.ytd.budget, 'GHS') })}</small></h2>
        <YearChart year={d.year} month={d.month} onPick={setMonth} />
      </section>
      {!shown.length ? <div className="x7-empty"><span aria-hidden="true">🎯</span><p>{tr('No budget and nothing spent this month.')}</p></div> : (
        <div className="x7-list">
          {shown.map((r) => {
            const st = STATE[r.state];
            const w = r.budget ? Math.min(100, r.actual / r.budget * 100) : 100;
            return (
              <button key={r.category} type="button" className={'x7-row bg-row' + (r.state === 'over' ? ' is-flag is-bad' : r.state === 'near' ? ' is-flag is-warn' : '')} onClick={() => setRow(r)}>
                <span className="x7-icon" aria-hidden="true">{CAT[r.category][0]}</span>
                <span className="x7-who">
                  <b>{tr(CAT[r.category][1])}</b>
                  <small>{r.budget ? tr('{spent} of {budget}', { spent: money(r.actual, 'GHS'), budget: money(r.budget, 'GHS') }) : tr('{spent} spent, no budget', { spent: money(r.actual, 'GHS') })}{r.lastMonth ? ' · ' + tr('last month {amount}', { amount: money(r.lastMonth, 'GHS') }) : ''}</small>
                  <span className="bg-meter" role="img" aria-label={r.budget ? tr('{n}% of the budget', { n: r.pct }) : tr('No budget')}>
                    <i className={'is-' + r.state} style={{ width: w + '%' }} />
                    {d.elapsed > 0 && d.elapsed < 100 && r.budget > 0 && <s style={{ left: d.elapsed + '%' }} title={tr('Where spending would be at an even pace')} />}
                  </span>
                </span>
                {st[0] ? <span className={'x7-pill ' + (r.state === 'over' ? 'is-bad' : r.state === 'near' ? 'is-warn' : r.state === 'ok' ? 'is-good' : '')}>{st[0]} {tr(st[1])}</span> : <span />}
                <span className="x7-money"><b>{r.budget ? (r.left < 0 ? '−' : '') + money(Math.abs(r.left), 'GHS') : '—'}</b><small>{r.budget ? (r.left < 0 ? tr('over') : tr('left')) : ''}</small></span>
              </button>
            );
          })}
        </div>
      )}
      {editing && <EditDialog d={d} onClose={() => setEditing(false)} onSaved={(x) => { setEditing(false); setD(x); }} />}
      {row && <SpentSheet d={d} row={row} onClose={() => setRow(null)} />}
    </div>
  );
}
