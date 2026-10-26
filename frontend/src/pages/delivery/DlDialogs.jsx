import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import DeliveryMap from './DeliveryMap';
import { VEHICLES, kmText, minText, payName, vehicleEmoji, vehicleName, waLink } from './dlShared';
import './delivery.css';

// Sending an order out (the delivery screen's "Send with a rider", and the
// till's prompt when a delivery's food is ready: RestaurantPosPage.jsx):
// one of the restaurant's riders, or someone whose name and phone are typed;
// what they collect at the door; a pin if the order has none. Then the
// rider's link, to send them on WhatsApp. reassign: a delivery handed to
// another rider instead (backend restaurantDelivery send / reassign).
export function SendDialog({ token, target, reassign, riders: given, settings, onClose, onDone }) {
  const [riders, setRiders] = useState(given || null);
  const [riderId, setRiderId] = useState(null);
  const [other, setOther] = useState(false);
  const [rider, setRider] = useState({ name: '', phone: '', vehicle: 'motorbike', plate: '' });
  const [keep, setKeep] = useState(true);
  const [collect, setCollect] = useState(target ? String(target.paid ? 0 : target.total) : '0');
  const [method, setMethod] = useState((target && target.payMethod) || 'cash');
  const [pin, setPin] = useState(null);
  const [landmark, setLandmark] = useState((target && target.customer.landmark) || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (given) return undefined;
    let live = true;
    posFetch('POST', '/pos/delivery/riders', token, {}).then((r) => { if (live) setRiders(r.riders); }).catch(() => { if (live) setRiders([]); });
    return () => { live = false; };
  }, [given, token]);
  const working = (riders || []).filter((r) => r.active);
  useEffect(() => { if (riders && !working.length) setOther(true); }, [riders]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsPin = target && target.fulfillment === 'delivery' && target.customer.lat == null;
  const here = settings && settings.location;

  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      let who = riderId && !other ? { riderId } : { rider };
      if (other && keep) {
        const saved = await posFetch('POST', '/pos/delivery/riders', token, { action: 'save', rider });
        const r = saved.riders.find((x) => x.name === rider.name.trim() && x.phone === rider.phone.trim());
        if (r) who = { riderId: r.id };
      }
      const res = reassign
        ? await posFetch('POST', '/pos/delivery/' + reassign.id + '/rider', token, who)
        : await posFetch('POST', '/pos/delivery/send', token, {
          ...(target.tabId ? { tabId: target.tabId } : { orderId: target.orderId }), ...who,
          collect: Number(collect) || 0, collectMethod: method, ...(pin ? { lat: pin.lat, lng: pin.lng } : {}), landmark
        });
      setSent(res.delivery);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (sent) {
    const text = tr('Delivery {ref} for {name}. Open your delivery: {link}', { ref: sent.ref, name: sent.customer.name, link: sent.riderLink || '' });
    return (
      <div className="dialog-backdrop dl-over" onClick={() => onDone(sent)}>
        <div className="dialog dl-send is-sent" role="dialog" aria-modal="true" aria-labelledby="dl-sent-title" onClick={(e) => e.stopPropagation()}>
          <div className="dl-sent-art" aria-hidden="true"><span>{vehicleEmoji(sent.rider.vehicle)}</span><i /><b>🏠</b></div>
          <h2 id="dl-sent-title">{tr('{ref} is with {rider}', { ref: sent.ref, rider: sent.rider.name })}</h2>
          <p className="dk-muted">{tr('Send them their link: it shows where to go, who to call and what to collect, and shares where they are so the customer can watch them come.')}</p>
          {sent.riderLink && <code className="dl-link">{sent.riderLink}</code>}
          <div className="dl-sent-go">
            {sent.riderLink && <a className="btn dl-go" href={waLink(sent.rider.phone, text)} target="_blank" rel="noopener noreferrer">💬 {tr('Send on WhatsApp')}</a>}
            {sent.riderLink && navigator.clipboard && <button type="button" className="btn btn-secondary" onClick={() => navigator.clipboard.writeText(sent.riderLink).then(() => setCopied(true)).catch(() => {})}>{copied ? tr('Copied ✓') : tr('Copy link')}</button>}
            <button type="button" className="btn btn-secondary" onClick={() => onDone(sent)}>{tr('Done')}</button>
          </div>
        </div>
      </div>
    );
  }

  const valid = (other ? rider.name.trim() && rider.phone.trim() : !!riderId) && (!target || Number(collect) >= 0);
  return (
    <div className="dialog-backdrop dl-over" onClick={() => !busy && onClose()}>
      <form className="dialog dl-send" role="dialog" aria-modal="true" aria-labelledby="dl-send-title" onClick={(e) => e.stopPropagation()} onSubmit={send}>
        <div className="dl-send-head">
          <span className="dl-send-ico" aria-hidden="true">🛵</span>
          <div>
            <h2 id="dl-send-title">{reassign ? tr('Hand {ref} to another rider', { ref: reassign.ref }) : tr('Send {name}\'s order', { name: target.customer.name || target.label })}</h2>
            <p className="dk-muted">{reassign ? tr('{name} gets a new link; the old one stops working.', { name: reassign.rider.name })
              : [target.onlineRef, target.customer.address].filter(Boolean).join(' · ')}</p>
          </div>
        </div>

        <fieldset className="dl-fs">
          <legend>{tr('Who takes it')}</legend>
          {riders === null ? <p className="dk-muted">{tr('Loading…')}</p> : (
            <div className="dl-riders-pick" role="radiogroup" aria-label={tr('Rider')}>
              {working.map((r) => (
                <button key={r.id} type="button" role="radio" aria-checked={!other && riderId === r.id} className={'dl-rider-opt' + (!other && riderId === r.id ? ' is-on' : '') + (r.busy ? ' is-busy' : '')}
                  onClick={() => { setOther(false); setRiderId(r.id); }} disabled={reassign && reassign.rider.id === r.id}>
                  <span className="dl-rider-face" aria-hidden="true">{vehicleEmoji(r.vehicle)}</span>
                  <span><strong>{r.name}</strong><small>{r.busy ? tr('out with {ref}', { ref: r.busy.map((b) => 'D-' + String(b.number).padStart(3, '0')).join(', ') }) : tr('free')}{r.plate ? ' · ' + r.plate : ''}</small></span>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={other} className={'dl-rider-opt is-other' + (other ? ' is-on' : '')} onClick={() => setOther(true)}>
                <span className="dl-rider-face" aria-hidden="true">＋</span><span><strong>{tr('Someone else')}</strong><small>{tr('Type their name and phone')}</small></span>
              </button>
            </div>
          )}
          {other && (
            <div className="dl-form">
              <label><span>{tr('Name')}</span><input className="input" required value={rider.name} maxLength={80} onChange={(e) => setRider({ ...rider, name: e.target.value })} /></label>
              <label><span>{tr('Phone')}</span><input className="input" required type="tel" inputMode="tel" value={rider.phone} maxLength={40} onChange={(e) => setRider({ ...rider, phone: e.target.value })} /></label>
              <div className="dl-form-wide">
                <span className="dl-form-label">{tr('Vehicle')}</span>
                <div className="dl-chips">{VEHICLES.map((v) => <button key={v} type="button" className={rider.vehicle === v ? 'is-on' : ''} onClick={() => setRider({ ...rider, vehicle: v })}>{vehicleEmoji(v)} {vehicleName(v)}</button>)}</div>
              </div>
              <label><span>{tr('Number plate')}</span><input className="input" value={rider.plate} maxLength={20} onChange={(e) => setRider({ ...rider, plate: e.target.value })} placeholder={tr('Optional')} /></label>
              <label className="dl-check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /><span>{tr('Keep them in our riders')}</span></label>
            </div>
          )}
        </fieldset>

        {target && (
          <fieldset className="dl-fs">
            <legend>{tr('At the door')}</legend>
            <div className="dl-form">
              <label><span>{tr('The rider collects')}</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={collect} onChange={(e) => setCollect(e.target.value)} /></label>
              <div className="dl-form-wide">
                <span className="dl-form-label">{tr('How the customer pays')}</span>
                <div className="dl-chips">{['cash', 'mobile_money'].map((m) => <button key={m} type="button" className={method === m ? 'is-on' : ''} disabled={!(Number(collect) > 0)} onClick={() => setMethod(m)}>{payName(m)}</button>)}</div>
              </div>
              <p className="dl-hint dl-form-wide">{target.paid ? tr('Paid at the till already: nothing to collect.') : tr('The order comes to {amount}. The cashier charges it on the till when the rider is back.', { amount: money(target.total) })}</p>
              {target.fulfillment === 'delivery' && <label className="dl-form-wide"><span>{tr('Landmark, for the rider')}</span><input className="input" value={landmark} maxLength={200} onChange={(e) => setLandmark(e.target.value)} placeholder={tr('e.g. blue gate opposite the pharmacy')} /></label>}
            </div>
            {needsPin && (
              <div className="dl-pinbox">
                <p className="dl-hint">📍 {tr('This order has no pin. Tap the map where it goes, so the rider and the map can find it (optional).')}{pin && here ? ' · ' + kmText(Math.round(Math.hypot((pin.lat - here.lat) * 111, (pin.lng - here.lng) * 111) * 13) / 10) : ''}</p>
                <div className="dl-pinmap"><DeliveryMap lite markers={here ? [{ id: 'here', kind: 'restaurant', lat: here.lat, lng: here.lng, emoji: '🍽️' }] : []} fitKey="pin" pick={pin} onPick={(lat, lng) => setPin({ lat, lng })} center={here ? [here.lat, here.lng] : undefined} /></div>
              </div>
            )}
          </fieldset>
        )}

        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn dl-go" disabled={busy || !valid}>{busy ? tr('Sending…') : reassign ? tr('Hand it over') : '🛵 ' + tr('Send it out')}</button>
        </div>
      </form>
    </div>
  );
}

// The delivery settings: where the restaurant is, how much a delivery costs
// and how far it goes, delivery and pickup, how long food usually takes.
// A manager opens them (signed in, or their PIN typed).
export function SettingsDialog({ token, canSettings, onClose, onSaved }) {
  const [pinCode, setPinCode] = useState('');
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [locating, setLocating] = useState(false);
  async function open(managerPin) {
    setBusy(true); setError(null);
    try { const d = await posFetch('POST', '/pos/delivery/settings', token, { managerPin }); setData(d); setForm(JSON.parse(JSON.stringify(d.settings))); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { if (canSettings) open(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  function useHere() {
    if (!navigator.geolocation) { setError(tr('This device cannot tell where it is.')); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition((p) => { setLocating(false); set({ location: { ...(form.location || {}), lat: p.coords.latitude, lng: p.coords.longitude } }); },
      () => { setLocating(false); setError(tr('Location is off for this page. Tap the map instead.')); }, { enableHighAccuracy: true, timeout: 15000 });
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await posFetch('POST', '/pos/delivery/settings', token, { managerPin: pinCode || undefined, settings: form });
      onSaved(); onClose();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const eg = form ? Math.round(form.fee.base + form.fee.perKm * 3) : 0;
  return (
    <div className="dialog-backdrop dl-over" onClick={() => !busy && onClose()}>
      <div className="dialog dl-send dl-settings" role="dialog" aria-modal="true" aria-labelledby="dl-set-title" onClick={(e) => e.stopPropagation()}>
        <div className="dl-send-head">
          <span className="dl-send-ico is-key" aria-hidden="true">⚙️</span>
          <div><h2 id="dl-set-title">{tr('Delivery settings')}</h2><p className="dk-muted">{data ? tr('Opened by {name}', { name: data.managerName }) : tr('A manager opens these: where the restaurant is, the delivery fee, how far it delivers.')}</p></div>
        </div>
        {!form ? (
          <form className="dl-pinask" onSubmit={(e) => { e.preventDefault(); open(pinCode); }}>
            {canSettings ? <p className="dk-muted">{busy ? tr('Opening…') : ''}</p> : <>
              <label><span>{tr('Manager\'s PIN')}</span><input className="input ts-pin" type="password" inputMode="numeric" autoFocus maxLength={4} value={pinCode} onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))} /></label>
              <button type="submit" className="btn dl-go" disabled={busy || pinCode.length !== 4}>{tr('Open')}</button>
            </>}
            {error && <div className="error-banner">{error}</div>}
          </form>
        ) : (
          <form onSubmit={save} className="dl-set-form">
            <fieldset className="dl-fs">
              <legend>{tr('Where the restaurant is')}</legend>
              <p className="dl-hint">{tr('Tap the map on the restaurant\'s door, or use this device\'s location while you are there. Distances and fees are counted from here.')}</p>
              <div className="dl-pinmap is-tall">
                <DeliveryMap lite markers={[]} fitKey={form.location ? 'loc' : 'none'} pick={form.location} onPick={(lat, lng) => set({ location: { ...(form.location || {}), lat, lng } })}
                  center={form.location ? [form.location.lat, form.location.lng] : undefined} zoom={form.location ? 16 : 12} />
              </div>
              <div className="dl-form">
                <button type="button" className="btn btn-secondary" onClick={useHere} disabled={locating}>📍 {locating ? tr('Finding…') : tr('Use this device\'s location')}</button>
                <label className="dl-form-wide"><span>{tr('Address')}</span><input className="input" value={(form.location && form.location.address) || ''} maxLength={200} disabled={!form.location}
                  onChange={(e) => set({ location: { ...form.location, address: e.target.value } })} placeholder={tr('e.g. Spintex Road, by the roundabout')} /></label>
                <label><span>{tr('Phone customers call')}</span><input className="input" type="tel" value={form.phone} maxLength={40} onChange={(e) => set({ phone: e.target.value })} /></label>
              </div>
            </fieldset>
            <fieldset className="dl-fs">
              <legend>{tr('What it costs, how far it goes')}</legend>
              <div className="dl-form is-3">
                <label><span>{tr('Delivery fee: start')}</span><input className="input" type="number" min="0" step="1" value={form.fee.base} onChange={(e) => set({ fee: { ...form.fee, base: Number(e.target.value) } })} /></label>
                <label><span>{tr('Plus, per km by road')}</span><input className="input" type="number" min="0" step="0.5" value={form.fee.perKm} onChange={(e) => set({ fee: { ...form.fee, perKm: Number(e.target.value) } })} /></label>
                <label><span>{tr('Free from an order of')}</span><input className="input" type="number" min="0" step="1" value={form.fee.freeOver} onChange={(e) => set({ fee: { ...form.fee, freeOver: Number(e.target.value) } })} placeholder="0" /></label>
                <label><span>{tr('Delivers up to (km)')}</span><input className="input" type="number" min="0" step="0.5" value={form.maxKm} onChange={(e) => set({ maxKm: Number(e.target.value) })} /></label>
                <label><span>{tr('Smallest order')}</span><input className="input" type="number" min="0" step="1" value={form.minOrder} onChange={(e) => set({ minOrder: Number(e.target.value) })} /></label>
                <label><span>{tr('Food is usually ready in (min)')}</span><input className="input" type="number" min="5" max="240" step="5" value={form.readyMinutes} onChange={(e) => set({ readyMinutes: Number(e.target.value) })} /></label>
              </div>
              <p className="dl-hint">{tr('e.g. a delivery 3 km away costs {amount}.', { amount: money(eg) })}{form.fee.freeOver > 0 ? ' ' + tr('Free for orders of {amount} or more.', { amount: money(form.fee.freeOver) }) : ''}</p>
            </fieldset>
            <fieldset className="dl-fs">
              <legend>{tr('On the website')}</legend>
              <div className="dl-toggles">
                {[['delivery', tr('Delivery'), tr('Customers drop a pin; a rider brings it.')], ['pickup', tr('Pickup'), tr('Customers collect it at the counter.')],
                  ['payOnline', '💳 ' + tr('Pay online when ordering'), tr('Card or Mobile Money through Paystack (turned on in Till settings → Payments). The order reaches you once it is paid; turned down, the money goes back.')]].map(([k, label, note]) => (
                  <button key={k} type="button" role="switch" aria-checked={form[k]} className={'dl-toggle' + (form[k] ? ' is-on' : '')} onClick={() => set({ [k]: !form[k] })}>
                    <span><strong>{label}</strong><small>{note}</small></span><span className={'ts-switch' + (form[k] ? ' is-on' : '')} aria-hidden="true"><i /></span>
                  </button>
                ))}
              </div>
              <label className="dl-form-wide"><span>{tr('A line for customers (hours, an offer)')}</span><input className="input" value={form.note} maxLength={200} onChange={(e) => set({ note: e.target.value })} placeholder={tr('e.g. Open every day 11:00 to 22:00')} /></label>
              {data && <p className="dl-hint">🌐 <a href={data.siteUrl} target="_blank" rel="noopener noreferrer">{data.siteUrl.replace(/^https?:\/\//, '')}</a> · {tr('Customers order there; turn it on and off at the top of this screen.')}</p>}
            </fieldset>
            <fieldset className="dl-fs">
              <legend>🗓️ {tr('Orders for later')}</legend>
              <div className="dl-toggles">
                {[['on', tr('Customers choose a day and a time'), tr('Confirmed, the order goes to the kitchen by itself in time to cook it.')],
                  ['whenClosed', tr('Also while not taking orders'), tr('Closed now, customers can still order for when you are open.')]].map(([k, label, note]) => (
                  <button key={k} type="button" role="switch" aria-checked={form.later[k]} disabled={k === 'whenClosed' && !form.later.on} className={'dl-toggle' + (form.later[k] ? ' is-on' : '')}
                    onClick={() => set({ later: { ...form.later, [k]: !form.later[k] } })}>
                    <span><strong>{label}</strong><small>{note}</small></span><span className={'ts-switch' + (form.later[k] ? ' is-on' : '')} aria-hidden="true"><i /></span>
                  </button>
                ))}
              </div>
              {form.later.on && (
                <div className="dl-form is-3">
                  <label><span>{tr('First time on offer')}</span><input className="input" type="time" step="900" value={form.later.from} onChange={(e) => set({ later: { ...form.later, from: e.target.value } })} /></label>
                  <label><span>{tr('Last time on offer')}</span><input className="input" type="time" step="900" value={form.later.to} onChange={(e) => set({ later: { ...form.later, to: e.target.value } })} /></label>
                  <label><span>{tr('Days ahead')}</span>
                    <select className="input" value={form.later.days} onChange={(e) => set({ later: { ...form.later, days: Number(e.target.value) } })}>
                      {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => <option key={n} value={n}>{n === 0 ? tr('Today only') : n === 1 ? tr('Today and tomorrow') : tr('{n} days ahead', { n })}</option>)}
                    </select></label>
                </div>
              )}
              {form.later.on && <p className="dl-hint">{tr('Every 15 minutes from {from} to {to}, at least {m} from when they order, for cooking and the ride.', { from: form.later.from, to: form.later.to, m: minText(form.readyMinutes + 35) })}</p>}
            </fieldset>
            <fieldset className="dl-fs">
              <legend>⏱ {tr('Order limits')}</legend>
              <div className="dl-toggles">
                <button type="button" role="switch" aria-checked={form.limits.on} className={'dl-toggle' + (form.limits.on ? ' is-on' : '')} onClick={() => set({ limits: { ...form.limits, on: !form.limits.on } })}>
                  <span><strong>{tr('Limit website orders')}</strong><small>{tr('No more than this many orders due in any 15 minutes: a full time is not offered, and customers are offered the next one with room.')}</small></span>
                  <span className={'ts-switch' + (form.limits.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
                </button>
              </div>
              {form.limits.on && (
                <div className="dl-form is-3 dl-limits">
                  <label><span>{tr('Orders every 15 minutes')}</span><input className="input" type="number" min="1" max="200" value={form.limits.orders} onChange={(e) => set({ limits: { ...form.limits, orders: e.target.value } })} /></label>
                  <label><span>{tr('Dishes every 15 minutes (0: no limit)')}</span><input className="input" type="number" min="0" max="2000" value={form.limits.dishes} onChange={(e) => set({ limits: { ...form.limits, dishes: e.target.value } })} /></label>
                  <p className="dl-hint dl-limits-eg">{tr('That is up to {n} website orders an hour.', { n: Math.max(1, Number(form.limits.orders) || 1) * 4 })}</p>
                </div>
              )}
            </fieldset>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              <button type="submit" className="btn dl-go" disabled={busy}>{busy ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
