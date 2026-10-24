// Deals on a bill (till settings promotions): the same sums as the server's
// (backend restaurantPromos.service.js) — keep the two the same. Used by
// the till's bill (tillBill.js billOf), the kiosk and the website basket.
// No imports: the backend's tests load this file to check both agree.
//
// A deal: { id, name, on, kind: 'percent' | 'amount' | 'buyget', value,
// buy, get, categories, items, minSpend, code, days, from, to, startsOn,
// endsOn, where: { till, kiosk, online } }. One deal per bill: the one that
// saves most. A dish given its own discount or put on the house gets none.

function r2(n) { return Math.round(Number(Number(n || 0).toPrecision(12)) * 100) / 100; }
function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
export function codeOf(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase().slice(0, 24); }
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }

// Ghana keeps GMT all year: the restaurant's clock is UTC (backend restaurantTillTimes isOn).
function windowOn(w, at) {
  const d = at ? new Date(at) : new Date();
  const now = d.getUTCHours() * 60 + d.getUTCMinutes();
  const day = d.getUTCDay();
  const days = w.days && w.days.length ? w.days : null;
  if (!TIME.test(w.from || '') || !TIME.test(w.to || '')) return !days || days.indexOf(day) >= 0;
  const from = mins(w.from), to = mins(w.to);
  if (from === to) return !days || days.indexOf(day) >= 0;
  if (from < to) return now >= from && now < to && (!days || days.indexOf(day) >= 0);
  if (now >= from) return !days || days.indexOf(day) >= 0;
  if (now < to) return !days || days.indexOf((day + 6) % 7) >= 0;
  return false;
}

// Whether a deal is on for this bill now. opts: { channel, code, at, kept }.
export function isOpen(p, opts) {
  opts = opts || {};
  if (opts.kept && opts.kept === p.id) return true;
  if (!p.on || !(p.where || {})[opts.channel || 'till']) return false;
  if (p.code && codeOf(opts.code) !== p.code) return false;
  const day = new Date(opts.at ? new Date(opts.at) : Date.now()).toISOString().slice(0, 10);
  if (p.startsOn && day < p.startsOn) return false;
  if (p.endsOn && day > p.endsOn) return false;
  return windowOn(p, opts.at);
}

function canTake(l) { return !l.fee && !l.comp && !(Number(l.discount) > 0) && Number(l.net) > 0; }
function onDeal(p, l) {
  const cats = p.categories || [], items = p.items || [];
  if (!cats.length && !items.length) return true;
  return (l.menuItemId && items.indexOf(l.menuItemId) >= 0) || cats.some((c) => norm(c) === norm(l.category));
}

// What a deal takes off each line (by index), or null. lines: [{ net, qty,
// fee, comp, discount, menuItemId, category }] — net: after its own discount.
export function savingOf(p, lines) {
  const dishes = r2(lines.filter((l) => !l.fee).reduce((a, l) => a + Number(l.net), 0));
  if (p.minSpend && dishes < p.minSpend) return null;
  const idx = [];
  lines.forEach((l, i) => { if (canTake(l) && onDeal(p, l)) idx.push(i); });
  if (!idx.length) return null;
  let shares = lines.map(() => 0);
  if (p.kind === 'percent') {
    idx.forEach((i) => { shares[i] = r2(Number(lines[i].net) * p.value / 100); });
  } else if (p.kind === 'amount') {
    const base = r2(idx.reduce((a, i) => a + Number(lines[i].net), 0));
    const off = Math.min(base, p.value);
    let left = off;
    idx.forEach((i, k) => {
      const s = k === idx.length - 1 ? left : Math.min(left, r2(off * Number(lines[i].net) / base));
      shares[i] = s; left = r2(left - s);
    });
  } else {
    const units = [];
    idx.forEach((i) => {
      const n = Math.floor(Number(lines[i].qty));
      const each = n > 0 ? Number(lines[i].net) / Number(lines[i].qty) : 0;
      for (let u = 0; u < n; u++) units.push({ i, price: each });
    });
    units.sort((a, b) => b.price - a.price || a.i - b.i);
    const set = p.buy + p.get;
    for (let s0 = 0; s0 + set <= units.length; s0 += set) {
      for (let g = s0 + p.buy; g < s0 + set; g++) shares[units[g].i] = shares[units[g].i] + units[g].price * p.value / 100;
    }
    shares = shares.map(r2);
  }
  const amount = r2(shares.reduce((a, b) => a + b, 0));
  return amount > 0 ? { amount, shares } : null;
}

// The best deal on for these lines: { promo, amount, shares } or null.
export function bestDeal(lines, promotions, opts) {
  let top = null;
  (promotions || []).forEach((p) => {
    if (!isOpen(p, opts)) return;
    const s = savingOf(p, lines);
    if (s && (!top || s.amount > top.amount)) top = { promo: p, amount: s.amount, shares: s.shares };
  });
  return top;
}

// A large party's service charge in place of the usual one (backend restaurantPromos serviceFor).
export function serviceFor(settings, fulfillment, guests) {
  const sc = settings.serviceCharge || {};
  const usual = { on: !!(sc.on && sc.rate > 0 && (sc.types || {})[fulfillment || 'dine_in']), rate: Number(sc.rate) || 0, name: sc.name || 'Service charge', party: false };
  const ps = settings.partyService || {};
  if (ps.on && (fulfillment || 'dine_in') === 'dine_in' && Number(guests) >= ps.minGuests && (!usual.on || ps.rate > usual.rate)) {
    return { on: true, rate: ps.rate, name: ps.name, party: true };
  }
  return usual;
}

// A deal in a few words, for its card: "10% off", "Buy 2, get 1 free", "GHS 20 off".
export function dealWords(p, tr, money) {
  if (p.kind === 'buyget') return p.value >= 100 ? tr('Buy {buy}, get {get} free', { buy: p.buy, get: p.get }) : tr('Buy {buy}, get {get} at {pct}% off', { buy: p.buy, get: p.get, pct: p.value });
  if (p.kind === 'amount') return tr('{amount} off', { amount: money(p.value) });
  return tr('{pct}% off', { pct: p.value });
}
