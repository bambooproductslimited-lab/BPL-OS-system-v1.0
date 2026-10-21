import { useCallback, useEffect, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';
import DeliveryMap from '../delivery/DeliveryMap';
import { minText, minutesLeft, payName, riderSpot, routePoints, telLink, timeOf, vehicleEmoji, vehicleName, waLink } from '../delivery/dlShared';
import './online.css';

// A website order followed by its customer (online.starbartema.com/t/<its
// link>; backend restaurantOnline track): waiting for the restaurant, then
// cooking, ready, the rider coming on the map — where their phone says, or
// an estimate along the way — and at the door. Asked again every few
// seconds until it is over. While it waits it can be cancelled.

const POLL_MS = 5000;
const OVER = ['rejected', 'cancelled', 'delivered', 'collected', 'failed'];
const STAGE = {
  waiting: ['⏳', () => tr('Waiting for the restaurant'), () => tr('They will accept it in a moment. You can still cancel.')],
  rejected: ['😔', () => tr('The restaurant could not take this order'), null],
  cancelled: ['✕', () => tr('This order was cancelled'), null],
  preparing: ['👩‍🍳', () => tr('Being prepared'), null],
  ready: ['📦', () => tr('Ready, a rider is coming for it'), () => tr('Your food is packed and waiting for its rider.')],
  ready_pickup: ['🥡', () => tr('Ready! Come and pick it up'), () => tr('Your order is waiting at the counter.')],
  rider: ['🛵', () => tr('Your rider is on the way to the restaurant'), null],
  on_the_way: ['🛵', () => tr('On the way to you'), null],
  arrived: ['📍', () => tr('Your rider is at the door'), () => tr('Go and meet them.')],
  delivered: ['🎉', () => tr('Delivered. Enjoy your meal!'), () => tr('Thank you for ordering.')],
  collected: ['🎉', () => tr('Collected. Enjoy your meal!'), () => tr('Thank you for ordering.')],
  failed: ['⚠️', () => tr('Your rider could not deliver it'), null]
};
const STEPS_DELIVERY = [['waiting', () => tr('Placed')], ['preparing', () => tr('Cooking')], ['ready', () => tr('Ready')], ['on_the_way', () => tr('On the way')], ['delivered', () => tr('At your door')]];
const STEPS_PICKUP = [['waiting', () => tr('Placed')], ['preparing', () => tr('Cooking')], ['ready_pickup', () => tr('Ready')], ['collected', () => tr('Collected')]];
const ORDER = { waiting: 0, preparing: 1, ready: 2, ready_pickup: 2, rider: 2, on_the_way: 3, arrived: 3, delivered: 4, collected: 3 };

export default function OnlineTrack({ token, onMenu }) {
  const [o, setO] = useState(null);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const stage = useRef(null); // asked again until it is over
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  const load = useCallback(async () => {
    try { const r = await posFetch('GET', '/pos/online/track/' + encodeURIComponent(token)); stage.current = r.stage; setO(r); setFetchedAt(Date.now()); setError(null); document.title = r.ref + ' · ' + r.restaurant.name; return r; }
    catch (e) { if (e.status) setError(e.message); return null; }
  }, [token]);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!OVER.includes(stage.current)) load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  async function cancel() {
    if (!window.confirm(tr('Cancel this order?'))) return;
    setBusy(true);
    try { const r = await posFetch('POST', '/pos/online/track/' + encodeURIComponent(token) + '/cancel'); stage.current = r.stage; setO(r); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!o) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🛵</span><strong>{error ? tr('We cannot find that order') : tr('Finding your order…')}</strong>{error && <p>{error}</p>}</div></div>;
  const r = o.restaurant;
  const logo = restaurantLogoUrl(r.code);
  const st = STAGE[o.stage] || STAGE.preparing;
  const here = r.location ? { lat: r.location.lat, lng: r.location.lng } : null;
  const home = o.customer.lat != null ? { lat: o.customer.lat, lng: o.customer.lng } : null;
  const d = o.delivery;
  const spot = d && here ? riderSpot({ ...d, customer: o.customer }, here, now, fetchedAt) : null;
  const left = !OVER.includes(o.stage) ? minutesLeft(o, now) : null;
  const steps = o.fulfillment === 'pickup' ? STEPS_PICKUP : STEPS_DELIVERY;
  const at = ORDER[o.stage] != null ? ORDER[o.stage] : -1;
  const bad = o.stage === 'rejected' || o.stage === 'cancelled' || o.stage === 'failed';
  let sub = st[2] ? st[2]() : '';
  if (o.stage === 'rejected') sub = o.rejectReason || '';
  if (o.stage === 'failed') sub = (d && d.note) || tr('Call the restaurant to sort it out.');
  if (o.stage === 'preparing') sub = left != null ? (o.fulfillment === 'pickup' ? tr('Ready in about {m}.', { m: minText(left) }) : tr('At your door in about {m}.', { m: minText(left) })) : tr('The kitchen is on it.');
  if (o.stage === 'rider' && d) sub = tr('{name} is picking it up.', { name: d.rider.name });
  if (o.stage === 'on_the_way') sub = left != null ? tr('Arriving in about {m}.', { m: minText(left) }) : tr('Coming to you now.');

  const markers = [];
  if (here) markers.push({ id: 'here', kind: 'restaurant', lat: here.lat, lng: here.lng, emoji: '🍽️', label: r.name, fit: true });
  if (home) markers.push({ id: 'home', kind: 'home', tone: 'active', lat: home.lat, lng: home.lng, emoji: '🏠', label: tr('You'), fit: true });
  if (spot && d && !['delivered'].includes(d.status)) markers.push({ id: 'rider', kind: 'rider', lat: spot.lat, lng: spot.lng, emoji: vehicleEmoji(d.rider.vehicle), live: spot.live, label: d.rider.name, sub: spot.live ? tr('live') : tr('estimated'), fit: true });
  const routes = here && home && o.fulfillment === 'delivery' ? [{ id: 'way', points: routePoints(here, home), done: spot ? spot.progress : 0 }] : [];

  return (
    <div className="on-shell on-track">
      <header className="on-track-top">
        <button type="button" className="on-x is-plain" onClick={onMenu} aria-label={tr('The menu')}>←</button>
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{r.name}</strong><small>{tr('Order {ref}', { ref: o.ref })} · {timeOf(o.placedAt)}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>

      <section className={'on-status is-' + o.stage + (bad ? ' is-bad' : '')} aria-live="polite">
        <span className="on-status-art" aria-hidden="true">{st[0]}</span>
        <div>
          <h1>{st[1]()}</h1>
          {sub && <p>{sub}</p>}
          {left != null && !bad && <span className="on-eta">⏱ {tr('about {m}', { m: minText(left) })}</span>}
        </div>
      </section>

      {!bad && (
        <ol className="on-steps" style={{ '--n': steps.length }}>
          {steps.map(([k, label], i) => <li key={k} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}><i>{i < at ? '✓' : i + 1}</i><span>{label()}</span></li>)}
        </ol>
      )}

      {(here || home) && (
        <div className="on-track-map">
          <DeliveryMap markers={markers} routes={routes} fitKey={'t:' + o.stage + ':' + (spot ? 1 : 0)} center={here ? [here.lat, here.lng] : undefined} />
          {spot && !spot.live && d && d.status === 'picked_up' && <span className="on-map-tag">{tr('The rider\'s place is estimated from the time on the way.')}</span>}
        </div>
      )}

      {d && (
        <div className="on-card on-rider">
          <span className="on-rider-face" aria-hidden="true">{vehicleEmoji(d.rider.vehicle)}</span>
          <div><strong>{d.rider.name}</strong><small>{vehicleName(d.rider.vehicle)}{d.rider.plate ? ' · ' + d.rider.plate : ''}</small></div>
          {d.rider.phone && ['assigned', 'picked_up', 'arrived'].includes(d.status) && (
            <span className="on-contact">
              <a href={telLink(d.rider.phone)} aria-label={tr('Call {name}', { name: d.rider.name })}>📞</a>
              <a href={waLink(d.rider.phone)} target="_blank" rel="noopener noreferrer" aria-label={tr('WhatsApp')}>💬</a>
            </span>
          )}
        </div>
      )}

      <div className="on-card on-receipt">
        <h2>{tr('Your order')}</h2>
        <ul className="on-lines is-plain">
          {o.items.map((l, i) => <li key={i}><span className="on-line-text"><strong>{l.qty}× {l.name}</strong>{l.note && <small>{l.note}</small>}</span><i>{money(l.lineTotal)}</i></li>)}
        </ul>
        <div className="on-total">
          <div><span>{tr('Food')}</span><b>{money(o.subtotal)}</b></div>
          {o.fulfillment === 'delivery' && <div><span>{tr('Delivery')}</span><b>{o.deliveryFee ? money(o.deliveryFee) : tr('Free')}</b></div>}
          <div className="is-total"><span>{tr('Total')}</span><strong>{money(o.total)}</strong></div>
          <p className="on-hint">{o.fulfillment === 'delivery' ? tr('Pay the rider: {method}.', { method: payName(o.payMethod) }) : tr('Pay at the counter: {method}.', { method: payName(o.payMethod) })}</p>
        </div>
        {o.fulfillment === 'delivery' && <p className="on-hint">📍 {o.customer.address}{o.customer.landmark ? ' · ' + o.customer.landmark : ''}</p>}
      </div>

      <div className="on-track-go">
        {r.phone && <a className="on-go is-ghost" href={telLink(r.phone)}>📞 {tr('Call the restaurant')}</a>}
        {o.stage === 'waiting' && <button type="button" className="on-go is-stop" disabled={busy} onClick={cancel}>{tr('Cancel the order')}</button>}
        {OVER.includes(o.stage) && <button type="button" className="on-go" onClick={onMenu}>{tr('Order again')}</button>}
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </div>
  );
}
