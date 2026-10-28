import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentyfirst.css';

// Bamboo outgrowers (Operations → Bamboo outgrowers; backend
// outgrowers.service.js, migration 0203): the farmers who grow bamboo for
// Bamboo Products — their plots and the harvests expected month by month,
// money advanced, each delivery taken in and paid (usually by Mobile Money)
// with the advance taken off, and their scorecard grade.

const METHOD = { mobile_money: ['📱', msg('Mobile Money')], cash: ['💵', msg('Cash')], bank: ['🏦', msg('Bank')] };
const GRADE = { A: 'is-good', B: 'is-teal', C: 'is-warn', D: 'is-bad' };

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function num(v) { return v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString(activeIntlLocale()); }
function today() { return new Date().toISOString().slice(0, 10); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function initials(name) { const w = String(name || '').split(/\s+/).filter((x) => /^\p{L}/u.test(x) && x !== 'Zq'); return (w.length ? w.map((x) => x[0]).slice(0, 2).join('') : '?').toUpperCase(); }
function harvestWords(day) {
  if (!day) return tr('No harvest set');
  const n = Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
  if (n < 0) return tr('due {n} days ago', { n: -n });
  if (n === 0) return tr('due today');
  if (n < 60) return tr('in {n} days', { n });
  return dayText(day, { year: 'numeric' });
}

function Forecast({ f }) {
  const top = Math.max(1, ...f.months.map((m) => m.qty));
  return (
    <div className="ogr-forecast" role="img" aria-label={tr('Harvests expected: {list}', { list: f.months.map((m) => monthText(m.month) + ' ' + num(m.qty)).join(', ') })}>
      {f.months.map((m, i) => (
        <div key={m.month} className={'ogr-month' + (i === 0 ? ' is-now' : '')}>
          <span className="ogr-bar"><i style={{ height: m.qty / top * 100 + '%' }} className={m.late ? 'is-late' : ''} /><b>{m.qty ? num(m.qty) : ''}</b></span>
          <small>{monthText(m.month)}</small>
          <em>{m.plots ? (m.plots === 1 ? tr('1 plot') : tr('{n} plots', { n: m.plots })) : ''}{m.late ? ' · ' + tr('{n} late', { n: m.late }) : ''}</em>
        </div>
      ))}
    </div>
  );
}

function Dialog({ title, icon, sub, onClose, onSubmit, children, busy, error, submit, width }) {
  // On the page itself, not inside the farmer's sheet (which would clip it).
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(' + (width || 600) + 'px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="ogr-d-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{icon}</span><div><h2 id="ogr-d-t">{title}</h2>{sub && <p>{sub}</p>}</div></div>
        {children}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{submit}</button></div>
      </form>
    </div>,
    document.body
  );
}

function useSend(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function send(fn) {
    setBusy(true); setError(null);
    try { onDone(await fn()); } catch (e) { setError(e.message); setBusy(false); }
  }
  return { busy, error, send };
}

function FarmerDialog({ d, farmer, onClose, onDone }) {
  const [way, setWay] = useState(farmer ? 'edit' : 'new');
  const [f, setF] = useState(farmer
    ? { name: farmer.name, phone: farmer.phone, town: farmer.town, district: farmer.district, region: farmer.region, momoNumber: farmer.momoNumber, momoNetwork: farmer.momoNetwork, joinedOn: farmer.joinedOn || '', notes: farmer.notes, active: farmer.active }
    : { name: '', phone: '', town: '', district: '', region: '', momoNumber: '', momoNetwork: 'MTN', joinedOn: today(), notes: '', supplierId: '' });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = () => s.send(() => (farmer ? api.patch('/outgrowers/' + farmer.id, f) : api.post('/outgrowers', way === 'existing' ? { supplierId: f.supplierId, momoNumber: f.momoNumber, momoNetwork: f.momoNetwork, joinedOn: f.joinedOn } : f)));
  return (
    <Dialog title={farmer ? farmer.name : tr('A farmer')} icon="👩🏾‍🌾" sub={tr('A farmer who grows bamboo for us, and the Mobile Money number they are paid on.')} onClose={onClose} onSubmit={save} busy={s.busy} error={s.error} submit={tr('Save')}>
      {!farmer && d.candidates.length > 0 && <div className="x7-seg" role="tablist">{[['new', '➕', msg('Someone new')], ['existing', '📇', msg('A supplier on file')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={way === k} className={way === k ? 'is-on' : ''} onClick={() => setWay(k)}>{ic} {tr(lab)}</button>)}</div>}
      {way === 'existing' ? (
        <label><span>{tr('Supplier')}</span><select className="input" required value={f.supplierId} onChange={(e) => set('supplierId', e.target.value)}><option value="">—</option>{d.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.town ? ' · ' + c.town : ''}</option>)}</select></label>
      ) : (
        <>
          <div className="x7-grid2">
            <label><span>{tr('Name')}</span><input className="input" required autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
            <label><span>{tr('Phone')}</span><input className="input" type="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
          </div>
          <div className="x7-grid3">
            <label><span>{tr('Town or village')}</span><input className="input" value={f.town} onChange={(e) => set('town', e.target.value)} /></label>
            <label><span>{tr('District')}</span><input className="input" value={f.district} onChange={(e) => set('district', e.target.value)} /></label>
            <label><span>{tr('Region')}</span><input className="input" value={f.region} onChange={(e) => set('region', e.target.value)} /></label>
          </div>
        </>
      )}
      <div className="x7-grid3">
        <label><span>{tr('Mobile Money number')}</span><input className="input" type="tel" value={f.momoNumber} onChange={(e) => set('momoNumber', e.target.value)} /></label>
        <label><span>{tr('Network')}</span><select className="input" value={f.momoNetwork} onChange={(e) => set('momoNetwork', e.target.value)}><option value="">—</option>{d.networks.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <label><span>{tr('Joined')}</span><input className="input" type="date" value={f.joinedOn} onChange={(e) => set('joinedOn', e.target.value)} /></label>
      </div>
      {way !== 'existing' && <label><span>{tr('Notes')}</span><textarea className="input" rows="2" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>}
      {farmer && <label className="x7-check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /><span>{tr('Still growing for us')}</span></label>}
    </Dialog>
  );
}

function PlotDialog({ farmer, plot, units, onClose, onDone }) {
  const [f, setF] = useState(plot
    ? { ...plot, lat: plot.lat ?? '', lng: plot.lng ?? '', hectares: plot.hectares ?? '', clumps: plot.clumps ?? '', plantedYear: plot.plantedYear ?? '', nextHarvest: plot.nextHarvest || '', expectedQty: plot.expectedQty ?? '' }
    : { name: '', place: farmer.town || '', lat: '', lng: '', hectares: '', species: '', clumps: '', plantedYear: '', cycleMonths: '12', nextHarvest: '', expectedQty: '', unit: 'poles', note: '', active: true });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = () => s.send(() => (plot ? api.patch('/outgrowers/plots/' + plot.id, f) : api.post('/outgrowers/' + farmer.id + '/plots', f)));
  return (
    <Dialog title={plot ? plot.name : tr('A plot')} icon="🎋" sub={tr('Where it is, how big, when it is next cut and what it should give.')} onClose={onClose} onSubmit={save} busy={s.busy} error={s.error} submit={tr('Save')} width={660}>
      <div className="x7-grid2">
        <label><span>{tr('Name')}</span><input className="input" required autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={tr('e.g. the river plot')} /></label>
        <label><span>{tr('Where')}</span><input className="input" value={f.place} onChange={(e) => set('place', e.target.value)} /></label>
      </div>
      <div className="x7-grid3">
        <label><span>{tr('Hectares')}</span><input className="input" type="number" min="0" step="0.01" value={f.hectares} onChange={(e) => set('hectares', e.target.value)} /></label>
        <label><span>{tr('Species')}</span><input className="input" value={f.species} onChange={(e) => set('species', e.target.value)} placeholder="Bambusa vulgaris" /></label>
        <label><span>{tr('Clumps')}</span><input className="input" type="number" min="0" value={f.clumps} onChange={(e) => set('clumps', e.target.value)} /></label>
      </div>
      <div className="x7-grid3">
        <label><span>{tr('Next harvest')}</span><input className="input" type="date" value={f.nextHarvest} onChange={(e) => set('nextHarvest', e.target.value)} /></label>
        <label><span>{tr('Cut every (months)')}</span><input className="input" type="number" min="1" max="60" value={f.cycleMonths} onChange={(e) => set('cycleMonths', e.target.value)} /></label>
        <label><span>{tr('Planted')}</span><input className="input" type="number" min="1950" max="2100" value={f.plantedYear} onChange={(e) => set('plantedYear', e.target.value)} placeholder={tr('year')} /></label>
      </div>
      <div className="x7-grid3">
        <label><span>{tr('Should give')}</span><input className="input" type="number" min="0" value={f.expectedQty} onChange={(e) => set('expectedQty', e.target.value)} /></label>
        <label><span>{tr('Unit')}</span><select className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)}>{units.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
        <span />
      </div>
      <div className="x7-grid2">
        <label><span>{tr('Latitude')}</span><input className="input" type="number" step="any" value={f.lat} onChange={(e) => set('lat', e.target.value)} placeholder="6.6885" /></label>
        <label><span>{tr('Longitude')}</span><input className="input" type="number" step="any" value={f.lng} onChange={(e) => set('lng', e.target.value)} placeholder="-1.6244" /></label>
      </div>
      <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
      {plot && <label className="x7-check"><input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} /><span>{tr('Still being cut')}</span></label>}
    </Dialog>
  );
}

function AdvanceDialog({ farmer, d, onClose, onDone }) {
  const [f, setF] = useState({ amount: '', givenOn: today(), method: 'mobile_money', reference: '', note: '' });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog title={tr('Money advanced to {name}', { name: farmer.name })} icon="🤝" sub={tr('It comes off what their next deliveries are worth.')} onClose={onClose} onSubmit={() => s.send(() => api.post('/outgrowers/' + farmer.id + '/advances', f))} busy={s.busy} error={s.error} submit={tr('Save the advance')}>
      <div className="x7-grid2">
        <label><span>{tr('Amount')}</span><input className="input" type="number" min="0" step="0.01" required autoFocus value={f.amount} onChange={(e) => set('amount', e.target.value)} /></label>
        <label><span>{tr('Given on')}</span><input className="input" type="date" value={f.givenOn} onChange={(e) => set('givenOn', e.target.value)} /></label>
      </div>
      <div className="ogr-methods" role="radiogroup" aria-label={tr('How')}>{d.methods.map((m) => <button key={m} type="button" role="radio" aria-checked={f.method === m} className={f.method === m ? 'is-on' : ''} onClick={() => set('method', m)}><em aria-hidden="true">{METHOD[m][0]}</em>{tr(METHOD[m][1])}</button>)}</div>
      <div className="x7-grid2">
        <label><span>{tr('Reference')}</span><input className="input" value={f.reference} onChange={(e) => set('reference', e.target.value)} /></label>
        <label><span>{tr('What for')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={tr('e.g. to pay the cutters')} /></label>
      </div>
    </Dialog>
  );
}

function DeliveryDialog({ d, farmer, onClose, onDone }) {
  const first = farmer || d.farmers.find((x) => x.active) || {};
  const [f, setF] = useState({ farmerId: first.id || '', plotId: '', species: 'Bambusa vulgaris', qty: '', unit: 'poles', grade: 'B', value: '', dateReceived: today(), notes: '' });
  const [plots, setPlots] = useState(farmer ? farmer.plotList : []);
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    if (farmer || !f.farmerId) return;
    api.get('/outgrowers/' + f.farmerId).then((x) => setPlots(x.plotList)).catch(() => setPlots([]));
  }, [f.farmerId, farmer]);
  const who = d.farmers.find((x) => x.id === f.farmerId);
  const each = who && who.quotedPrice ? who.quotedPrice : null;
  return (
    <Dialog title={tr('A delivery in')} icon="🚚" sub={tr('Taken into the raw materials store as a raw batch from the farmer; pay it once its value is set.')} onClose={onClose} onSubmit={() => s.send(() => api.post('/outgrowers/deliveries', f))} busy={s.busy} error={s.error} submit={tr('Take it in')} width={640}>
      <div className="x7-grid2">
        <label><span>{tr('Farmer')}</span><select className="input" value={f.farmerId} disabled={!!farmer} onChange={(e) => { set('farmerId', e.target.value); set('plotId', ''); }}>{d.farmers.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}{x.town ? ' · ' + x.town : ''}</option>)}</select></label>
        <label><span>{tr('From the plot')}</span><select className="input" value={f.plotId} onChange={(e) => set('plotId', e.target.value)}><option value="">—</option>{plots.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      <div className="x7-grid3">
        <label><span>{tr('How many')}</span><input className="input" type="number" min="0" step="any" required autoFocus value={f.qty} onChange={(e) => { set('qty', e.target.value); if (each && !f.value) set('value', ''); }} /></label>
        <label><span>{tr('Unit')}</span><select className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)}>{d.units.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
        <label><span>{tr('Grade')}</span><select className="input" value={f.grade} onChange={(e) => set('grade', e.target.value)}>{['A', 'B', 'C'].map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
      </div>
      <div className="x7-grid3">
        <label><span>{tr('Species')}</span><input className="input" value={f.species} onChange={(e) => set('species', e.target.value)} /></label>
        <label><span>{tr('Worth')}</span><input className="input" type="number" min="0" step="0.01" value={f.value} onChange={(e) => set('value', e.target.value)} placeholder={each && f.qty ? String(Math.round(each * Number(f.qty) * 100) / 100) : ''} />{each && <small>{tr('{v} a {unit} quoted', { v: money(each), unit: who.priceUnit || tr('pole') })}</small>}</label>
        <label><span>{tr('Came on')}</span><input className="input" type="date" value={f.dateReceived} onChange={(e) => set('dateReceived', e.target.value)} /></label>
      </div>
      <input className="input" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder={tr('Anything to add')} aria-label={tr('Note')} />
    </Dialog>
  );
}

function PayDialog({ d, batch, onClose, onDone }) {
  const left = Math.max(0, batch.farmer.advanceLeft || 0);
  const [f, setF] = useState({ advanceTaken: String(Math.min(left, batch.value)), method: 'mobile_money', momoNumber: batch.farmer.momoNumber || '', reference: '', paidOn: today(), note: '', text: true });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const net = Math.max(0, batch.value - (Number(f.advanceTaken) || 0));
  return (
    <Dialog title={tr('Pay {name}', { name: batch.farmer.name })} icon="📲" sub={tr('{batch}: {qty} {unit} on {date}', { batch: batch.batchNo, qty: num(batch.qty), unit: batch.unit, date: dayText(batch.day) })} onClose={onClose} onSubmit={() => s.send(() => api.post('/outgrowers/pay', { ...f, batchId: batch.id }))} busy={s.busy} error={s.error} submit={'📲 ' + tr('Paid {v}', { v: money(net) })} width={560}>
      <div className="ogr-pay">
        <div><small>{tr('The delivery is worth')}</small><b>{money(batch.value)}</b></div>
        <div><small>{tr('Off the advance')}</small><b>− {money(Number(f.advanceTaken) || 0)}</b>{left > 0 && <em>{tr('{v} still out', { v: money(left) })}</em>}</div>
        <div className="is-net"><small>{tr('To send')}</small><b>{money(net)}</b></div>
      </div>
      {left > 0 && <label><span>{tr('Off the advance')}</span><input className="input" type="number" min="0" max={Math.min(left, batch.value)} step="0.01" value={f.advanceTaken} onChange={(e) => set('advanceTaken', e.target.value)} /></label>}
      <div className="ogr-methods" role="radiogroup" aria-label={tr('How')}>{d.methods.map((m) => <button key={m} type="button" role="radio" aria-checked={f.method === m} className={f.method === m ? 'is-on' : ''} onClick={() => set('method', m)}><em aria-hidden="true">{METHOD[m][0]}</em>{tr(METHOD[m][1])}</button>)}</div>
      <div className="x7-grid2">
        {f.method === 'mobile_money' && <label><span>{tr('Mobile Money number')}</span><input className="input" type="tel" value={f.momoNumber} onChange={(e) => set('momoNumber', e.target.value)} /></label>}
        {f.method !== 'cash' && <label><span>{tr('Transaction reference')}</span><input className="input" value={f.reference} onChange={(e) => set('reference', e.target.value)} placeholder={tr('on the Mobile Money message')} /></label>}
        <label><span>{tr('Paid on')}</span><input className="input" type="date" value={f.paidOn} onChange={(e) => set('paidOn', e.target.value)} /></label>
      </div>
      <label className="x7-check"><input type="checkbox" checked={f.text} onChange={(e) => set('text', e.target.checked)} /><span>{tr('Text the farmer what was paid')}</span></label>
    </Dialog>
  );
}

function FarmerSheet({ id, d, onClose, onChanged }) {
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/outgrowers/' + id).then(setF).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const done = (x) => { setF(x); setDlg(null); onChanged(); if (x && x.texted) setFlash(tr('Paid, and the farmer was texted.')); };
  async function cut(plot) {
    try { done(await api.post('/outgrowers/plots/' + plot.id + '/harvested', {})); setFlash(tr('{name} cut today: the next harvest moves on.', { name: plot.name })); } catch (e) { setError(e.message); }
  }
  if (!f) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const unpaid = f.deliveries.filter((b) => !b.paid && b.value > 0);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="ogr-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#15803d', '--g2': '#0f766e' }}>
          <span className="x7-avatar" style={{ '--h': hue(f.name) }} aria-hidden="true">{initials(f.name)}</span>
          <div><small>{[f.town, f.district, f.region].filter(Boolean).join(' · ') || tr('Outgrower')}</small><h2 id="ogr-s-t">{f.name}</h2>
            <p>{f.grade ? <span className="x7-pill">⭐ {tr('grade {g}', { g: f.grade })} · {f.score}</span> : <span className="x7-pill">{tr('Not graded yet')}</span>}
              {f.momoNumber && <span className="x7-pill">📱 {f.momoNumber}{f.momoNetwork ? ' · ' + f.momoNetwork : ''}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {flash && <p className="x7-flash is-good" role="status">✅ {flash}</p>}
        <div className="ogr-sums">
          <div><small>🎋 {tr('Plots')}</small><b>{f.plots}</b><em>{num(f.hectares)} ha</em></div>
          <div><small>📅 {tr('Next harvest')}</small><b>{f.nextHarvest ? dayText(f.nextHarvest) : '—'}</b><em>{f.soonQty ? tr('{n} in 90 days', { n: num(f.soonQty) }) : ''}</em></div>
          <div className={f.advanceLeft > 0 ? 'is-warn' : ''}><small>🤝 {tr('Advance still out')}</small><b>{money(f.advanceLeft)}</b><em>{tr('of {v} given', { v: money(f.advanced) })}</em></div>
          <div className={f.owed > 0 ? 'is-bad' : ''}><small>💸 {tr('Owed to them')}</small><b>{money(f.owed)}</b><em>{f.unpaid === 1 ? tr('1 delivery') : tr('{n} deliveries', { n: f.unpaid })}</em></div>
        </div>
        <div className="x7-sec"><h3>📈 {tr('Harvests expected')}</h3><Forecast f={f.forecast} /></div>
        <div className="x7-sec"><h3>🎋 {tr('Plots')}</h3>
          {!f.plotList.length ? <p className="x7-muted">{tr('No plot yet.')}</p> : <div className="ogr-plots">{f.plotList.map((p) => (
            <div key={p.id} className={'ogr-plot' + (p.overdue ? ' is-late' : '') + (p.active ? '' : ' is-off')}>
              <div className="ogr-plot-top"><b>{p.name}</b>{p.overdue ? <span className="x7-pill is-bad">⏰ {harvestWords(p.nextHarvest)}</span> : <span className="x7-pill is-calm">✂️ {harvestWords(p.nextHarvest)}</span>}</div>
              <small>{[p.place, p.hectares != null ? num(p.hectares) + ' ha' : null, p.species, p.clumps ? tr('{n} clumps', { n: p.clumps }) : null].filter(Boolean).join(' · ')}</small>
              <small>{p.expectedQty != null ? tr('should give {n} {unit}', { n: num(p.expectedQty), unit: p.unit }) : ''}{' · '}{tr('cut every {n} months', { n: p.cycleMonths })}{p.lat != null ? ' · 📍 ' + p.lat + ', ' + p.lng : ''}</small>
              {f.canEdit && <div className="ogr-plot-acts"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setDlg({ k: 'plot', plot: p })}>✏️ {tr('Edit')}</button>{p.active && <button type="button" className="btn btn-secondary btn-sm" onClick={() => cut(p)}>✂️ {tr('Cut today')}</button>}</div>}
            </div>
          ))}</div>}
        </div>
        <div className="x7-sec"><h3>🚚 {tr('Deliveries')}</h3>
          {!f.deliveries.length ? <p className="x7-muted">{tr('Nothing delivered yet.')}</p> : <div className="x7-list">{f.deliveries.slice(0, 12).map((b) => (
            <div key={b.id} className={'x7-row ogr-del' + (!b.paid && b.value > 0 ? ' is-flag' : '')}>
              <span className="x7-icon" aria-hidden="true">🎋</span>
              <span className="x7-who"><b>{b.batchNo} · {num(b.qty)} {b.unit}</b><small>{dayText(b.day)} · {b.species}{b.grade ? ' · ' + tr('grade {g}', { g: b.grade }) : ''}</small></span>
              <span className="x7-money">{money(b.value)}</span>
              {b.paid ? <span className="x7-pill is-good">✅ {tr('Paid')}</span> : f.canPay && b.value > 0 ? <button type="button" className="btn btn-primary btn-sm" onClick={() => setDlg({ k: 'pay', batch: { ...b, farmer: { id: f.id, name: f.name, momoNumber: f.momoNumber, advanceLeft: f.advanceLeft } } })}>📲 {tr('Pay')}</button> : <span className="x7-pill is-warn">{b.value > 0 ? tr('To pay') : tr('No value yet')}</span>}
            </div>
          ))}</div>}
        </div>
        {(f.payments.length > 0 || f.advances.length > 0) && (
          <div className="x7-grid2 ogr-money">
            <div className="x7-sec"><h3>📲 {tr('Paid')}</h3>{!f.payments.length ? <p className="x7-muted">{tr('Nothing paid yet.')}</p> : <ul className="ogr-ledger">{f.payments.map((p) => <li key={p.id}><b>{money(p.paid)}</b><span>{METHOD[p.method][0]} {p.batchNo || ''}{p.advanceTaken ? ' · ' + tr('{v} off the advance', { v: money(p.advanceTaken) }) : ''}</span><small>{dayText(p.day)}{p.reference ? ' · ' + p.reference : ''}{p.texted ? ' · 💬' : ''}</small></li>)}</ul>}</div>
            <div className="x7-sec"><h3>🤝 {tr('Advances')}</h3>{!f.advances.length ? <p className="x7-muted">{tr('None.')}</p> : <ul className="ogr-ledger">{f.advances.map((a) => <li key={a.id}><b>{money(a.amount)}</b><span>{METHOD[a.method][0]} {a.note || tr(METHOD[a.method][1])}</span><small>{dayText(a.day)}{a.reference ? ' · ' + a.reference : ''}</small></li>)}</ul>}</div>
          </div>
        )}
        {(f.canEdit || f.canPay || f.canTakeIn) && (
          <div className="x7-actions">
            {f.canEdit && <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'farmer' })}>✏️ {tr('Edit')}</button>}
            {f.canEdit && <button type="button" className="btn btn-secondary is-end" onClick={() => setDlg({ k: 'plot' })}>🎋 {tr('A plot')}</button>}
            {f.canPay && <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'advance' })}>🤝 {tr('Advance')}</button>}
            {f.canTakeIn && <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'delivery' })}>🚚 {tr('A delivery in')}</button>}
            {unpaid.length > 0 && f.canPay && !f.canTakeIn && <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'pay', batch: { ...unpaid[0], farmer: { id: f.id, name: f.name, momoNumber: f.momoNumber, advanceLeft: f.advanceLeft } } })}>📲 {tr('Pay')}</button>}
          </div>
        )}
        {dlg && dlg.k === 'farmer' && <FarmerDialog d={d} farmer={f} onClose={() => setDlg(null)} onDone={done} />}
        {dlg && dlg.k === 'plot' && <PlotDialog farmer={f} plot={dlg.plot} units={d.units} onClose={() => setDlg(null)} onDone={done} />}
        {dlg && dlg.k === 'advance' && <AdvanceDialog farmer={f} d={d} onClose={() => setDlg(null)} onDone={done} />}
        {dlg && dlg.k === 'delivery' && <DeliveryDialog d={d} farmer={f} onClose={() => setDlg(null)} onDone={done} />}
        {dlg && dlg.k === 'pay' && <PayDialog d={d} batch={dlg.batch} onClose={() => setDlg(null)} onDone={done} />}
      </div>
    </div>
  );
}

export default function OutgrowersPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => api.get('/outgrowers').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const open = params.get('farmer');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const shown = d.farmers.filter((f) => !q || (f.name + ' ' + f.town + ' ' + f.region).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🎋 {tr('Bamboo outgrowers')}</h1>
          <p>{tr('The farmers who grow bamboo for us: their plots and the harvests coming, money advanced, each delivery paid by Mobile Money with the advance taken off, and how each has done.')}</p>
        </div>
        <div className="x7-head-actions">
          {d.canEdit && <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'farmer' })}>👩🏾‍🌾 {tr('A farmer')}</button>}
          {d.canTakeIn && d.farmers.length > 0 && <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'delivery' })}>🚚 {tr('A delivery in')}</button>}
        </div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-good"><small>👩🏾‍🌾 {tr('Farmers')}</small><b>{s.farmers}</b><span>{tr('{n} plots · {h} ha', { n: s.plots, h: num(s.hectares) })}</span></div>
        <div className="x7-tile is-teal"><small>✂️ {tr('Coming in 90 days')}</small><b>{num(s.soonQty)}</b><span>{d.forecast.unit}</span></div>
        <div className={'x7-tile ' + (s.overdue ? 'is-warn' : 'is-good')}><small>⏰ {tr('Harvests overdue')}</small><b>{s.overdue}</b><span>{tr('two weeks past and not in')}</span></div>
        <div className={'x7-tile ' + (s.advanceLeft > 0 ? 'is-violet' : 'is-calm')}><small>🤝 {tr('Advances out')}</small><b>{money(s.advanceLeft)}</b><span>{tr('to come off deliveries')}</span></div>
        <div className={'x7-tile ' + (s.toPay ? 'is-bad' : 'is-good')}><small>💸 {tr('To pay')}</small><b>{money(s.owed)}</b><span>{s.toPay === 1 ? tr('1 delivery') : tr('{n} deliveries', { n: s.toPay })}</span></div>
        <div className="x7-tile is-calm"><small>📲 {tr('Paid this month')}</small><b>{money(s.paidMonth)}</b><span>{s.momoShare != null ? tr('{n}% by Mobile Money', { n: s.momoShare }) : tr('nothing yet')}</span></div>
      </div>
      <div className="x7-grid2 ogr-top">
        <section className="x7-card"><h2>📈 {tr('Harvests expected')} <small>{tr('six months, in {unit}', { unit: d.forecast.unit })}</small></h2><Forecast f={d.forecast} /></section>
        <section className="x7-card"><h2>💸 {tr('Deliveries to pay')} <small>{d.toPay.length}</small></h2>
          {!d.toPay.length ? <p className="x7-muted">✅ {tr('Every delivery is paid.')}</p> : <div className="x7-list">{d.toPay.slice(0, 6).map((b) => (
            <div key={b.id} className="x7-row ogr-del is-flag">
              <span className="x7-avatar" style={{ '--h': hue(b.farmer.name) }} aria-hidden="true">{initials(b.farmer.name)}</span>
              <span className="x7-who"><b>{b.farmer.name}</b><small>{b.batchNo} · {num(b.qty)} {b.unit} · {dayText(b.day)}</small></span>
              <span className="x7-money">{money(b.value)}</span>
              {d.canPay ? <button type="button" className="btn btn-primary btn-sm" onClick={() => setDlg({ k: 'pay', batch: b })}>📲 {tr('Pay')}</button> : <span />}
            </div>
          ))}</div>}
        </section>
      </div>
      {d.overdue.length > 0 && <div className="x7-flash is-warn" role="status">⏰ {tr('Harvests overdue: {list}', { list: d.overdue.map((p) => p.farmer + ' — ' + p.name).join(', ') })}</div>}
      <div className="ogr-bar-top"><h2>👩🏾‍🌾 {tr('The farmers')}</h2><input className="input ogr-search" data-type-to-search value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a farmer')} aria-label={tr('Find a farmer')} /></div>
      {!d.farmers.length ? <div className="x7-empty"><span aria-hidden="true">🎋</span><p>{tr('No outgrower yet: add the first farmer.')}</p></div> : (
        <div className="ogr-grid">{shown.map((f) => (
          <button key={f.id} type="button" className={'ogr-card' + (f.active ? '' : ' is-off') + (f.owed > 0 ? ' is-owed' : '')} onClick={() => setParams({ farmer: f.id })}>
            <span className="ogr-card-top">
              <span className="x7-avatar" style={{ '--h': hue(f.name) }} aria-hidden="true">{initials(f.name)}</span>
              <span className="x7-who"><b>{f.name}</b><small>{[f.town, f.region].filter(Boolean).join(' · ') || '—'}</small></span>
              {f.grade ? <span className={'ogr-grade ' + GRADE[f.grade]} title={tr('Scorecard {n} out of 100', { n: f.score })}>{f.grade}</span> : <span className="ogr-grade" title={tr('Not graded yet')}>·</span>}
            </span>
            <span className="ogr-card-mid">
              <span><small>{tr('Plots')}</small><b>{f.plots}</b><em>{num(f.hectares)} ha</em></span>
              <span><small>{tr('Next harvest')}</small><b className={f.overdue ? 'is-bad' : ''}>{f.nextHarvest ? dayText(f.nextHarvest) : '—'}</b><em>{f.soonQty ? '+' + num(f.soonQty) : ''}</em></span>
              <span><small>{tr('This year')}</small><b>{num(f.deliveredYear)}</b><em>{money(f.paidYear)}</em></span>
            </span>
            <span className="ogr-card-foot">
              {f.momoNumber ? <span>📱 {f.momoNumber}</span> : <span className="is-warn">📱 {tr('No Mobile Money number')}</span>}
              {f.owed > 0 ? <span className="x7-pill is-bad">💸 {money(f.owed)}</span> : f.advanceLeft > 0 ? <span className="x7-pill is-violet">🤝 {money(f.advanceLeft)}</span> : <span className="x7-pill is-good">✅ {tr('Square')}</span>}
            </span>
          </button>
        ))}</div>
      )}
      {d.payments.length > 0 && (
        <section className="x7-card"><h2>📲 {tr('Paid lately')}</h2>
          <ul className="ogr-ledger">{d.payments.map((p) => <li key={p.id}><b>{money(p.paid)}</b><span>{p.farmer} · {METHOD[p.method][0]} {p.batchNo || ''}{p.advanceTaken ? ' · ' + tr('{v} off the advance', { v: money(p.advanceTaken) }) : ''}</span><small>{dayText(p.day)}{p.reference ? ' · ' + p.reference : ''}{p.by ? ' · ' + p.by : ''}</small></li>)}</ul>
        </section>
      )}
      {dlg && dlg.k === 'farmer' && <FarmerDialog d={d} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); load(); setParams({ farmer: x.id }); }} />}
      {dlg && dlg.k === 'delivery' && <DeliveryDialog d={d} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); load(); setParams({ farmer: x.id }); }} />}
      {dlg && dlg.k === 'pay' && <PayDialog d={d} batch={dlg.batch} onClose={() => setDlg(null)} onDone={() => { setDlg(null); load(); }} />}
      {open && <FarmerSheet key={open} id={open} d={d} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
