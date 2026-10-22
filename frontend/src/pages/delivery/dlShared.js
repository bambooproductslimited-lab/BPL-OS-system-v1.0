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
// Orders for later, on the restaurant's clock (Ghana keeps GMT all year):
// the day — Today, Tomorrow, Sat 24 Oct — and the time.
const DAY_MS = 86400000;
export function dayName(date, now) {
  const at = Date.parse(String(date).slice(0, 10) + 'T00:00:00Z');
  const today = Date.parse(new Date(now || Date.now()).toISOString().slice(0, 10) + 'T00:00:00Z');
  const n = Math.round((at - today) / DAY_MS);
  if (n === 0) return tr('Today');
  if (n === 1) return tr('Tomorrow');
  return new Date(at).toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function clockOf(iso) { return iso ? new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) : ''; }
// In a sentence: today at 18:30, tomorrow at 11:00, Sat 24 Oct at 18:30.
export function laterText(iso, now) {
  if (!iso) return '';
  const n = Math.round((Date.parse(new Date(iso).toISOString().slice(0, 10)) - Date.parse(new Date(now || Date.now()).toISOString().slice(0, 10))) / DAY_MS);
  const time = clockOf(iso);
  if (n === 0) return tr('today at {time}', { time });
  if (n === 1) return tr('tomorrow at {time}', { time });
  return tr('{day} at {time}', { day: dayName(new Date(iso).toISOString(), now), time });
}
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
  const road = hasRoad(d) ? d.route : null;
  const route = road ? road.points : routePoints(from, home);
  let progress = 0;
  if (d.status === 'arrived' || d.status === 'delivered') progress = 1;
  else if (d.status === 'picked_up') {
    // On the road from when it was started (pick-up, or where the rider
    // was last asked from) for as long as Google says it takes.
    const t0 = new Date((road && road.startAt) || d.pickedUpAt || d.createdAt).getTime();
    const ms = road && road.startAt ? road.seconds * 1000 : Math.max(5, d.etaMinutes || 20) * 60000;
    progress = Math.min(0.94, Math.max(0.02, (now - t0) / Math.max(60000, ms)));
  }
  if (d.riderAt && d.riderAt.lat != null) {
    const age = (d.riderAt.ageSeconds || 0) + Math.max(0, (now - (fetchedAt || now)) / 1000);
    if (age < 120) return { lat: d.riderAt.lat, lng: d.riderAt.lng, live: true, progress };
  }
  if (!route.length) return null;
  return Object.assign(along(route, progress), { live: false, progress });
}
// ── the road (Google's Routes API, backend restaurantRoutes) ──
// { points, traffic: [[from, to, 'slow'|'jam']], seconds, freeSeconds,
// meters, withTraffic, startAt, arriveAt } on a delivery under way.
export function hasRoad(d) { return !!(d && d.route && Array.isArray(d.route.points) && d.route.points.length > 1); }
function kmBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
// Where on the road a point is nearest: the stretch it is on (i: from
// points[i] to points[i + 1]) and the point there.
export function nearestOnRoad(points, p) {
  const kx = 111.32 * Math.cos(p.lat * Math.PI / 180), ky = 110.57;
  let best = { d: Infinity, i: 0, pt: points[0] };
  for (let i = 1; i < points.length; i++) {
    const ax = (points[i - 1][1] - p.lng) * kx, ay = (points[i - 1][0] - p.lat) * ky;
    const dx = (points[i][1] - points[i - 1][1]) * kx, dy = (points[i][0] - points[i - 1][0]) * ky;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const d = Math.hypot(ax + dx * t, ay + dy * t);
    if (d < best.d) best = { d, i: i - 1, pt: [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t] };
  }
  return best;
}
// The point a share p of the way along the road, and its stretch.
function cutAlong(points, p) {
  const at = along(points, p);
  return at ? nearestOnRoad(points, at) : null;
}
// The road cut where the rider is: behind them, and ahead in stretches by
// the traffic on them — clear, slow, jammed.
export function roadParts(route, cut) {
  const pts = route.points, jams = route.traffic || [];
  const speed = (k) => { for (const x of jams) if (k >= x[0] && k < x[1]) return x[2]; return 'clear'; };
  const i = cut ? cut.i : 0, start = cut ? cut.pt : pts[0];
  const done = cut ? pts.slice(0, i + 1).concat([start]) : [];
  const ahead = [];
  let cur = { speed: speed(i), points: [start] };
  for (let k = i + 1; k < pts.length; k++) {
    cur.points.push(pts[k]);
    if (k < pts.length - 1 && speed(k) !== cur.speed) { ahead.push(cur); cur = { speed: speed(k), points: [pts[k]] }; }
  }
  ahead.push(cur);
  return { done, ahead: ahead.filter((x) => x.points.length > 1) };
}
function kmOf(parts) {
  let km = 0;
  parts.ahead.forEach((x) => { for (let k = 1; k < x.points.length; k++) km += kmBetween(x.points[k - 1], x.points[k]); });
  return Math.round(km * 10) / 10;
}
// Halfway along what is ahead, for the chip.
function middleOf(parts) {
  const all = [];
  parts.ahead.forEach((x) => x.points.forEach((p) => all.push(p)));
  const m = all.length > 1 ? along(all, 0.5) : null;
  return m ? [m.lat, m.lng] : null;
}
// The traffic on it: minutes more than on empty roads (2 or more), else 0.
export function trafficMinutes(d) {
  if (!hasRoad(d) || !d.route.withTraffic) return 0;
  const m = Math.round((d.route.seconds - d.route.freeSeconds) / 60);
  return m >= 2 ? m : 0;
}
// Minutes until the food is at the door, once it is on its way: by the
// road's time (traffic and all) when there is one, else by the ride's.
export function rideLeft(d, now) {
  if (d.status !== 'picked_up') return null;
  if (hasRoad(d) && d.route.arriveAt) return Math.max(1, Math.round((new Date(d.route.arriveAt).getTime() - now) / 60000));
  const t0 = new Date(d.pickedUpAt || d.createdAt).getTime();
  return Math.max(1, Math.round((d.etaMinutes || 20) - (now - t0) / 60000));
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
export function chipOf(d, spot, now, parts) {
  if (d.status === 'assigned') return tr('Picking up');
  if (d.status !== 'picked_up') return null;
  const left = rideLeft(d, now);
  const home = d.customer && d.customer.lat != null ? d.customer : null;
  let km;
  if (parts) km = kmOf(parts);
  else km = spot && spot.live ? roadKm(spot, home) : d.distanceKm != null ? Math.round(d.distanceKm * (1 - (spot ? spot.progress : 0)) * 10) / 10 : null;
  const jam = trafficMinutes(d);
  return minText(left) + (km != null ? ' · ' + kmText(km) : '') + (jam ? ' · 🚦 +' + minText(jam) : '');
}
// A delivery's way on the map (DeliveryMap routes): where the rider really
// went while their phone shares it, then the rest of the way from them,
// dashed; else the whole way from the restaurant, solid as far as they
// should have come by now. Null without both ends.
export function wayOf(d, here, spot, now) {
  const home = d.customer && d.customer.lat != null ? { lat: d.customer.lat, lng: d.customer.lng } : null;
  if (!here || !home) return null;
  const live = spot && spot.live;
  const trail = live && Array.isArray(d.trail) && d.trail.length ? d.trail.concat([[spot.lat, spot.lng]]) : null;
  // Google's road: behind the rider faded, ahead coloured by its traffic.
  if (hasRoad(d)) {
    let cut = null;
    if (d.status === 'arrived') cut = nearestOnRoad(d.route.points, home);
    else if (d.status === 'picked_up' && spot) cut = live ? nearestOnRoad(d.route.points, spot) : cutAlong(d.route.points, spot.progress);
    const road = roadParts(d.route, cut);
    // Nearly there, the chip would sit on the rider: their card says it.
    return { id: d.id, trail, road, chip: chipOf(d, spot, now, road), chipAt: kmOf(road) >= 0.4 ? middleOf(road) : null };
  }
  const chip = chipOf(d, spot, now);
  if (live && d.status !== 'assigned') return { id: d.id, trail, points: routePoints(spot, home, 24), done: 0, chip };
  return { id: d.id, trail, points: routePoints(here, home), done: spot ? spot.progress : 0, chip };
}
// Minutes left until the food is at the door, roughly (for the customer):
// waiting for the kitchen, then the ride.
export function minutesLeft(order, now) {
  const d = order.delivery;
  if (d && d.status === 'picked_up') return rideLeft(d, now);
  const ride = d ? d.etaMinutes || 15 : order.distanceKm != null ? Math.round(order.distanceKm / 24 * 60) + 4 : 15;
  if (d && d.status === 'assigned') return Math.max(3, ride + 5);
  // For later: at the time chosen.
  if (order.scheduledFor) return Math.max(order.fulfillment === 'pickup' ? 0 : ride, Math.round((new Date(order.scheduledFor).getTime() - now) / 60000));
  if (order.decidedAt && order.readyMinutes) {
    const ready = new Date(order.decidedAt).getTime() + order.readyMinutes * 60000;
    return Math.max(ride, Math.round((ready - now) / 60000) + (order.fulfillment === 'pickup' ? 0 : ride));
  }
  return null;
}
