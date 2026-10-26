import { useCallback, useEffect, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { modsWords, serviceWords } from '../till/tillBill';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';
import DeliveryMap from '../delivery/DeliveryMap';
import { activeIntlLocale } from '../../lib/i18n.jsx';
import { chipOf, clockOf, dayName, laterText, minText, minutesLeft, payName, riderSpot, routePoints, telLink, timeOf, trafficMinutes, vehicleEmoji, vehicleName, waLink, wayOf } from '../delivery/dlShared';
import './online.css';

// A website order followed by its customer (online.starbartema.com/t/<its
// link>; backend restaurantOnline track): waiting for the restaurant, then
// cooking, ready, the rider coming on the map — where their phone says, or
// an estimate along the way — and at the door. Asked again every few
// seconds until it is over. While it waits it can be cancelled; one for
// later, until the kitchen starts on it (and it is asked for less often
// while it waits for its time).

const POLL_MS = 5000;
const SLOW_EVERY = 6; // confirmed for later: every 30 s
const OVER = ['rejected', 'cancelled', 'delivered', 'collected', 'failed'];
const STAGE = {
  unpaid: ['💳', () => tr('Waiting for your payment'), () => tr('Pay to send your order to the restaurant.')],
  waiting: ['⏳', () => tr('Waiting for the restaurant'), () => tr('They will accept it in a moment. You can still cancel.')],
  scheduled: ['🗓️', null, () => tr('The kitchen starts on it in good time. You can still cancel until then.')],
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
const STEP_LATER = ['scheduled', () => tr('Confirmed')];
// The step each stage is at.
const STEP_OF = { unpaid: 'unpaid', waiting: 'waiting', scheduled: 'scheduled', preparing: 'preparing', ready: 'ready', ready_pickup: 'ready_pickup', rider: 'ready', on_the_way: 'on_the_way', arrived: 'on_the_way', delivered: 'delivered', collected: 'collected' };

// mineId and auth: an order of the signed-in customer's, found through their
// account (any phone) rather than the order's own link.
export default function OnlineTrack({ token, mineId, auth, onMenu: toMenu }) {
  const path = mineId ? '/pos/online/account/orders/' + encodeURIComponent(mineId) : '/pos/online/track/' + encodeURIComponent(token);
  const [o, setO] = useState(null);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  // Back from Paystack's page (it adds ?reference=): the payment is being checked.
  const [backFromPaying] = useState(() => { try { return new URLSearchParams(window.location.search).has('reference'); } catch { return false; } });
  const stage = useRef(null); // asked again until it is over
  const ticks = useRef(0);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  const load = useCallback(async () => {
    try { const r = await posFetch('GET', path, auth || null); stage.current = r.stage; setO(r); setFetchedAt(Date.now()); setError(null); document.title = r.ref + ' · ' + r.restaurant.name; return r; }
    catch (e) { if (e.status) setError(e.message); return null; }
  }, [path, auth]);
  useEffect(() => {
    load();
    const t = setInterval(() => {
      ticks.current += 1;
      if (OVER.includes(stage.current) || (stage.current === 'scheduled' && ticks.current % SLOW_EVERY)) return;
      load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Curbside: outside for a pickup, with a word about the car.
  const [car, setCar] = useState(null);
  async function sayHere(e) {
    e.preventDefault();
    setBusy(true);
    try { const r = await posFetch('POST', path + '/here', auth || null, { note: car || '' }); stage.current = r.stage; setO(r); setCar(null); setError(null); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Paid online: the payment page again (the first did not go through).
  async function payNow() {
    setBusy(true); setError(null);
    try { const r = await posFetch('POST', path + '/pay', auth || null); window.location.assign(r.url); } catch (e) { setError(e.message); setBusy(false); }
  }

  async function cancel() {
    if (!window.confirm(tr('Cancel this order?'))) return;
    setBusy(true);
    try { const r = await posFetch('POST', path + '/cancel', auth || null); stage.current = r.stage; setO(r); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!o) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🛵</span><strong>{error ? tr('We cannot find that order') : tr('Finding your order…')}</strong>{error && <p>{error}</p>}</div></div>;
  const r = o.restaurant;
  const onMenu = () => toMenu(r.code); // this restaurant's menu, not the site's first one
  const logo = restaurantLogoUrl(r.code);
  const st = STAGE[o.stage] || STAGE.preparing;
  const here = r.location ? { lat: r.location.lat, lng: r.location.lng } : null;
  const home = o.customer.lat != null ? { lat: o.customer.lat, lng: o.customer.lng } : null;
  const d = o.delivery;
  const spot = d && here ? riderSpot({ ...d, customer: o.customer }, here, now, fetchedAt) : null;
  const left = !OVER.includes(o.stage) && !['waiting', 'scheduled', 'ready_pickup'].includes(o.stage) ? minutesLeft(o, now) : null;
  const base = o.fulfillment === 'pickup' ? STEPS_PICKUP : STEPS_DELIVERY;
  const steps = o.scheduledFor ? [base[0], STEP_LATER].concat(base.slice(1)) : base;
  const at = steps.findIndex(([k]) => k === STEP_OF[o.stage]);
  const bad = o.stage === 'rejected' || o.stage === 'cancelled' || o.stage === 'failed';
  const forLater = o.scheduledFor ? laterText(o.scheduledFor, now) : '';
  const title = o.stage === 'scheduled' ? tr('Confirmed for {when}', { when: forLater }) : st[1]();
  let sub = st[2] ? st[2]() : '';
  if (o.stage === 'waiting' && o.scheduledFor) sub = tr('For {when}. They will confirm it soon. You can still cancel.', { when: forLater });
  if (o.stage === 'rejected') sub = o.rejectReason || '';
  if (o.stage === 'failed') sub = (d && d.note) || tr('Call the restaurant to sort it out.');
  if (o.stage === 'preparing' && o.scheduledFor) sub = o.fulfillment === 'pickup' ? tr('Ready to pick up at {time}.', { time: clockOf(o.scheduledFor) }) : tr('At your door around {time}.', { time: clockOf(o.scheduledFor) });
  else if (o.stage === 'preparing') sub = left != null ? (o.fulfillment === 'pickup' ? tr('Ready in about {m}.', { m: minText(left) }) : tr('At your door in about {m}.', { m: minText(left) })) : tr('The kitchen is on it.');
  if (o.stage === 'rider' && d) sub = tr('{name} is picking it up.', { name: d.rider.name });
  if (o.stage === 'on_the_way') sub = left != null ? tr('Arriving in about {m}.', { m: minText(left) }) : tr('Coming to you now.');
  if (o.stage === 'on_the_way' && trafficMinutes(d)) sub += ' 🚦 ' + tr('Traffic adds about {m}.', { m: minText(trafficMinutes(d)) });

  // The way: Google's road coloured by its traffic, or where the rider has
  // really gone and the rest to the door; the time left on it.
  const way = d && spot && o.fulfillment === 'delivery' && ['picked_up', 'arrived'].includes(d.status) ? wayOf({ ...d, customer: o.customer }, here, spot, now) : null;
  const markers = [];
  if (here) markers.push({ id: 'here', kind: 'restaurant', lat: here.lat, lng: here.lng, emoji: '🍽️', label: r.name, fit: true,
    info: [r.name, r.location.address ? '📍 ' + r.location.address : '', r.phone ? '📞 ' + r.phone : ''] });
  if (home) markers.push({ id: 'home', kind: 'home', tone: 'active', lat: home.lat, lng: home.lng, emoji: '🏠', label: tr('You'), fit: true,
    info: [tr('Your door'), o.customer.address ? '📍 ' + o.customer.address : '', o.customer.landmark] });
  if (spot && d && !['delivered'].includes(d.status)) markers.push({ id: 'rider', kind: 'rider', lat: spot.lat, lng: spot.lng, emoji: vehicleEmoji(d.rider.vehicle), live: spot.live, label: d.rider.name, sub: spot.live ? tr('live') : tr('estimated'), fit: true,
    info: [d.rider.name, vehicleName(d.rider.vehicle) + (d.rider.plate ? ' · ' + d.rider.plate : ''), way ? way.chip : chipOf({ ...d, customer: o.customer }, spot, now), spot.live ? tr('Live from their phone') : tr('Estimated from the time on the way')] });
  const routes = way ? [way] : here && home && o.fulfillment === 'delivery' ? [{ id: 'way', points: routePoints(here, home), done: spot ? spot.progress : 0 }] : [];

  return (
    <div className="on-shell on-track" data-brand={r.code}>
      <header className="on-track-top">
        <button type="button" className="on-x is-plain" onClick={onMenu} aria-label={tr('The menu')}>←</button>
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{r.name}</strong><small>{tr('Order {ref}', { ref: o.ref })} · {timeOf(o.placedAt)}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>

      <section className={'on-status is-' + o.stage + (bad ? ' is-bad' : '')} aria-live="polite">
        <span className="on-status-art" aria-hidden="true">{st[0]}</span>
        <div>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
          {left != null && !bad && <span className="on-eta">⏱ {tr('about {m}', { m: minText(left) })}</span>}
        </div>
      </section>

      {o.stage === 'unpaid' && (
        <div className="on-card on-pay-card">
          <span className="on-pay-amt"><small>{tr('To pay')}</small><strong>{money(o.total)}</strong></span>
          {o.paid && ['failed', 'abandoned'].includes(o.paid.status) && <p className="on-pay-note is-bad">{tr('That payment did not go through. Nothing was taken: try again.')}</p>}
          {o.paid && o.paid.status === 'pending' && backFromPaying && <p className="on-pay-note">⏳ {tr('Checking your payment… This page updates by itself.')}</p>}
          <button type="button" className="on-go is-big" disabled={busy} onClick={payNow}>🔒 {tr('Pay by card or Mobile Money')}</button>
          {o.payBy && <p className="on-hint is-center">{tr('Not paid by {time}, the order is cancelled.', { time: clockOf(o.payBy) })}</p>}
        </div>
      )}

      {o.scheduledFor && !bad && ['waiting', 'scheduled'].includes(o.stage) && (
        <div className="on-card on-when-card">
          <span className="on-cal" aria-hidden="true">
            <small>{new Date(o.scheduledFor).toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' })}</small>
            <b>{new Date(o.scheduledFor).getUTCDate()}</b>
          </span>
          <div>
            <strong>{dayName(o.scheduledFor, now)} · {clockOf(o.scheduledFor)}</strong>
            <small>{o.fulfillment === 'pickup' ? tr('Ready at the counter') : tr('Brought to your door')}</small>
            {o.catering && <small className="ctg-track">🎉 {tr('Catering for {n} guests', { n: o.catering.guests })}</small>}
          </div>
          <span className="on-cal-count">{countdown(o.scheduledFor, now)}</span>
        </div>
      )}

      {o.fulfillment === 'pickup' && (o.canSayHere || o.here) && (
        o.here && o.here.broughtAt ? (
          <div className="on-card cbs-here is-done"><span className="cbs-here-art" aria-hidden="true">🛍️</span><div><strong>{tr('Brought out to you. Enjoy!')}</strong></div></div>
        ) : o.here && car == null ? (
          <div className="on-card cbs-here is-waiting">
            <span className="cbs-here-art" aria-hidden="true">🚗<i /></span>
            <div>
              <strong>{tr('We know you are here')}</strong>
              <small>{o.stage === 'ready_pickup' ? tr('Someone is bringing it out to you now.') : tr('It is still cooking: we bring it out as soon as it is ready.')}</small>
              {o.here.note && <small className="cbs-here-note">🚙 “{o.here.note}”</small>}
            </div>
            <button type="button" className="on-link" onClick={() => setCar(o.here.note || '')}>{tr('Change')}</button>
          </div>
        ) : (
          <form className="on-card cbs-here" onSubmit={sayHere}>
            <span className="cbs-here-art" aria-hidden="true">🚗</span>
            <div className="cbs-here-form">
              <strong>{o.here ? tr('Where are you?') : tr('Here to collect it?')}</strong>
              <small>{tr('Tell us you are outside and we bring it out to you.')}</small>
              <input className="input" maxLength={120} value={car || ''} onChange={(e) => setCar(e.target.value)} placeholder={tr('Your car or where you are, e.g. blue Corolla by the gate')} aria-label={tr('Your car or where you are')} />
              <button type="submit" className="on-go" disabled={busy}>{o.here ? tr('Update') : '🙋 ' + tr('I\'m here')}</button>
            </div>
          </form>
        )
      )}

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
          {o.items.map((l, i) => <li key={i}><span className="on-line-text"><strong>{l.qty}× {l.name}</strong>{(l.modifiers || []).length > 0 && <small className="on-line-mods">+ {modsWords(l.modifiers, tr)}</small>}{l.note && <small>{l.note}</small>}</span><i>{money(l.lineTotal)}</i></li>)}
        </ul>
        <div className="on-total">
          <div><span>{tr('Food')}</span><b>{money(o.subtotal)}</b></div>
          {o.fulfillment === 'delivery' && <div><span>{tr('Delivery')}</span><b>{o.deliveryFee ? money(o.deliveryFee) : tr('Free')}</b></div>}
          {(o.charges || {}).promo && o.charges.promo.amount > 0 && <div className="is-deal"><span>🎟️ {o.charges.promo.name}</span><b>−{money(o.charges.promo.amount)}</b></div>}
          {(o.charges || {}).serviceCharge > 0 && <div><span>{serviceWords(o.charges.serviceName, tr)} {o.charges.serviceRate}%</span><b>{money(o.charges.serviceCharge)}</b></div>}
          {((o.charges || {}).taxes || []).filter((t) => !t.included).map((t) => <div key={t.name}><span>{t.name} {t.rate}%</span><b>{money(t.amount)}</b></div>)}
          <div className="is-total"><span>{tr('Total')}</span><strong>{money(o.total)}</strong></div>
          {((o.charges || {}).taxes || []).filter((t) => t.included).map((t) => <div key={t.name} className="is-incl"><span>{tr('incl. {tax} {rate}%', { tax: t.name, rate: t.rate })}</span><b>{money(t.amount)}</b></div>)}
          {o.payMethod !== 'online' ? <p className="on-hint">{o.fulfillment === 'delivery' ? tr('Pay the rider: {method}.', { method: payName(o.payMethod) }) : tr('Pay at the counter: {method}.', { method: payName(o.payMethod) })}</p>
            : o.paid && o.paid.status === 'success' && (
              <p className={'on-paid' + (o.paid.refund ? ' is-refund' + (o.paid.refund.status === 'failed' ? ' is-failed' : '') : '')}>
                {!o.paid.refund ? '✅ ' + tr('Paid online: {amount}', { amount: money(o.paid.amount) }) + (o.paid.channel === 'mobile_money' ? ' · ' + tr('Mobile Money') : o.paid.channel === 'card' ? ' · ' + tr('Card') : '')
                  : o.paid.refund.status === 'failed' ? '⚠️ ' + tr('We could not give your {amount} back automatically: the restaurant will call you to sort it out.', { amount: money(o.paid.amount) })
                    : '↩️ ' + tr('Your {amount} is being given back: it reaches your card or Mobile Money in a few days.', { amount: money(o.paid.amount) })}
              </p>
            )}
        </div>
        {o.fulfillment === 'delivery' && <p className="on-hint">📍 {o.customer.address}{o.customer.landmark ? ' · ' + o.customer.landmark : ''}</p>}
      </div>

      <div className="on-track-go">
        {r.phone && <a className="on-go is-ghost" href={telLink(r.phone)}>📞 {tr('Call the restaurant')}</a>}
        {o.canCancel && <button type="button" className="on-go is-stop" disabled={busy} onClick={cancel}>{tr('Cancel the order')}</button>}
        {OVER.includes(o.stage) && <button type="button" className="on-go" onClick={onMenu}>{tr('Order again')}</button>}
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </div>
  );
}

// How long until an order for later: in 2 h 15 min, in 1 day.
function countdown(iso, now) {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60000));
  if (m >= 1440) { const d = Math.floor(m / 1440); return d === 1 ? tr('in 1 day') : tr('in {n} days', { n: d }); }
  return tr('in {m}', { m: minText(m) });
}
