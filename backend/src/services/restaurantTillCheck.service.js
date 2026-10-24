var jwt = require('jsonwebtoken');
var { fail } = require('../utils/errors');
var config = require('../config');
var times = require('./restaurantTillTimes.service');
var promos = require('./restaurantPromos.service');

// The bill on the till (migration 0168), beyond the dishes and their prices
// (restaurantPos priceLines):
//
//   Add-ons    a dish's groups of choices ("Pick a side", "Extras"), each
//              choice with its price; a choice can also be asked for as
//              "no …", "extra …" or "… on the side" (no costs nothing,
//              extra and on the side cost what the choice costs).
//   Discounts  on a dish, or on the whole bill: a percentage or an amount,
//              one of the manager's ready-made discounts or typed at the
//              till; a dish can be "on the house" (comp), with why.
//   Service    the service charge, a percentage of the dishes on the
//              order types the manager picks (dine in, by default); it can
//              be taken off a bill.
//   Taxes      named taxes (VAT and the levies), included in the menu
//              prices or added on top; a tax may be charged on the ones
//              before it (compound), as Ghana's VAT is on the levies.
//
// Who may give a discount, put a dish on the house or take the service
// charge off is the till role's (discount, comp); anyone else asks a
// manager, whose PIN gives an approval for that one thing (approve) that
// the till sends with the order. What an open order was given before
// stays given (it was approved when it was saved).

// To the pesewa, after taking off floating-point dust (0.15 × 1.025 × 100
// is 15.374999…, which is 15.375 to anyone counting money).
function round2(n) { return Math.round(Number(Number(n || 0).toPrecision(12)) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

// ── add-ons ──

var HOWS = ['add', 'no', 'extra', 'side'];
// The active add-on groups of these dishes, with their active choices:
// Map(menuItemId → [{ id, name, minPick, maxPick, options: [{ id, name, price }] }]).
// A combo's slots come first (migration 0183): each a group whose choices
// are other dishes on the menu (combo: true; a choice's menuItemId and
// variationId say which, and its price is what it adds to the combo's).
async function groupsFor(db, itemIds) {
  var out = new Map();
  if (!itemIds.length) return out;
  await comboGroups(db, itemIds, out);
  var rows = (await db.query(
    'SELECT mg.menu_item_id, g.id, g.name, g.min_pick, g.max_pick FROM restaurant_menu_item_modifier_groups mg ' +
    'JOIN restaurant_modifier_groups g ON g.id = mg.group_id WHERE mg.menu_item_id = ANY($1::uuid[]) AND g.active ORDER BY mg.sort_order, g.sort_order, g.name',
    [itemIds])).rows;
  if (!rows.length) return out;
  var opts = (await db.query('SELECT id, group_id, name, price FROM restaurant_modifiers WHERE group_id = ANY($1::uuid[]) AND active ORDER BY sort_order, name',
    [Array.from(new Set(rows.map(function (r) { return r.id; })))])).rows;
  rows.forEach(function (r) {
    if (!out.has(r.menu_item_id)) out.set(r.menu_item_id, []);
    out.get(r.menu_item_id).push({
      id: r.id, name: r.name, minPick: r.min_pick, maxPick: r.max_pick,
      options: opts.filter(function (o) { return o.group_id === r.id; }).map(function (o) { return { id: o.id, name: o.name, price: Number(o.price) }; })
    });
  });
  return out;
}

async function comboGroups(db, itemIds, out) {
  var slots = (await db.query('SELECT id, menu_item_id, name, min_pick, max_pick FROM restaurant_combo_slots WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, name', [itemIds])).rows;
  if (!slots.length) return;
  var opts = (await db.query(
    "SELECT o.id, o.slot_id, o.menu_item_id, o.variation_id, o.extra, m.name AS item, v.name AS size FROM restaurant_combo_options o " +
    'JOIN restaurant_menu_items m ON m.id = o.menu_item_id AND m.active LEFT JOIN restaurant_menu_item_variations v ON v.id = o.variation_id ' +
    'WHERE o.slot_id = ANY($1::uuid[]) ORDER BY o.sort_order, m.name', [slots.map(function (s) { return s.id; })])).rows;
  slots.forEach(function (s) {
    if (!out.has(s.menu_item_id)) out.set(s.menu_item_id, []);
    out.get(s.menu_item_id).push({
      id: s.id, name: s.name, minPick: s.min_pick, maxPick: s.max_pick, combo: true,
      options: opts.filter(function (o) { return o.slot_id === s.id; }).map(function (o) {
        return { id: o.id, name: o.size ? o.item + ' — ' + o.size : o.item, price: Number(o.extra), menuItemId: o.menu_item_id, variationId: o.variation_id || null };
      })
    });
  });
}

// What was picked for a dish, checked against its groups: [{ id, groupId,
// group, name, how, price }] in the menu's order (a combo's pick also
// with the dish it is: menuItemId, variationId). A group's "at least" and
// "at most" count what was added (not "no …").
function pickMods(dishName, groups, asked) {
  asked = Array.isArray(asked) ? asked : [];
  groups = groups || [];
  var picked = [];
  var seen = new Set();
  asked.forEach(function (a) {
    var id = a && (a.id || a);
    var how = a && HOWS.indexOf(a.how) >= 0 ? a.how : 'add';
    var grp = null, opt = null;
    groups.some(function (g) { var o = g.options.find(function (x) { return x.id === id; }); if (o) { grp = g; opt = o; } return !!o; });
    if (!opt) fail('invalid', 'An add-on for ' + dishName + ' is no longer offered. Take it off and pick again.');
    var key = opt.id + ':' + how;
    if (seen.has(key)) return;
    seen.add(key);
    if (grp.combo && how !== 'add') fail('invalid', dishName + ': ' + opt.name + ' is one of the combo\'s choices, picked or not.');
    picked.push(Object.assign({ id: opt.id, groupId: grp.id, group: grp.name, name: opt.name, how: how, price: how === 'no' ? 0 : round2(opt.price) },
      opt.menuItemId ? { menuItemId: opt.menuItemId, variationId: opt.variationId || null, combo: true } : {}));
  });
  groups.forEach(function (g) {
    var n = picked.filter(function (p) { return p.groupId === g.id && p.how === 'add'; }).length;
    if (n < g.minPick) fail('invalid', dishName + ': pick ' + (g.minPick === 1 ? 'one' : g.minPick) + ' from ' + g.name + '.');
    if (g.maxPick && n > g.maxPick) fail('invalid', dishName + ': at most ' + g.maxPick + ' from ' + g.name + '.');
  });
  // In the menu's order, so the same choices make the same line.
  var order = [];
  groups.forEach(function (g) { g.options.forEach(function (o) { order.push(o.id); }); });
  picked.sort(function (a, b) { return order.indexOf(a.id) - order.indexOf(b.id) || HOWS.indexOf(a.how) - HOWS.indexOf(b.how); });
  return picked;
}
function modsPrice(mods) { return round2((mods || []).reduce(function (a, m) { return a + Number(m.price || 0); }, 0)); }
// The same choices make the same key (the kitchen's line, a cart's line).
function modsKey(mods) {
  return (mods || []).length ? JSON.stringify((mods || []).map(function (m) { return [m.how || 'add', m.name]; })) : '';
}
// In words, for a kitchen ticket printed in English and the activity log.
function modsText(mods) {
  return (mods || []).map(function (m) {
    return m.how === 'no' ? 'No ' + m.name : m.how === 'extra' ? 'Extra ' + m.name : m.how === 'side' ? m.name + ' on the side' : m.name;
  }).join(', ');
}
// What a line keeps of its add-ons on an open order: the ids and how.
function modsAsked(mods) { return (mods || []).map(function (m) { return m.how && m.how !== 'add' ? { id: m.id, how: m.how } : { id: m.id }; }); }
// The dishes a line's combo is made of: [{ menuItemId, variationId, qty }] (qty per combo).
function comboParts(mods) {
  var out = [];
  (mods || []).forEach(function (m) {
    if (!m.menuItemId || m.how === 'no') return;
    var had = out.find(function (x) { return x.menuItemId === m.menuItemId && x.variationId === (m.variationId || null); });
    if (had) had.qty += 1; else out.push({ menuItemId: m.menuItemId, variationId: m.variationId || null, qty: 1 });
  });
  return out;
}

// ── approvals ──

var APPROVAL_HOURS = 12;
// What an approval is for: a discount (its kind and size), a dish on the
// house, or the service charge taken off.
function discountSpec(d) { return d.kind + ':' + round2(d.value); }
function approvalToken(companyId, manager, what, spec) {
  return jwt.sign({ t: 'till-ok', c: companyId, m: manager.id, n: manager.first_name + ' ' + manager.last_name, w: what, s: spec },
    config.jwt.secret, { expiresIn: APPROVAL_HOURS + 'h' });
}
// The manager's name, if this approval is for this; null otherwise.
function approvedBy(companyId, token, what, spec) {
  if (!token) return null;
  try {
    var p = jwt.verify(String(token), config.jwt.secret);
    if (p.t !== 'till-ok' || p.c !== companyId || p.w !== what || p.s !== spec) return null;
    return p.n;
  } catch (e) { return null; }
}

// ── discounts, service, taxes ──

// A happy hour still counts this long after it ends, for an order placed in it.
var GRACE_MS = 30 * 60000;

var KINDS = ['percent', 'amount'];
// A discount as the till asked for it: one of the manager's (presetId) or
// typed (kind, value, name). null for none.
function cleanDiscount(d, settings) {
  if (!d) return null;
  if (d.presetId) {
    // The manager's ready-made discounts, and the happy hours (anyone may
    // give one, while it is on: restaurantTillTimes).
    // And the loyalty rewards, paid with a customer's points (restaurantTillFront rewardPresets).
    var p = (settings.discounts || []).concat(times.asPresets(settings), require('./restaurantTillFront.service').rewardPresets(settings)).find(function (x) { return x.id === d.presetId; });
    if (p) return Object.assign({ presetId: p.id, kind: p.kind, value: p.value, name: p.name, open: !!p.open, approval: d.approval || null }, p.happy ? { happy: p.happy } : {}, p.loyalty ? { loyalty: p.loyalty } : {});
    // Taken off the list since it was given: it stays as it was, by its size.
    if (!d.kind) fail('invalid', 'That discount is no longer offered. Pick another.');
  }
  if (KINDS.indexOf(d.kind) < 0) fail('invalid', 'A discount is a percentage or an amount.');
  var value = round2(d.value);
  if (!(value > 0)) fail('invalid', 'Give the discount a size.');
  if (d.kind === 'percent' && value > 100) fail('invalid', 'A discount is at most 100%.');
  if (d.kind === 'amount' && value >= 1000000) fail('invalid', 'That discount is too big.');
  return { kind: d.kind, value: value, name: text(d.name, 60) || (d.kind === 'percent' ? value + '% off' : 'Discount'), open: false, approval: d.approval || null };
}
function cleanComp(c) {
  if (!c) return null;
  var reason = text(c.reason, 120);
  if (reason.length < 2) fail('invalid', 'Say why the dish is on the house.');
  return { reason: reason, approval: c.approval || null };
}
// A line's identity on an open order, whatever its quantity: the dish, its
// size and add-ons by their ids (a dish not on the menu by its name and
// price) — the same however the line came (priced, kept, from the till).
function identity(l) {
  var mods = (l.modifiers || []).map(function (m) { return (m.how || 'add') + ':' + m.id; }).sort().join(',');
  return (l.custom ? 'c:' + String(l.custom.name || l.name || '').toLowerCase() + ':' + round2(l.custom.price != null ? l.custom.price : l.unitPrice) : l.menuItemId + '::' + (l.variationId || '')) + '::' + mods;
}

// Who allowed it: the person signed in, if their role may; the same thing
// on the open order as it was saved; else a manager's approval.
function allow(ctx, what, spec, given, before, label) {
  if (before) return before;
  if (ctx.can[what === 'service' ? 'discount' : what]) return ctx.name;
  var by = approvedBy(ctx.companyId, given, what, spec);
  if (by) return by;
  fail('forbidden', label + ' needs a manager: ask one to approve it with their PIN.');
}

// The bill. lines: priced lines (restaurantPos priceLines: lineTotal is
// before discounts), each perhaps with discount and comp as asked; adjust:
// { discount, serviceOff } for the whole bill; ctx: { companyId, name, can,
// before: { items, adjust } — the open order as saved }. Lines come back
// with gross, discount, discountName, compReason and lineTotal (what is
// paid for them), and the bill with its totals; adjust as it is to keep.
function compute(lines, adjust, settings, fulfillment, ctx) {
  adjust = adjust || {};
  ctx = ctx || { can: {}, before: null };
  var before = ctx.before || { items: [], adjust: {} };
  var approvals = [];

  var out = lines.map(function (l) {
    var gross = round2(l.lineTotal);
    var o = Object.assign({}, l, { gross: gross, discount: 0, discountName: null, compReason: null, discountBy: null });
    var comp = cleanComp(l.comp);
    var disc = comp ? null : cleanDiscount(l.discount, settings);
    if (disc && disc.loyalty) fail('invalid', disc.name + ' is a reward: it goes on the whole bill.');
    var was = before.items.find(function (b) { return identity(b) === identity(l) && (comp ? b.comp && b.comp.reason === comp.reason : disc ? b.discount && discountSpec(b.discount) === discountSpec(disc) : false); });
    if (comp) {
      var cby = allow(ctx, 'comp', 'comp:' + identity(l), comp.approval, was && was.comp && was.comp.by, 'Putting ' + l.name + ' on the house');
      o.discount = gross; o.discountName = 'On the house'; o.compReason = comp.reason; o.discountBy = cby;
      o.comp = { reason: comp.reason, by: cby };
      o.discountAsked = null;
      if (cby !== ctx.name) approvals.push(cby);
    } else if (disc) {
      // A happy hour only while it is on, on its categories (or kept on the open order as it was given).
      if (disc.happy && !(was && was.discount)) {
        // (A website or table order placed in it and taken a little after is still in it.)
        if (!times.isOn(disc.happy, ctx.at) && !times.isOn(disc.happy, Date.now() - GRACE_MS)) fail('conflict', disc.name + ' is not on now (' + disc.happy.from + '–' + disc.happy.to + ').');
        if (disc.happy.categories.length && !disc.happy.categories.some(function (c) { return String(c).toLowerCase() === String(l.category || '').toLowerCase(); })) fail('invalid', disc.name + ' is not on ' + l.name + '.');
      }
      var dby = disc.open ? ctx.name : allow(ctx, 'discount', discountSpec(disc), disc.approval, was && was.discount && was.discount.by, 'A discount on ' + l.name);
      o.discount = Math.min(gross, disc.kind === 'percent' ? round2(gross * disc.value / 100) : disc.value);
      o.discountName = disc.name; o.discountBy = dby;
      o.discountAsked = Object.assign(disc.presetId ? { presetId: disc.presetId } : {}, { kind: disc.kind, value: disc.value, name: disc.name, by: dby });
      o.comp = null;
      if (dby !== ctx.name) approvals.push(dby);
    } else { o.discountAsked = null; o.comp = null; }
    o.lineTotal = round2(gross - o.discount);
    return o;
  });

  // A deal (restaurantPromos): the best one on for this bill, by itself or
  // with its code; one given on an open order stays (kept). Not on a
  // delivery app's order (its own prices).
  var keep = {};
  var keptPromo = before.adjust && before.adjust.promo ? before.adjust.promo : null;
  var channel = ctx.channel || (before.adjust && before.adjust.channel) || (keptPromo && keptPromo.channel) || 'till';
  var promoAmount = 0;
  // (A website or kiosk order on the till keeps its own deals.)
  if (channel === 'online' || channel === 'kiosk') keep.channel = channel;
  if (channel !== 'app') {
    var deal = promos.best(out, settings.promotions, { channel: channel, code: adjust.promoCode, keptCode: before.adjust && before.adjust.promoCode, at: ctx.at, kept: keptPromo && keptPromo.id });
    if (adjust.promoCode) keep.promoCode = promos.codeOf(adjust.promoCode);
    if (deal) {
      out.forEach(function (l, i) {
        var s = deal.shares[i];
        if (!s) return;
        l.discount = round2(l.discount + s); l.lineTotal = round2(l.lineTotal - s);
        if (!l.discountName) l.discountName = deal.promo.name;
      });
      promoAmount = deal.amount;
      keep.promo = { id: deal.promo.id, name: deal.promo.name, amount: deal.amount, channel: channel };
    }
  }

  // The whole bill's discount, shared over its dishes (not a delivery fee).
  var billDisc = cleanDiscount(adjust.discount, settings);
  var billDiscount = 0;
  if (billDisc && billDisc.happy && !(before.adjust && before.adjust.discount) && !times.isOn(billDisc.happy, ctx.at)) fail('conflict', billDisc.name + ' is not on now (' + billDisc.happy.from + '–' + billDisc.happy.to + ').');
  if (billDisc) {
    var wasDisc = before.adjust && before.adjust.discount && discountSpec(before.adjust.discount) === discountSpec(billDisc) ? before.adjust.discount.by : null;
    var bby = billDisc.open ? ctx.name : allow(ctx, 'discount', discountSpec(billDisc), billDisc.approval, wasDisc, 'A discount on the bill');
    var dishes = out.filter(function (l) { return !l.fee && l.lineTotal > 0; });
    var base = round2(dishes.reduce(function (a, l) { return a + l.lineTotal; }, 0));
    billDiscount = Math.min(base, billDisc.kind === 'percent' ? round2(base * billDisc.value / 100) : billDisc.value);
    var left = billDiscount;
    dishes.forEach(function (l, i) {
      var share = i === dishes.length - 1 ? left : Math.min(left, round2(billDiscount * l.lineTotal / base));
      l.discount = round2(l.discount + share); l.lineTotal = round2(l.lineTotal - share);
      if (!l.discountName) l.discountName = billDisc.name;
      left = round2(left - share);
    });
    keep.discount = Object.assign(billDisc.presetId ? { presetId: billDisc.presetId } : {}, { kind: billDisc.kind, value: billDisc.value, name: billDisc.name, by: bby, amount: billDiscount });
    if (bby !== ctx.name) approvals.push(bby);
  }

  var itemsGross = round2(out.reduce(function (a, l) { return a + l.gross; }, 0));
  var subtotal = round2(out.reduce(function (a, l) { return a + l.lineTotal; }, 0));
  var discountTotal = round2(itemsGross - subtotal);

  // The service charge, on this kind of order (or a large party's), unless taken off.
  var sc = settings.serviceCharge || {};
  var svc = promos.serviceFor(settings, fulfillment, ctx.guests);
  var service = 0;
  var serviceOn = svc.on;
  if (serviceOn && adjust.serviceOff) {
    var wasOff = before.adjust && before.adjust.serviceOff ? before.adjust.serviceOff.by : null;
    var sby = allow(ctx, 'service', 'service-off', adjust.serviceOff.approval, wasOff, 'Taking the service charge off');
    keep.serviceOff = { by: sby };
    if (sby !== ctx.name) approvals.push(sby);
    serviceOn = false;
  }
  if (serviceOn) {
    var serviceBase = round2(out.filter(function (l) { return !l.fee; }).reduce(function (a, l) { return a + l.lineTotal; }, 0));
    service = round2(serviceBase * svc.rate / 100);
  }

  // Taxes: per cedi of what they are charged on, then on the bill.
  var tx = settings.tax || { included: true, list: [] };
  var per = [];
  var running = 0;
  (tx.list || []).forEach(function (t) {
    var a = (t.rate / 100) * (1 + (t.compound ? running : 0));
    per.push(a); running += a;
  });
  var taxedOn = round2(subtotal + (sc.taxed !== false ? service : 0));
  var base0 = tx.included ? taxedOn / (1 + running) : taxedOn;
  var taxes = (tx.list || []).map(function (t, i) { return { name: t.name, rate: t.rate, compound: !!t.compound, included: !!tx.included, amount: round2(per[i] * base0) }; })
    .filter(function (t) { return t.amount > 0; });
  var taxSum = round2(taxes.reduce(function (a, t) { return a + t.amount; }, 0));
  var taxAdded = tx.included ? 0 : taxSum;

  return {
    lines: out, itemsGross: itemsGross, discountTotal: discountTotal, billDiscount: billDiscount, subtotal: subtotal,
    serviceCharge: service, serviceName: svc.name, serviceRate: service > 0 ? svc.rate : 0, serviceOff: !!keep.serviceOff, partyService: service > 0 && svc.party,
    promo: keep.promo || null, promoDiscount: promoAmount,
    taxes: taxes, taxTotal: taxAdded, taxIncluded: tx.included ? taxSum : 0,
    total: round2(subtotal + service + taxAdded),
    adjust: keep, approvals: Array.from(new Set(approvals))
  };
}

// What a line keeps on an open order: its discount or comp with who
// allowed it (restaurantPos keepTab).
function keepOnTab(l) {
  var o = {};
  if (l.comp) o.comp = { reason: l.comp.reason, by: l.comp.by };
  else if (l.discountAsked) o.discount = l.discountAsked;
  return o;
}

// A manager's PIN given for one thing (restaurantTillAccess approver): an
// approval the till sends with that discount, comp or service charge
// taken off. p: { what: 'discount' | 'comp' | 'service', discount, line }.
function approval(companyId, manager, p, settings) {
  p = p || {};
  if (p.what === 'service') return { approval: approvalToken(companyId, manager, 'service', 'service-off') };
  if (p.what === 'comp') {
    if (!p.line) fail('invalid', 'Which dish goes on the house?');
    return { approval: approvalToken(companyId, manager, 'comp', 'comp:' + identity(p.line)) };
  }
  if (p.what === 'discount') {
    var d = cleanDiscount(p.discount, settings);
    if (!d) fail('invalid', 'Which discount?');
    return { approval: approvalToken(companyId, manager, 'discount', discountSpec(d)) };
  }
  fail('invalid', 'Approve what?');
}

// The bill's money as a sale keeps it (restaurant_orders, migration 0168).
function saleColumns(c) {
  return {
    discountTotal: c.discountTotal, serviceCharge: c.serviceCharge, taxTotal: c.taxTotal,
    taxes: c.taxes, adjustments: Object.assign({}, c.adjust, c.serviceCharge > 0 ? { service: { name: c.serviceName, rate: c.serviceRate } } : {}, c.taxIncluded > 0 ? { taxIncluded: c.taxIncluded } : {})
  };
}

module.exports = {
  HOWS: HOWS, KINDS: KINDS, groupsFor: groupsFor, pickMods: pickMods, modsPrice: modsPrice, modsKey: modsKey, modsText: modsText, modsAsked: modsAsked, comboParts: comboParts,
  identity: identity, cleanDiscount: cleanDiscount, compute: compute, keepOnTab: keepOnTab, approval: approval, approvedBy: approvedBy, saleColumns: saleColumns
};
