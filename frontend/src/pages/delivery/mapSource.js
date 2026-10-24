import { posFetch } from '../../lib/posApi';

// Which streets the maps draw (DeliveryMap.jsx). Google's own map — street
// names, shops and places, satellite pictures, traffic — through Google's
// Map Tiles API when the server holds a key for it (backend GET /pos/map,
// GOOGLE_MAPS_KEY on Render); OpenStreetMap's otherwise, or if Google says
// no. A Google "session" names the kind of map (and its language, night
// colours, traffic); each tile is asked for with it.

const GOOGLE = 'https://tile.googleapis.com';
export const GOOGLE_LOGO = 'https://developers.google.com/static/maps/documentation/images/google_on_white.png';
export const GOOGLE_LOGO_DARK = 'https://developers.google.com/static/maps/documentation/images/google_on_non_white.png';

let config = null;
// A page that already has the server's answer (the sales team's route,
// CrmRoutePage.jsx, gets it with the day's visits) hands it over, so the
// map need not ask the till's API — which the sales app cannot reach.
export function setMapConfig(c) { config = Promise.resolve(c || { google: null }); }
export function mapConfig() {
  if (!config) config = posFetch('GET', '/pos/map').catch(() => ({ google: null }));
  return config;
}

// Google's night colours for the street map, so the dark theme is a real
// night map rather than the day one turned over.
const NIGHT = [
  { elementType: 'geometry', stylers: [{ color: '#1d2433' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1d2433' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a96ab' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: '#e2b07a' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#d6a46c' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#203a36' }] },
  { featureType: 'poi.park', elementType: 'labels.text.fill', stylers: [{ color: '#6b9a76' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#36404f' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#202836' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#a3adbd' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#6f6450' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#1f2835' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#f3d19c' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2f3948' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#14253b' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#55657d' }] }
];

// The map's language, as Google wants it, from the page's.
const LANG = { en: 'en-GB', fr: 'fr-FR', zh: 'zh-CN' };

const sessions = new Map(); // the request, as text → Promise of { session, expiry }
async function createSession(key, body) {
  const res = await fetch(GOOGLE + '/v1/createSession?key=' + encodeURIComponent(key), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Google map: ' + res.status);
  const j = await res.json();
  if (!j.session) throw new Error('Google map: no session');
  return { session: j.session, expiry: Number(j.expiry) * 1000 || Date.now() + 86400000 };
}
// A session for { type: 'roadmap' | 'satellite', traffic, night, lang, region }:
// satellite comes with the street names on it; kept until shortly before it
// runs out. Night colours Google will not take are dropped, not the map.
export function googleSession(key, opts) {
  const body = { mapType: opts.type === 'satellite' ? 'satellite' : 'roadmap', language: LANG[opts.lang] || 'en-GB', region: opts.region || 'GH' };
  const layers = [];
  if (body.mapType === 'satellite') layers.push('layerRoadmap');
  if (opts.traffic) layers.push('layerTraffic');
  if (layers.length) body.layerTypes = layers;
  if (typeof window !== 'undefined' && window.devicePixelRatio > 1) { body.scale = 'scaleFactor2x'; body.highDpi = true; }
  const styled = opts.night && body.mapType === 'roadmap' ? { ...body, styles: NIGHT } : null;
  const want = JSON.stringify(styled || body);
  const kept = sessions.get(want);
  if (kept && kept.expiry > Date.now() + 120000) return kept.p;
  const p = (styled ? createSession(key, styled).catch(() => createSession(key, body)) : createSession(key, body))
    .then((s) => { sessions.set(want, { p: Promise.resolve(s), expiry: s.expiry }); return s; })
    .catch((e) => { sessions.delete(want); throw e; });
  sessions.set(want, { p, expiry: Infinity });
  return p;
}
export function googleTiles(key, session) {
  return GOOGLE + '/v1/2dtiles/{z}/{x}/{y}?session=' + encodeURIComponent(session) + '&key=' + encodeURIComponent(key);
}
// Whose map data is in view (Google asks for it to be shown with the map).
export async function googleCopyright(key, session, zoom, b) {
  const q = 'session=' + encodeURIComponent(session) + '&key=' + encodeURIComponent(key) + '&zoom=' + zoom +
    '&north=' + b.getNorth().toFixed(6) + '&south=' + b.getSouth().toFixed(6) + '&east=' + b.getEast().toFixed(6) + '&west=' + b.getWest().toFixed(6);
  const res = await fetch(GOOGLE + '/tile/v1/viewport?' + q);
  if (!res.ok) return '';
  const j = await res.json();
  return j.copyright || '';
}

// What this device last chose: the street map or satellite, and traffic.
export function savedView() {
  try { return { layer: localStorage.getItem('bamboo.map.layer') === 'satellite' ? 'satellite' : 'map', traffic: localStorage.getItem('bamboo.map.traffic') === '1' }; }
  catch { return { layer: 'map', traffic: false }; }
}
export function saveView(v) {
  try { localStorage.setItem('bamboo.map.layer', v.layer); localStorage.setItem('bamboo.map.traffic', v.traffic ? '1' : '0'); } catch { /* private window */ }
}
