import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { activeLocale, tr } from '../../lib/i18n.jsx';
import { along } from './dlShared';
import { GOOGLE_LOGO, GOOGLE_LOGO_DARK, googleCopyright, googleSession, googleTiles, mapConfig, savedView, saveView } from './mapSource';
import './deliveryMap.css';

// The map on the delivery screen, the rider's page and the website
// (Leaflet). Its streets are Google's — the street map with its places, or
// satellite with the street names, and traffic — when the server has a key
// for Google's map (mapSource.js); else OpenStreetMap's (VITE_MAP_TILES for
// others). Buttons on it: the kind of map, traffic, show everything, full
// screen; a scale. Markers come as data — { id, kind: restaurant|home|order|
// rider, lat, lng, emoji, label, sub, info: [title, line, …], tone, live,
// active, fit, onClick } — kept by id: a rider that moves glides there; info
// is the card shown on pointing at it (or tapping). routes: { id, points,
// tone, done, trail, chip } — points dashed, solid as far as done; trail the
// way the rider really went (their phone), solid; chip the time and distance
// left, on the way. fitKey: when it changes, the view fits the markers with
// fit (all, if none say). pick: a pin to drag or place by tapping the map,
// for choosing where (onPick(lat, lng)). lite: no traffic or full screen
// (the small maps for choosing a place).

const TILES = import.meta.env.VITE_MAP_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = import.meta.env.VITE_MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const ACCRA = [5.6037, -0.187];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function iconHtml(m) {
  const cls = ['dm-pin', 'is-' + m.kind, m.tone ? 'tone-' + m.tone : '', m.live ? 'is-live' : '', m.active ? 'is-active' : ''].filter(Boolean).join(' ');
  return '<div class="' + cls + '"><span class="dm-dot"><i>' + esc(m.emoji || '') + '</i></span>' +
    (m.label ? '<span class="dm-label">' + esc(m.label) + (m.sub ? '<small>' + esc(m.sub) + '</small>' : '') + '</span>' : '') + '</div>';
}
// The card beside a pin opens to its side, clear of the pin itself.
function iconOf(m) { return L.divIcon({ className: 'dm-icon', html: iconHtml(m), iconSize: [0, 0], tooltipAnchor: m.kind === 'rider' ? [28, 0] : [24, -30] }); }
function tipHtml(info) {
  return '<strong>' + esc(info[0]) + '</strong>' + info.slice(1).filter(Boolean).map((l) => '<span>' + esc(l) + '</span>').join('');
}
const TIP = { direction: 'auto', className: 'dm-tip', opacity: 1 };
function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// The page's theme, followed: the night map in the dark one.
function useNight() {
  const [night, setNight] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => {
    const o = new MutationObserver(() => setNight(document.documentElement.dataset.theme === 'dark'));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => o.disconnect();
  }, []);
  return night;
}

export default function DeliveryMap({ markers = [], routes = [], fitKey, pick, onPick, className, center, zoom, lite }) {
  const wrap = useRef(null);
  const box = useRef(null);
  const map = useRef(null);
  const base = useRef(null); // the streets drawn now
  const kept = useRef(new Map()); // id → { marker, html, tip, anim }
  const lines = useRef([]);
  const pickPin = useRef(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const fitWith = useRef({ markers, pick });
  fitWith.current = { markers, pick };
  const [src, setSrc] = useState(null); // { google: { key } } or { osm: true }, once known
  const [view, setView] = useState(savedView);
  const [shown, setShown] = useState(false); // Google's streets are on the map
  const [copyright, setCopyright] = useState('');
  const [logoOk, setLogoOk] = useState(true);
  const [full, setFull] = useState(false);
  const night = useNight();
  const lang = activeLocale();
  const google = src && src.google ? src.google : null;
  const satellite = !!google && view.layer === 'satellite';
  const fsOk = !lite && typeof document !== 'undefined' && !!document.fullscreenEnabled;

  useEffect(() => {
    const m = L.map(box.current, { zoomControl: true, attributionControl: true, center: center || ACCRA, zoom: zoom || 13, scrollWheelZoom: true });
    m.attributionControl.setPrefix(false);
    L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 110 }).addTo(m);
    m.on('click', (e) => { if (onPickRef.current) onPickRef.current(e.latlng.lat, e.latlng.lng); });
    // Zoomed out, the pins crowd: only the riders, the restaurant and the
    // picked one keep their names (deliveryMap.css .is-far).
    const far = () => wrap.current && wrap.current.classList.toggle('is-far', m.getZoom() < 14);
    m.on('zoomend', far);
    far();
    map.current = m;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(box.current);
    const keptNow = kept.current;
    return () => {
      ro.disconnect();
      keptNow.forEach((k) => { if (k.anim) cancelAnimationFrame(k.anim); });
      keptNow.clear();
      m.remove();
      map.current = null;
      base.current = null; // they went with the map
      pickPin.current = null;
      lines.current = [];
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Which streets: asked of the server once.
  useEffect(() => {
    let on = true;
    mapConfig().then((c) => { if (on) setSrc(c && c.google && c.google.key ? { google: c.google } : { osm: true }); });
    return () => { on = false; };
  }, []);

  // The streets drawn: the new ones put in before the old go, so the map
  // never goes blank; Google's, unless Google turns the key down.
  useEffect(() => {
    const m = map.current;
    if (!m || !src) return undefined;
    let gone = false, onMove = null, wait = null;
    const put = (layer) => {
      layer.addTo(m);
      layer.bringToBack();
      if (base.current) base.current.remove();
      base.current = layer;
    };
    if (!src.google) {
      put(L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }));
      setShown(false);
      setCopyright('');
      return () => { gone = true; };
    }
    googleSession(src.google.key, { type: satellite ? 'satellite' : 'roadmap', traffic: view.traffic, night, lang })
      .then((s) => {
        if (gone) return;
        put(L.tileLayer(googleTiles(src.google.key, s.session), { maxZoom: 22, maxNativeZoom: 22 }));
        setShown(true);
        onMove = () => {
          clearTimeout(wait);
          wait = setTimeout(() => {
            googleCopyright(src.google.key, s.session, m.getZoom(), m.getBounds()).then((c) => { if (!gone) setCopyright(c); }).catch(() => {});
          }, 400);
        };
        m.on('moveend', onMove);
        onMove();
      })
      .catch(() => { if (!gone) setSrc({ osm: true }); });
    return () => { gone = true; clearTimeout(wait); if (onMove) m.off('moveend', onMove); };
  }, [src, satellite, view.traffic, night, lang]);

  // Whose map data it is, as Google asks, beside the map.
  useEffect(() => {
    const m = map.current;
    if (m) m.attributionControl.setPrefix(shown && copyright ? esc(copyright) : false);
  }, [shown, copyright]);

  // Markers, by id: new ones added, gone ones removed, riders gliding.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set();
    markers.forEach((mk) => {
      if (mk.lat == null || mk.lng == null) return;
      seen.add(mk.id);
      const html = iconHtml(mk);
      const tip = mk.info && mk.info.length ? tipHtml(mk.info) : null;
      let k = kept.current.get(mk.id);
      if (!k) {
        const marker = L.marker([mk.lat, mk.lng], { icon: iconOf(mk), zIndexOffset: mk.kind === 'rider' ? 1000 : mk.kind === 'restaurant' ? 500 : 0, keyboard: false });
        if (tip) marker.bindTooltip(tip, TIP);
        marker.addTo(m);
        k = { marker, html, tip, anim: null, onClick: mk.onClick };
        marker.on('click', () => { const cur = kept.current.get(mk.id); if (cur && cur.onClick) cur.onClick(); });
        kept.current.set(mk.id, k);
        return;
      }
      k.onClick = mk.onClick;
      if (k.html !== html) { k.marker.setIcon(iconOf(mk)); k.html = html; }
      if (k.tip !== tip) {
        if (!tip) k.marker.unbindTooltip();
        else if (k.marker.getTooltip()) k.marker.setTooltipContent(tip);
        else k.marker.bindTooltip(tip, TIP);
        k.tip = tip;
      }
      const from = k.marker.getLatLng();
      if (Math.abs(from.lat - mk.lat) < 1e-7 && Math.abs(from.lng - mk.lng) < 1e-7) return;
      if (mk.kind !== 'rider') { k.marker.setLatLng([mk.lat, mk.lng]); return; }
      if (k.anim) cancelAnimationFrame(k.anim);
      const t0 = performance.now(), dur = 1100;
      const step = (t) => {
        const f = ease(Math.min(1, (t - t0) / dur));
        k.marker.setLatLng([from.lat + (mk.lat - from.lat) * f, from.lng + (mk.lng - from.lng) * f]);
        k.anim = f < 1 ? requestAnimationFrame(step) : null;
      };
      k.anim = requestAnimationFrame(step);
    });
    kept.current.forEach((k, id) => {
      if (seen.has(id)) return;
      if (k.anim) cancelAnimationFrame(k.anim);
      k.marker.remove();
      kept.current.delete(id);
    });
  }, [markers]);

  // The ways: where the rider really went, solid; the rest dashed, solid as
  // far as covered; the time and distance left on it.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    lines.current.forEach((l) => l.remove());
    lines.current = [];
    routes.forEach((r) => {
      const tone = r.tone || 'go';
      if (r.trail && r.trail.length > 1) {
        lines.current.push(L.polyline(r.trail, { className: 'dm-trail tone-' + tone, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(m));
      }
      if (!r.points || r.points.length < 2) return;
      lines.current.push(L.polyline(r.points, { className: 'dm-route tone-' + tone, weight: 5, opacity: 0.9, dashArray: '2 10', lineCap: 'round', interactive: false }).addTo(m));
      const done = Math.min(1, r.done || 0);
      if (done > 0) {
        const n = Math.max(2, Math.round(r.points.length * done));
        lines.current.push(L.polyline(r.points.slice(0, n), { className: 'dm-route is-done tone-' + tone, weight: 5, opacity: 1, lineCap: 'round', interactive: false }).addTo(m));
      }
      if (r.chip) {
        const at = along(r.points, Math.min(0.8, done + (1 - done) * 0.5));
        const icon = L.divIcon({ className: 'dm-icon', html: '<span class="dm-chip tone-' + tone + '">' + esc(r.chip) + '</span>', iconSize: [0, 0] });
        lines.current.push(L.marker([at.lat, at.lng], { icon, interactive: false, keyboard: false, zIndexOffset: 800 }).addTo(m));
      }
    });
  }, [routes]);

  // The view fits the markers that matter (or all of them, asked).
  const fitNow = useCallback((all) => {
    const m = map.current;
    if (!m) return;
    const { markers: list, pick: pk } = fitWith.current;
    const pts = list.filter((mk) => mk.lat != null && (all || mk.fit || !list.some((x) => x.fit))).map((mk) => [mk.lat, mk.lng]);
    if (pk && pk.lat != null) pts.push([pk.lat, pk.lng]);
    if (pts.length === 1) m.setView(pts[0], Math.max(m.getZoom(), 15), { animate: true });
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [48, 84], paddingBottomRight: [48, 56], maxZoom: 16, animate: true }); // room for the names above the pins
  }, []);
  useEffect(() => { fitNow(false); }, [fitKey, fitNow]);

  // A pin to place: dragged, or moved where the map is tapped.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!pick || pick.lat == null) { if (pickPin.current) { pickPin.current.remove(); pickPin.current = null; } return; }
    const icon = L.divIcon({ className: 'dm-icon', html: '<div class="dm-pin is-pick"><span class="dm-dot"><i>📍</i></span><span class="dm-label">' + esc(tr('Drag me to the door')) + '</span></div>', iconSize: [0, 0] });
    if (!pickPin.current) {
      pickPin.current = L.marker([pick.lat, pick.lng], { draggable: true, icon, zIndexOffset: 2000, autoPan: true }).addTo(m);
      pickPin.current.on('dragend', () => { const p = pickPin.current.getLatLng(); if (onPickRef.current) onPickRef.current(p.lat, p.lng); });
    } else pickPin.current.setLatLng([pick.lat, pick.lng]);
  }, [pick]);

  // Full screen, where the browser can.
  useEffect(() => {
    const f = () => setFull(!!wrap.current && document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (wrap.current) wrap.current.requestFullscreen().catch(() => {});
  }
  function choose(patch) {
    const next = { ...view, ...patch };
    setView(next);
    saveView(next);
  }

  const cls = ['dm-map', onPick ? 'is-pickable' : '', shown ? 'is-google' : 'is-osm', satellite && shown ? 'is-satellite' : '', full ? 'is-full' : '', className || ''].filter(Boolean).join(' ');
  return (
    <div ref={wrap} className={cls}>
      <div ref={box} className="dm-canvas" role="application" aria-label={tr('Map')} />
      <div className="dm-tools">
        {google && (
          <div className="dm-seg" role="group" aria-label={tr('Kind of map')}>
            <button type="button" aria-pressed={!satellite} onClick={() => choose({ layer: 'map' })} title={tr('Street map')}><span aria-hidden="true">🗺️</span><b>{tr('Map')}</b></button>
            <button type="button" aria-pressed={satellite} onClick={() => choose({ layer: 'satellite' })} title={tr('Satellite, with the street names')}><span aria-hidden="true">🛰️</span><b>{tr('Satellite')}</b></button>
          </div>
        )}
        {google && !lite && (
          <button type="button" className={'dm-tool' + (view.traffic ? ' is-on' : '')} aria-pressed={view.traffic} onClick={() => choose({ traffic: !view.traffic })} title={tr('Traffic on the roads now')}>
            <span aria-hidden="true">🚦</span><b>{tr('Traffic')}</b>
          </button>
        )}
        <button type="button" className="dm-tool is-icon" onClick={() => fitNow(true)} title={tr('Show everything')} aria-label={tr('Show everything')}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /><circle cx="12" cy="12" r="2.5" /></svg>
        </button>
        {fsOk && (
          <button type="button" className="dm-tool is-icon" onClick={toggleFull} title={full ? tr('Leave full screen') : tr('Full screen')} aria-label={full ? tr('Leave full screen') : tr('Full screen')}>
            {full
              ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /></svg>
              : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>}
          </button>
        )}
      </div>
      {shown && (
        <span className="dm-glogo">
          {logoOk ? <img src={satellite || night ? GOOGLE_LOGO_DARK : GOOGLE_LOGO} alt="Google" onError={() => setLogoOk(false)} /> : 'Google'}
        </span>
      )}
    </div>
  );
}
