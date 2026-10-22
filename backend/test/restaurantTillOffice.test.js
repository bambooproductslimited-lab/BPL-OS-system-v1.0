// The till's back office (migration 0158): kitchen screens a manager sets
// up (a code, a name, a station) and cooks sign in on with their PIN; one
// cashier's drawer at a time, money only on an open drawer, a drawer left
// open closed by a manager; disputes (complaints, wrong charges, drawers
// short); IOUs and VIP money; the menu kept from the till; stock counted on
// dishes, taken off by sales and put back by a void. Test data uses the ZQB
// company code.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var pos = require('../src/services/restaurantPos.service');
var money = require('../src/services/restaurantTillMoney.service');
var kitchen = require('../src/services/restaurantKitchen.service');
var access = require('../src/services/restaurantTillAccess.service');
var screens = require('../src/services/restaurantKdsScreens.service');
var pinAuth = require('../src/lib/pinAuth');

var PINS = { ama: '7461', efua: '7462', kojo: '7463', esi: '7464', yaw: '7465' };
var IP = '10.9.6.1', OTHER_IP = '10.9.6.2';
var company, people = {}, fish, beer, soda, t1, tok = {}, grill, bar;

async function cleanup() {
  var cos = (await pool.query("SELECT id FROM companies WHERE code = 'ZQB'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM restaurant_kds_screens WHERE status = 'waiting' AND device LIKE 'Zqb%'");
  if (cos.length) {
    for (var q of ['DELETE FROM restaurant_vip_entries WHERE company_id = ANY($1)', 'DELETE FROM restaurant_refunds WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kitchen_tickets WHERE company_id = ANY($1)', 'DELETE FROM restaurant_open_tabs WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_disputes WHERE company_id = ANY($1)', 'DELETE FROM restaurant_stock_moves WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_order_items WHERE order_id IN (SELECT id FROM restaurant_orders WHERE company_id = ANY($1))', 'DELETE FROM restaurant_orders WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_drawer_movements WHERE session_id IN (SELECT id FROM restaurant_drawer_sessions WHERE company_id = ANY($1))',
      'DELETE FROM restaurant_drawer_sessions WHERE company_id = ANY($1)', 'DELETE FROM restaurant_guests WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_kds_screens WHERE company_id = ANY($1)', 'DELETE FROM restaurant_kds_stations WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_menu_items WHERE company_id = ANY($1)', 'DELETE FROM restaurant_tables WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_till_staff WHERE company_id = ANY($1)', 'DELETE FROM restaurant_till_settings WHERE company_id = ANY($1)',
      'DELETE FROM restaurant_activity WHERE company_id = ANY($1)']) await pool.query(q, [cos]);
    await pool.query("DELETE FROM audit_logs WHERE entity_id = ANY($1::text[]) OR action LIKE 'restaurant.menu%' AND actor_name LIKE '%Zqb'", [cos]);
  }
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQB-%'");
  if (cos.length) {
    await pool.query('DELETE FROM departments WHERE company_id = ANY($1)', [cos]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [cos]);
  }
}
async function person(key, code, first, dept) {
  people[key] = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type, kiosk_pin_hash) VALUES ($1, $2, 'Zqb', $3, $4, current_date, 'active', 'permanent', $5) RETURNING id",
    [code, first, code.toLowerCase() + '@example.com', dept, pinAuth.hashPin(PINS[key])])).rows[0].id;
}
async function dish(name, cat, price) {
  return (await pool.query('INSERT INTO restaurant_menu_items (company_id, name, category, price, active) VALUES ($1, $2, $3, $4, true) RETURNING id', [company.id, name, cat, price])).rows[0].id;
}
var manager = function () { return { id: people.kojo, first_name: 'Kojo', last_name: 'Zqb' }; };

test.before(async function () {
  await cleanup();
  await pool.query('UPDATE employees SET kiosk_pin_hash = NULL WHERE kiosk_pin_hash = ANY($1)', [Object.values(PINS).map(pinAuth.hashPin)]);
  company = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQB', 'Zqb Beach Bar') RETURNING *")).rows[0];
  var dept = (await pool.query("INSERT INTO departments (code, name, company_id) VALUES ('ZQBF', 'Zqb Floor', $1) RETURNING id", [company.id])).rows[0].id;
  await person('ama', 'ZQB-1', 'Ama', dept);
  await person('efua', 'ZQB-2', 'Efua', dept);
  await person('kojo', 'ZQB-3', 'Kojo', dept);
  await person('esi', 'ZQB-4', 'Esi', dept);
  await person('yaw', 'ZQB-5', 'Yaw', dept);
  await pool.query("INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, 'manager'), ($1, $3, 'kitchen'), ($1, $4, 'waiter')",
    [company.id, people.kojo, people.esi, people.yaw]);
  fish = await dish('Zqb grilled fish', 'Zqb Grill', 100);
  beer = await dish('Zqb lager', 'Zqb Bar', 20);
  soda = await dish('Zqb soda', 'Zqb Bar', 10);
  t1 = (await pool.query("INSERT INTO restaurant_tables (company_id, name) VALUES ($1, 'Zqb T1') RETURNING id", [company.id])).rows[0].id;
  grill = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories, everything_else) VALUES ($1, 'Zqb Grill', '{\"Zqb Grill\"}', true) RETURNING id", [company.id])).rows[0].id;
  bar = (await pool.query("INSERT INTO restaurant_kds_stations (company_id, name, categories) VALUES ($1, 'Zqb Bar', '{\"Zqb Bar\"}') RETURNING id", [company.id])).rows[0].id;
  for (var k of ['ama', 'efua', 'kojo', 'yaw']) tok[k] = (await pos.login(PINS[k], IP, 'till')).token;
});
test.after(async function () { await cleanup(); await pool.end(); });

test('kitchen screens: a code to set up, a name and a station from the manager, cooks sign in with their PIN', async function () {
  // A new tablet waits with a code; a reload keeps it.
  var hello = await screens.hello(null, IP, 'Zqb Mozilla/5.0 (Linux; Android 13; SM-X200) Chrome/120 Safari/537.36');
  assert.equal(hello.status, 'waiting');
  assert.match(hello.code, /^[A-Z2-9]{6}$/);
  assert.ok(hello.screenToken.length > 20);
  assert.deepEqual(await screens.hello(hello.screenToken, IP, 'x'), { status: 'waiting', code: hello.code });
  await assert.rejects(pos.login(PINS.esi, IP, 'kds', hello.screenToken), /waiting for a manager to set it up \(code /);
  await assert.rejects(pos.login(PINS.esi, IP, 'kds'), /This screen is not set up/);
  // The manager sees it waiting on the same network (not from elsewhere), and sets it up by its code.
  var list = await access.kitchenScreens(tok.kojo, { action: 'list' }, IP);
  assert.ok(list.waiting.some(function (w) { return w.code === hello.code && w.device === 'Android tablet · Chrome'; }));
  assert.ok(!(await access.kitchenScreens(tok.kojo, {}, OTHER_IP)).waiting.some(function (w) { return w.code === hello.code; }));
  await assert.rejects(access.kitchenScreens(tok.ama, { action: 'list' }, IP), /type a manager's PIN/);
  await assert.rejects(access.kitchenScreens(tok.kojo, { action: 'claim', code: 'AAAAAA', name: 'Zqb grill screen' }, IP), /No screen is waiting with the code AAAAAA/);
  await assert.rejects(access.kitchenScreens(tok.kojo, { action: 'claim', code: hello.code, name: ' ' }, IP), /Give the screen a name/);
  var set = await access.kitchenScreens(tok.kojo, { action: 'claim', code: hello.code.toLowerCase().slice(0, 3) + ' ' + hello.code.slice(3), name: 'Zqb grill screen', stationId: grill }, IP);
  var mine = set.screens.find(function (s) { return s.id === set.changed; });
  assert.deepEqual([mine.name, mine.stationName, mine.status], ['Zqb grill screen', 'Zqb Grill', 'active']);
  var known = await screens.hello(hello.screenToken, IP, 'x');
  assert.deepEqual([known.status, known.name, known.stationName, known.companyName], ['active', 'Zqb grill screen', 'Zqb Grill', 'Zqb Beach Bar']);

  // A cook signs in with their PIN; the board is the screen's station only, whatever is asked.
  await assert.rejects(pos.login(PINS.ama, IP, 'kds', 'not-a-token'), /not set up/);
  var cook = await pos.login(PINS.esi, IP, 'kds', hello.screenToken);
  assert.deepEqual(cook.screen, { id: mine.id, name: 'Zqb grill screen', stationId: grill, stationName: 'Zqb Grill' });
  await pos.saveTab(tok.yaw, { tableId: t1, waiterId: people.yaw, fulfillment: 'dine_in', items: [{ menuItemId: fish, qty: 1 }, { menuItemId: beer, qty: 2 }] });
  var b = await kitchen.board(cook.token, { station: bar });
  assert.equal(b.station, grill);
  assert.equal(b.screen.name, 'Zqb grill screen');
  assert.deepEqual(b.cooking[0].items.map(function (i) { return i.name; }), ['Zqb grilled fish']);
  // "Done" on the grill screen finishes the grill's dishes only.
  var done = await kitchen.finishTicket(cook.token, b.cooking[0].id, 'all');
  assert.equal(done.status, 'cooking', 'the bar is still pouring');
  var signin = (await pool.query("SELECT summary FROM restaurant_activity WHERE company_id = $1 AND action = 'kds.signin'", [company.id])).rows[0];
  assert.equal(signin.summary, 'Esi Zqb signed in to the kitchen screen Zqb grill screen.');
  var seen = (await access.kitchenScreens(tok.kojo, {}, IP)).screens[0];
  assert.deepEqual([seen.signedIn, seen.online], ['Esi Zqb', true]);

  // Moved to the bar by the manager: the screen follows on its next look.
  await access.kitchenScreens(tok.kojo, { action: 'update', id: mine.id, name: 'Zqb bar screen', stationId: bar }, IP);
  b = await kitchen.board(cook.token, {});
  assert.deepEqual([b.station, b.screen.name], [bar, 'Zqb bar screen']);
  assert.deepEqual(b.cooking[0].items.map(function (i) { return i.name; }), ['Zqb lager']);
  // Another restaurant's cook cannot sign in on it.
  var other = await pool.query("INSERT INTO companies (code, name) VALUES ('ZQBX', 'Zqb Other') RETURNING id");
  await pool.query('UPDATE restaurant_kds_screens SET company_id = $2 WHERE id = $1', [mine.id, other.rows[0].id]);
  await assert.rejects(pos.login(PINS.esi, IP, 'kds', hello.screenToken), /This screen belongs to Zqb Other/);
  await pool.query('UPDATE restaurant_kds_screens SET company_id = $2 WHERE id = $1', [mine.id, company.id]);
  await pool.query('DELETE FROM companies WHERE id = $1', [other.rows[0].id]);
  // Taken off: the signed-in screen stops, and waits again with a new code.
  await access.kitchenScreens(tok.kojo, { action: 'remove', id: mine.id }, IP);
  await assert.rejects(kitchen.board(cook.token, {}), /A manager took this screen off/);
  var again = await screens.hello(hello.screenToken, IP, 'Zqb tablet');
  assert.equal(again.status, 'waiting');
  assert.notEqual(again.screenToken, hello.screenToken);
  await pool.query('DELETE FROM restaurant_kds_screens WHERE id = (SELECT id FROM restaurant_kds_screens WHERE code = $1 AND status = $2)', [again.code, 'waiting']);
  await pool.query('DELETE FROM restaurant_kitchen_tickets WHERE company_id = $1', [company.id]);
  await pool.query('DELETE FROM restaurant_open_tabs WHERE company_id = $1', [company.id]);
});

test('one cashier at a time, a manager\'s drawer beside it; signing out keeps a drawer open; one left open is closed by the manager; short opens a dispute', async function () {
  await pos.openDrawerSession(tok.ama, 200);
  var efua = await access.profile(tok.efua);
  assert.deepEqual([efua.cashierOnDuty.name, efua.cashierOnDuty.me], ['Ama Zqb', false]);
  assert.equal((await access.profile(tok.ama)).cashierOnDuty.me, true);
  await assert.rejects(pos.openDrawerSession(tok.efua, 100), /Ama Zqb is the cashier on duty: their drawer has been open since \d\d:\d\d/);
  // Efua takes orders while Ama is on duty, but takes no money and prints no receipts.
  var tab = await pos.saveTab(tok.efua, { label: 'Zqb Akosua', fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: soda, qty: 1 }] });
  await assert.rejects(pos.createOrder(tok.efua, { tabId: tab.id, fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: soda, qty: 1 }], payments: [{ method: 'mobile_money' }] }), /open your cash drawer first/);
  var sale = await pos.createOrder(tok.ama, { tabId: tab.id, fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: soda, qty: 1 }], payments: [{ method: 'cash' }] });
  assert.equal((await pos.receiptForSession(tok.ama, sale.id)).orderNo, sale.orderNo);
  await assert.rejects(pos.receiptForSession(tok.efua, sale.id), /open your cash drawer first/);
  await assert.rejects(pos.receiptForSession(tok.yaw, sale.id), /cannot take payments/);
  await assert.rejects(pos.receiptForSession(tok.kojo, sale.id), /open your cash drawer first/);

  // Ama steps away: signing out leaves her drawer open, and the log says so.
  assert.deepEqual(await pos.signOut(tok.ama), { signedOut: true, drawerOpen: true });
  await pos.signOut(tok.yaw, 'idle');
  // The manager opens their own drawer beside hers and charges on it; Ama
  // is still the cashier on duty, and her drawer holds only her sales.
  await pos.openDrawerSession(tok.kojo, 50);
  assert.equal((await access.profile(tok.efua)).cashierOnDuty.name, 'Ama Zqb');
  var bossSale = await pos.createOrder(tok.kojo, { fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: soda, qty: 1 }], payments: [{ method: 'cash' }] });
  assert.equal((await pos.receiptForSession(tok.kojo, bossSale.id)).orderNo, bossSale.orderNo);
  assert.equal((await pos.receiptForSession(tok.kojo, sale.id)).orderNo, sale.orderNo);
  // Ama is back: her drawer is as she left it.
  tok.ama = (await pos.login(PINS.ama, IP, 'till')).token;
  var mine = await pos.getOpenDrawerSession(tok.ama);
  assert.deepEqual([mine.session.status, mine.expected], ['open', 210]);

  // Everything done on Ama's drawer, for the manager: not the manager's own sale.
  var log = await access.activityReport(tok.kojo, { drawerId: mine.session.id }, IP);
  assert.deepEqual(log.rows.map(function (r) { return r.action; }).reverse(), ['till.drawer_open', 'till.sale', 'till.signout', 'till.signin']);
  assert.match(log.rows[1].summary, /Ama Zqb signed out of the till; their cash drawer stays open\./);
  var yawOut = await access.activityReport(tok.kojo, { kind: 'till.signout', employeeId: people.yaw }, IP);
  assert.match(yawOut.rows[0].summary, /Yaw Zqb was signed out after the till went unused\./);
  await assert.rejects(access.activityReport(tok.kojo, { drawerId: 'not-a-drawer' }, IP), /not this restaurant's/);

  // Ama leaves her drawer open; the manager counts it and closes it (short by 5).
  var hist = await access.drawers(tok.kojo, {}, IP);
  var open = hist.drawers.find(function (d) { return d.session.status === 'open' && d.cashierName === 'Ama Zqb'; });
  assert.deepEqual([open.expected, open.byManager], [210, false]);
  assert.equal(hist.drawers.find(function (d) { return d.cashierName === 'Kojo Zqb'; }).byManager, true);
  await assert.rejects(access.drawers(tok.ama, { action: 'close', id: open.session.id, actualCash: 205 }, IP), /type a manager's PIN/);
  await assert.rejects(access.drawers(tok.kojo, { action: 'close', id: open.session.id }, IP), /Count the cash/);
  hist = await access.drawers(tok.kojo, { action: 'close', id: open.session.id, actualCash: 205, note: 'Zqb Ama went home' }, IP);
  assert.deepEqual([hist.closed.difference, hist.closed.session.closingNote], [-5, 'Closed by Kojo Zqb: Zqb Ama went home']);
  assert.ok(hist.closed.disputeId);
  assert.deepEqual([hist.totals.short, hist.totals.open], [-5, 1]);
  await assert.rejects(access.drawers(tok.kojo, { action: 'close', id: open.session.id, actualCash: 1 }, IP), /already closed/);
  log = await access.activityReport(tok.kojo, { drawerId: open.session.id }, IP);
  assert.equal(log.rows[0].action, 'till.drawer_close');
  // Now Efua opens hers for the next shift, the manager's still open beside it.
  await pos.openDrawerSession(tok.efua, 100);
  assert.equal((await pos.closeDrawerSession(tok.kojo, { actualCash: 60 })).difference, 0);
  var closed = await pos.closeDrawerSession(tok.efua, { actualCash: 100 });
  assert.equal(closed.difference, 0);
  assert.equal(closed.disputeId, undefined, 'a drawer that counts right opens no dispute');

  var d = await access.disputes(tok.kojo, { filter: { status: 'open' } }, IP);
  assert.equal(d.rows.length, 1);
  assert.deepEqual([d.rows[0].kind, d.rows[0].amount, d.rows[0].drawerCashier], ['drawer_short', 5, 'Ama Zqb']);
  assert.match(d.rows[0].description, /Ama Zqb's drawer was counted 205.00, 210.00 expected: short by 5.00/);
});

test('disputes: complaints and wrong charges raised on the till, resolved and opened again by the manager', async function () {
  await pos.openDrawerSession(tok.ama, 50);
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: fish, qty: 1 }], payments: [{ method: 'mobile_money' }] });
  await assert.rejects(pos.raiseDispute(tok.yaw, { kind: 'complaint', description: '' }), /Say what happened/);
  await assert.rejects(pos.raiseDispute(tok.yaw, { kind: 'wrong_charge', description: 'Zqb charged twice' }), /Pick the sale/);
  await assert.rejects(pos.raiseDispute(tok.yaw, { kind: 'drawer_short', description: 'Zqb' }), /Pick what kind/);
  var c = await pos.raiseDispute(tok.yaw, { kind: 'complaint', orderId: sale.id, description: 'Zqb fish was cold', customerName: 'Zqb Adwoa' });
  await pos.raiseDispute(tok.ama, { kind: 'wrong_charge', orderId: sale.id, amount: 100, description: 'Zqb charged on two phones' });
  var list = await access.disputes(tok.kojo, {}, IP);
  var complaint = list.rows.find(function (r) { return r.id === c.id; });
  assert.deepEqual([complaint.kind, complaint.orderNo, complaint.openedBy, complaint.customerName, complaint.status], ['complaint', sale.orderNo, 'Yaw Zqb', 'Zqb Adwoa', 'open']);
  assert.equal(list.totals.open, 3);
  assert.equal(list.totals.openAmount, 105);
  await assert.rejects(access.disputes(tok.kojo, { action: 'resolve', id: c.id, resolution: 'free food' }, IP), /Pick how it was resolved/);
  list = await access.disputes(tok.kojo, { action: 'resolve', id: c.id, resolution: 'remade', note: 'Zqb made a fresh one' }, IP);
  complaint = list.rows.find(function (r) { return r.id === c.id; });
  assert.deepEqual([complaint.status, complaint.resolution, complaint.resolvedBy, complaint.resolutionNote], ['resolved', 'remade', 'Kojo Zqb', 'Zqb made a fresh one']);
  assert.equal(list.rows[list.rows.length - 1].id, c.id, 'resolved ones come after the open ones');
  assert.equal((await access.disputes(tok.kojo, { filter: { kind: 'wrong_charge' } }, IP)).rows.length, 1);
  list = await access.disputes(tok.kojo, { action: 'reopen', id: c.id }, IP);
  assert.equal(list.rows.find(function (r) { return r.id === c.id; }).status, 'open');
  var acts = (await pool.query("SELECT action FROM restaurant_activity WHERE company_id = $1 AND action IN ('till.dispute', 'settings.dispute')", [company.id])).rows;
  assert.equal(acts.length, 5);
});

test('the menu kept from the till; stock counted on a dish, taken off by sales, held by open orders, put back by a void', async function () {
  // The manager adds a dish with sizes and counts its stock; a waiter cannot.
  await assert.rejects(access.menu(tok.yaw, { action: 'list' }, IP), /type a manager's PIN/);
  var m = await access.menu(tok.kojo, { action: 'save', item: { name: 'Zqb malt', category: 'Zqb Bar', price: 12, trackStock: true, stockQty: 5, lowStock: 2,
    variations: [{ name: 'Bottle', price: 12 }, { name: 'Can', price: 10 }] } }, IP);
  var malt = m.items.find(function (i) { return i.id === m.saved; });
  assert.deepEqual([malt.trackStock, malt.stockQty, malt.lowStock, malt.variations.map(function (v) { return v.name; })], [true, 5, 2, ['Bottle', 'Can']]);
  await assert.rejects(access.menu(tok.kojo, { action: 'save', item: { name: 'zqb MALT', price: 1 } }, IP), /already a dish called/);
  // A price change, a size dropped.
  m = await access.menu(tok.kojo, { action: 'save', item: { id: malt.id, name: 'Zqb malt', category: 'Zqb Bar', price: 14, trackStock: true, lowStock: 2,
    variations: [{ id: malt.variations[0].id, name: 'Bottle', price: 14 }, { id: malt.variations[1].id, remove: true }] } }, IP);
  malt = m.items.find(function (i) { return i.id === malt.id; });
  assert.deepEqual([malt.price, malt.stockQty, malt.variations.length], [14, 5, 1]);
  var bottle = malt.variations[0].id;

  // The till shows what is left; an open order holds its share.
  var tiles = await pos.menuForSession(tok.yaw);
  assert.deepEqual(tiles.find(function (t) { return t.id === malt.id; }).stock, { left: 5, low: false, soldOut: false });
  assert.equal(tiles.find(function (t) { return t.id === fish; }).stock, undefined, 'a dish not counted shows nothing');
  var tab = await pos.saveTab(tok.yaw, { label: 'Zqb Kofi', fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: malt.id, variationId: bottle, qty: 3 }] });
  tiles = await pos.menuForSession(tok.yaw);
  assert.deepEqual(tiles.find(function (t) { return t.id === malt.id; }).stock, { left: 2, low: true, soldOut: false });
  await assert.rejects(pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: malt.id, variationId: bottle, qty: 3 }], payments: [{ method: 'cash' }] }), /Only 2 × Zqb malt left in stock/);
  await assert.rejects(pos.saveTab(tok.yaw, { id: tab.id, label: 'Zqb Kofi', fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: malt.id, variationId: bottle, qty: 6 }] }), /Only 5 × Zqb malt left/);
  // Paying the open order takes its 3 off; a direct sale takes 2 more.
  await pos.createOrder(tok.ama, { tabId: tab.id, fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: malt.id, variationId: bottle, qty: 3 }], payments: [{ method: 'cash' }] });
  var sale = await pos.createOrder(tok.ama, { fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: malt.id, variationId: bottle, qty: 2 }], payments: [{ method: 'cash' }] });
  tiles = await pos.menuForSession(tok.yaw);
  assert.deepEqual(tiles.find(function (t) { return t.id === malt.id; }).stock, { left: 0, low: true, soldOut: true });
  await assert.rejects(pos.saveTab(tok.yaw, { label: 'Zqb Esi', fulfillment: 'pickup', customerName: 'Zqb Walk-in', customerPhone: '0200000991', items: [{ menuItemId: malt.id, variationId: bottle, qty: 1 }] }), /Zqb malt is sold out/);

  // A void puts the 2 back (in the OS).
  var admin = { can: function () { return true; }, user: { id: null }, employee: null };
  await pos.voidOrder(admin, sale.id);
  var st = await access.stock(tok.kojo, {}, IP);
  assert.equal(st.menu.find(function (i) { return i.id === malt.id; }).qty, 2);

  // New stock comes in; a count corrects it. Each step in the history.
  await assert.rejects(access.stock(tok.yaw, { action: 'move', type: 'menu', id: malt.id, kind: 'received', qty: 12 }, IP), /type a manager's PIN/);
  st = await access.stock(tok.kojo, { action: 'move', type: 'menu', id: malt.id, kind: 'received', qty: 12, note: 'Zqb crate' }, IP);
  assert.equal(st.moved.qty, 14);
  st = await access.stock(tok.kojo, { action: 'move', type: 'menu', id: malt.id, kind: 'count', qty: 13 }, IP);
  assert.equal(st.moved.qty, 13);
  await assert.rejects(access.stock(tok.kojo, { action: 'move', type: 'menu', id: fish, kind: 'count', qty: 3 }, IP), /does not count its stock/);
  var hist = await access.stock(tok.kojo, { action: 'history', type: 'menu', id: malt.id }, IP);
  assert.deepEqual(hist.map(function (h) { return [h.kind, h.delta, h.after]; }), [['count', -1, 13], ['received', 12, 14], ['voided', 2, 2], ['sold', -2, 0], ['sold', -3, 2], ['count', 5, 5]]);
  assert.equal(hist[3].orderNo, sale.orderNo);
  // Whoever's role may count the stock does so without a manager.
  await access.saveSettings(tok.kojo, { settings: { roles: { waiter: { stock: true } } } }, IP);
  st = await access.stock(tok.yaw, { action: 'move', type: 'menu', id: malt.id, kind: 'wasted', qty: 1, note: 'Zqb broken bottle' }, IP);
  assert.equal(st.moved.qty, 12);
  assert.equal((await access.stock(tok.kojo, { action: 'history', type: 'menu', id: malt.id }, IP))[0].by, 'Yaw Zqb');

  // Removed from the menu: past sales keep its name.
  m = await access.menu(tok.kojo, { action: 'remove', id: malt.id }, IP);
  assert.ok(!m.items.some(function (i) { return i.id === malt.id; }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM restaurant_order_items WHERE name = 'Zqb malt — Bottle'")).rows[0].n, 2);
});

test('IOUs and VIP money: what is owed and paid back, what was put down and spent', async function () {
  var g = await pos.createGuestForSession(tok.ama, { name: 'Zqb Abena', phone: '0200000301' });
  await pool.query('UPDATE restaurant_guests SET iou_allowed = true WHERE id = $1', [g.id]);
  var iou = await pos.createOrder(tok.ama, { fulfillment: 'pickup', guestId: g.id, items: [{ menuItemId: fish, qty: 1 }], payments: [{ method: 'iou' }] });
  await pos.createOrder(tok.ama, { fulfillment: 'pickup', guestId: g.id, items: [{ menuItemId: beer, qty: 2 }], payments: [{ method: 'iou' }] });
  await money.payIou(tok.ama, iou.id, { method: 'mobile_money' });
  await money.vipTopUp(tok.ama, { guestId: g.id, amount: 300, method: 'cash' });
  await pos.createOrder(tok.ama, { fulfillment: 'pickup', guestId: g.id, items: [{ menuItemId: beer, qty: 3 }], payments: [{ method: 'vip' }] });
  var r = await access.accounts(tok.kojo, {}, IP);
  assert.deepEqual([r.totals.owedNow, r.totals.owingCustomers, r.totals.iouPaid, r.totals.iouSold], [40, 1, 100, 140]);
  assert.deepEqual(r.ious.map(function (i) { return [i.owed, i.paid]; }), [[40, false], [100, true]]);
  assert.deepEqual([r.ious[1].paidMethod, r.ious[1].paidBy], ['mobile_money', 'Ama Zqb']);
  assert.deepEqual([r.totals.vipToppedUp, r.totals.vipSpent, r.totals.vipHeld], [300, 60, 240]);
  assert.deepEqual(r.vip.map(function (v) { return [v.kind, v.amount]; }).sort(), [['sale', -60], ['topup', 300]]);
  await assert.rejects(access.accounts(tok.ama, {}, IP), /type a manager's PIN/);
});
