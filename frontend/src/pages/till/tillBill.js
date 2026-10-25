import { msg } from '../../lib/i18n.jsx';
import { bestDeal, serviceFor } from './promos.js';
// The bill as the till shows it while an order is taken: the same sums as
// the server's (backend restaurantTillCheck compute) — add-ons priced into
// each dish, discounts and dishes on the house, the bill-wide discount
// shared over the dishes (not a delivery fee), the service charge on the
// order types the manager picked, and the taxes, included in the prices or
// added on top (a compound one on the ones before it). The server prices
// the order again when it is sent; this is what the cashier sees meanwhile,
// and what a receipt taken without the internet shows.

// To the pesewa, after floating-point dust (as the server does).
export function r2(n) { return Math.round(Number(Number(n || 0).toPrecision(12)) * 100) / 100; }

// A dish's add-ons in words, in the till's language: tr is lib/i18n's.
export function modsWords(mods, tr) {
  return (mods || []).map((m) => (m.how === 'no' ? tr('No {name}', { name: m.name })
    : m.how === 'extra' ? tr('Extra {name}', { name: m.name })
      : m.how === 'side' ? tr('{name} on the side', { name: m.name }) : m.name)).join(', ');
}
// The service charge's name: the till's own, or the usual words in the
// reader's language.
export function serviceWords(name, tr) { return !name || name === 'Service charge' ? tr('Service charge') : name; }
export function modsPrice(mods) { return r2((mods || []).reduce((a, m) => a + (m.how === 'no' ? 0 : Number(m.price || 0)), 0)); }

// lines: [{ price (unit, with add-ons), qty, fee, discountSpec, comp,
// menuItemId, category }]; adjust: { discount, serviceOff, promoCode, promo
// (a deal kept on the open order) }; settings: the till's (discounts,
// serviceCharge, tax, promotions, partyService); opts: { guests, channel
// ('till', 'kiosk', 'online', 'app': no deals), at }.
export function billOf(lines, adjust, settings, fulfillment, opts) {
  adjust = adjust || {};
  settings = settings || {};
  opts = opts || {};
  // The manager's ready-made discounts, and the happy hours (till/tillService.js).
  // And the loyalty rewards, paid with the customer's points (backend restaurantTillFront rewardPresets).
  const presets = (settings.discounts || []).concat((settings.happyHours || []).map((h) => ({ id: h.id, name: h.name, kind: 'percent', value: h.percent, open: true })),
    settings.loyalty && settings.loyalty.on ? (settings.loyalty.rewards || []).map((r) => ({ id: 'loyalty:' + r.id, name: r.name, kind: r.kind, value: r.value, open: true })) : []);
  const specOf = (d) => {
    if (!d) return null;
    const p = d.presetId && presets.find((x) => x.id === d.presetId);
    return p ? { kind: p.kind, value: p.value, name: p.name } : d.kind ? d : null;
  };
  const out = lines.map((l) => {
    const gross = r2(l.price * l.qty);
    let discount = 0;
    const d = specOf(l.discountSpec);
    if (l.comp) discount = gross;
    else if (d) discount = Math.min(gross, d.kind === 'percent' ? r2(gross * d.value / 100) : Number(d.value));
    return { ...l, gross, discount, net: r2(gross - discount) };
  });
  // A deal (till/promos.js): the best one on for this bill, by itself or
  // with its code; one kept on the open order stays.
  const kept = adjust.promo || null;
  const channel = opts.channel || adjust.channel || (kept && kept.channel) || 'till';
  const deal = channel === 'app' ? null : bestDeal(out, settings.promotions, { channel, code: adjust.promoCode, at: opts.at, kept: kept && kept.id });
  if (deal) {
    out.forEach((l, i) => {
      const s = deal.shares[i];
      if (s) { l.discount = r2(l.discount + s); l.net = r2(l.net - s); l.dealName = deal.promo.name; }
    });
  }
  let billDiscount = 0;
  const bd = specOf(adjust.discount);
  if (bd) {
    const dishes = out.filter((l) => !l.fee && l.net > 0);
    const base = r2(dishes.reduce((a, l) => a + l.net, 0));
    billDiscount = Math.min(base, bd.kind === 'percent' ? r2(base * bd.value / 100) : Number(bd.value));
    let left = billDiscount;
    dishes.forEach((l, i) => {
      const share = i === dishes.length - 1 ? left : Math.min(left, r2(billDiscount * l.net / base));
      l.discount = r2(l.discount + share); l.net = r2(l.net - share);
      left = r2(left - share);
    });
  }
  const itemsGross = r2(out.reduce((a, l) => a + l.gross, 0));
  const subtotal = r2(out.reduce((a, l) => a + l.net, 0));
  const sc = settings.serviceCharge || {};
  // The usual service charge, or a large party's (till settings partyService).
  const svc = serviceFor(settings, fulfillment, opts.guests);
  const scOn = svc.on;
  const service = scOn && !adjust.serviceOff ? r2(out.filter((l) => !l.fee).reduce((a, l) => a + l.net, 0) * svc.rate / 100) : 0;
  const tx = settings.tax || { included: true, list: [] };
  const per = [];
  let running = 0;
  (tx.list || []).forEach((t) => { const a = (t.rate / 100) * (1 + (t.compound ? running : 0)); per.push(a); running += a; });
  const taxedOn = r2(subtotal + (sc.taxed !== false ? service : 0));
  const base0 = tx.included ? taxedOn / (1 + running) : taxedOn;
  const taxes = (tx.list || []).map((t, i) => ({ name: t.name, rate: t.rate, included: !!tx.included, amount: r2(per[i] * base0) })).filter((t) => t.amount > 0);
  const taxSum = r2(taxes.reduce((a, t) => a + t.amount, 0));
  const taxTotal = tx.included ? 0 : taxSum;
  return {
    lines: out, itemsGross, discountTotal: r2(itemsGross - subtotal), billDiscount, billDiscountName: bd ? bd.name : null, subtotal,
    serviceCharge: service, serviceName: svc.name, serviceRate: service > 0 ? svc.rate : 0, serviceOn: scOn, serviceOff: scOn && !!adjust.serviceOff, partyService: svc.party,
    deal: deal ? { id: deal.promo.id, name: deal.promo.name, amount: deal.amount, code: deal.promo.code || '' } : null,
    taxes, taxTotal, taxIncluded: tx.included ? taxSum : 0, total: r2(subtotal + service + taxTotal)
  };
}

// A delivery app's prices (till/AppOrder.jsx; backend restaurantApps
// applyMarkup): each dish, and its add-ons, with the app's markup.
export function withMarkup(lines, markup) {
  if (!markup) return lines;
  const f = 1 + markup / 100;
  return lines.map((l) => ({ ...l, price: r2(l.price * f), modifiers: (l.modifiers || []).map((m) => ({ ...m, price: r2((Number(m.price) || 0) * f) })) }));
}
// A card noted from the bank's terminal (till/CardPay.jsx): its last 4 digits, or none.
export function cardOk(v) { return !v.last4 || v.last4.length === 4; }
// A card on the bank's terminal (backend restaurantTillMoney CARD_BRANDS): its brand and how it was read.
export const CARD_BRANDS = ['Visa', 'Mastercard', 'Verve', 'American Express', 'Other'];
export const CARD_ENTRIES = [['tap', msg('Tap')], ['chip', msg('Chip')], ['swipe', msg('Swipe')]];
// A customer's email, birthday and yes or no to messages, as the forms edit them (till/GuestContact.jsx).
export function contactOf(g) {
  return { email: (g && g.email) || '', birthday: g && g.birthday ? String(g.birthday).slice(0, 10) : '', marketing: (g && g.marketing) || 'unknown' };
}

// What an open order was paid ahead through Paystack, for the pay screen
// (PayDialog paidAhead): on the self-order kiosk, and by guests from the
// table (their part of the bill, with any tip).
export function paidAheadOf(tab) {
  if (!tab) return [];
  return (tab.paidOnKiosk ? [{ ref: tab.paidOnKiosk.ref, amount: tab.paidOnKiosk.amount, tip: 0, payer: '', channel: tab.paidOnKiosk.channel, from: 'kiosk' }] : [])
    .concat((tab.paidAtTable || []).map((p) => ({ ref: p.ref, amount: p.amount, tip: p.tip || 0, payer: p.payer || '', channel: p.channel, from: p.kind === 'online' || p.kind === 'deposit' ? p.kind : 'table' })));
}
// What was paid ahead, in words: on the website, a booking's deposit, at the table or on the kiosk.
export function paidAheadWords(list, amount, tr) {
  const from = (list || []).map((p) => p.from || p.kind || 'table');
  if (from.includes('deposit')) return tr('Deposit paid: {amount}', { amount });
  if (from.length && from.every((f) => f === 'online')) return tr('Paid online: {amount}', { amount });
  if (from.includes('table') || from.includes('online')) return tr('Paid at the table: {amount}', { amount });
  return tr('Paid on the kiosk: {amount}', { amount });
}
