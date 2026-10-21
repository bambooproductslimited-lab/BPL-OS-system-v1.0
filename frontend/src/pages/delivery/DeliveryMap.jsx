import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { tr } from '../../lib/i18n.jsx';
import './deliveryMap.css';

// The map on the delivery screen, the rider's page and the website's
// tracking (Leaflet, OpenStreetMap's streets; VITE_MAP_TILES for others).
// Markers come as data — { id, kind: restaurant|home|order|rider, lat, lng,
// emoji, label, sub, tone, live, active, fit, onClick } — and are kept by
// id: a rider that moves glides there. routes: { id, points, tone, done }
// drawn dashed, the part covered solid. fitKey: when it changes, the view
// fits the markers with fit (all, if none say). pick: a pin to drag or
// place by tapping the map, for choosing where (onPick(lat, lng)).

const TILES = import.meta.env.VITE_MAP_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = import.meta.env.VITE_MAP_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const ACCRA = [5.6037, -0.187];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function iconHtml(m) {
  const cls = ['dm-pin', 'is-' + m.kind, m.tone ? 'tone-' + m.tone : '', m.live ? 'is-live' : '', m.active ? 'is-active' : ''].filter(Boolean).join(' ');
  return '<div class="' + cls + '"><span class="dm-dot"><i>' + esc(m.emoji || '') + '</i></span>' +
    (m.label ? '<span class="dm-label">' + esc(m.label) + (m.sub ? '<small>' + esc(m.sub) + '</small>' : '') + '</span>' : '') + '</div>';
}
function iconOf(m) { return L.divIcon({ className: 'dm-icon', html: iconHtml(m), iconSize: [0, 0] }); }
function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

export default function DeliveryMap({ markers = [], routes = [], fitKey, pick, onPick, className, center, zoom }) {
  const box = useRef(null);
  const map = useRef(null);
  const kept = useRef(new Map()); // id → { marker, html, anim }
  const lines = useRef([]);
  const pickPin = useRef(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  useEffect(() => {
    const m = L.map(box.current, { zoomControl: true, attributionControl: true, center: center || ACCRA, zoom: zoom || 13, scrollWheelZoom: true });
    L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
    m.attributionControl.setPrefix(false);
    m.on('click', (e) => { if (onPickRef.current) onPickRef.current(e.latlng.lat, e.latlng.lng); });
    // Zoomed out, the pins crowd: only the riders, the restaurant and the
    // picked one keep their names (deliveryMap.css .is-far).
    const far = () => box.current && box.current.classList.toggle('is-far', m.getZoom() < 14);
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
      pickPin.current = null; // they went with the map
      lines.current = [];
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Markers, by id: new ones added, gone ones removed, riders gliding.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set();
    markers.forEach((mk) => {
      if (mk.lat == null || mk.lng == null) return;
      seen.add(mk.id);
      const html = iconHtml(mk);
      let k = kept.current.get(mk.id);
      if (!k) {
        const marker = L.marker([mk.lat, mk.lng], { icon: iconOf(mk), zIndexOffset: mk.kind === 'rider' ? 1000 : mk.kind === 'restaurant' ? 500 : 0, keyboard: false });
        marker.addTo(m);
        k = { marker, html, anim: null, onClick: mk.onClick };
        marker.on('click', () => { const cur = kept.current.get(mk.id); if (cur && cur.onClick) cur.onClick(); });
        kept.current.set(mk.id, k);
        return;
      }
      k.onClick = mk.onClick;
      if (k.html !== html) { k.marker.setIcon(iconOf(mk)); k.html = html; }
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

  // The ways: dashed the whole way, solid as far as covered.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    lines.current.forEach((l) => l.remove());
    lines.current = [];
    routes.forEach((r) => {
      if (!r.points || r.points.length < 2) return;
      lines.current.push(L.polyline(r.points, { className: 'dm-route tone-' + (r.tone || 'go'), weight: 5, opacity: 0.9, dashArray: '2 10', lineCap: 'round', interactive: false }).addTo(m));
      if (r.done > 0) {
        const n = Math.max(2, Math.round(r.points.length * Math.min(1, r.done)));
        lines.current.push(L.polyline(r.points.slice(0, n), { className: 'dm-route is-done tone-' + (r.tone || 'go'), weight: 5, opacity: 1, lineCap: 'round', interactive: false }).addTo(m));
      }
    });
  }, [routes]);

  // The view fits the markers that matter when fitKey changes.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const pts = markers.filter((mk) => mk.lat != null && (mk.fit || !markers.some((x) => x.fit))).map((mk) => [mk.lat, mk.lng]);
    if (pick && pick.lat != null) pts.push([pick.lat, pick.lng]);
    if (pts.length === 1) m.setView(pts[0], Math.max(m.getZoom(), 15), { animate: true });
    else if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [48, 84], paddingBottomRight: [48, 56], maxZoom: 16, animate: true }); // room for the names above the pins
  }, [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return <div ref={box} className={'dm-map' + (onPick ? ' is-pickable' : '') + (className ? ' ' + className : '')} role="application" aria-label={tr('Map')} />;
}
