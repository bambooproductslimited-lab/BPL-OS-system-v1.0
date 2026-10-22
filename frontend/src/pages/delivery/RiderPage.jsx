import { useCallback, useEffect, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';
import DeliveryMap from './DeliveryMap';
import { kmText, minText, navLink, payName, rideLeft, riderSpot, routePoints, statusName, stepOf, telLink, timeOf, trafficMinutes, vehicleEmoji, waLink, wayOf } from './dlShared';
import { CollectForm } from './DlCards';
import './delivery.css';

// A rider's page (delivery.starbartema.com/r/<their link>): no sign-in, the
// link is the key (backend restaurantDelivery riderView). Where to take the
// food and who to call, what to collect at the door, the way on the map,
// and one big button for the next step — picked up, arrived, delivered —
// or "could not deliver". While it is open it shares where the phone is
// (every few seconds), so the restaurant and the customer see them coming.

const POLL_MS = 10000;
const SEND_EVERY_MS = 6000;

export default function RiderPage({ token }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [me, setMe] = useState(null); // this phone's position
  const [sharing, setSharing] = useState(() => (navigator.geolocation ? 'off' : 'unsupported'));
  const [busy, setBusy] = useState(false);
  const [failing, setFailing] = useState(false);
  const [taking, setTaking] = useState(false); // delivered: saying what was collected
  const [note, setNote] = useState('');
  const [fitKey, setFitKey] = useState('start');
  const lastSent = useRef(0);
  const watch = useRef(null);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);

  const load = useCallback(async () => {
    try { const r = await posFetch('GET', '/pos/rider/' + encodeURIComponent(token)); setD(r); setFetchedAt(Date.now()); setError(null); } catch (e) { if (e.status) setError(e.message); }
  }, [token]);
  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const active = d && ['assigned', 'picked_up', 'arrived'].includes(d.status);
  // Sharing where the phone is: started by a tap (or by itself if allowed before).
  const startSharing = useCallback(() => {
    if (!navigator.geolocation || watch.current != null) return;
    setSharing('asking');
    watch.current = navigator.geolocation.watchPosition((p) => {
      const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
      setMe(pos); setSharing('on');
      if (Date.now() - lastSent.current > SEND_EVERY_MS) {
        lastSent.current = Date.now();
        posFetch('POST', '/pos/rider/' + encodeURIComponent(token) + '/location', null, pos).catch(() => {});
      }
    }, (err) => { setSharing(err && err.code === 1 ? 'denied' : 'off'); if (watch.current != null) navigator.geolocation.clearWatch(watch.current); watch.current = null; },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }, [token]);
  useEffect(() => {
    if (!active || sharing !== 'off' || !navigator.permissions) return;
    navigator.permissions.query({ name: 'geolocation' }).then((r) => { if (r.state === 'granted') startSharing(); }).catch(() => {});
  }, [active, sharing, startSharing]);
  useEffect(() => { if (!active && watch.current != null) { navigator.geolocation.clearWatch(watch.current); watch.current = null; } }, [active]);
  useEffect(() => () => { if (watch.current != null) navigator.geolocation.clearWatch(watch.current); }, []);

  async function step(status, why, collected) {
    setBusy(true);
    try { setD(await posFetch('POST', '/pos/rider/' + encodeURIComponent(token) + '/status', null, { status, note: why, collected })); setFetchedAt(Date.now()); setFailing(false); setTaking(false); setFitKey(status); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!d) {
    return (
      <div className="dk dl-rider-page is-empty">
        <div className="dl-empty"><span aria-hidden="true">🛵</span><strong>{error ? tr('This link is not working') : tr('Loading your delivery…')}</strong>{error && <p>{error}</p>}</div>
      </div>
    );
  }
  const r = d.restaurant;
  const here = r.location ? { lat: r.location.lat, lng: r.location.lng } : null;
  const home = d.customer.lat != null ? { lat: d.customer.lat, lng: d.customer.lng } : null;
  const spot = me && active ? { ...me, live: true, progress: 0 } : riderSpot(d, here, now, fetchedAt);
  const markers = [];
  if (here) markers.push({ id: 'here', kind: 'restaurant', lat: here.lat, lng: here.lng, emoji: '🍽️', label: r.name, fit: d.status === 'assigned' || !home,
    info: [r.name, r.location && r.location.address ? '📍 ' + r.location.address : '', r.phone ? '📞 ' + r.phone : ''] });
  if (home) markers.push({ id: 'home', kind: 'home', tone: 'active', lat: home.lat, lng: home.lng, emoji: '🏠', label: d.customer.name, fit: true,
    info: [d.customer.name, d.customer.address ? '📍 ' + d.customer.address : '', d.customer.landmark, d.toCollect > 0 ? tr('Collect') + ' ' + money(d.toCollect) + ' · ' + payName(d.collectMethod) : ''] });
  if (spot) markers.push({ id: 'me', kind: 'rider', lat: spot.lat, lng: spot.lng, emoji: vehicleEmoji(d.rider.vehicle), live: spot.live, label: tr('You'), fit: true, tone: d.status === 'delivered' ? 'done' : undefined });
  // The way: to the restaurant first, while they go for the food; then the
  // way they have really gone and the rest to the door.
  let routes = [];
  if (here && home && spot && spot.live && d.status === 'assigned') routes = [{ id: 'way', points: routePoints(spot, here, 24), done: 0, trail: d.trail && d.trail.length ? d.trail.concat([[spot.lat, spot.lng]]) : null, chip: tr('Picking up') }];
  else if (here && home) routes = [wayOf(d, here, spot, now)].filter(Boolean);
  const next = { assigned: ['picked_up', '🥡 ' + tr('I have picked up the food')], picked_up: ['arrived', '📍 ' + tr('I have arrived')], arrived: ['delivered', '✅ ' + tr('Delivered')] }[d.status];
  const at = stepOf(d.status);
  const logo = restaurantLogoUrl(r.code);
  const target = d.status === 'assigned' ? here : home;

  return (
    <div className="dk dl-rider-page">
      <header className="dl-rp-top">
        {logo ? <img src={logo} alt="" /> : <span className="dl-brand-mark">🛵</span>}
        <div><strong>{d.ref} · {r.name}</strong><small>{tr('Hello {name}', { name: d.rider.name })}</small></div>
        <DeviceLanguage className="pos-lang" />
      </header>
      <div className="dl-rp-map">
        <DeliveryMap markers={markers} routes={routes} fitKey={fitKey + ':' + (spot ? (spot.live ? 'live' : 1) : 0)} center={here ? [here.lat, here.lng] : undefined} />
        {active && (
          <div className={'dl-rp-share is-' + sharing}>
            {sharing === 'on' ? <><i className="dl-live-dot" />{tr('Sharing where you are')}</>
              : sharing === 'unsupported' ? tr('This phone cannot share where it is.')
                : sharing === 'denied' ? tr('Location is off for this page: the customer sees an estimate.')
                  : <button type="button" className="btn dl-go" onClick={startSharing}>📡 {sharing === 'asking' ? tr('Asking…') : tr('Share my location')}</button>}
          </div>
        )}
      </div>

      <section className="dl-rp-sheet">
        <div className={'dl-rp-status is-' + d.status}>
          <span aria-hidden="true">{d.status === 'delivered' ? '🎉' : d.status === 'failed' ? '⚠️' : d.status === 'cancelled' ? '✕' : vehicleEmoji(d.rider.vehicle)}</span>
          <div><strong>{d.status === 'delivered' ? tr('Delivered. Thank you!') : statusName(d.status)}</strong>
            <small>{d.status === 'assigned' ? tr('Go to the restaurant and pick up the food.') : d.status === 'picked_up' ? (rideLeft(d, now) ? tr('About {m} to the customer.', { m: minText(rideLeft(d, now)) }) + (trafficMinutes(d) ? ' 🚦 ' + tr('Traffic adds about {m}.', { m: minText(trafficMinutes(d)) }) : '') : tr('Take it to the customer.'))
              : d.status === 'arrived' ? tr('Hand it over and collect the money.') : d.status === 'failed' ? d.note : d.status === 'cancelled' ? tr('The restaurant cancelled this delivery.') : ''}</small></div>
        </div>
        <ol className="dl-rp-steps">{[tr('Pick up'), tr('On the way'), tr('At the door'), tr('Delivered')].map((l, i) => <li key={i} className={i < at ? 'is-done' : i === at && active ? 'is-now' : ''}>{l}</li>)}</ol>

        {taking && <CollectForm big d={d} busy={busy} onBack={() => setTaking(false)} onDone={(c) => step('delivered', '', c)} />}
        {active && next && !failing && !taking && (
          <button type="button" className="btn dl-go dl-rp-next" disabled={busy} onClick={() => (next[0] === 'delivered' && d.toCollect > 0 ? setTaking(true) : step(next[0]))}>{busy ? tr('Saving…') : next[1]}</button>
        )}
        {target && active && <a className="btn btn-secondary dl-rp-nav" href={navLink(target.lat, target.lng)} target="_blank" rel="noopener noreferrer">🧭 {d.status === 'assigned' ? tr('Directions to the restaurant') : tr('Directions to the customer')}</a>}

        {d.toCollect > 0 && d.money.state === 'to_collect' && !taking && (
          <div className="dl-rp-collect"><span>{tr('Collect')}</span><strong>{money(d.toCollect)}</strong><small>{payName(d.collectMethod)}</small></div>
        )}
        {d.money.state === 'with_rider' && (
          <div className="dl-rp-collect is-held"><span>{tr('Hand to the cashier')}</span><strong>{money(d.money.collected.amount)}</strong>
            <small>{tr('You collected it: {method}, {time}.', { method: payName(d.money.collected.method), time: timeOf(d.money.collected.at) })}</small></div>
        )}
        {d.money.state === 'handed' && (
          <div className={'dl-rp-collect ' + (d.money.short > 0 ? 'is-short' : 'is-in')}><span>{d.money.short > 0 ? tr('Handed in, short') : tr('Handed in ✓')}</span><strong>{money(d.money.handed.amount)}</strong>
            <small>{tr('{amount} handed in to {name} at {time}', { amount: money(d.money.handed.amount), name: d.money.handed.by || '—', time: timeOf(d.money.handed.at) })}</small></div>
        )}
        <div className="dl-rp-card">
          <span className="dl-rp-card-ico" aria-hidden="true">🏠</span>
          <div>
            <strong>{d.customer.name}</strong>
            <p>{d.customer.address}{d.customer.landmark && <small>{d.customer.landmark}</small>}</p>
            {d.distanceKm != null && <small>{kmText(d.distanceKm)} {tr('from the restaurant')}</small>}
          </div>
          <span className="dl-contact">
            {d.customer.phone && <a className="dl-round" href={telLink(d.customer.phone)} aria-label={tr('Call {phone}', { phone: d.customer.phone })}>📞</a>}
            {d.customer.phone && <a className="dl-round is-wa" href={waLink(d.customer.phone, tr('Hello {name}, I am bringing your order from {place}.', { name: d.customer.name, place: r.name }))} target="_blank" rel="noopener noreferrer" aria-label={tr('WhatsApp')}>💬</a>}
          </span>
        </div>
        <div className="dl-rp-card">
          <span className="dl-rp-card-ico" aria-hidden="true">🥡</span>
          <div><strong>{tr('The order')}</strong><ul className="dl-items is-short">{d.items.map((l, i) => <li key={i}><span>{l}</span></li>)}</ul></div>
        </div>
        <div className="dl-rp-card">
          <span className="dl-rp-card-ico" aria-hidden="true">🍽️</span>
          <div><strong>{r.name}</strong><p>{r.location && r.location.address}</p></div>
          {r.phone && <span className="dl-contact"><a className="dl-round" href={telLink(r.phone)} aria-label={tr('Call the restaurant')}>📞</a></span>}
        </div>

        {active && !failing && <button type="button" className="pos-link is-bad dl-rp-fail" onClick={() => setFailing(true)}>{tr('I could not deliver it')}</button>}
        {failing && (
          <div className="dl-answer is-no">
            <span className="dl-answer-label">{tr('What happened?')}</span>
            <input className="input" autoFocus value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. nobody answered, wrong address')} />
            <div className="dl-answer-go">
              <button type="button" className="btn dl-stop" disabled={busy || !note.trim()} onClick={() => step('failed', note.trim())}>{tr('Could not deliver')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setFailing(false)}>{tr('Back')}</button>
            </div>
          </div>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
      </section>
    </div>
  );
}
