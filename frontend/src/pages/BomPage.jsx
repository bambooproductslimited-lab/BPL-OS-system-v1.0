import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentieth.css';

// Bills of materials (Operations → Bills of materials; backend
// bom.service.js, migration 0201): what one of a product is made of, with a
// share for waste, plus labour and overhead; the cost rolled up through the
// parts that have a bill of their own; the margin against the price; the
// cost price on file kept right; what the stock can make and what a planned
// run is short of.

function pct(n) { return n == null ? '—' : (Math.round(n * 10) / 10) + '%'; }
function qty(n) { return String(Math.round(Number(n) * 10000) / 10000); }
function dayText(d) { return d ? new Date(d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
const TABS = [['made', '🧩', msg('With a bill')], ['parts', '🪵', msg('Parts')], ['none', '➕', msg('Without a bill')]];

// The cost of one, as three parts of a bar: materials, labour, overhead.
function CostBar({ r, big }) {
  const total = Math.max(0.0001, r.material + r.labour + r.overhead);
  const price = r.price > 0 ? r.price : null;
  const scale = Math.max(total, price || 0);
  return (
    <span className={'bom-bar' + (big ? ' is-big' : '')} aria-hidden="true">
      <span className="bom-bar-track">
        <i className="is-mat" style={{ width: r.material / scale * 100 + '%' }} />
        <i className="is-lab" style={{ width: r.labour / scale * 100 + '%' }} />
        <i className="is-ovh" style={{ width: r.overhead / scale * 100 + '%' }} />
        {price && <em style={{ left: Math.min(100, price / scale * 100) + '%' }} />}
      </span>
    </span>
  );
}

function marginTone(m, low) { return m == null ? '' : m < 0 ? 'is-bad' : m < low ? 'is-warn' : 'is-good'; }

function EditDialog({ d, p, onClose, onDone }) {
  const [lines, setLines] = useState(p.lines.map((l) => ({ componentId: l.component.id, qty: String(l.qty), wastePct: String(l.wastePct), note: l.note || '' })));
  const [f, setF] = useState({ labourHours: String(p.labourHours || ''), labourRate: String(p.labourRate || ''), overhead: String(p.overheadEach || ''), note: p.note || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const parts = d.catalogue.filter((c) => c.id !== p.id);
  const byId = Object.fromEntries(d.catalogue.map((c) => [c.id, c]));
  const setLine = (n, k, v) => setLines(lines.map((l, i) => (i === n ? { ...l, [k]: v } : l)));
  // About what it comes to, from the costs on file of the parts.
  const material = lines.reduce((a, l) => a + (byId[l.componentId] ? byId[l.componentId].cost * (Number(l.qty) || 0) * (1 + (Number(l.wastePct) || 0) / 100) : 0), 0);
  const about = material + (Number(f.labourHours) || 0) * (Number(f.labourRate) || 0) + (Number(f.overhead) || 0);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.put('/bom/' + p.id, { ...f, lines: lines.filter((l) => l.componentId) })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(820px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="bom-e-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🧩</span><div><h2 id="bom-e-t">{tr('What one {name} is made of', { name: p.name })}</h2><p>{tr('The parts for one, with a share for what is cut off or spoilt; the hours it takes and the overhead on each.')}</p></div></div>
        <div className="bom-lines">
          <div className="bom-line is-head" aria-hidden="true"><span>{tr('Part')}</span><span>{tr('For one')}</span><span>{tr('Waste %')}</span><span>{tr('Costs')}</span><span /></div>
          {lines.map((l, n) => {
            const c = byId[l.componentId];
            return (
              <div key={n} className="bom-line">
                <select className="input" value={l.componentId} onChange={(e) => setLine(n, 'componentId', e.target.value)} aria-label={tr('Part')}><option value="">—</option>{parts.map((c2) => <option key={c2.id} value={c2.id}>{c2.name}{c2.sku ? ' · ' + c2.sku : ''}</option>)}</select>
                <span className="bom-qty"><input className="input" type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(n, 'qty', e.target.value)} aria-label={tr('For one')} /><small>{c ? c.unit : ''}</small></span>
                <input className="input" type="number" min="0" max="90" step="0.5" value={l.wastePct} onChange={(e) => setLine(n, 'wastePct', e.target.value)} aria-label={tr('Waste %')} />
                <span className="bom-cost">{c ? money(c.cost * (Number(l.qty) || 0) * (1 + (Number(l.wastePct) || 0) / 100), 'GHS') : '—'}</span>
                <button type="button" className="bom-x" onClick={() => setLines(lines.filter((_, i) => i !== n))} aria-label={tr('Take it off')}>✕</button>
              </div>
            );
          })}
          <button type="button" className="btn btn-secondary bom-add" onClick={() => setLines([...lines, { componentId: '', qty: '1', wastePct: '0', note: '' }])}>➕ {tr('A part')}</button>
        </div>
        <div className="x7-grid3">
          <label><span>{tr('Labour hours for one')}</span><input className="input" type="number" min="0" step="0.05" value={f.labourHours} onChange={(e) => setF({ ...f, labourHours: e.target.value })} /></label>
          <label><span>{tr('Labour rate an hour')}</span><input className="input" type="number" min="0" step="0.5" value={f.labourRate} onChange={(e) => setF({ ...f, labourRate: e.target.value })} /></label>
          <label><span>{tr('Overhead on each')}</span><input className="input" type="number" min="0" step="0.5" value={f.overhead} onChange={(e) => setF({ ...f, overhead: e.target.value })} /><small>{tr('power, the kiln, the workshop')}</small></label>
        </div>
        <p className="x7-note">🧮 {tr('About {v} for one, at the parts\' costs on file.', { v: money(about, 'GHS') })}{p.price > 0 ? ' ' + tr('It sells at {v}.', { v: money(p.price, 'GHS') }) : ''}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save the bill')}</button></div>
      </form>
    </div>
  );
}

function ProductSheet({ id, d, onClose, onChanged, onOpen }) {
  const [p, setP] = useState(null);
  const [run, setRun] = useState('');
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback((n) => api.get('/bom/' + id + (n ? '?qty=' + n : '')).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function useCost() {
    setBusy(true); setError(null);
    try { setP(await api.post('/bom/' + id + '/use-cost')); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!p) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const tone = marginTone(p.marginPct, d.lowMargin);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="bom-p-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#7c3aed', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">🧩</span>
          <div><small>{[p.sku, p.category].filter(Boolean).join(' · ')}</small><h2 id="bom-p-t">{p.name}</h2>
            <p><b>{money(p.cost, 'GHS')}</b><span className="x7-pill">{tr('to make one')}</span>{p.price > 0 && <span className="x7-pill">{tr('sells at {v}', { v: money(p.price, 'GHS') })} · {pct(p.marginPct)}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="bom-split">
          <CostBar r={p} big />
          <div className="bom-keys">
            <span><i className="is-mat" />{tr('Materials')} <b>{money(p.material, 'GHS')}</b></span>
            <span><i className="is-lab" />{tr('Labour')} <b>{money(p.labour, 'GHS')}</b><small>{p.labourHours ? tr('{h} h at {r}', { h: p.labourHours, r: money(p.labourRate, 'GHS') }) : ''}</small></span>
            <span><i className="is-ovh" />{tr('Overhead')} <b>{money(p.overhead, 'GHS')}</b></span>
            {p.price > 0 && <span><i className="is-price" />{tr('Price')} <b>{money(p.price, 'GHS')}</b><small className={tone}>{tr('{v} margin', { v: money(p.margin, 'GHS') })}</small></span>}
          </div>
        </div>
        {p.diffPct != null && Math.abs(p.diffPct) > 0.5 && (
          <div className={'bom-stale ' + (Math.abs(p.diffPct) > 5 ? 'is-warn' : 'is-calm')}>
            <span aria-hidden="true">📌</span>
            <p>{tr('The cost on file is {file}; the bill says {bill} ({diff}).', { file: money(p.costOnFile, 'GHS'), bill: money(p.cost, 'GHS'), diff: (p.diffPct > 0 ? '+' : '') + pct(p.diffPct) })}</p>
            {p.canManage && <button type="button" className="btn btn-primary" disabled={busy} onClick={useCost}>{tr('Use {v}', { v: money(p.cost, 'GHS') })}</button>}
          </div>
        )}
        <div className="x7-sec"><h3>🪵 {tr('What one is made of')}</h3>
          {!p.lines.length ? <p className="x7-muted">{tr('No parts yet.')}</p> : (
            <div className="bom-table" role="table">
              <div className="bom-tr is-head" role="row"><span role="columnheader">{tr('Part')}</span><span role="columnheader">{tr('For one')}</span><span role="columnheader">{tr('Costs')}</span><span role="columnheader">{tr('In stock')}</span></div>
              {p.lines.map((l) => (
                <div key={l.id} className="bom-tr" role="row">
                  <span role="cell" className="bom-part">{l.component.hasBom ? <button type="button" className="x7-link" onClick={() => onOpen(l.component.id)}>🧩 {l.component.name}</button> : <b>{l.component.name}</b>}<small>{money(l.unitCost, 'GHS')} / {l.component.unit}</small></span>
                  <span role="cell"><b>{qty(l.qty)} {l.component.unit}</b>{l.wastePct > 0 && <small>+{l.wastePct}% {tr('waste')}</small>}</span>
                  <span role="cell"><b>{money(l.lineCost, 'GHS')}</b><small>{pct(l.lineCost / Math.max(0.0001, p.cost) * 100)}</small></span>
                  <span role="cell" className={l.makes < 1 ? 'is-bad' : ''}><b>{qty(l.component.stock)}</b><small>{tr('enough for {n}', { n: l.makes })}</small></span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="x7-sec bom-plan"><h3>🏭 {tr('A run')}</h3>
          <p className="x7-muted">{p.buildable != null ? tr('The stock makes {n} now; {part} runs out first.', { n: p.buildable, part: p.limiting ? p.limiting.name : '—' }) : tr('Add the parts to see what the stock makes.')}</p>
          <form className="bom-run" onSubmit={(e) => { e.preventDefault(); load(Number(run) || 0); }}>
            <input className="input" type="number" min="1" max="100000" value={run} onChange={(e) => setRun(e.target.value)} placeholder={tr('How many to make')} aria-label={tr('How many to make')} />
            <button type="submit" className="btn btn-secondary">{tr('What is short?')}</button>
          </form>
          {p.plan && (
            <div className={'bom-plan-out ' + (p.plan.ok ? 'is-good' : 'is-warn')}>
              <p><b>{p.plan.ok ? '✅ ' + tr('Everything is there for {n}.', { n: p.plan.qty }) : '🛒 ' + tr('To buy for {n}: {v}', { n: p.plan.qty, v: money(p.plan.shortCost, 'GHS') })}</b><small>{tr('Costs {c} to make, sells for {v}.', { c: money(p.plan.cost, 'GHS'), v: money(p.plan.value, 'GHS') })}</small></p>
              <ul>{p.plan.needs.map((n) => (
                <li key={n.component.id} className={n.short > 0 ? 'is-short' : ''}><span>{n.component.name}</span><span>{tr('need {n}', { n: qty(n.need) })}</span><span>{tr('have {n}', { n: qty(n.have) })}</span><b>{n.short > 0 ? tr('short {n}', { n: qty(n.short) }) + ' · ' + money(n.shortCost, 'GHS') : '✓'}</b></li>
              ))}</ul>
            </div>
          )}
        </div>
        {p.whereUsed.length > 0 && <div className="x7-sec"><h3>🔗 {tr('Goes into')}</h3><div className="x7-chips">{p.whereUsed.map((w) => <button key={w.id} type="button" onClick={() => onOpen(w.id)}>🧩 {w.name} · {qty(w.qty)}</button>)}</div></div>}
        {p.history.length > 0 && <div className="x7-sec"><h3>🗂️ {tr('Cost price changes')}</h3><ul className="x7-mine-list">{p.history.map((h, n) => <li key={n}><span aria-hidden="true">📌</span><span><b>{money(h.before, 'GHS')} → {money(h.after, 'GHS')}</b><small>{dayText(h.at)}{h.by ? ' · ' + h.by : ''}</small></span></li>)}</ul></div>}
        {p.canManage && <div className="x7-actions"><button type="button" className="btn btn-primary is-end" onClick={() => setEditing(true)}>✏️ {p.lines.length ? tr('Change the bill') : tr('Write the bill')}</button></div>}
        {editing && <EditDialog d={d} p={p} onClose={() => setEditing(false)} onDone={(x) => { setEditing(false); setP(x); onChanged(); }} />}
      </div>
    </div>
  );
}

export default function BomPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => api.get('/bom').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const tab = params.get('tab') || 'made';
  const open = params.get('product');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const go = (p) => setParams(p);
  const openP = (pid) => go({ ...(tab === 'made' ? {} : { tab }), product: pid });
  const like = (x) => !q || (x.name + ' ' + (x.sku || '')).toLowerCase().includes(q.toLowerCase());
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🧩 {tr('Bills of materials')}</h1>
          <p>{tr('What each product is made of, what one really costs with labour and overhead, the margin it leaves, and what the stock can make.')}</p>
        </div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🧩 {tr('Costed')}</small><b>{s.costed}</b><span>{s.noBom ? tr('{n} still without a bill', { n: s.noBom }) : tr('every product')}</span></div>
        <div className={'x7-tile ' + (s.avgMargin == null ? 'is-calm' : s.avgMargin < d.lowMargin ? 'is-warn' : 'is-good')}><small>📈 {tr('Average margin')}</small><b>{pct(s.avgMargin)}</b><span>{tr('on the selling price')}</span></div>
        <div className={'x7-tile ' + (s.lowMargin ? 'is-bad' : 'is-good')}><small>⚠️ {tr('Margin under {n}%', { n: d.lowMargin })}</small><b>{s.lowMargin}</b><span>{tr('price or cost to look at')}</span></div>
        <div className={'x7-tile ' + (s.stale ? 'is-warn' : 'is-good')}><small>📌 {tr('Cost on file out of date')}</small><b>{s.stale}</b><span>{tr('more than 5% off the bill')}</span></div>
        <div className="x7-tile is-violet"><small>🏭 {tr('The stock can make')}</small><b>{money(s.canMake, 'GHS')}</b><span>{tr('at selling prices')}</span></div>
      </div>
      <div className="lic-bar">
        <div className="x7-seg" role="tablist">{TABS.map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => go(k === 'made' ? {} : { tab: k })}>{ic} {tr(lab)}<i>{k === 'made' ? d.products.length : k === 'parts' ? d.parts.length : d.noBom.length}</i></button>)}</div>
        <input className="input lic-search" data-type-to-search value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a product')} aria-label={tr('Find a product')} />
      </div>
      {tab === 'made' && (!d.products.length ? <div className="x7-empty"><span aria-hidden="true">🧩</span><p>{tr('No bill yet: open a product under "Without a bill" and write what it is made of.')}</p></div> : (
        <section className="x7-card">
          <div className="bom-legend" aria-hidden="true"><span><i className="is-mat" />{tr('Materials')}</span><span><i className="is-lab" />{tr('Labour')}</span><span><i className="is-ovh" />{tr('Overhead')}</span><span><i className="is-price" />{tr('Price')}</span></div>
          <div className="bom-rows">{d.products.filter(like).map((r) => (
            <button key={r.id} type="button" className="bom-row" onClick={() => openP(r.id)}>
              <span className="bom-name"><b>{r.name}</b><small>{[r.sku, r.lines === 1 ? tr('1 part') : tr('{n} parts', { n: r.lines })].filter(Boolean).join(' · ')}</small></span>
              <CostBar r={r} />
              <span className="bom-num"><b>{money(r.cost, 'GHS')}</b><small>{r.price > 0 ? tr('sells {v}', { v: money(r.price, 'GHS') }) : tr('not sold')}</small></span>
              <span className={'x7-pill bom-margin ' + marginTone(r.marginPct, d.lowMargin)}>{r.marginPct != null ? pct(r.marginPct) : '—'}</span>
              <span className="bom-num is-small">{r.buildable != null ? <b>{r.buildable}</b> : <b>—</b>}<small>{r.limiting ? tr('{part} first', { part: r.limiting.name }) : tr('can make')}</small></span>
              {r.diffPct != null && Math.abs(r.diffPct) > 5 ? <span className="x7-pill is-warn bom-file" title={tr('The cost on file is out of date')}>📌 {(r.diffPct > 0 ? '+' : '') + pct(r.diffPct)}</span> : <span className="bom-file" />}
            </button>
          ))}</div>
        </section>
      ))}
      {tab === 'parts' && (
        <div className="x7-list">{d.parts.filter(like).map((p) => (
          <button key={p.id} type="button" className="x7-row" onClick={() => openP(p.id)}>
            <span className="x7-icon" aria-hidden="true">🪵</span>
            <span className="x7-who"><b>{p.name}</b><small>{[p.sku, money(p.cost, 'GHS') + ' / ' + p.unit, tr('{n} in stock', { n: qty(p.stock) })].filter(Boolean).join(' · ')}</small></span>
            <span className="x7-pill is-calm">{p.usedIn === 1 ? tr('in 1 product') : tr('in {n} products', { n: p.usedIn })}</span><span />
          </button>
        ))}</div>
      )}
      {tab === 'none' && (
        <div className="bom-none">{d.noBom.filter(like).map((p) => (
          <button key={p.id} type="button" className="bom-none-card" onClick={() => openP(p.id)}>
            <b>{p.name}</b><small>{[p.sku, p.category].filter(Boolean).join(' · ')}</small>
            <span>{tr('sells {v}', { v: money(p.price, 'GHS') })} · {tr('cost on file {v}', { v: money(p.costOnFile, 'GHS') })}</span>
            {d.canManage && <em>➕ {tr('Write the bill')}</em>}
          </button>
        ))}</div>
      )}
      {open && <ProductSheet key={open} id={open} d={d} onClose={() => go(tab === 'made' ? {} : { tab })} onChanged={load} onOpen={openP} />}
    </div>
  );
}
