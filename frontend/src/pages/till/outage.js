import { posFetch } from '../../lib/posApi';
import { buildKitchenChitBytes, escPosToStarRaster } from '../../lib/thermalPrinter';
import { cacheLoad, cacheSave } from './tillOffline';
import { lineKey } from './tillShared';

// Outage mode — the kitchen's tickets while the internet is down (a power
// cut can keep it down for days):
//
//   kept      what the server says while it can (backend restaurantPrintHub
//             outage): the kitchens and the categories each makes, the
//             printers each prints on, and where the print hub answers on
//             the restaurant's network, with its key;
//   tickets   an order taken with no internet: one ticket per kitchen, for
//             the dishes it had not had yet, marked as taken offline;
//   the hub   they go to the print hub (tools/print-hub, outage mode): it
//             prints them on each kitchen's printers — drawn here, in the
//             printer's own language — and the kitchen screens take them
//             from it. No hub (or not reachable): the till prints them
//             itself, or shows them to print (RestaurantPosPage printChits).
//
// When the internet is back the order reaches the server as already told
// to the kitchen (offlineAt): not printed again (migration 0215).

const HUB_MS = 5000;

export function outageLoad(companyId) { return cacheLoad(companyId, 'outage') || null; }
export async function outageRefresh(companyId, token) {
  const o = await posFetch('GET', '/pos/kitchen/outage', token);
  cacheSave(companyId, 'outage', o);
  return o;
}

function norm(s) { return String(s || '').trim().toLowerCase(); }
// The kitchen that makes a category: the one listing it, else the one
// taking everything else, else none (not sent) — as the server does.
export function stationFor(stations, category) {
  const c = norm(category);
  return (stations || []).find((s) => (s.categories || []).some((x) => norm(x) === c)) || (stations || []).find((s) => s.everythingElse) || null;
}
// What the kitchen has not had yet: each line less what was sent of it.
export function newDishes(lines, sent) {
  const had = new Map();
  (sent || []).forEach((l) => { const k = lineKey(l); had.set(k, (had.get(k) || 0) + Number(l.qty || 0)); });
  const out = [];
  (lines || []).forEach((l) => {
    if (l.custom && l.custom.fee) return; // a delivery fee: charged, never cooked
    const k = lineKey(l);
    const before = had.get(k) || 0;
    const qty = Math.round((Number(l.qty || 0) - before) * 100) / 100;
    had.set(k, Math.max(0, before - Number(l.qty || 0)));
    if (qty > 0) out.push({ ...l, qty });
  });
  return out;
}

// One ticket per kitchen (and course) for the dishes, as the server's are
// (restaurantKitchen chitsFor), marked as taken offline.
// m = { ref, label, tableName, waiterName, guestName, fulfillment, guests,
//       allergy: { list, note }, note, categoryOf(line), allergensOf(line),
//       courseOf(line) → { n, label, waits } | null }
export function offlineChits(outage, dishes, m) {
  if (!outage || !(outage.stations || []).length) return [];
  const by = new Map();
  const short = String(m.ref || '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase() || '0000';
  dishes.forEach((l) => {
    const st = stationFor(outage.stations, m.categoryOf(l));
    if (!st) return;
    const c = (m.courseOf && m.courseOf(l)) || null;
    const key = st.id + ':' + (c ? c.n : 0);
    if (!by.has(key)) {
      by.set(key, {
        id: (m.ref || 'till') + ':' + st.id + ':' + (c ? c.n : 0), offline: true, stationId: st.id, station: st.name, number: 'OFF-' + short,
        label: m.label || '', tableName: m.tableName || '', waiterName: m.waiterName || '', guestName: m.guestName || '', fulfillment: m.fulfillment || '',
        guests: m.guests || null, allergy: (m.allergy && m.allergy.note) || '', allergens: (m.allergy && m.allergy.list) || [], note: m.note || '',
        course: c ? c.n : 0, courseLabel: c ? c.label : '', waits: !!(c && c.waits), sentAt: new Date().toISOString(), items: []
      });
    }
    by.get(key).items.push({
      name: l.name, qty: l.qty, note: l.note || '', seat: l.seat || null, allergens: (m.allergensOf && m.allergensOf(l)) || [],
      mods: (l.modifiers || []).map((x) => ({ how: x.how || 'add', name: x.name }))
    });
  });
  return Array.from(by.values());
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}
// A ticket as the printer's own bytes: ESC/POS, or Star raster for a Star.
export function chitBytes(chit, printer, companyName) {
  const paper = Number(printer.paper) === 58 ? 58 : 80;
  const bytes = buildKitchenChitBytes(chit, companyName, { lineWidth: paper === 58 ? 32 : 42, courseName: chit.courseLabel || '' });
  return printer.language === 'star' ? escPosToStarRaster(bytes, paper === 58 ? 384 : 576) : Uint8Array.from(bytes);
}

// A call to the print hub on the restaurant's network, at each of its
// addresses in turn; given up on after a few seconds.
export async function hubFetch(hub, method, path, body, ms) {
  let last = null;
  for (const url of (hub && hub.urls) || []) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || HUB_MS);
    try {
      const res = await fetch(url + path, {
        // HTTPS (the hub's own certificate): no mixed content. The browser
        // may ask once to let the page reach a device on the local network.
        method, signal: ctl.signal, cache: 'no-store',
        headers: Object.assign({ 'X-Hub-Key': hub.key }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || 'The print hub said no (' + res.status + ')'), { status: res.status });
      return data;
    } catch (e) { last = e; if (e.status) throw e; } finally { clearTimeout(t); }
  }
  throw last || new Error('No print hub');
}
// Whether this device reaches the hub and trusts it (the setup page).
export async function hubPing(hub) {
  try { const r = await hubFetch(hub, 'GET', '/lan/ping', null, 4000); return { ok: !!r.ok, version: r.version || '' }; } catch (e) { return { ok: false, error: e.message }; }
}

// The tickets to the hub: kept there for the kitchen screens, printed on
// each kitchen's printers. → { ok, failed: [printer names not printed] }
// (ok false: the hub could not be reached — the till prints them itself).
export async function hubSend(outage, chits, from, companyName) {
  if (!outage || !outage.hub || !chits.length) return { ok: false, failed: [] };
  const failed = [];
  for (const chit of chits) {
    const mine = (outage.printers || []).filter((p) => (p.stationIds || []).includes(chit.stationId));
    const prints = mine.map((p) => ({ mac: p.mac, ip: p.ip || undefined, port: p.port, title: chit.station + ' #' + chit.number, data: base64(chitBytes(chit, p, companyName)) }));
    const ticket = { ...chit, course: chit.courseLabel || '' };
    try {
      const r = await hubFetch(outage.hub, 'POST', '/lan/tickets', { ticket, prints, from }, 15000);
      (r.results || []).forEach((x) => { if (!x.ok) { const p = mine.find((y) => y.mac === x.mac); failed.push(p ? p.name : x.mac); } });
    } catch (e) {
      if (chit === chits[0]) return { ok: false, failed: [], error: e.message };
      failed.push(chit.station);
    }
  }
  return { ok: true, failed };
}
