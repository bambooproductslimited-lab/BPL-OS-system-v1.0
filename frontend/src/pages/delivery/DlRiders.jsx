import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';
import { ContactLinks } from './DlCards';
import { VEHICLES, vehicleEmoji, vehicleName } from './dlShared';

// The restaurant's riders, on the delivery screen: who is free and who is
// out with which delivery; added, changed, off for now, or removed. Someone
// typed in when sending can be kept here too (DlDialogs SendDialog).
const EMPTY = { name: '', phone: '', vehicle: 'motorbike', plate: '', active: true };

export default function RidersPanel({ token, riders, onChanged, onError }) {
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  async function call(body) {
    setBusy(true);
    try { await posFetch('POST', '/pos/delivery/riders', token, body); await onChanged(); return true; } catch (e) { onError(e.message); return false; } finally { setBusy(false); }
  }
  async function save(e) {
    e.preventDefault();
    if (await call({ action: 'save', rider: form })) setForm(null);
  }
  const working = riders.filter((r) => r.active);
  const free = working.filter((r) => !r.busy).length;
  return (
    <div className="dl-riders">
      <div className="dl-riders-head">
        <div><strong>{tr('Our riders')}</strong><small>{tr('{free} free · {out} out · {off} off', { free, out: working.length - free, off: riders.length - working.length })}</small></div>
        {!form && <button type="button" className="btn dl-go" onClick={() => setForm({ ...EMPTY })}>＋ {tr('Add a rider')}</button>}
      </div>
      {form && (
        <form className="dl-card is-form" onSubmit={save}>
          <strong>{form.id ? tr('Change {name}', { name: form.name }) : tr('A new rider')}</strong>
          <div className="dl-form">
            <label><span>{tr('Name')}</span><input className="input" required autoFocus value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label><span>{tr('Phone')}</span><input className="input" required type="tel" inputMode="tel" value={form.phone} maxLength={40} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <div className="dl-form-wide">
              <span className="dl-form-label">{tr('Vehicle')}</span>
              <div className="dl-chips">{VEHICLES.map((v) => <button key={v} type="button" className={form.vehicle === v ? 'is-on' : ''} onClick={() => setForm({ ...form, vehicle: v })}>{vehicleEmoji(v)} {vehicleName(v)}</button>)}</div>
            </div>
            <label><span>{tr('Number plate')}</span><input className="input" value={form.plate} maxLength={20} onChange={(e) => setForm({ ...form, plate: e.target.value })} placeholder={tr('Optional')} /></label>
            <label className="dl-check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /><span>{tr('Working now')}</span></label>
          </div>
          <div className="dialog-actions">
            {form.id && <button type="button" className="pos-link is-bad" disabled={busy} onClick={async () => { if (window.confirm(tr('Remove {name} from the riders?', { name: form.name })) && await call({ action: 'remove', id: form.id })) setForm(null); }}>{tr('Remove')}</button>}
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>{tr('Cancel')}</button>
            <button type="submit" className="btn dl-go" disabled={busy}>{tr('Save')}</button>
          </div>
        </form>
      )}
      {!riders.length && !form && <div className="dl-empty"><span aria-hidden="true">🛵</span><strong>{tr('No riders yet')}</strong><p>{tr('Add the people who deliver for you. Anyone else can still be typed in when an order goes out.')}</p></div>}
      {riders.map((r) => (
        <article key={r.id} className={'dl-card dl-rider-card' + (r.active ? '' : ' is-off') + (r.busy ? ' is-busy' : '')}>
          <span className="dl-rider-face" aria-hidden="true">{vehicleEmoji(r.vehicle)}</span>
          <span className="dl-rider-text">
            <strong>{r.name}</strong>
            <small>{vehicleName(r.vehicle)}{r.plate ? ' · ' + r.plate : ''} · {r.phone}</small>
          </span>
          <span className={'dl-rider-state' + (!r.active ? ' is-off' : r.busy ? ' is-busy' : ' is-free')}>
            {!r.active ? tr('Off') : r.busy ? tr('Out: {refs}', { refs: r.busy.map((b) => 'D-' + String(b.number).padStart(3, '0')).join(', ') }) : tr('Free')}
          </span>
          <ContactLinks phone={r.phone} />
          <button type="button" className="pos-link" onClick={() => setForm({ id: r.id, name: r.name, phone: r.phone, vehicle: r.vehicle, plate: r.plate, active: r.active })}>{tr('Change')}</button>
        </article>
      ))}
    </div>
  );
}
