import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { shrinkPhoto } from './till/photoShrink';
import './VehiclesPage.css';

// Vehicles and fuel (Operations → Vehicles and fuel; backend
// vehicles.service.js, migration 0197): each company's vans, trucks and
// motorbikes with their driver, the fuel bought for them (a photo of the
// receipt from the pump), what that comes to a km, when the insurance and
// roadworthy run out and when the next service is due. A driver logs fuel
// for their own from their phone (My space links here).

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function km(n) { return n == null ? '—' : Number(n).toLocaleString(activeIntlLocale()) + ' km'; }
function today() { return new Date().toISOString().slice(0, 10); }
const KIND = { van: ['🚐', msg('Van')], truck: ['🚚', msg('Truck')], pickup: ['🛻', msg('Pickup')], car: ['🚗', msg('Car')], motorbike: ['🏍️', msg('Motorbike')], tricycle: ['🛺', msg('Tricycle')], other: ['🚙', msg('Other')] };
const FUEL = { petrol: msg('Petrol'), diesel: msg('Diesel'), gas: msg('Gas'), electric: msg('Electric') };
const PAID = { cash: ['💵', msg('Cash')], mobile_money: ['📱', msg('Mobile Money')], card: ['💳', msg('Card')], fuel_card: ['⛽', msg('Fuel card')], account: ['🧾', msg('On account')] };
const PAPER = { insurance: ['🛡️', msg('Insurance')], roadworthy: ['📋', msg('Roadworthy')] };
function paperText(p) {
  if (p.state === 'missing') return tr('not on record');
  if (p.state === 'expired') return p.daysLeft === -1 ? tr('ran out yesterday') : tr('ran out {n} days ago', { n: -p.daysLeft });
  if (p.daysLeft === 0) return tr('runs out today');
  return p.state === 'soon' ? tr('{n} days left', { n: p.daysLeft }) : tr('until {date}', { date: dayText(p.until, { year: 'numeric' }) });
}
function serviceText(v) {
  if (v.serviceIn == null) return null;
  return v.serviceIn <= 0 ? tr('Service due — {n} past', { n: km(-v.serviceIn) }) : tr('Service in {n}', { n: km(v.serviceIn) });
}

function Papers({ v }) {
  return (
    <span className="veh-papers">
      {v.papers.map((p) => <span key={p.key} className={'veh-paper is-' + p.state}><em aria-hidden="true">{p.state === 'expired' ? '⛔' : p.state === 'soon' ? '⏳' : PAPER[p.key][0]}</em>{tr(PAPER[p.key][1])}: {paperText(p)}</span>)}
    </span>
  );
}

function ReceiptPhoto({ id, onClose }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let made = null, live = true;
    fetch(API_URL + '/vehicles/fuel/' + id + '/photo', { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return <div className="veh-zoom" onClick={onClose} role="dialog" aria-label={tr('Receipt')}>{url ? <img src={url} alt={tr('Fuel receipt')} /> : <p>{tr('Loading…')}</p>}</div>;
}

function FuelForm({ v, onDone, onCancel }) {
  const [f, setF] = useState({ day: today(), litres: '', amount: '', odometer: '', fullTank: true, station: '', paidWith: 'cash', note: '', photo: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const per = Number(f.litres) > 0 && Number(f.amount) > 0 ? Number(f.amount) / Number(f.litres) : null;
  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { setF((x) => ({ ...x, photo: null })); const p = await shrinkPhoto(file); setF((x) => ({ ...x, photo: p })); } catch { setError(tr('That file is not a photo.')); }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/vehicles/' + v.id + '/fuel', { ...f, litres: Number(f.litres), amount: Number(f.amount) })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="veh-form" onSubmit={save}>
      <h3>⛽ {tr('Log fuel for {name}', { name: v.name })}</h3>
      <div className="veh-grid3">
        <label><span>{tr('Litres')}</span><input className="input veh-big" type="number" inputMode="decimal" min="0.1" step="0.01" required value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} autoFocus /></label>
        <label><span>{tr('Paid (GHS)')}</span><input className="input veh-big" type="number" inputMode="decimal" min="0.1" step="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label><span>{tr('Odometer (km)')}</span><input className="input veh-big" type="number" inputMode="numeric" min="0" value={f.odometer} onChange={(e) => setF({ ...f, odometer: e.target.value })} placeholder={v.odometer != null ? String(v.odometer) : ''} /></label>
      </div>
      {per != null && <p className="veh-per">{tr('{amount} a litre', { amount: money(per, 'GHS') })}</p>}
      <div className="veh-chips" role="group" aria-label={tr('Paid with')}>
        {Object.entries(PAID).map(([k, [ic, l]]) => <button key={k} type="button" className={f.paidWith === k ? 'is-on' : ''} onClick={() => setF({ ...f, paidWith: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}
      </div>
      <div className="veh-grid3">
        <label><span>{tr('Day')}</span><input className="input" type="date" max={today()} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>
        <label><span>{tr('Station')}</span><input className="input" value={f.station} onChange={(e) => setF({ ...f, station: e.target.value })} placeholder={tr('Optional')} /></label>
        <label className="veh-check"><input type="checkbox" checked={f.fullTank} onChange={(e) => setF({ ...f, fullTank: e.target.checked })} /><span>{tr('Filled the tank')}<small>{tr('For km per litre.')}</small></span></label>
      </div>
      <label className={'veh-drop' + (f.photo ? ' is-set' : '')}>
        <input type="file" accept="image/*" capture="environment" onChange={pick} />
        <em aria-hidden="true">{f.photo ? '✅' : '📸'}</em><span>{f.photo ? tr('Receipt photo added — tap to change') : tr('Photo of the receipt')}</span>
      </label>
      <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('Optional')} /></label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
    </form>
  );
}

function VehicleForm({ meta, v, onDone, onCancel }) {
  const [f, setF] = useState(v ? {
    id: v.id, companyId: v.companyId, name: v.name, plate: v.plate, kind: v.kind, fuel: v.fuel, driverId: v.driver ? v.driver.id : '', odometer: v.odometer == null ? '' : String(v.odometer),
    insuranceUntil: v.insuranceUntil || '', roadworthyUntil: v.roadworthyUntil || '', serviceEveryKm: v.serviceEveryKm == null ? '' : String(v.serviceEveryKm), lastServiceKm: v.lastServiceKm == null ? '' : String(v.lastServiceKm), notes: v.notes || '', active: v.active
  } : { companyId: (meta.companies[0] || {}).id || '', name: '', plate: '', kind: 'van', fuel: 'diesel', driverId: '', odometer: '', insuranceUntil: '', roadworthyUntil: '', serviceEveryKm: '5000', lastServiceKm: '', notes: '', active: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/vehicles', { ...f, driverId: f.driverId || null })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="veh-form" onSubmit={save}>
      <h3>{v ? '✏️ ' + tr('Change {name}', { name: v.name }) : '🚐 ' + tr('Add a vehicle')}</h3>
      <div className="veh-chips" role="group" aria-label={tr('Company')}>
        {meta.companies.map((c) => <button key={c.id} type="button" className={f.companyId === c.id ? 'is-on' : ''} onClick={() => setF({ ...f, companyId: c.id })}>{c.name}</button>)}
      </div>
      <div className="veh-chips" role="group" aria-label={tr('Kind')}>
        {meta.kinds.map((k) => <button key={k} type="button" className={f.kind === k ? 'is-on' : ''} onClick={() => setF({ ...f, kind: k })}><em aria-hidden="true">{KIND[k][0]}</em>{tr(KIND[k][1])}</button>)}
      </div>
      <div className="veh-grid3">
        <label><span>{tr('Name')}</span><input className="input" required value={f.name} onChange={set('name')} placeholder={tr('e.g. The white van')} /></label>
        <label><span>{tr('Number plate')}</span><input className="input veh-plate-in" value={f.plate} onChange={set('plate')} placeholder="GR 1234-24" /></label>
        <label><span>{tr('Fuel')}</span><select className="input" value={f.fuel} onChange={set('fuel')}>{meta.fuels.map((k) => <option key={k} value={k}>{tr(FUEL[k])}</option>)}</select></label>
        <label><span>{tr('Driver')}</span><select className="input" value={f.driverId} onChange={set('driverId')}><option value="">{tr('No one in particular')}</option>{meta.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label><span>{tr('Insurance until')}</span><input className="input" type="date" value={f.insuranceUntil} onChange={set('insuranceUntil')} /></label>
        <label><span>{tr('Roadworthy until')}</span><input className="input" type="date" value={f.roadworthyUntil} onChange={set('roadworthyUntil')} /></label>
        <label><span>{tr('Odometer (km)')}</span><input className="input" type="number" min="0" value={f.odometer} onChange={set('odometer')} /></label>
        <label><span>{tr('Service every (km)')}</span><input className="input" type="number" min="0" value={f.serviceEveryKm} onChange={set('serviceEveryKm')} /></label>
        <label><span>{tr('Last service at (km)')}</span><input className="input" type="number" min="0" value={f.lastServiceKm} onChange={set('lastServiceKm')} /></label>
      </div>
      <label><span>{tr('Notes')}</span><input className="input" value={f.notes} onChange={set('notes')} placeholder={tr('Optional')} /></label>
      {v && <label className="veh-check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>{tr('In use')}<small>{tr('Untick when it is sold or off the road for good.')}</small></span></label>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
    </form>
  );
}

function Sheet({ id, meta, startFuel, onClose, onChanged }) {
  const [v, setV] = useState(null);
  const [mode, setMode] = useState(startFuel ? 'fuel' : '');
  const [odo, setOdo] = useState('');
  const [photo, setPhoto] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/vehicles/' + id).then(setV).catch((e) => setError(e.message)); }, [id]);
  function done(x) { setV(x); setMode(''); onChanged(); }
  async function serviced(e) {
    e.preventDefault();
    try { done(await api.post('/vehicles/' + id + '/serviced', { odometer: Number(odo) })); } catch (err) { setError(err.message); }
  }
  async function removeFill(fid) {
    try { done(await api.del('/vehicles/fuel/' + fid)); } catch (err) { setError(err.message); }
  }
  if (!v) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog veh-sheet"><p className="veh-wait">{error || tr('Loading…')}</p></div></div>;
  const maxM = Math.max(1, ...v.months.map((m) => m.amount));
  const bad = v.papers.some((p) => p.state === 'expired');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog veh-sheet" role="dialog" aria-modal="true" aria-labelledby="veh-title" onClick={(e) => e.stopPropagation()}>
        <div className={'veh-hero' + (bad ? ' is-bad' : !v.active ? ' is-off' : '')}>
          <span className="veh-emoji" aria-hidden="true">{KIND[v.kind][0]}</span>
          <div>
            <small>{v.company} · {tr(FUEL[v.fuel])}{v.driver ? ' · ' + tr('driven by {name}', { name: v.driver.name }) : ''}</small>
            <h2 id="veh-title">{v.name}</h2>
            <p>{v.plate && <span className="veh-plate">{v.plate}</span>}<span className="veh-pill">{km(v.odometer)}</span>{!v.active && <span className="veh-pill">{tr('Out of use')}</span>}</p>
          </div>
          <button type="button" className="veh-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <div className="veh-stats">
          <span><small>{tr('Km per litre')}</small><b>{v.kmPerLitre ?? '—'}</b></span>
          <span><small>{tr('Cost per km')}</small><b>{v.costPerKm != null ? money(v.costPerKm, 'GHS') : '—'}</b></span>
          <span><small>{tr('Fuel this month')}</small><b>{money(v.month.amount, 'GHS')}</b><i>{tr('{n} L', { n: v.month.litres })}</i></span>
          <span className={v.serviceIn != null && v.serviceIn <= 500 ? 'is-warn' : ''}><small>{tr('Next service')}</small><b>{v.serviceAt != null ? km(v.serviceAt) : '—'}</b>{serviceText(v) && <i>{serviceText(v)}</i>}</span>
        </div>
        <Papers v={v} />
        {v.months.length > 0 && (
          <div className="veh-months" role="img" aria-label={tr('Fuel by month') + ': ' + v.months.map((m) => monthText(m.month) + ' ' + money(m.amount, 'GHS')).join(', ')}>
            {v.months.map((m) => (
              <span key={m.month} title={monthText(m.month) + ': ' + money(m.amount, 'GHS') + ' · ' + m.litres + ' L'}>
                <b>{Math.round(m.amount).toLocaleString(activeIntlLocale())}</b>
                <i style={{ height: Math.max(4, m.amount / maxM * 70) + 'px' }} />
                <small>{monthText(m.month)}</small>
              </span>
            ))}
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {mode === 'fuel' && <FuelForm v={v} onDone={done} onCancel={() => setMode('')} />}
        {mode === 'edit' && <VehicleForm meta={meta} v={v} onDone={done} onCancel={() => setMode('')} />}
        {mode === 'service' && (
          <form className="veh-form" onSubmit={serviced}>
            <h3>🔧 {tr('Serviced')}</h3>
            <label><span>{tr('At how many km?')}</span><input className="input veh-big" type="number" min="0" required value={odo} onChange={(e) => setOdo(e.target.value)} placeholder={v.odometer != null ? String(v.odometer) : ''} autoFocus /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary">{tr('Save')}</button></div>
          </form>
        )}
        {!mode && (
          <div className="veh-actions">
            {v.active && <button type="button" className="btn btn-primary" onClick={() => setMode('fuel')}>⛽ {tr('Log fuel')}</button>}
            {v.canManage && <button type="button" className="btn btn-secondary" onClick={() => { setOdo(v.odometer != null ? String(v.odometer) : ''); setMode('service'); }}>🔧 {tr('Serviced')}</button>}
            {v.canManage && <button type="button" className="btn btn-secondary" onClick={() => setMode('edit')}>✏️ {tr('Change')}</button>}
          </div>
        )}
        <div className="veh-fills">
          <h3>{tr('Fill-ups')}</h3>
          {!v.fills.length && <p className="veh-none">{tr('No fuel logged yet.')}</p>}
          {v.fills.map((x) => (
            <div key={x.id} className="veh-fill">
              <span className="veh-fill-day"><b>{dayText(x.day)}</b><small>{PAID[x.paidWith][0]} {tr(PAID[x.paidWith][1])}</small></span>
              <span className="veh-fill-main"><b>{tr('{n} L', { n: x.litres })} · {money(x.amount, 'GHS')}</b><small>{[tr('{amount}/L', { amount: money(x.perLitre, 'GHS') }), x.odometer != null ? km(x.odometer) : null, x.km != null ? '+' + km(x.km) : null, x.station, x.by, !x.fullTank ? tr('part fill') : null].filter(Boolean).join(' · ')}</small></span>
              {x.kmPerLitre != null ? <span className="veh-kmpl">{x.kmPerLitre}<small>{tr('km/L')}</small></span> : <span />}
              <span className="veh-fill-tools">
                {x.hasPhoto && <button type="button" onClick={() => setPhoto(x.id)} aria-label={tr('See the receipt')}>🧾</button>}
                {v.canManage && <button type="button" onClick={() => removeFill(x.id)} aria-label={tr('Remove this entry')}>✕</button>}
              </span>
            </div>
          ))}
        </div>
        {photo && <ReceiptPhoto id={photo} onClose={() => setPhoto(null)} />}
      </div>
    </div>
  );
}

export default function VehiclesPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [retired, setRetired] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api.get('/vehicles' + (retired ? '?retired=1' : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [retired]);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('vehicle');
  const open = (id) => setParams((p) => { const n = new URLSearchParams(p); n.delete('fuel'); if (id) n.set('vehicle', id); else n.delete('vehicle'); return n; });
  if (!d) return <div className="veh"><p className="veh-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const all = d.canManage || d.companies.length > 0;
  return (
    <div className="veh">
      <header className="veh-head">
        <div>
          <h1>🚚 {all ? tr('Vehicles and fuel') : tr('My vehicles')}</h1>
          <p>{all ? tr('Every van, truck and motorbike: fuel bought, what it comes to a km, papers and services.') : tr('Log fuel for the vehicles you drive: litres, what you paid, and a photo of the receipt.')}</p>
        </div>
        {d.canManage && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>➕ {tr('Add a vehicle')}</button>}
      </header>
      {all && (
        <div className="veh-tiles">
          <div className="veh-tile is-calm"><small>🚐 {tr('In use')}</small><b>{s.vehicles}</b><span>{tr('vehicles')}</span></div>
          <div className="veh-tile is-violet"><small>⛽ {tr('Fuel this month')}</small><b>{money(s.monthAmount, 'GHS')}</b><span>{tr('{n} L', { n: s.monthLitres })}</span></div>
          <div className="veh-tile is-teal"><small>📏 {tr('Cost per km')}</small><b>{s.costPerKm != null ? money(s.costPerKm, 'GHS') : '—'}</b><span>{tr('average, full tank to full tank')}</span></div>
          <div className={'veh-tile ' + (s.papersExpired ? 'is-bad' : 'is-warn')}><small>{s.papersExpired ? '⛔' : '⏳'} {tr('Papers to renew')}</small><b>{s.papersSoon}</b><span>{s.papersExpired ? tr('{n} ran out', { n: s.papersExpired }) : tr('in the next 30 days')}</span></div>
          <div className="veh-tile is-warn"><small>🔧 {tr('Service due')}</small><b>{s.serviceDue}</b><span>{tr('within 500 km')}</span></div>
        </div>
      )}
      {all && <label className="veh-retired"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} /> {tr('Show vehicles out of use')}</label>}
      {!d.vehicles.length ? <div className="veh-empty"><span aria-hidden="true">🛣️</span><p>{all ? tr('No vehicles yet. Add the first one.') : tr('No vehicle is yours to drive.')}</p></div> : (
        <div className="veh-cards">
          {d.vehicles.map((v, i) => {
            const bad = v.papers.some((p) => p.state === 'expired'), soon = v.papers.some((p) => p.state === 'soon');
            return (
              <div key={v.id} className={'veh-card' + (bad ? ' is-bad' : soon ? ' is-soon' : '') + (!v.active ? ' is-off' : '')} style={{ animationDelay: Math.min(i, 8) * 0.04 + 's' }}>
                <button type="button" className="veh-card-open" onClick={() => open(v.id)} aria-label={tr('Open {name}', { name: v.name })} />
                <div className="veh-card-top">
                  <span className="veh-emoji" aria-hidden="true">{KIND[v.kind][0]}</span>
                  <span className="veh-card-name"><b>{v.name}</b><small>{v.company}{v.driver ? ' · ' + v.driver.name : ''}</small></span>
                  {v.plate && <span className="veh-plate">{v.plate}</span>}
                </div>
                <div className="veh-card-stats">
                  <span><b>{v.kmPerLitre ?? '—'}</b><small>{tr('km/L')}</small></span>
                  <span><b>{v.costPerKm != null ? v.costPerKm.toFixed(2) : '—'}</b><small>{tr('GHS/km')}</small></span>
                  <span><b>{Math.round(v.month.amount).toLocaleString(activeIntlLocale())}</b><small>{tr('GHS this month')}</small></span>
                </div>
                <Papers v={v} />
                <div className="veh-card-foot">
                  <span className={v.serviceIn != null && v.serviceIn <= 500 ? 'is-warn' : ''}>🔧 {serviceText(v) || tr('No service plan')}</span>
                  {v.active && (d.canManage || d.mine.includes(v.id)) && <button type="button" className="veh-fuel-btn" onClick={() => setParams({ vehicle: v.id, fuel: '1' })}>⛽ {tr('Log fuel')}</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {openId && <Sheet key={openId} id={openId} meta={d} startFuel={params.get('fuel') === '1'} onClose={() => open(null)} onChanged={load} />}
      {adding && (
        <div className="dialog-backdrop" onClick={() => setAdding(false)}>
          <div className="dialog veh-sheet is-form" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <VehicleForm meta={d} onDone={(v) => { setAdding(false); load(); open(v.id); }} onCancel={() => setAdding(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

// My space: the vehicles you drive, one tap from logging fuel.
export function MyVehiclesCard() {
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/vehicles').then((x) => setList(x.vehicles.filter((v) => x.mine.includes(v.id)))).catch(() => setList([])); }, []);
  if (!list.length) return null;
  return (
    <div className="msx-card veh-mine">
      <h4 className="msp-h4">🚚 {tr('My vehicles')}</h4>
      {list.map((v) => (
        <div key={v.id} className="veh-mine-row">
          <span className="veh-emoji" aria-hidden="true">{KIND[v.kind][0]}</span>
          <span className="veh-mine-main"><b>{v.name}</b><small>{v.plate}{v.lastFill ? ' · ' + tr('last fuel {date}', { date: dayText(v.lastFill.day) }) : ''}</small>
            {v.papers.some((p) => p.state !== 'ok') && <Papers v={{ papers: v.papers.filter((p) => p.state !== 'ok') }} />}</span>
          <Link className="veh-fuel-btn" to={'/vehicles?vehicle=' + v.id + '&fuel=1'}>⛽ {tr('Log fuel')}</Link>
        </div>
      ))}
    </div>
  );
}
