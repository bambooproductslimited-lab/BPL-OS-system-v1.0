var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// The kitchen display (KDS): what the till sends to the kitchen, on a
// screen there (frontend pages/KdsPage.jsx at /kds). Tables in migration
// 0152.
//
// Stations: parts of the kitchen with a screen each ("Chinese kitchen",
// "Bar"), each cooking the menu categories it lists; one may also take
// "everything else". A dish no station takes is not sent (bottled drinks,
// retail); a restaurant with no stations sends nothing — the kitchen
// display is off until one is set up.
//
// Sending (fire): the till sends when an order is kept open (an open
// table, a new round) and when it is charged. For an open table only what
// is new since the last round goes, as a new ticket; a dish taken off
// after it was sent is cancelled on its ticket, so the cook stops. Paying
// the table links its tickets to the sale. Removing an open table, or
// voiding a sale, cancels what was not yet served.
//
// On the screen a cook taps a dish when it is done, or finishes the whole
// ticket for their station; a ticket with every dish done is ready, and
// is served (taken off the screen) from the "ready" lane or the till. A
// served ticket can be called back for half an hour.
//
// The kitchen screen signs in like the till, with a staff PIN
// (restaurantPos.service.js login), so it is scoped to that restaurant.

// The screen colours a ticket by how long it has waited.
// When a ticket turns amber and red comes from the till settings
// (restaurantTillAccess.service.js: 10 and 20 minutes unless changed).
var RECALL_MINUTES = 30;

var access = require('./restaurantTillAccess.service');
var times = require('./restaurantTillTimes.service');
var activity = require('./restaurantActivity.service');
var screens = require('./restaurantKdsScreens.service');
function norm(c) { return String(c == null ? '' : c).trim().toLowerCase(); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
// A dish on a ticket: the menu item and its variation, or a dish not on
// the menu by its name; its add-ons (mods: restaurantTillCheck modsKey, as
// kept on the ticket), its note ("no onions") and its seat — the same dish
// with other add-ons, another note or for another seat is another line.
function lineKey(menuItemId, variationId, name, note, mods, seat) {
  return (menuItemId ? menuItemId + '::' + (variationId || '') : 'custom::' + norm(name)) + '::' + (mods || '') + '::' + norm(note) + '::' + (seat || '');
}
function modsKey(l) { return require('./restaurantTillCheck.service').modsKey(l.modifiers); }
// A dish's add-ons on the screen (mods: [{ how, name }]), when it has any.
function withMods(o, text) { var m = modsOut(text); if (m.length) o.mods = m; return o; }
// A ticket's add-ons for the screen: [{ how, name }].
function modsOut(text) {
  if (!text) return [];
  try { return JSON.parse(text).map(function (m) { return { how: m[0], name: m[1] }; }); } catch (e) { return []; }
}

var WHERE_NAME = { dine_in: 'Dine in', togo: 'To go', pickup: 'Pickup', delivery: 'Delivery' };

async function activeStations(client, companyId) {
  return (await client.query('SELECT * FROM restaurant_kds_stations WHERE company_id = $1 AND active ORDER BY sort_order, name', [companyId])).rows;
}
// The station that cooks a category: the one listing it, else the one
// taking everything else, else none (not sent).
function stationFor(stations, category) {
  var c = norm(category);
  return stations.find(function (s) { return (s.categories || []).some(function (x) { return norm(x) === c; }); }) ||
    stations.find(function (s) { return s.everything_else; }) || null;
}

// A ticket's state from its dishes: cooking while one is cooking, ready
// once all are done, cancelled when none is left. A served ticket stays
// served, and a later course waiting to be called (held) stays held.
async function refresh(client, ticketId) {
  var t = (await client.query('SELECT status FROM restaurant_kitchen_tickets WHERE id = $1', [ticketId])).rows[0];
  if (!t || t.status === 'served') return;
  var c = (await client.query(
    "SELECT count(*) FILTER (WHERE status = 'cooking')::int AS cooking, count(*) FILTER (WHERE status = 'done')::int AS done FROM restaurant_kitchen_items WHERE ticket_id = $1",
    [ticketId])).rows[0];
  if (t.status === 'held') { if (!c.cooking && !c.done) await client.query("UPDATE restaurant_kitchen_tickets SET status = 'cancelled' WHERE id = $1", [ticketId]); return; }
  if (c.cooking > 0) await client.query("UPDATE restaurant_kitchen_tickets SET status = 'cooking', ready_at = NULL WHERE id = $1", [ticketId]);
  else if (c.done > 0) await client.query("UPDATE restaurant_kitchen_tickets SET status = 'ready', ready_at = coalesce(ready_at, now()) WHERE id = $1", [ticketId]);
  else await client.query("UPDATE restaurant_kitchen_tickets SET status = 'cancelled' WHERE id = $1", [ticketId]);
}

// Sends an order to the kitchen. o.lines is the whole order as it stands
// ([{ menuItemId, variationId, name, qty, seat, course }]); for an open
// table (o.tabId) only what is new since the last round is sent and what
// was taken off is cancelled. Runs inside the caller's transaction.
//
// Courses (o.settings.courses, restaurantTillTimes courseOf): with o.hold
// (an open order eaten in), the first course goes now with what goes right
// away, and each later course waits as a ticket of its own (held) until it
// is called (fireCourse) — or is cooked at once when the order has been
// called that far already (o.firedCourse). o.allergy ({ list, note }) and
// o.guests go on the ticket.
//
// Returns the new ticket ({ id, number, dishes, held: [courses waiting],
// firedCourse, ids }) or null.
async function fire(client, companyId, o) {
  var stations = await activeStations(client, companyId);
  if (!stations.length) return null;
  await client.query("SELECT pg_advisory_xact_lock(hashtext('kds:' || $1))", [companyId]);

  var want = new Map();
  // A delivery fee is charged, not cooked (restaurantPos priceLines).
  (o.lines || []).filter(function (l) { return !l.fee; }).forEach(function (l) {
    var k = lineKey(l.menuItemId, l.variationId, l.name, l.note, modsKey(l), l.seat);
    var cur = want.get(k);
    if (cur) cur.qty = round2(cur.qty + Number(l.qty)); else want.set(k, { line: l, qty: round2(l.qty) });
  });
  var sent = new Map();
  if (o.tabId) {
    var rows = (await client.query(
      "SELECT i.* FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id " +
      "WHERE t.company_id = $1 AND t.tab_id = $2 AND i.status <> 'cancelled' ORDER BY i.created_at DESC", [companyId, o.tabId])).rows;
    rows.forEach(function (r) {
      var k = lineKey(r.menu_item_id, r.variation_id, r.name, r.note, r.mods, r.seat);
      if (!sent.has(k)) sent.set(k, []);
      sent.get(k).push(r);
    });
  }

  // Taken off since it was sent: cancel the newest first.
  var touched = new Set();
  for (var entry of sent) {
    var k = entry[0], items = entry[1];
    var have = items.reduce(function (a, r) { return a + Number(r.qty); }, 0);
    var less = round2(have - (want.has(k) ? want.get(k).qty : 0));
    for (var i = 0; i < items.length && less > 0; i++) {
      var it = items[i], q = Number(it.qty), take = Math.min(q, less);
      if (take >= q) {
        await client.query("UPDATE restaurant_kitchen_items SET status = 'cancelled' WHERE id = $1", [it.id]);
      } else {
        await client.query('UPDATE restaurant_kitchen_items SET qty = $2 WHERE id = $1', [it.id, round2(q - take)]);
        await client.query(
          "INSERT INTO restaurant_kitchen_items (ticket_id, station_id, menu_item_id, variation_id, name, category, qty, status, note, mods, seat, course, allergens) VALUES ($1,$2,$3,$4,$5,$6,$7,'cancelled',$8,$9,$10,$11,$12)",
          [it.ticket_id, it.station_id, it.menu_item_id, it.variation_id, it.name, it.category, round2(take), it.note || '', it.mods || '', it.seat, it.course || 0, it.allergens || []]);
      }
      touched.add(it.ticket_id);
      less = round2(less - take);
    }
  }
  for (var tid of touched) await refresh(client, tid);

  // New since the last round.
  var toSend = [];
  want.forEach(function (w, key) {
    var already = (sent.get(key) || []).reduce(function (a, r) { return a + Number(r.qty); }, 0);
    var more = round2(w.qty - already);
    if (more > 0) toSend.push({ line: w.line, qty: more });
  });
  if (!toSend.length) return null;
  var ids = toSend.map(function (s) { return s.line.menuItemId; }).filter(Boolean);
  var menu = new Map((await client.query('SELECT id, category, allergens FROM restaurant_menu_items WHERE id = ANY($1::uuid[])', [ids])).rows.map(function (r) { return [r.id, r]; }));
  var settings = o.settings || {};
  var routed = toSend.map(function (s) {
    // A dish not on the menu is cooked where its category is (picked at
    // the till), else by the station taking everything else.
    var m = s.line.menuItemId ? menu.get(s.line.menuItemId) : null;
    var category = m ? (m.category || '') : String(s.line.category || '');
    return { line: s.line, qty: s.qty, category: category, station: stationFor(stations, category), allergens: m ? (m.allergens || []) : [],
      course: times.courseOf(settings, { course: s.line.course, category: category }) };
  }).filter(function (s) { return s.station; });
  if (!routed.length) return null;

  // What is cooked now, and the courses that wait to be called.
  var firedCourse = Number(o.firedCourse) || 0;
  if (o.hold) {
    var all = (o.lines || []).filter(function (l) { return !l.fee; }).map(function (l) { return times.courseOf(settings, { course: l.course, category: l.category || (menu.get(l.menuItemId) || {}).category }); });
    var first = all.filter(function (c) { return c > 0; }).sort()[0] || 0;
    if (!firedCourse) firedCourse = first;
  }
  var groups = new Map();
  routed.forEach(function (r) {
    var now = !o.hold || r.course === 0 || r.course <= firedCourse;
    var key = now ? 'now' : 'c' + r.course;
    if (!groups.has(key)) groups.set(key, { held: !now, course: now ? (o.hold ? firedCourse : 0) : r.course, items: [] });
    groups.get(key).items.push(r);
  });

  var number = (await client.query(
    "SELECT coalesce(max(number), 0) + 1 AS n FROM restaurant_kitchen_tickets WHERE company_id = $1 AND created_at >= date_trunc('day', now())", [companyId])).rows[0].n;
  var allergy = o.allergy && ((o.allergy.list || []).length || o.allergy.note) ? o.allergy : null;
  var made = [];
  var order = Array.from(groups.values()).sort(function (a, b) { return (a.held - b.held) || a.course - b.course; });
  for (var g = 0; g < order.length; g++) {
    var grp = order[g];
    var ticket = (await client.query(
      'INSERT INTO restaurant_kitchen_tickets (company_id, number, tab_id, order_id, label, table_name, waiter_name, guest_name, note, sent_by, fulfillment, customer_phone, delivery_address, status, course, fired_at, allergy, allergens, guests) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id, number',
      [companyId, number, o.tabId || null, o.orderId || null, String(o.label || '').slice(0, 80), o.tableName || null, o.waiterName || null, o.guestName || null,
        String(o.note == null ? '' : o.note).trim().slice(0, 300), o.sentBy || null, o.fulfillment || '', String(o.customerPhone || '').slice(0, 40), String(o.deliveryAddress || '').slice(0, 300),
        grp.held ? 'held' : 'cooking', grp.course, grp.held ? null : new Date(), allergy ? String(allergy.note || '').slice(0, 200) : '', allergy ? allergy.list || [] : [], o.guests || null])).rows[0];
    for (var j = 0; j < grp.items.length; j++) {
      var r = grp.items[j];
      await client.query(
        'INSERT INTO restaurant_kitchen_items (ticket_id, station_id, menu_item_id, variation_id, name, category, qty, note, mods, seat, course, allergens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [ticket.id, r.station.id, r.line.menuItemId || null, r.line.variationId || null, r.line.name, r.category, r.qty, String(r.line.note || '').slice(0, 140), modsKey(r.line), r.line.seat || null, r.course, r.allergens]);
    }
    made.push({ id: ticket.id, held: grp.held, course: grp.course });
  }
  var first0 = made.find(function (m) { return !m.held; }) || made[0];
  return { id: first0.id, number: number, ids: made.filter(function (m) { return !m.held; }).map(function (m) { return m.id; }),
    held: made.filter(function (m) { return m.held; }).map(function (m) { return m.course; }), firedCourse: firedCourse,
    dishes: routed.map(function (x) {
      var mods = require('./restaurantTillCheck.service').modsText(x.line.modifiers);
      return x.qty + '× ' + x.line.name + (x.line.seat ? ' (seat ' + x.line.seat + ')' : '') + (mods ? ' [' + mods + ']' : '') + (x.line.note ? ' (' + x.line.note + ')' : '') +
        (o.hold && x.course > firedCourse ? ' — waits for course ' + x.course : '');
    }) };
}

// A later course called (restaurantPos fireCourse): an open order's held
// tickets up to that course go to the cooks now. Returns their ids.
async function fireCourse(client, companyId, tabId, upTo) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('kds:' || $1))", [companyId]);
  return (await client.query(
    "UPDATE restaurant_kitchen_tickets SET status = 'cooking', fired_at = now() WHERE company_id = $1 AND tab_id = $2 AND status = 'held' AND course <= $3 RETURNING id",
    [companyId, tabId, upTo])).rows.map(function (r) { return r.id; });
}
// Everything an order has waiting goes now (it is paid: nobody will call it).
async function releaseHeld(client, companyId, where, arg) {
  return (await client.query(
    "UPDATE restaurant_kitchen_tickets SET status = 'cooking', fired_at = now() WHERE company_id = $1 AND " + (where === 'order_id' ? 'order_id' : 'tab_id') + " = $2 AND status = 'held' RETURNING id",
    [companyId, arg])).rows.map(function (r) { return r.id; });
}
// The ticket of each station that prints (no screen there: print_tickets),
// for the till to print when it sends or calls a course: what that station
// cooks of these tickets, with who it is for, its course, seats, add-ons,
// notes and any allergy alert.
async function chitsFor(client, ticketIds) {
  if (!ticketIds || !ticketIds.length) return [];
  var rows = (await client.query(
    "SELECT i.*, s.name AS station_name, t.number, t.label, t.table_name, t.waiter_name, t.guest_name, t.note AS ticket_note, t.fulfillment, t.course AS ticket_course, t.allergy, t.allergens AS ticket_allergens, t.guests, t.created_at AS sent_at " +
    "FROM restaurant_kitchen_items i JOIN restaurant_kds_stations s ON s.id = i.station_id AND s.print_tickets JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id " +
    "WHERE i.ticket_id = ANY($1::uuid[]) AND i.status = 'cooking' ORDER BY s.sort_order, s.name, t.course, i.seat NULLS FIRST, i.created_at", [ticketIds])).rows;
  var by = new Map();
  rows.forEach(function (r) {
    var k = r.station_id + ':' + r.ticket_id;
    if (!by.has(k)) {
      by.set(k, { ticketId: r.ticket_id, station: r.station_name, number: r.number, label: r.label, tableName: r.table_name, waiterName: r.waiter_name, guestName: r.guest_name, note: r.ticket_note || '',
        fulfillment: r.fulfillment || '', course: r.ticket_course, guests: r.guests || null, allergy: r.allergy || '', allergens: r.ticket_allergens || [], sentAt: r.sent_at, items: [] });
    }
    by.get(k).items.push(withMods({ name: r.name, qty: Number(r.qty), note: r.note || '', seat: r.seat || null, allergens: r.allergens || [] }, r.mods));
  });
  return Array.from(by.values());
}
// The tickets a till has in hand to print as it sends them (sent, a course
// called, paid): not printed again from the queue below.
async function markPrinted(client, ticketIds) {
  if (!ticketIds || !ticketIds.length) return;
  await client.query('UPDATE restaurant_kitchen_tickets SET chit_printed_at = coalesce(chit_printed_at, now()) WHERE id = ANY($1::uuid[])', [ticketIds]);
}
// Tickets that reached the kitchen with nobody at the till to print them —
// a website order, a kiosk or table QR order sent straight on, an order for
// later reaching its time — for the stations that print: waiting for a till
// with a kitchen printer. Within the last hour, still cooking.
var QUEUE_SQL = "SELECT t.id FROM restaurant_kitchen_tickets t WHERE t.company_id = $1 AND t.chit_printed_at IS NULL AND t.status = 'cooking' " +
  "AND coalesce(t.fired_at, t.created_at) > now() - interval '60 minutes' " +
  "AND EXISTS (SELECT 1 FROM restaurant_kitchen_items i JOIN restaurant_kds_stations s ON s.id = i.station_id AND s.print_tickets WHERE i.ticket_id = t.id AND i.status = 'cooking')";
// GET /api/pos/kitchen/to-print — what waits (each station's ticket).
async function printQueue(token) {
  var session = await access.need(token, 'till');
  var ids = (await pool.query(QUEUE_SQL + ' ORDER BY t.created_at', [session.posCompanyId])).rows.map(function (r) { return r.id; });
  return { chits: await chitsFor(pool, ids) };
}
// POST /api/pos/kitchen/to-print { ids } — this till prints them now: taken
// off the queue first, so two tills never print the same ticket. Returns
// the tickets it took (an empty list when another till took them).
async function takePrints(token, p) {
  var session = await access.need(token, 'till');
  var ids = Array.isArray((p || {}).ids) ? p.ids.filter(function (x) { return typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x); }).slice(0, 50) : [];
  if (!ids.length) fail('invalid', 'Say which tickets to print.');
  return withTransaction(async function (client) {
    var took = (await client.query('UPDATE restaurant_kitchen_tickets SET chit_printed_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[]) AND chit_printed_at IS NULL RETURNING id, number',
      [session.posCompanyId, ids])).rows;
    if (took.length) {
      await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'till', action: 'till.kitchenPrinted',
        summary: (took.length === 1 ? 'Kitchen ticket #' + took[0].number : 'Kitchen tickets ' + took.map(function (t) { return '#' + t.number; }).join(', ')) + ' printed at the kitchen printer.', refType: 'ticket', refId: took[0].id });
    }
    return { chits: await chitsFor(client, took.map(function (t) { return t.id; })) };
  });
}

// Dishes leaving an open order for another bill (restaurantPos: paid on
// their own, moved to another order): what the kitchen has of them goes
// with them, on a twin of each ticket they were on — the same number and
// times, the new bill's table and names — so the kitchen keeps cooking
// them and neither order thinks they were taken off or added. lines:
// [{ menuItemId, variationId, name, note, modifiers, qty }]; dest: { tabId
// or orderId, label, tableName, waiterName, guestName }.
async function moveItems(client, companyId, fromTabId, lines, dest) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('kds:' || $1))", [companyId]);
  var twins = new Map();
  var touched = new Set();
  async function twinOf(ticketId) {
    if (twins.has(ticketId)) return twins.get(ticketId);
    var t = (await client.query('SELECT * FROM restaurant_kitchen_tickets WHERE id = $1', [ticketId])).rows[0];
    var id = (await client.query(
      'INSERT INTO restaurant_kitchen_tickets (company_id, number, tab_id, order_id, label, table_name, waiter_name, guest_name, note, sent_by, fulfillment, customer_phone, delivery_address, status, created_at, ready_at, served_at, printed_at, ' +
      '  course, fired_at, allergy, allergens, guests, chit_printed_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING id',
      [companyId, t.number, dest.tabId || null, dest.orderId || null, String(dest.label || t.label || '').slice(0, 80), dest.tableName !== undefined ? dest.tableName : t.table_name,
        dest.waiterName !== undefined ? dest.waiterName : t.waiter_name, dest.guestName !== undefined ? dest.guestName : t.guest_name, t.note, t.sent_by, t.fulfillment, t.customer_phone, t.delivery_address,
        // Paid on their own: a course still waiting is cooked now.
        t.status === 'held' && dest.orderId ? 'cooking' : t.status, t.created_at, t.ready_at, t.served_at, t.printed_at,
        t.course || 0, t.status === 'held' && dest.orderId ? new Date() : t.fired_at, t.allergy || '', t.allergens || [], t.guests,
        // Printed with the order it came from, or still waiting to be (printQueue).
        t.chit_printed_at])).rows[0].id;
    twins.set(ticketId, id);
    return id;
  }
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (l.fee) continue;
    var key = lineKey(l.menuItemId, l.variationId, l.name, l.note, modsKey(l), l.seat);
    var rows = (await client.query(
      "SELECT i.* FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id WHERE t.company_id = $1 AND t.tab_id = $2 AND i.status <> 'cancelled' ORDER BY i.created_at DESC",
      [companyId, fromTabId])).rows.filter(function (r) { return lineKey(r.menu_item_id, r.variation_id, r.name, r.note, r.mods, r.seat) === key; });
    var left = round2(l.qty);
    for (var j = 0; j < rows.length && left > 0; j++) {
      var r = rows[j], q = Number(r.qty), take = Math.min(q, left);
      var twin = await twinOf(r.ticket_id);
      if (take >= q) await client.query('UPDATE restaurant_kitchen_items SET ticket_id = $2 WHERE id = $1', [r.id, twin]);
      else {
        await client.query('UPDATE restaurant_kitchen_items SET qty = $2 WHERE id = $1', [r.id, round2(q - take)]);
        await client.query(
          'INSERT INTO restaurant_kitchen_items (ticket_id, station_id, menu_item_id, variation_id, name, category, qty, status, note, mods, done_at, created_at, seat, course, allergens) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
          [twin, r.station_id, r.menu_item_id, r.variation_id, r.name, r.category, round2(take), r.status, r.note || '', r.mods || '', r.done_at, r.created_at, r.seat, r.course || 0, r.allergens || []]);
      }
      touched.add(r.ticket_id);
      left = round2(left - take);
    }
  }
  // A ticket left with nothing goes (it all moved); the rest show what they hold now.
  for (var tid of touched) {
    var n = (await client.query('SELECT count(*)::int AS n FROM restaurant_kitchen_items WHERE ticket_id = $1', [tid])).rows[0].n;
    if (!n) await client.query('DELETE FROM restaurant_kitchen_tickets WHERE id = $1', [tid]);
    else await refresh(client, tid);
  }
  for (var tw of twins.values()) await refresh(client, tw);
}
// A whole open order joined to another, or moved to another table: its
// tickets now belong to it, and say where its food goes (not yet served).
async function retarget(client, companyId, fromTabId, toTabId, names) {
  await client.query('UPDATE restaurant_kitchen_tickets SET tab_id = $3 WHERE company_id = $1 AND tab_id = $2', [companyId, fromTabId, toTabId]);
  await client.query('UPDATE restaurant_kitchen_tickets SET label = $3, table_name = $4, waiter_name = $5 WHERE company_id = $1 AND tab_id = $2 AND served_at IS NULL',
    [companyId, toTabId, String(names.label || '').slice(0, 80), names.tableName || null, names.waiterName || null]);
}

// An open table removed, or a sale voided: what the kitchen has not
// served yet is cancelled.
async function cancelUnserved(client, companyId, where, arg) {
  var tickets = (await client.query(
    "SELECT id FROM restaurant_kitchen_tickets WHERE company_id = $1 AND " + where + " = $2 AND status <> 'served' AND served_at IS NULL", [companyId, arg])).rows;
  for (var i = 0; i < tickets.length; i++) {
    await client.query("UPDATE restaurant_kitchen_items SET status = 'cancelled' WHERE ticket_id = $1 AND status <> 'cancelled'", [tickets[i].id]);
    await refresh(client, tickets[i].id);
  }
  return tickets.length;
}
function cancelForTab(client, companyId, tabId) { return cancelUnserved(client, companyId, 'tab_id', tabId); }
function cancelForOrder(client, companyId, orderId) { return cancelUnserved(client, companyId, 'order_id', orderId); }

// ── the kitchen screen ─────────────────────────────────────────────────

function minutesSince(ts, now) { return ts ? Math.max(0, Math.floor((now - new Date(ts).getTime()) / 60000)) : null; }

// A ticket on the screen: its course (and when it was called), how many
// sat down, any allergy alert, and each dish's seat and allergens. Its
// time runs from when it was called, for a course that waited.
function ticketOut(t, items, stationId, now) {
  var mine = items.filter(function (i) { return !stationId || i.station_id === stationId; });
  var others = items.filter(function (i) { return stationId && i.station_id !== stationId && i.status === 'cooking'; });
  return {
    id: t.id, number: t.number, label: t.label, tableName: t.table_name, waiterName: t.waiter_name, guestName: t.guest_name, note: t.note,
    fulfillment: t.fulfillment || '', customerPhone: t.customer_phone || '', deliveryAddress: t.delivery_address || '', printedAt: t.printed_at || null,
    status: t.status, createdAt: t.created_at, readyAt: t.ready_at, servedAt: t.served_at, cleared: !!t.served_at,
    course: t.course || 0, firedAt: t.fired_at || null, guests: t.guests || null, allergy: t.allergy || '', allergens: t.allergens || [],
    waitedMinutes: minutesSince(t.status === 'held' ? null : (t.fired_at || t.created_at), now),
    items: mine.map(function (i) {
      return withMods({ id: i.id, name: i.name, qty: Number(i.qty), note: i.note || '', status: i.status, stationId: i.station_id, stationName: i.station_name || null, category: i.category, doneAt: i.done_at,
        seat: i.seat || null, allergens: i.allergens || [] }, i.mods);
    }),
    elsewhere: others.map(function (i) { return withMods({ name: i.name, qty: Number(i.qty), note: i.note || '', stationName: i.station_name || null }, i.mods); })
  };
}

// GET /api/pos/kds — what is cooking, ready and lately served, for the
// kitchen screen's station (set by a manager, restaurantKdsScreens), or —
// asked from elsewhere — ?station=<id|all>.
async function board(token, opts) {
  var session = await access.need(token, 'kds');
  var company = session.posCompanyId;
  var screen = await screens.forSession(session);
  var stations = await activeStations(pool, company);
  var stationId = screen ? screen.station_id : opts && opts.station && opts.station !== 'all' ? String(opts.station) : null;
  if (stationId && !stations.some(function (s) { return s.id === stationId; })) fail('notfound', 'That station is not set up any more. Pick another.');
  var now = Date.now();
  var tickets = (await pool.query(
    "SELECT * FROM restaurant_kitchen_tickets WHERE company_id = $1 AND created_at > now() - interval '36 hours' " +
    "AND (served_at IS NULL OR served_at > now() - ($2 || ' minutes')::interval) ORDER BY created_at, number", [company, String(RECALL_MINUTES)])).rows;
  var items = tickets.length ? (await pool.query(
    'SELECT i.*, s.name AS station_name FROM restaurant_kitchen_items i LEFT JOIN restaurant_kds_stations s ON s.id = i.station_id ' +
    'WHERE i.ticket_id = ANY($1::uuid[]) ORDER BY i.created_at, i.name', [tickets.map(function (t) { return t.id; })])).rows : [];
  var byTicket = new Map();
  items.forEach(function (i) { if (!byTicket.has(i.ticket_id)) byTicket.set(i.ticket_id, []); byTicket.get(i.ticket_id).push(i); });

  var cooking = [], ready = [], recent = [], held = [];
  tickets.forEach(function (t) {
    var its = byTicket.get(t.id) || [];
    var mine = its.filter(function (i) { return !stationId || i.station_id === stationId; });
    if (!mine.length) return;
    var out = ticketOut(t, its, stationId, now);
    if (t.served_at) { recent.push(out); return; }
    // A later course, waiting to be called: shown so the cooks see it coming.
    if (t.status === 'held') { held.push(out); return; }
    var mineCooking = mine.some(function (i) { return i.status === 'cooking'; });
    if (mineCooking || t.status === 'cancelled') cooking.push(out);
    else ready.push(out);
  });
  recent.sort(function (a, b) { return new Date(b.servedAt) - new Date(a.servedAt); });
  return {
    now: new Date(now).toISOString(), station: stationId || 'all',
    screen: screen ? { id: screen.id, name: screen.name, stationId: screen.station_id, stationName: screen.station_name || null } : null,
    stations: stations.map(function (s) { return { id: s.id, name: s.name }; }),
    timing: session.access.settings.kitchen,
    printReady: !!session.access.settings.kitchen.printReady,
    cooking: cooking, ready: ready, recent: recent.slice(0, 12), held: held,
    courses: session.access.settings.courses.on ? session.access.settings.courses.names : [],
    counts: { cooking: cooking.filter(function (t) { return t.status !== 'cancelled'; }).length, ready: ready.length, held: held.length }
  };
}

async function ticketOfCompany(client, company, id) {
  var t = (await client.query('SELECT * FROM restaurant_kitchen_tickets WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, company])).rows[0];
  if (!t) fail('notfound', 'That ticket is no longer on the screen.');
  return t;
}

// POST /api/pos/kds/items/:id { done } — a dish done, or back to cooking.
async function setItemDone(token, itemId, done) {
  var session = await access.need(token, 'kds');
  return textWhenReady(session, await withTransaction(async function (client) {
    var it = (await client.query(
      'SELECT i.*, t.company_id, t.served_at FROM restaurant_kitchen_items i JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id WHERE i.id = $1 FOR UPDATE OF i', [itemId])).rows[0];
    if (!it || it.company_id !== session.posCompanyId) fail('notfound', 'That dish is no longer on the screen.');
    if (it.status === 'cancelled') fail('invalid', 'That dish was taken off the order.');
    if (it.served_at) fail('invalid', 'That ticket has been served. Call it back first.');
    if (done) await client.query("UPDATE restaurant_kitchen_items SET status = 'done', done_at = coalesce(done_at, now()) WHERE id = $1", [itemId]);
    else await client.query("UPDATE restaurant_kitchen_items SET status = 'cooking', done_at = NULL WHERE id = $1", [itemId]);
    var before = (await client.query('SELECT number, status FROM restaurant_kitchen_tickets WHERE id = $1', [it.ticket_id])).rows[0];
    await refresh(client, it.ticket_id);
    var status = (await client.query('SELECT status FROM restaurant_kitchen_tickets WHERE id = $1', [it.ticket_id])).rows[0].status;
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'kds', action: done ? 'kds.dish_done' : 'kds.dish_back',
      summary: (done ? 'Done: ' : 'Back to cooking: ') + Number(it.qty) + '× ' + it.name + ' on #' + before.number + '.', refType: 'ticket', refId: it.ticket_id });
    if (status === 'ready' && before.status !== 'ready') await logReady(client, session, it.ticket_id);
    return { ticketId: it.ticket_id, status: status, nowReady: status === 'ready' && before.status !== 'ready' };
  }));
}

// POST /api/pos/kds/tickets/:id/done { station } — every dish of a ticket
// done, for one station or all.
async function finishTicket(token, ticketId, stationId) {
  var session = await access.need(token, 'kds');
  var screen = await screens.forSession(session);
  if (screen) stationId = screen.station_id || 'all';
  return textWhenReady(session, await withTransaction(async function (client) {
    var t = await ticketOfCompany(client, session.posCompanyId, ticketId);
    if (t.served_at) fail('invalid', 'That ticket has been served already.');
    if (stationId && stationId !== 'all') {
      await client.query("UPDATE restaurant_kitchen_items SET status = 'done', done_at = now() WHERE ticket_id = $1 AND station_id = $2 AND status = 'cooking'", [ticketId, stationId]);
    } else {
      await client.query("UPDATE restaurant_kitchen_items SET status = 'done', done_at = now() WHERE ticket_id = $1 AND status = 'cooking'", [ticketId]);
    }
    await refresh(client, ticketId);
    var status = (await client.query('SELECT status FROM restaurant_kitchen_tickets WHERE id = $1', [ticketId])).rows[0].status;
    if (status === 'ready' && t.status !== 'ready') await logReady(client, session, ticketId);
    else await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'kds', action: 'kds.station_done',
      summary: '#' + t.number + ' done at this station; another is still cooking.', refType: 'ticket', refId: ticketId });
    return { ticketId: ticketId, status: status, nowReady: status === 'ready' && t.status !== 'ready' };
  }));
}

// "Your food is ready": a pickup customer with a phone, texted once when
// the kitchen has every ticket of their order ready (the till's settings,
// readyText) — by SMS when the server can send it, else a WhatsApp link the
// till shows beside the ticket. After the kitchen's change is saved: a text
// that does not go never undoes it.
function fillIn(message, t, company) {
  var first = String(t.guest_name || t.label || '').trim().split(' ')[0] || 'there';
  return String(message).replace(/\{name\}/g, first).replace(/\{number\}/g, '#' + t.number).replace(/\{restaurant\}/g, company);
}
async function readyText(companyId, ticketId) {
  var settings = (await access.settingsOf(companyId)).readyText;
  if (!settings.on) return null;
  var t = (await pool.query('SELECT t.*, c.name AS company_name FROM restaurant_kitchen_tickets t JOIN companies c ON c.id = t.company_id WHERE t.id = $1', [ticketId])).rows[0];
  if (!t || (t.fulfillment !== 'pickup' && t.fulfillment !== 'togo') || !t.customer_phone || t.status !== 'ready') return null;
  var by = t.tab_id ? 'tab_id' : 'order_id', key = t.tab_id || t.order_id;
  if (!key) return null;
  var others = (await pool.query("SELECT count(*) FILTER (WHERE status IN ('cooking', 'held'))::int AS cooking, count(*) FILTER (WHERE ready_text IS NOT NULL)::int AS texted " +
    'FROM restaurant_kitchen_tickets WHERE company_id = $1 AND ' + by + ' = $2', [companyId, key])).rows[0];
  if (others.cooking > 0 || others.texted > 0) return null;
  var digits = require('../utils/phone').internationalNumber(t.customer_phone);
  if (!digits) return null;
  var words = fillIn(settings.message, t, t.company_name);
  var sms = require('./sms.service');
  var out = { channel: 'whatsapp', to: '+' + digits, at: new Date().toISOString() };
  if (sms.configured()) {
    try { await sms.send({ to: '+' + digits, message: words, purpose: 'order_ready', refId: t.id }); out = { channel: 'sms', to: '+' + digits, at: out.at, status: 'sent' }; }
    catch (e) { out.error = String(e.message).slice(0, 200); }
  }
  if (out.channel === 'whatsapp') out.url = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(words);
  // Once: the first to claim it texts (a second ready at the same moment finds it claimed).
  var claimed = (await pool.query('UPDATE restaurant_kitchen_tickets SET ready_text = $2 WHERE id = $1 AND ready_text IS NULL RETURNING id', [t.id, JSON.stringify(out)])).rows[0];
  if (!claimed) return null;
  await activity.log(pool, { companyId: companyId, employeeId: null, app: 'kds', action: 'kds.ready_text',
    summary: '#' + t.number + ' ready: ' + (out.channel === 'sms' ? 'texted ' + (t.guest_name || t.label || 'the customer') + '.' : 'a WhatsApp message to send to ' + (t.guest_name || t.label || 'the customer') + ' is on the till.'), refType: 'ticket', refId: t.id });
  return out;
}
async function textWhenReady(session, result) {
  if (result.nowReady) {
    try { result.readyText = await readyText(session.posCompanyId, result.ticketId); } catch (e) { result.readyText = null; }
  }
  delete result.nowReady;
  return result;
}

// A ticket's food is all done: in the activity report, by who finished it.
async function logReady(client, session, ticketId) {
  var t = (await client.query('SELECT number, label, table_name, fulfillment FROM restaurant_kitchen_tickets WHERE id = $1', [ticketId])).rows[0];
  await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'kds', action: 'kds.ready',
    summary: '#' + t.number + ' ready' + (t.table_name || t.label ? ' for ' + (t.table_name || t.label) : '') + (t.fulfillment ? ' (' + WHERE_NAME[t.fulfillment] + ')' : '') + '.', refType: 'ticket', refId: ticketId });
}

// POST /api/pos/kds/tickets/:id/served { from: 'till' | 'kds' } — taken
// out to the table (a ready ticket), or a cancelled one cleared off the
// screen; from the kitchen screen or the till.
async function serveTicket(token, ticketId, from) {
  var session = await access.need(token, ['kds', 'till']);
  return withTransaction(async function (client) {
    var t = await ticketOfCompany(client, session.posCompanyId, ticketId);
    if (t.served_at) return { ticketId: ticketId, status: t.status };
    if (t.status === 'cooking') fail('invalid', 'Some dishes on #' + t.number + ' are still cooking.');
    if (t.status === 'held') fail('invalid', '#' + t.number + ' waits to be called: nothing is cooked yet.');
    if (t.status === 'cancelled') await client.query('UPDATE restaurant_kitchen_tickets SET served_at = now() WHERE id = $1', [ticketId]);
    else await client.query("UPDATE restaurant_kitchen_tickets SET status = 'served', served_at = now() WHERE id = $1", [ticketId]);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: from === 'till' ? 'till' : 'kds',
      action: t.status === 'cancelled' ? 'kds.cleared' : 'kds.served',
      summary: (t.status === 'cancelled' ? 'Cancelled #' : 'Served #') + t.number + (t.table_name || t.label ? ' (' + (t.table_name || t.label) + ')' : '') + '.', refType: 'ticket', refId: ticketId });
    return { ticketId: ticketId, status: t.status === 'cancelled' ? 'cancelled' : 'served' };
  });
}

// POST /api/pos/kds/tickets/:id/recall — a served ticket back on the
// screen (served by mistake), as it was before.
async function recallTicket(token, ticketId) {
  var session = await access.need(token, 'kds');
  return withTransaction(async function (client) {
    var t = await ticketOfCompany(client, session.posCompanyId, ticketId);
    if (!t.served_at) return { ticketId: ticketId, status: t.status };
    if (Date.now() - new Date(t.served_at).getTime() > RECALL_MINUTES * 60000) fail('invalid', 'That ticket was served too long ago to call back.');
    await client.query("UPDATE restaurant_kitchen_tickets SET served_at = NULL, status = CASE WHEN status = 'served' THEN 'ready' ELSE status END WHERE id = $1", [ticketId]);
    await refresh(client, ticketId);
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'kds', action: 'kds.recalled',
      summary: '#' + t.number + ' brought back on the screen.', refType: 'ticket', refId: ticketId });
    return { ticketId: ticketId, status: (await client.query('SELECT status FROM restaurant_kitchen_tickets WHERE id = $1', [ticketId])).rows[0].status };
  });
}

// POST /api/pos/kds/tickets/:id/printed — the ticket printed for the
// runner when its food is done: the whole order as it stands (every
// station's dishes), who it is for and where it goes. Returns what to print.
async function printTicket(token, ticketId) {
  var session = await access.need(token, ['kds', 'till']);
  return withTransaction(async function (client) {
    var t = await ticketOfCompany(client, session.posCompanyId, ticketId);
    await client.query('UPDATE restaurant_kitchen_tickets SET printed_at = now() WHERE id = $1', [ticketId]);
    var items = (await client.query(
      "SELECT i.*, s.name AS station_name FROM restaurant_kitchen_items i LEFT JOIN restaurant_kds_stations s ON s.id = i.station_id WHERE i.ticket_id = $1 AND i.status <> 'cancelled' ORDER BY i.created_at, i.name",
      [ticketId])).rows;
    var sender = t.sent_by ? (await client.query("SELECT first_name || ' ' || last_name AS n FROM employees WHERE id = $1", [t.sent_by])).rows[0] : null;
    await activity.log(client, { companyId: session.posCompanyId, employeeId: session.posEmployeeId, app: 'kds', action: 'kds.printed',
      summary: 'Ticket #' + t.number + ' printed for ' + (t.table_name || t.label || t.guest_name || 'the counter') + '.', refType: 'ticket', refId: ticketId });
    var out = ticketOut(Object.assign({}, t, { printed_at: new Date() }), items, null, Date.now());
    out.sentBy = sender ? sender.n : null;
    out.printedBy = null;
    return out;
  });
}

// GET /api/pos/kitchen — for the till: whether the kitchen display is in
// use here, and what is ready to take out (a delivery's ticket says whether
// it has gone out with a rider, and a website order's its number, so the
// till can ask to send it: restaurantDelivery send).
async function tillSummary(token) {
  var session = await access.need(token, 'till');
  var company = session.posCompanyId;
  var inUse = (await pool.query('SELECT 1 FROM restaurant_kds_stations WHERE company_id = $1 AND active LIMIT 1', [company])).rows.length > 0;
  if (!inUse) return { inUse: false, cooking: 0, ready: [] };
  var rows = (await pool.query(
    "SELECT t.*, (SELECT coalesce(sum(qty), 0) FROM restaurant_kitchen_items i WHERE i.ticket_id = t.id AND i.status = 'done') AS dishes, " +
    "(SELECT d.id FROM restaurant_deliveries d WHERE d.status <> 'cancelled' AND ((t.tab_id IS NOT NULL AND d.tab_id = t.tab_id) OR (t.order_id IS NOT NULL AND d.order_id = t.order_id)) LIMIT 1) AS delivery_id, " +
    "(SELECT o.number FROM restaurant_online_orders o WHERE t.tab_id IS NOT NULL AND o.tab_id = t.tab_id LIMIT 1) AS online_number " +
    "FROM restaurant_kitchen_tickets t WHERE t.company_id = $1 AND t.served_at IS NULL AND t.status IN ('cooking', 'ready') AND t.created_at > now() - interval '36 hours' ORDER BY coalesce(t.ready_at, t.created_at)",
    [company])).rows;
  var now = Date.now();
  return {
    inUse: true,
    cooking: rows.filter(function (r) { return r.status === 'cooking'; }).length,
    ready: rows.filter(function (r) { return r.status === 'ready'; }).map(function (r) {
      return { id: r.id, number: r.number, label: r.label, tableName: r.table_name, waiterName: r.waiter_name, guestName: r.guest_name,
        fulfillment: r.fulfillment || '', customerPhone: r.customer_phone || '', deliveryAddress: r.delivery_address || '',
        tabId: r.tab_id, orderId: r.order_id, deliveryId: r.delivery_id || null, onlineRef: r.online_number ? 'W-' + String(r.online_number).padStart(4, '0') : null,
        dishes: Number(r.dishes), readyAt: r.ready_at, waitingMinutes: minutesSince(r.ready_at, now), readyText: r.ready_text || null };
    })
  };
}

// Where the food of open orders (tabs) or sales stands, for tags on the
// till: { [id]: { state: cooking|ready|served, tickets, cooking, ready,
// served } }. by: 'tab_id' or 'order_id'.
async function statusOf(db, companyId, by, ids) {
  var out = {};
  if (!ids.length) return out;
  var col = by === 'order_id' ? 'order_id' : 'tab_id';
  var rows = (await (db || pool).query(
    'SELECT ' + col + " AS id, count(*)::int AS tickets, count(*) FILTER (WHERE status = 'cooking' AND served_at IS NULL)::int AS cooking, " +
    "array_remove(array_agg(DISTINCT course) FILTER (WHERE status = 'held'), NULL) AS held, " +
    "count(*) FILTER (WHERE status = 'ready' AND served_at IS NULL)::int AS ready, count(*) FILTER (WHERE status = 'served')::int AS served, " +
    "max(served_at) AS served_at, max(ready_at) FILTER (WHERE served_at IS NULL) AS ready_at FROM restaurant_kitchen_tickets " +
    'WHERE company_id = $1 AND ' + col + " = ANY($2::uuid[]) AND status <> 'cancelled' GROUP BY 1", [companyId, ids])).rows;
  rows.forEach(function (r) {
    out[r.id] = {
      state: r.cooking > 0 ? 'cooking' : r.ready > 0 ? 'ready' : (r.held || []).length ? 'held' : r.served > 0 ? 'served' : null,
      held: (r.held || []).map(Number).sort(),
      tickets: r.tickets, cooking: r.cooking, ready: r.ready, served: r.served, servedAt: r.served_at || null, readyAt: r.ready_at || null
    };
  });
  return out;
}

// ── management: stations and how the kitchen is doing ─────────────────

function stationOut(s) {
  return { id: s.id, name: s.name, categories: s.categories || [], everythingElse: s.everything_else, sortOrder: s.sort_order, active: s.active, printTickets: !!s.print_tickets };
}

async function requireCompany(companyId) {
  var c = (await pool.query('SELECT id, name, code FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c) fail('notfound', 'Company not found.');
  return c;
}

// GET /api/restaurant/kitchen?companyId= — the stations, the menu's
// categories and which station cooks each, and today in the kitchen.
async function kitchenOverview(ctx, companyId) {
  if (!ctx.can('restaurant.read')) fail('forbidden', 'Your role does not allow this action (restaurant.read).');
  var company = await requireCompany(companyId);
  var timing = (await access.settingsOf(company.id)).kitchen;
  var stations = (await pool.query('SELECT * FROM restaurant_kds_stations WHERE company_id = $1 ORDER BY sort_order, name', [company.id])).rows;
  var active = stations.filter(function (s) { return s.active; });
  var cats = (await pool.query(
    "SELECT coalesce(category, '') AS category, count(*)::int AS n FROM restaurant_menu_items WHERE company_id = $1 AND active GROUP BY 1 ORDER BY 1", [company.id])).rows;
  var categories = cats.map(function (c) {
    var s = stationFor(active, c.category);
    return { name: c.category, items: c.n, stationId: s ? s.id : null, stationName: s ? s.name : null };
  });

  var today = (await pool.query(
    "SELECT count(*)::int AS tickets, count(*) FILTER (WHERE status = 'cooking')::int AS cooking, count(*) FILTER (WHERE status = 'ready' AND served_at IS NULL)::int AS ready, " +
    "count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled, " +
    "avg(extract(epoch FROM ready_at - coalesce(fired_at, created_at)) / 60) FILTER (WHERE ready_at IS NOT NULL) AS avg_ready, " +
    "max(extract(epoch FROM ready_at - coalesce(fired_at, created_at)) / 60) FILTER (WHERE ready_at IS NOT NULL) AS max_ready, " +
    "count(*) FILTER (WHERE ready_at IS NOT NULL AND ready_at - coalesce(fired_at, created_at) > ($2 || ' minutes')::interval)::int AS late " +
    "FROM restaurant_kitchen_tickets WHERE company_id = $1 AND created_at >= date_trunc('day', now())", [company.id, String(timing.lateAfter)])).rows[0];
  var byStation = (await pool.query(
    "SELECT s.id, s.name, count(i.id)::int AS dishes, count(i.id) FILTER (WHERE i.status = 'cooking' AND t.status <> 'held')::int AS cooking, " +
    "avg(extract(epoch FROM i.done_at - coalesce(t.fired_at, t.created_at)) / 60) FILTER (WHERE i.status = 'done') AS avg_done " +
    "FROM restaurant_kds_stations s LEFT JOIN restaurant_kitchen_items i ON i.station_id = s.id AND i.status <> 'cancelled' " +
    "  AND i.ticket_id IN (SELECT id FROM restaurant_kitchen_tickets WHERE company_id = $1 AND created_at >= date_trunc('day', now())) " +
    "LEFT JOIN restaurant_kitchen_tickets t ON t.id = i.ticket_id " +
    "WHERE s.company_id = $1 GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order, s.name", [company.id])).rows;
  var latest = (await pool.query(
    "SELECT t.*, (SELECT coalesce(json_agg(json_build_object('name', i.name, 'qty', i.qty, 'status', i.status, 'station', s.name) ORDER BY i.created_at), '[]'::json) " +
    "  FROM restaurant_kitchen_items i LEFT JOIN restaurant_kds_stations s ON s.id = i.station_id WHERE i.ticket_id = t.id) AS items " +
    "FROM restaurant_kitchen_tickets t WHERE t.company_id = $1 AND t.created_at >= date_trunc('day', now()) ORDER BY t.created_at DESC LIMIT 40", [company.id])).rows;
  function mins(v) { return v == null ? null : Math.round(Number(v) * 10) / 10; }
  return {
    company: { id: company.id, name: company.name, code: company.code },
    inUse: active.length > 0,
    timing: timing,
    stations: stations.map(stationOut),
    categories: categories,
    today: {
      tickets: today.tickets, cooking: today.cooking, ready: today.ready, cancelled: today.cancelled, late: today.late,
      averageMinutes: mins(today.avg_ready), longestMinutes: mins(today.max_ready),
      byStation: byStation.map(function (s) { return { id: s.id, name: s.name, dishes: s.dishes, cooking: s.cooking, averageMinutes: mins(s.avg_done) }; })
    },
    tickets: latest.map(function (t) {
      return { id: t.id, number: t.number, label: t.label, tableName: t.table_name, waiterName: t.waiter_name, status: t.status,
        createdAt: t.created_at, readyAt: t.ready_at, servedAt: t.served_at, note: t.note,
        readyMinutes: t.ready_at ? mins((new Date(t.ready_at) - new Date(t.created_at)) / 60000) : null,
        items: (t.items || []).map(function (i) { return { name: i.name, qty: Number(i.qty), status: i.status, station: i.station }; }) };
    })
  };
}

// Categories as given: trimmed, each once, not one another active station
// already lists (a dish goes to one station).
async function cleanCategories(companyId, list, exceptId) {
  if (list == null) return [];
  if (!Array.isArray(list)) fail('invalid', 'Categories must be a list.');
  var seen = new Set(), out = [];
  list.forEach(function (c) {
    var v = String(c == null ? '' : c).trim().slice(0, 120);
    if (v && !seen.has(norm(v))) { seen.add(norm(v)); out.push(v); }
  });
  if (out.length > 200) fail('invalid', 'Too many categories for one station.');
  var others = (await pool.query('SELECT name, categories FROM restaurant_kds_stations WHERE company_id = $1 AND active AND id <> $2', [companyId, exceptId || '00000000-0000-0000-0000-000000000000'])).rows;
  out.forEach(function (c) {
    var taken = others.find(function (s) { return (s.categories || []).some(function (x) { return norm(x) === norm(c); }); });
    if (taken) fail('invalid', '"' + c + '" is already cooked at ' + taken.name + '. Take it off there first.');
  });
  return out;
}

// POST /api/restaurant/kitchen/stations { companyId, name, categories, everythingElse }
async function createStation(ctx, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var company = await requireCompany(p.companyId);
  var name = V.text(p.name, 'Name', 40);
  if ((await pool.query('SELECT 1 FROM restaurant_kds_stations WHERE company_id = $1 AND lower(name) = lower($2)', [company.id, name])).rows[0]) {
    fail('invalid', company.name + ' already has a station named "' + name + '".');
  }
  var categories = await cleanCategories(company.id, p.categories, null);
  var everythingElse = p.everythingElse === true;
  var s = await withTransaction(async function (client) {
    if (everythingElse) await client.query('UPDATE restaurant_kds_stations SET everything_else = false WHERE company_id = $1', [company.id]);
    var order = (await client.query('SELECT coalesce(max(sort_order), 0) + 1 AS n FROM restaurant_kds_stations WHERE company_id = $1', [company.id])).rows[0].n;
    var row = (await client.query(
      'INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else, sort_order, print_tickets) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [company.id, name, categories, everythingElse, order, p.printTickets === true])).rows[0];
    await audit(client, ctx, 'restaurant.kds.station.create', 'restaurant_kds_station', row.id, 'Added kitchen station "' + name + '" to ' + company.name + '.');
    return row;
  });
  return stationOut(s);
}

// PUT /api/restaurant/kitchen/stations/:id { name, categories, everythingElse, active, sortOrder }
async function updateStation(ctx, id, p) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var s = (await pool.query('SELECT * FROM restaurant_kds_stations WHERE id = $1', [id])).rows[0];
  if (!s) fail('notfound', 'Station not found.');
  var name = p.name === undefined ? s.name : V.text(p.name, 'Name', 40);
  if (name.toLowerCase() !== s.name.toLowerCase() &&
    (await pool.query('SELECT 1 FROM restaurant_kds_stations WHERE company_id = $1 AND lower(name) = lower($2) AND id <> $3', [s.company_id, name, id])).rows[0]) {
    fail('invalid', 'There is already a station named "' + name + '".');
  }
  var active = p.active === undefined ? s.active : p.active === true;
  var categories = p.categories === undefined ? s.categories : await cleanCategories(s.company_id, p.categories, id);
  if (p.categories === undefined && active && !s.active) await cleanCategories(s.company_id, s.categories, id);
  var everythingElse = p.everythingElse === undefined ? s.everything_else : p.everythingElse === true;
  var sortOrder = p.sortOrder === undefined ? s.sort_order : Math.max(0, Math.min(999, Math.round(Number(p.sortOrder) || 0)));
  // No screen there: the till prints its tickets when it sends an order.
  var printTickets = p.printTickets === undefined ? s.print_tickets : p.printTickets === true;
  var row = await withTransaction(async function (client) {
    if (everythingElse && !s.everything_else) await client.query('UPDATE restaurant_kds_stations SET everything_else = false WHERE company_id = $1', [s.company_id]);
    var r = (await client.query(
      'UPDATE restaurant_kds_stations SET name = $2, categories = $3, everything_else = $4, active = $5, sort_order = $6, print_tickets = $7, updated_at = now() WHERE id = $1 RETURNING *',
      [id, name, categories, everythingElse, active, sortOrder, printTickets])).rows[0];
    await audit(client, ctx, 'restaurant.kds.station.update', 'restaurant_kds_station', id, 'Changed kitchen station "' + name + '".');
    return r;
  });
  return stationOut(row);
}

// DELETE /api/restaurant/kitchen/stations/:id — its dishes already sent
// stay on the "all stations" screen.
async function removeStation(ctx, id) {
  if (!ctx.can('restaurant.manage')) fail('forbidden', 'Your role does not allow this action (restaurant.manage).');
  var s = (await pool.query('DELETE FROM restaurant_kds_stations WHERE id = $1 RETURNING *', [id])).rows[0];
  if (!s) fail('notfound', 'Station not found.');
  await audit(pool, ctx, 'restaurant.kds.station.remove', 'restaurant_kds_station', id, 'Removed kitchen station "' + s.name + '".');
  return { removed: true };
}

module.exports = {
  moveItems: moveItems, retarget: retarget, fireCourse: fireCourse, releaseHeld: releaseHeld, chitsFor: chitsFor, markPrinted: markPrinted, printQueue: printQueue, takePrints: takePrints,
  fire: fire, cancelForTab: cancelForTab, cancelForOrder: cancelForOrder,
  board: board, setItemDone: setItemDone, finishTicket: finishTicket, serveTicket: serveTicket, recallTicket: recallTicket, printTicket: printTicket, tillSummary: tillSummary,
  statusOf: statusOf,
  kitchenOverview: kitchenOverview, createStation: createStation, updateStation: updateStation, removeStation: removeStation,
  readyText: readyText, _stationFor: stationFor
};
