import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import DeliveryMap from '../delivery/DeliveryMap';
import { setMapConfig } from '../delivery/mapSource';
import { along, kmText, minText, navLink, roadParts, telLink } from '../delivery/dlShared';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './CrmRoute.css';

// Today's route (backend crmRoute.service.js): a rep's site visits for the
// day on the map, in the quickest order by car from where they are now,
// with the roads, today's traffic, and how long each leg takes; each visit
// with directions in Google Maps, a call, and Visited. A visit nobody has
// placed is placed here — tap the map where it is, or "I'm here" at the
// site — and Google's reading of a visit's location can be moved the same
// way. Mine (the visits I go on or booked) or everyone's; any day.

const ACCRA = { lat: 5.6037, lng: -0.187 };
function iso(d) { return d.toISOString().slice(0, 10); }
function shift(day, n) { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function dayName(day) {
  const today = iso(new Date());
  if (day === today) return tr('Today');
  if (day === shift(today, 1)) return tr('Tomorrow');
  if (day === shift(today, -1)) return tr('Yesterday');
  return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}
function mins(s) { return s == null ? null : Math.max(1, Math.round(s / 60)); }
function legText(leg) { return leg ? minText(mins(leg.seconds)) + ' · ' + kmText(leg.meters / 1000) : ''; }
function delayOf(leg) { return leg && !leg.estimate ? Math.round(((leg.seconds || 0) - (leg.freeSeconds || 0)) / 60) : 0; }
function whereTo(s) { return s.place ? navLink(s.place.lat, s.place.lng) : 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s.location + ', Ghana') + '&travelmode=driving'; }
// The whole round in Google Maps: from here, through the visits in order (Google takes nine stops between).
function wholeRoute(start, route) {
  const at = (s) => (s.place ? s.place.lat + ',' + s.place.lng : s.location + ', Ghana');
  const stops = route.slice(0, 10);
  const last = stops[stops.length - 1];
  const middle = stops.slice(0, -1).map(at).join('|');
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving' + (start ? '&origin=' + start.lat + ',' + start.lng : '') +
    '&destination=' + encodeURIComponent(at(last)) + (middle ? '&waypoints=' + encodeURIComponent(middle) : '');
}

export default function CrmRoutePage() {
  const { can } = useAuth();
  const canManage = can('crm.manage');
  const [day, setDay] = useState(() => iso(new Date()));
  const [who, setWho] = useState('mine');
  const [here, setHere] = useState(undefined); // undefined: asking; null: not shared; { lat, lng }
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [placing, setPlacing] = useState(null); // { stop, lat, lng }
  const [fitKey, setFitKey] = useState(0);

  // Where the rep is, once, to start the round from.
  useEffect(() => {
    if (!navigator.geolocation) { setHere(null); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setHere({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setHere(null),
      { enableHighAccuracy: true, timeout: 9000, maximumAge: 120000 }
    );
  }, []);

  const load = useCallback(async () => {
    if (here === undefined) return;
    setError(null);
    try {
      const q = new URLSearchParams({ date: day, who });
      if (here) { q.set('lat', here.lat); q.set('lng', here.lng); }
      const d = await api.get('/crm/visits/day?' + q.toString());
      setMapConfig(d.map);
      setData(d);
      setFitKey((k) => k + 1);
    } catch (e) { setError(e.message); }
  }, [day, who, here]);
  useEffect(() => { load(); }, [load]);

  async function act(key, fn) {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  function startPlacing(s) {
    const p = s.place || here || (data && data.route[0] && data.route[0].place) || ACCRA;
    setPlacing({ stop: s, lat: p.lat, lng: p.lng });
  }
  function savePlace(by, pt) {
    const s = placing.stop;
    setPlacing(null);
    return act('place-' + s.id, () => api.post('/crm/visits/' + s.id + '/place', { lat: pt.lat, lng: pt.lng, by }));
  }
  function imHere() {
    if (!navigator.geolocation) { setError(tr('This phone cannot tell where it is.')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => savePlace('here', { lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setError(tr('Turn on location for this page, then try again.')),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }

  const route = useMemo(() => (data ? data.route : []), [data]);
  const markers = useMemo(() => {
    if (!data) return [];
    const list = [];
    if (data.start) list.push({ id: 'me', kind: 'home', emoji: '🧑🏾‍💼', label: tr('You'), lat: data.start.lat, lng: data.start.lng, fit: true });
    route.forEach((s) => {
      if (!s.place) return;
      list.push({
        id: s.id, kind: 'order', emoji: String(s.n), tone: s.n === 1 ? 'go' : 'new', active: s.n === 1, fit: true,
        lat: s.place.lat, lng: s.place.lng, label: s.client, sub: s.leg ? minText(mins(s.leg.seconds)) : tr('Start'),
        info: [s.n + '. ' + s.client, s.location, s.leg ? legText(s.leg) : ''],
        onClick: () => { const el = document.getElementById('rt-' + s.id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      });
    });
    data.done.forEach((s) => { if (s.place) list.push({ id: s.id, kind: 'order', emoji: '✓', tone: 'done', lat: s.place.lat, lng: s.place.lng, label: s.client, sub: tr('Visited') }); });
    return list;
  }, [data, route]);
  const routes = useMemo(() => route.filter((s) => s.leg && s.leg.points && s.leg.points.length > 1).map((s) => {
    const chip = minText(mins(s.leg.seconds));
    if (!s.leg.estimate) {
      const mid = along(s.leg.points, 0.5);
      return { id: 'leg-' + s.id, road: roadParts({ points: s.leg.points, traffic: s.leg.traffic }), chip, chipAt: [mid.lat, mid.lng], tone: 'go' };
    }
    return { id: 'leg-' + s.id, points: s.leg.points, tone: 'go', chip };
  }), [route]);

  const t = data && data.totals;
  const delay = t && !t.estimate ? Math.round((t.seconds - t.freeSeconds) / 60) : 0;
  const startNote = here === undefined ? tr('Finding where you are…') : here ? tr('From where you are now') : tr('Location is off: the round starts at the first visit');

  return (
    <div className="rt">
      <section className="rt-hero">
        <span className="rt-hero-road" aria-hidden="true" />
        <div className="rt-hero-main">
          <span className="rt-eyebrow">🚗 {dayName(day)}</span>
          <h1>
            {!data ? tr('Planning your round…') : !t.stops ? (data.unplaced.length ? tr('Put your visits on the map') : tr('No visits to go to')) : t.stops === 1 ? tr('1 visit') : tr('{n} visits', { n: t.stops })}
            {t && t.stops > 0 && <small> · {kmText(t.meters / 1000)}</small>}
          </h1>
          <p>
            {!data ? '' : !t.stops ? (data.unplaced.length ? tr('Tap "Put it on the map" on each one, and the quickest order appears.') : tr('Nothing booked for this day. Book site visits from a lead.'))
              : t.estimate ? tr('About {time} of driving, nearest first (as the crow flies: Google\'s roads and traffic need its key on the server).', { time: minText(mins(t.seconds)) })
              : delay > 0 ? tr('{time} of driving in the quickest order, with today\'s traffic: {delay} of it in jams and slow roads.', { time: minText(mins(t.seconds)), delay: minText(delay) })
              : tr('{time} of driving in the quickest order, with today\'s traffic.', { time: minText(mins(t.seconds)) })}
          </p>
          <div className="rt-controls">
            <div className="rt-days" role="group" aria-label={tr('Day')}>
              <button type="button" onClick={() => setDay(shift(day, -1))} aria-label={tr('The day before')}>‹</button>
              <button type="button" className={day === iso(new Date()) ? 'is-on' : ''} onClick={() => setDay(iso(new Date()))}>{tr('Today')}</button>
              <button type="button" onClick={() => setDay(shift(day, 1))} aria-label={tr('The day after')}>›</button>
            </div>
            <div className="rt-seg" role="group" aria-label={tr('Whose visits')}>
              <button type="button" aria-pressed={who === 'mine'} onClick={() => setWho('mine')}>{tr('Mine')}</button>
              <button type="button" aria-pressed={who === 'all'} onClick={() => setWho('all')}>{tr('Everyone\'s')}</button>
            </div>
            <span className={'rt-here' + (here ? ' is-on' : '')}>📍 {startNote}</span>
            {route.length > 0 && <a className="rt-gmaps" href={wholeRoute(data.start, route)} target="_blank" rel="noopener noreferrer">{tr('Drive it in Google Maps')} ↗</a>}
          </div>
        </div>
      </section>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="rt-main">
        <div className="rt-mapbox">
          {data && (
            <DeliveryMap markers={markers} routes={routes} fitKey={fitKey} className="rt-map"
              pick={placing ? { lat: placing.lat, lng: placing.lng, label: tr('Drag me to {name}', { name: placing.stop.client }) } : null}
              onPick={placing ? (lat, lng) => setPlacing((p) => ({ ...p, lat, lng })) : undefined} />
          )}
          {placing && (
            <div className="rt-placing">
              <b>{tr('Where is {name}?', { name: placing.stop.client })}</b>
              <span>{tr('Tap the map there, or drag the pin.')}</span>
              <div>
                <button type="button" className="btn btn-primary" onClick={() => savePlace('pin', placing)}>{tr('Save this place')}</button>
                <button type="button" className="btn btn-secondary" onClick={imHere}>📍 {tr('I\'m here now')}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setPlacing(null)}>{tr('Cancel')}</button>
              </div>
            </div>
          )}
        </div>

        <div className="rt-list">
          {route.length > 0 && (
            <ol className="rt-stops">
              {route.map((s) => {
                const late = delayOf(s.leg);
                return (
                  <li key={s.id} id={'rt-' + s.id} className="rt-stop" style={{ '--i': s.n }}>
                    {s.leg && (
                      <div className="rt-leg">
                        <span>🚗 {legText(s.leg)}</span>
                        {late > 1 && <span className="rt-jam">{tr('+{n} in traffic', { n: minText(late) })}</span>}
                        {s.leg.estimate && <span className="rt-guess">{tr('estimate')}</span>}
                      </div>
                    )}
                    <div className="rt-card">
                      <span className="rt-n">{s.n}</span>
                      <div className="rt-what">
                        <b>{s.client}</b>
                        <span>{s.location || tr('No location written')}{s.leadRef ? ' · ' + s.leadRef : ''}</span>
                        {s.people.length > 0 && <small>{s.people.join(', ')}</small>}
                        {s.placedBy === 'address' && <small className="rt-guess">{tr('Placed by Google from the location: move it if it is wrong.')}</small>}
                      </div>
                      <div className="rt-acts">
                        <a className="rt-act is-go" href={whereTo(s)} target="_blank" rel="noopener noreferrer">{tr('Directions')}</a>
                        {s.phone && <a className="rt-act" href={telLink(s.phone)}>{tr('Call')}</a>}
                        {canManage && <button type="button" className="rt-act" disabled={!!busy} onClick={() => startPlacing(s)}>{tr('Move pin')}</button>}
                        {canManage && <button type="button" className="rt-act is-done" disabled={!!busy} onClick={() => act('v-' + s.id, () => api.put('/crm/visits/' + s.id, { status: 'visited' }))}>✓ {tr('Visited')}</button>}
                      </div>
                    </div>
                  </li>
                );
              })}
              {data.back && <li className="rt-back">🏁 {tr('And back to where you started: {time}', { time: minText(mins(data.back.seconds)) })}</li>}
            </ol>
          )}

          {data && data.unplaced.length > 0 && (
            <section className="rt-box">
              <h3>{tr('Not on the map yet')}</h3>
              <p>{data.google ? tr('Google could not find where these are from their location. Put them on the map and they join the round.') : tr('Put them on the map and they join the round.')}</p>
              {data.unplaced.map((s) => (
                <div key={s.id} className="rt-un">
                  <span><b>{s.client}</b><small>{s.location || tr('No location written')}</small></span>
                  {canManage && <button type="button" className="btn btn-secondary" onClick={() => startPlacing(s)}>{tr('Put it on the map')}</button>}
                </div>
              ))}
            </section>
          )}

          {data && data.done.length > 0 && (
            <section className="rt-box is-done">
              <h3>✓ {tr('Visited')}</h3>
              {data.done.map((s) => <div key={s.id} className="rt-un"><span><b>{s.client}</b><small>{s.location}</small></span></div>)}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
