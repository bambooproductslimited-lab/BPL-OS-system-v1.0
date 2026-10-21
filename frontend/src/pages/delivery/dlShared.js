import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';

// Shared by the delivery screen (DeliveryApp.jsx), the rider's page
// (RiderPage.jsx) and the website's tracking (online/OnlineTrack.jsx):
// names, links to call or message, and where to draw a rider on the map —
// where their phone says they are, or, without it, an estimate along the
// way from the restaurant by the time gone (backend restaurantDelivery).

export const VEHICLE = {
  motorbike: ['🛵', msg('Motorbike')], bicycle: ['🚲', msg('Bicycle')], car: ['🚗', msg('Car')], on_foot: ['🚶', msg('On foot')]
};
export const VEHICLES = ['motorbike', 'bicycle', 'car', 'on_foot'];
export function vehicleEmoji(v) { return (VEHICLE[v] || VEHICLE.motorbike)[0]; }
export function vehicleName(v) { return tr((VEHICLE[v] || VEHICLE.motorbike)[1]); }

// A delivery's steps, and what each is called.
export const STEPS = ['assigned', 'picked_up', 'arrived', 'delivered'];
const STATUS = {
  assigned: msg('Rider going to the restaurant'), picked_up: msg('On the way'), arrived: msg('At the door'), delivered: msg('Delivered'),
  failed: msg('Could not deliver'), cancelled: msg('Cancelled')
};
export function statusName(s) { return STATUS[s] ? tr(STATUS[s]) : s; }
export function stepOf(s) { const i = STEPS.indexOf(s); return i < 0 ? (s === 'failed' || s === 'cancelled' ? 3 : 0) : i; }
export const PAY = { cash: msg('Cash'), mobile_money: msg('Mobile Money') };
export function payName(m) { return PAY[m] ? tr(PAY[m]) : m; }

// Phone numbers as links: to call, and on WhatsApp (Ghana numbers made international).
function intl(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d[0] === '0') return '233' + d.slice(1);
  if (d.length === 9) return '233' + d;
  return d;
}
export function telLink(phone) { return 'tel:' + String(phone || '').replace(/[^\d+]/g, ''); }
export function waLink(phone, text) { return 'https://wa.me/' + intl(phone) + (text ? '?text=' + encodeURIComponent(text) : ''); }
// Turn-by-turn in the phone's maps app.
export function navLink(lat, lng) { return 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lng + '&travelmode=driving'; }

export function kmText(km) { return km == null ? '' : tr('{n} km', { n: Number(km).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }) }); }
export function minText(m) { return m == null ? '' : m < 60 ? tr('{n} min', { n: m }) : tr('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }); }
export function timeOf(iso) { return iso ? new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) : ''; }
export function sinceText(iso, now) {
  const m = Math.max(0, Math.floor(((now || Date.now()) - new Date(iso).getTime()) / 60000));
  return m < 1 ? tr('just now') : m < 60 ? tr('{n} min ago', { n: m }) : tr('{h} h {m} min ago', { h: Math.floor(m / 60), m: m % 60 });
}

// ── the way, drawn ──
// A gentle curve from a to b (a straight line looks like no road at all),
// as points to draw and to move a rider along.
export function routePoints(a, b, n = 48) {
  if (!a || !b) return [];
  const mx = (a.lat + b.lat) / 2, my = (a.lng + b.lng) / 2;
  const dx = b.lat - a.lat, dy = b.lng - a.lng;
  const cx = mx - dy * 0.18, cy = my + dx * 0.18;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a.lat + 2 * u * t * cx + t * t * b.lat, u * u * a.lng + 2 * u * t * cy + t * t * b.lng]);
  }
  return out;
}
// The point a share p (0–1) of the way along.
export function along(points, p) {
  if (!points.length) return null;
  if (p <= 0) return { lat: points[0][0], lng: points[0][1] };
  if (p >= 1) return { lat: points[points.length - 1][0], lng: points[points.length - 1][1] };
  const seg = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    seg.push(d); total += d;
  }
  let want = total * p;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i]) {
      const f = seg[i] ? want / seg[i] : 0;
      return { lat: points[i][0] + (points[i + 1][0] - points[i][0]) * f, lng: points[i][1] + (points[i + 1][1] - points[i][1]) * f };
    }
    want -= seg[i];
  }
  return { lat: points[points.length - 1][0], lng: points[points.length - 1][1] };
}

// Where to draw a delivery's rider now: { lat, lng, live, progress } —
// their phone's position while it is fresh (under two minutes, counting the
// time since the screen asked: fetchedAt); else at the restaurant until the
// food is picked up, then along the way by the time gone over the time it
// should take (never quite there until they say they are), at the door once
// arrived. Null without the two ends on the map.
export function riderSpot(d, restaurant, now, fetchedAt) {
  const home = d.customer && d.customer.lat != null ? { lat: d.customer.lat, lng: d.customer.lng } : null;
  const from = restaurant && restaurant.lat != null ? { lat: restaurant.lat, lng: restaurant.lng } : null;
  const route = routePoints(from, home);
  let progress = 0;
  if (d.status === 'arrived' || d.status === 'delivered') progress = 1;
  else if (d.status === 'picked_up') {
    const t0 = new Date(d.pickedUpAt || d.createdAt).getTime();
    progress = Math.min(0.94, Math.max(0.02, (now - t0) / (Math.max(5, d.etaMinutes || 20) * 60000)));
  }
  if (d.riderAt && d.riderAt.lat != null) {
    const age = (d.riderAt.ageSeconds || 0) + Math.max(0, (now - (fetchedAt || now)) / 1000);
    if (age < 120) return { lat: d.riderAt.lat, lng: d.riderAt.lng, live: true, progress };
  }
  if (!route.length) return null;
  return Object.assign(along(route, progress), { live: false, progress });
}
// By road, roughly, as the server counts it (straight line × 1.3), in km.
export function roadKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(x)) * 1.3 * 10) / 10;
}
// What is left of a delivery, for the chip on its way: the minutes and the
// km to the door on the way; picking up. At the door, nothing is left.
export function chipOf(d, spot, now) {
  if (d.status === 'assigned') return tr('Picking up');
  if (d.status !== 'picked_up') return null;
  const t0 = new Date(d.pickedUpAt || d.createdAt).getTime();
  const left = Math.max(1, Math.round((d.etaMinutes || 20) - (now - t0) / 60000));
  const home = d.customer && d.customer.lat != null ? d.customer : null;
  const km = spot && spot.live ? roadKm(spot, home) : d.distanceKm != null ? Math.round(d.distanceKm * (1 - (spot ? spot.progress : 0)) * 10) / 10 : null;
  return minText(left) + (km != null ? ' · ' + kmText(km) : '');
}
// A delivery's way on the map (DeliveryMap routes): where the rider really
// went while their phone shares it, then the rest of the way from them,
// dashed; else the whole way from the restaurant, solid as far as they
// should have come by now. Null without both ends.
export function wayOf(d, here, spot, now) {
  const home = d.customer && d.customer.lat != null ? { lat: d.customer.lat, lng: d.customer.lng } : null;
  if (!here || !home) return null;
  const chip = chipOf(d, spot, now);
  const live = spot && spot.live;
  const trail = live && Array.isArray(d.trail) && d.trail.length ? d.trail.concat([[spot.lat, spot.lng]]) : null;
  if (live && d.status !== 'assigned') return { id: d.id, trail, points: routePoints(spot, home, 24), done: 0, chip };
  return { id: d.id, trail, points: routePoints(here, home), done: spot ? spot.progress : 0, chip };
}
// Minutes left until the food is at the door, roughly (for the customer):
// waiting for the kitchen, then the ride.
export function minutesLeft(order, now) {
  const d = order.delivery;
  if (d && d.status === 'picked_up') {
    const t0 = new Date(d.pickedUpAt || d.createdAt).getTime();
    return Math.max(1, Math.round((d.etaMinutes || 20) - (now - t0) / 60000));
  }
  const ride = d ? d.etaMinutes || 15 : order.distanceKm != null ? Math.round(order.distanceKm / 24 * 60) + 4 : 15;
  if (d && d.status === 'assigned') return Math.max(3, ride + 5);
  if (order.decidedAt && order.readyMinutes) {
    const ready = new Date(order.decidedAt).getTime() + order.readyMinutes * 60000;
    return Math.max(ride, Math.round((ready - now) / 60000) + (order.fulfillment === 'pickup' ? 0 : ride));
  }
  return null;
}
