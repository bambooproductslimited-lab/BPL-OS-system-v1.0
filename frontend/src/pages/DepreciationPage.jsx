import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';

// Asset depreciation and disposals (Finance → Depreciation; backend
// depreciation.service.js, migration 0199): what each asset in the register
// cost, what it has lost and is still worth on any day; straight line or
// reducing balance, its own life or its category's; the year by month; what
// one fetched when it was sold, scrapped or lost, against its book value.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function today() { return new Date().toISOString().slice(0, 10); }
function short(n) { const a = Math.abs(n); return a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a)); }
const METHOD = { straight: msg('Straight line'), reducing: msg('Reducing balance'), none: msg('Not depreciated') };
const SOURCE = { asset: msg('its own'), category: msg('its category\'s, from the useful lives'), usual: msg('the usual life for its kind'), default: msg('the usual five years') };
const DISPOSAL = { sold: ['💰', msg('Sold')], scrapped: ['🗑️', msg('Scrapped')], donated: ['🎁', msg('Given away')], lost: ['❓', msg('Lost')], stolen: ['🚨', msg('Stolen')] };
const USUAL = { it: msg('Computers and phones'), vehicles: msg('Vehicles'), buildings: msg('Buildings'), furniture: msg('Furniture'), machinery: msg('Machines and equipment'), other: msg('Anything else') };

function methodText(a) {
  if (a.method === 'none') return tr(METHOD.none);
  return a.method === 'reducing' ? tr('{n}% a year, reducing', { n: a.rate }) : tr('{n} months, straight', { n: a.months });
}

function YearChart({ months }) {
  const max = Math.max(1, ...months.map((m) => m.charge));
  const raw = max / 3, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const tick = [1, 2, 5, 10].map((k) => k * mag).find((k) => k >= raw);
  const top = Math.ceil(max / tick) * tick;
  const W = 640, H = 140, padL = 40, step = (W - padL - 6) / 12, bw = Math.min(28, step * 0.56);
  const y = (v) => 8 + H - v / top * H;
  const ticks = []; for (let t = 0; t <= top + tick / 2; t += tick) ticks.push(t);
  return (
    <svg className="dp-chart" viewBox={'0 0 ' + W + ' ' + (H + 30)} role="img" aria-label={tr('Depreciation each month')}>
      {ticks.map((t) => <g key={t}><line x1={padL} x2={W - 4} y1={y(t)} y2={y(t)} className="bg-grid" /><text x={padL - 6} y={y(t) + 4} textAnchor="end" className="bg-axis">{short(t)}</text></g>)}
      {months.map((m, i) => {
        const cx = padL + step * i + step / 2, h = Math.max(0, y(0) - y(m.charge));
        return (
          <g key={m.month}>
            {m.charge > 0 && <rect x={cx - bw / 2} y={y(m.charge)} width={bw} height={h} rx="4" className={'dp-bar' + (m.future ? ' is-future' : '')}><title>{monthText(m.month)}: {money(m.charge, 'GHS')}{m.future ? ' (' + tr('to come') + ')' : ''}</title></rect>}
            <text x={cx} y={H + 26} textAnchor="middle" className="bg-axis">{monthText(m.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

function AssetSheet({ id, meta, onClose, onChanged }) {
  const [a, setA] = useState(null);
  const [f, setF] = useState(null);
  const [g, setG] = useState({ on: today(), kind: 'sold', amount: '', note: '' });
  const [mode, setMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const take = (x) => { setA(x); setF({ method: x.source === 'asset' ? x.method : '', months: x.source === 'asset' && x.method === 'straight' ? String(x.months) : '', rate: x.source === 'asset' && x.method === 'reducing' ? String(x.rate) : '', residual: x.residual ? String(x.residual) : '', from: '' }); };
  useEffect(() => { api.get('/depreciation/assets/' + id).then(take).catch((e) => setError(e.message)); }, [id]);
  async function run(fn) {
    setBusy(true); setError(null);
    try { take(await fn()); setMode(''); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!a || !f) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const used = a.cost ? Math.min(100, Math.round(a.accumulated / a.cost * 100)) : 0;
  const maxCharge = Math.max(1, ...a.years.map((y) => y.charge));
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="dp-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={a.disposal ? { '--g1': '#475569', '--g2': '#334155' } : { '--g1': '#6d28d9', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">📉</span>
          <div><small>{a.assetNo} · {[a.category, a.company].filter(Boolean).join(' · ')}</small><h2 id="dp-t">{a.description}</h2>
            <p><b>{money(a.book, 'GHS')}</b><span className="x7-pill">{tr('of {amount}', { amount: money(a.cost, 'GHS') })}</span><span className="x7-pill">{methodText(a)}</span>{a.disposal && <span className="x7-pill">{DISPOSAL[a.disposal.kind][0]} {tr(DISPOSAL[a.disposal.kind][1])} {dayText(a.disposal.on)}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <div className="dp-wear" role="img" aria-label={tr('{n}% of its value used', { n: used })}><i style={{ width: used + '%' }} /><span>{tr('{n}% of its value used', { n: used })}</span></div>
        <dl className="x7-facts">
          <div><dt>{tr('Bought')}</dt><dd>{dayText(a.purchaseDate)}</dd></div>
          <div><dt>{tr('Depreciation to date')}</dt><dd>{money(a.accumulated, 'GHS')}</dd></div>
          <div><dt>{a.method === 'straight' ? tr('Each month') : tr('This year')}</dt><dd>{a.method === 'straight' ? money(a.monthly, 'GHS') : money(a.thisYear, 'GHS')}</dd></div>
          <div><dt>{tr('Worth at the end')}</dt><dd>{money(a.residual, 'GHS')}{a.endsOn ? ' · ' + dayText(a.endsOn) : ''}</dd></div>
        </dl>
        <p className="x7-muted">ⓘ {tr('Its life: {source}.', { source: tr(SOURCE[a.source]) })}{a.noCost ? ' ' + tr('It has no cost: add what it cost in Assets.') : ''}{a.noDate ? ' ' + tr('It has no purchase date.') : ''}</p>
        {a.disposal && (
          <dl className="x7-facts">
            <div><dt>{tr('Book value then')}</dt><dd>{money(a.disposal.book, 'GHS')}</dd></div>
            <div><dt>{tr('Fetched')}</dt><dd>{money(a.disposal.amount, 'GHS')}</dd></div>
            <div><dt>{a.disposal.gain >= 0 ? tr('Gain') : tr('Loss')}</dt><dd className={a.disposal.gain >= 0 ? 'dp-gain' : 'dp-loss'}>{money(Math.abs(a.disposal.gain), 'GHS')}</dd></div>
          </dl>
        )}
        {a.years.length > 0 && (
          <div className="x7-sec">
            <h3>📅 {tr('Year by year')}</h3>
            <div className="tx-table-wrap"><table className="tx-table">
              <thead><tr><th>{tr('Year')}</th><th className="num">{tr('Value at the start')}</th><th className="num">{tr('Depreciation')}</th><th />
                <th className="num">{tr('Value at the end')}</th></tr></thead>
              <tbody>{a.years.map((y) => <tr key={y.year} className={String(y.year) === today().slice(0, 4) ? 'is-now' : ''}><td>{y.year}</td><td className="num">{money(y.opening, 'GHS')}</td><td className="num">{money(y.charge, 'GHS')}</td><td className="dp-mini"><i style={{ width: Math.round(y.charge / maxCharge * 100) + '%' }} /></td><td className="num">{money(y.closing, 'GHS')}</td></tr>)}</tbody>
            </table></div>
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {meta.canManage && mode === 'policy' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run(() => api.put('/depreciation/assets/' + a.id, f)); }}>
            <h3>⚙️ {tr('How it loses value')}</h3>
            <div className="x7-seg" style={{ alignSelf: 'flex-start' }}>{[['', tr('As its category')], ['straight', tr(METHOD.straight)], ['reducing', tr(METHOD.reducing)], ['none', tr('None')]].map(([k, l]) => <button key={k} type="button" className={f.method === k ? 'is-on' : ''} onClick={() => setF({ ...f, method: k })}>{l}</button>)}</div>
            <div className="x7-grid3">
              {f.method === 'straight' && <label><span>{tr('Useful life (months)')}</span><input className="input" type="number" min="1" max="600" value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></label>}
              {f.method === 'reducing' && <label><span>{tr('Rate a year (%)')}</span><input className="input" type="number" min="1" max="100" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} /></label>}
              <label><span>{tr('Worth at the end')}</span><input className="input" type="number" min="0" step="0.01" value={f.residual} onChange={(e) => setF({ ...f, residual: e.target.value })} /></label>
              <label><span>{tr('From (if not the day it was bought)')}</span><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
          </form>
        )}
        {meta.canManage && mode === 'dispose' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run(() => api.post('/depreciation/assets/' + a.id + '/dispose', g)); }}>
            <h3>📤 {tr('It has gone')}</h3>
            <div className="x7-chips">{Object.entries(DISPOSAL).map(([k, [ic, l]]) => <button key={k} type="button" className={g.kind === k ? 'is-on' : ''} onClick={() => setG({ ...g, kind: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
            <div className="x7-grid2">
              <label><span>{tr('On')}</span><input className="input" type="date" required max={today()} value={g.on} onChange={(e) => setG({ ...g, on: e.target.value })} /></label>
              <label><span>{g.kind === 'sold' ? tr('Sold for') : tr('Anything received')}</span><input className="input" type="number" min="0" step="0.01" required={g.kind === 'sold'} value={g.amount} onChange={(e) => setG({ ...g, amount: e.target.value })} /></label>
            </div>
            <label><span>{tr('Note')}</span><input className="input" value={g.note} onChange={(e) => setG({ ...g, note: e.target.value })} placeholder={tr('e.g. To whom, the receipt number')} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-danger" disabled={busy}>{tr('Record it')}</button></div>
          </form>
        )}
        {meta.canManage && !mode && (
          <div className="x7-actions">
            {!a.disposal && <button type="button" className="btn btn-secondary" onClick={() => setMode('policy')}>⚙️ {tr('Change its life')}</button>}
            {!a.disposal ? <button type="button" className="btn btn-secondary is-end" onClick={() => setMode('dispose')}>📤 {tr('Sold, scrapped or lost')}</button>
              : <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => run(() => api.post('/depreciation/assets/' + a.id + '/undo', {}))}>↩️ {tr('Undo the disposal')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function LivesDialog({ d, onClose, onDone }) {
  const cats = Array.from(new Set(d.assets.map((a) => a.category).filter(Boolean))).sort();
  const [rows, setRows] = useState(() => cats.map((c) => ({ category: c, method: (d.settings.byCategory[c] || {}).method || 'straight', months: (d.settings.byCategory[c] || {}).months ? String(d.settings.byCategory[c].months) : '', rate: (d.settings.byCategory[c] || {}).rate ? String(d.settings.byCategory[c].rate) : '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setBusy(true); setError(null);
    const byCategory = {};
    rows.forEach((r) => { if (r.months) byCategory[r.category] = { method: r.method, months: Number(r.months), rate: r.rate ? Number(r.rate) : null }; });
    try { onDone(await api.put('/depreciation/settings', { byCategory })); } catch (e) { setError(e.message); setBusy(false); }
  }
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(720px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="dp-l-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">⏳</span><div><h2 id="dp-l-t">{tr('Useful lives')}</h2><p>{tr('How long each category lasts. Empty: the usual life for its kind.')}</p></div></div>
        <p className="x7-note">ⓘ {d.usual.map((u) => tr(USUAL[u.kind]) + ' ' + tr('{n} months', { n: u.months })).join(' · ')}</p>
        <div className="ob-edit">{rows.map((r, i) => (
          <div key={r.category} className="ob-edit-row dp-life">
            <b>{r.category}</b>
            <select className="input" value={r.method} onChange={(e) => set(i, { method: e.target.value })} aria-label={tr('Method')}>{Object.keys(METHOD).map((k) => <option key={k} value={k}>{tr(METHOD[k])}</option>)}</select>
            <input className="input" type="number" min="1" max="600" value={r.months} onChange={(e) => set(i, { months: e.target.value })} placeholder={tr('months')} aria-label={tr('Useful life (months)')} />
            <input className="input" type="number" min="1" max="100" value={r.rate} onChange={(e) => set(i, { rate: e.target.value })} placeholder={tr('% a year')} aria-label={tr('Rate a year (%)')} disabled={r.method !== 'reducing'} />
          </div>
        ))}</div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save')}</button></div>
      </div>
    </div>
  );
}

export default function DepreciationPage() {
  const [params, setParams] = useSearchParams();
  const [company, setCompany] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [year, setYear] = useState(today().slice(0, 4));
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [lives, setLives] = useState(false);
  const load = useCallback(() => api.get('/depreciation?asOf=' + asOf + '&year=' + year + (company ? '&company=' + company : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company, asOf, year]);
  useEffect(() => { load(); }, [load]);
  const assetId = params.get('asset');
  const open = (id) => setParams(id ? { asset: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const t = d.totals;
  const years = []; for (let y = Number(today().slice(0, 4)); y >= Number(today().slice(0, 4)) - 5; y--) years.push(String(y));
  async function csv() {
    const r = await fetch(API_URL + '/depreciation/export?asOf=' + asOf + (company ? '&company=' + company : ''), { headers: api.authHeaders() });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = 'depreciation-' + asOf + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>📉 {tr('Depreciation')}</h1>
          <p>{tr('What each asset cost, what it has lost and what it is still worth on any day; the year by month; what one fetched when it went, against its book value.')}</p>
        </div>
        <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={csv}>⬇️ {tr('Download')}</button>
          {d.canManage && <button type="button" className="btn btn-primary" onClick={() => setLives(true)}>⏳ {tr('Useful lives')}</button>}
        </div>
      </header>
      <div className="x7-bar">
        <div className="x7-chips">
          <button type="button" className={!company ? 'is-on' : ''} onClick={() => setCompany('')}>{tr('All companies')}</button>
          {d.companies.map((c) => <button key={c.id} type="button" className={company === c.id ? 'is-on' : ''} onClick={() => setCompany(c.id)}>{c.name}</button>)}
        </div>
        <div className="dp-when">
          <label><span>{tr('As at')}</span><input className="input" type="date" max={today()} value={asOf} onChange={(e) => setAsOf(e.target.value || today())} /></label>
          <label><span>{tr('Year')}</span><select className="input" value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
        </div>
      </div>
      <div className="x7-tiles">
        <div className="x7-tile is-calm"><small>🏷️ {tr('Cost')}</small><b>{money(t.cost, 'GHS')}</b><span>{tr('{n} assets', { n: t.count })}</span></div>
        <div className="x7-tile is-violet"><small>📉 {tr('Depreciation to date')}</small><b>{money(t.accumulated, 'GHS')}</b><span>{t.cost ? tr('{n}% of the cost', { n: Math.round(t.accumulated / t.cost * 100) }) : '—'}</span></div>
        <div className="x7-tile is-teal"><small>📘 {tr('Book value')}</small><b>{money(t.book, 'GHS')}</b><span>{tr('as at {date}', { date: dayText(d.asOf) })}</span></div>
        <div className="x7-tile is-warn"><small>📅 {tr('Charge in {year}', { year: d.year })}</small><b>{money(t.thisYear, 'GHS')}</b><span>{tr('{amount} so far', { amount: money(t.soFar, 'GHS') })}</span></div>
        {d.disposals.length > 0 && <div className={'x7-tile ' + (t.gain >= 0 ? 'is-good' : 'is-bad')}><small>📤 {tr('Disposals in {year}', { year: d.year })}</small><b>{(t.gain < 0 ? '−' : '+') + money(Math.abs(t.gain), 'GHS')}</b><span>{t.gain < 0 ? tr('loss on {n}', { n: d.disposals.length }) : tr('gain on {n}', { n: d.disposals.length })}</span></div>}
      </div>
      <section className="x7-card"><h2>📊 {tr('{year}, month by month', { year: d.year })} <small>{tr('lighter: to come')}</small></h2><YearChart months={d.months} /></section>
      {d.categories.length > 0 && (
        <section className="x7-card">
          <h2>🗂️ {tr('By category')}</h2>
          <div className="tx-table-wrap"><table className="tx-table">
            <thead><tr><th>{tr('Category')}</th><th className="num">{tr('Assets')}</th><th className="num">{tr('Cost')}</th><th>{tr('Used')}</th><th className="num">{tr('Book value')}</th><th className="num">{tr('This year')}</th></tr></thead>
            <tbody>{d.categories.map((c) => <tr key={c.category}><td>{c.category}</td><td className="num">{c.count}</td><td className="num">{money(c.cost, 'GHS')}</td><td className="dp-mini"><i style={{ width: (c.cost ? Math.round(c.accumulated / c.cost * 100) : 0) + '%' }} /></td><td className="num">{money(c.book, 'GHS')}</td><td className="num">{money(c.thisYear, 'GHS')}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
      {t.missing > 0 && <p className="x7-note">⚠️ {tr('{n} assets have no cost or no purchase date: they are left out until they do.', { n: t.missing })}</p>}
      {!d.assets.length ? <div className="x7-empty"><span aria-hidden="true">📉</span><p>{tr('No asset in the register yet: add them in Assets & maintenance.')}</p></div> : (
        <div className="x7-list">{d.assets.map((a) => {
          const used = a.cost ? Math.min(100, Math.round(a.accumulated / a.cost * 100)) : 0;
          return (
            <button key={a.id} type="button" className={'x7-row dp-row' + (a.disposal ? ' is-gone' : '')} onClick={() => open(a.id)}>
              <span className="x7-icon" aria-hidden="true">{a.disposal ? DISPOSAL[a.disposal.kind][0] : '🏷️'}</span>
              <span className="x7-who"><b>{a.assetNo} · {a.description}</b><small>{[a.category, a.company, a.purchaseDate ? tr('bought {date}', { date: dayText(a.purchaseDate) }) : null, methodText(a)].filter(Boolean).join(' · ')}</small>
                <span className="dp-wear is-small" aria-hidden="true"><i style={{ width: used + '%' }} /></span></span>
              <span className={'x7-pill ' + (a.disposal ? '' : a.fullyDepreciated ? 'is-violet' : a.noCost || a.noDate ? 'is-warn' : 'is-teal')}>{a.disposal ? tr(DISPOSAL[a.disposal.kind][1]) + ' ' + dayText(a.disposal.on, { year: undefined }) : a.fullyDepreciated ? tr('Fully depreciated') : a.noCost || a.noDate ? tr('No cost or date') : tr('{n}% used', { n: used })}</span>
              <span className="x7-money"><b>{money(a.book, 'GHS')}</b><small>{tr('of {amount}', { amount: money(a.cost, 'GHS') })}</small></span>
            </button>
          );
        })}</div>
      )}
      {lives && <LivesDialog d={d} onClose={() => setLives(false)} onDone={() => { setLives(false); load(); }} />}
      {assetId && <AssetSheet key={assetId} id={assetId} meta={d} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}
