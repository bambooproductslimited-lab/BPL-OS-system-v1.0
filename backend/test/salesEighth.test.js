// The eighth batch on Bamboo Products' side (migration 0187): the online
// shop (the catalogue on a public page, an order billed as an invoice to
// pay on its link), booking a consultation (free times, a lead and a site
// visit, the customer's own page, staff confirming), and a quotation
// approved online invoiced at once for its deposit. Fake Zqh data only;
// nothing goes out: Paystack is stubbed, email to a test transport.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var shares = require('../src/services/shares.service');
var shop = require('../src/services/shop.service');
var bookings = require('../src/services/bookings.service');
var invoicePay = require('../src/services/invoicePay.service');
var mail = require('../src/services/mail.service');
var { buildContext } = require('../src/services/context.service');

var boss, server, base, cust, catA, catB, item, other, varM, varL, varOff;
var keyWas = config.paystackBpl.secretKey;
var shopWas, bookingWas;
var sent = [];
var SIG = [[[20, 150], [80, 60], [140, 140], [220, 50], [300, 130]], [[320, 120], [420, 90]]];
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function http(method, path, body) {
  var res = await fetch(base + path, { method: method, headers: { 'Content-Type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
  var json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json };
}
async function cleanup() {
  var custs = (await pool.query("SELECT id FROM customers WHERE name LIKE 'Zqh %'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zqh%' OR body LIKE '%Zqh%' OR link LIKE '/shop-orders?open=%' OR link LIKE '/appointments?open=%'");
  await pool.query("DELETE FROM appointments WHERE name LIKE 'Zqh %'");
  await pool.query("DELETE FROM crm_site_visits WHERE client LIKE 'Zqh %'");
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'Zqh %'");
  if (custs.length) {
    await pool.query('DELETE FROM shop_orders WHERE customer_id = ANY($1)', [custs]);
    await pool.query('UPDATE quotations SET pay_share_id = NULL WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM invoice_online_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1))', [custs]);
    await pool.query("DELETE FROM document_responses WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1))", [custs]);
    await pool.query("DELETE FROM document_shares WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1) UNION SELECT id FROM invoices WHERE customer_id = ANY($1))", [custs]);
    await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1) UNION SELECT id FROM quotations WHERE customer_id = ANY($1))", [custs]);
    await pool.query('DELETE FROM invoices WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM quotations WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM customer_identities WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM customers WHERE id = ANY($1)', [custs]);
  }
  await pool.query("DELETE FROM catalog_item_variations WHERE item_id IN (SELECT id FROM catalog_items WHERE name LIKE 'Zqh %')");
  await pool.query("DELETE FROM catalog_items WHERE name LIKE 'Zqh %'");
  await pool.query("DELETE FROM catalog_categories WHERE name LIKE 'Zqh %'");
}

test.before(async function () {
  await cleanup();
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var s = (await pool.query('SELECT shop, booking FROM settings WHERE id = 1')).rows[0];
  shopWas = s.shop; bookingWas = s.booking;
  catA = (await pool.query("INSERT INTO catalog_categories (name) VALUES ('Zqh Blinds') RETURNING id")).rows[0].id;
  catB = (await pool.query("INSERT INTO catalog_categories (name) VALUES ('Zqh Hidden') RETURNING id")).rows[0].id;
  item = (await pool.query("INSERT INTO catalog_items (name, description, category_id, tax_rate_id, active) VALUES ('Zqh roller blind', 'Zqh: woven bamboo', $1, 'tx_zero', true) RETURNING id", [catA])).rows[0].id;
  varM = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, active, position) VALUES ($1, 'Medium', 'ZQH-M', 'each', 250, true, 0) RETURNING id", [item])).rows[0].id;
  varL = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, active, position) VALUES ($1, 'Large', 'ZQH-L', 'each', 400, true, 1) RETURNING id", [item])).rows[0].id;
  varOff = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, active, position) VALUES ($1, 'Old', 'ZQH-O', 'each', 99, false, 2) RETURNING id", [item])).rows[0].id;
  other = (await pool.query("INSERT INTO catalog_items (name, category_id, tax_rate_id, active) VALUES ('Zqh secret stool', $1, 'tx_zero', true) RETURNING id", [catB])).rows[0].id;
  await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, active) VALUES ($1, 'Regular', 'ZQH-S', 'each', 120, true)", [other]);
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zqh-' + sent.length }; } });
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () {
  invoicePay.setFetchForTests(null);
  config.paystackBpl.secretKey = keyWas;
  mail.setTransportForTests(null);
  // Only what this file changed: the rest of commercial holds the document
  // number counters, which other files running alongside move on.
  await pool.query("UPDATE settings SET shop = $1, booking = $2, commercial = commercial #- '{templates,invoiceOnApproval}' WHERE id = 1", [shopWas, bookingWas]);
  if (server) await new Promise(function (r) { server.close(r); });
  await cleanup();
  await pool.end();
});

test('the online shop: closed until opened; only its categories, active choices, today\'s prices; an order is a customer, an invoice and its link', async function () {
  await pool.query("UPDATE settings SET shop = '{}' WHERE id = 1");
  var closed = await http('GET', '/api/shop');
  assert.equal(closed.status, 404);
  await assert.rejects(shop.place({ name: 'Zqh Kofi', phone: '0244000111', fulfilment: 'pickup', lines: [{ variationId: varM, qty: 1 }] }, '10.7.0.1'), /closed/);

  var saved = await shop.saveSettings(boss, { on: true, title: 'Zqh Bamboo shop', intro: 'Zqh: made in Ghana', categories: [catA, 'not-a-category'], delivery: true, pickup: true, pickupAddress: 'Zqh showroom' });
  assert.deepEqual(saved.settings.categories, [catA]);
  var page = await http('GET', '/api/shop');
  assert.equal(page.status, 200);
  assert.equal(page.body.shop.title, 'Zqh Bamboo shop');
  var names = page.body.items.map(function (i) { return i.name; });
  assert.ok(names.indexOf('Zqh roller blind') >= 0);
  assert.ok(names.indexOf('Zqh secret stool') < 0, 'not in a category put on the shop');
  var blind = page.body.items.find(function (i) { return i.name === 'Zqh roller blind'; });
  assert.deepEqual(blind.variations.map(function (v) { return [v.name, v.price]; }), [['Medium', 250], ['Large', 400]]);

  var order = function (p, ip) { return http('POST', '/api/shop/orders', Object.assign({ name: 'Zqh Kofi Boateng', phone: '024 400 0111', email: 'zqh.kofi@example.com', fulfilment: 'delivery', address: 'Zqh: East Legon, near the mall' }, p)); };
  var bad = await order({ lines: [] });
  assert.match(bad.body.error.message, /basket is empty/);
  bad = await order({ phone: '12', lines: [{ variationId: varM, qty: 1 }] });
  assert.match(bad.body.error.message, /phone number/);
  bad = await order({ address: '', lines: [{ variationId: varM, qty: 1 }] });
  assert.match(bad.body.error.message, /Where should we deliver/);
  bad = await order({ lines: [{ variationId: varOff, qty: 1 }] });
  assert.match(bad.body.error.message, /no longer sold/);
  bad = await order({ lines: [{ variationId: varM, qty: 0 }] });
  assert.match(bad.body.error.message, /whole number/);
  bad = await order({ website: 'http://spam', lines: [{ variationId: varM, qty: 1 }] });
  assert.equal(bad.status, 400);

  // The page's prices are not taken: the catalogue's are.
  var ok = await order({ lines: [{ variationId: varM, qty: 2, unitPrice: 1 }, { variationId: varL, qty: 1 }], note: 'Zqh: call before' });
  assert.equal(ok.status, 201);
  assert.match(ok.body.orderNo, /^SHOP-\d+$/);
  assert.equal(ok.body.total, 900);
  var inv = (await pool.query('SELECT * FROM invoices WHERE invoice_no = $1', [ok.body.invoiceNo])).rows[0];
  assert.equal(Number(inv.grand_total), 900);
  assert.equal(inv.status, 'unpaid');
  assert.match(inv.notes, new RegExp(ok.body.orderNo + ': delivery to Zqh: East Legon'));
  var lines = (await pool.query("SELECT description, item_no, qty, unit_price FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1 ORDER BY sort_order", [inv.id])).rows;
  assert.deepEqual(lines.map(function (l) { return [l.description, l.item_no, Number(l.qty), Number(l.unit_price)]; }), [['Zqh roller blind — Medium', 'ZQH-M', 2, 250], ['Zqh roller blind — Large', 'ZQH-L', 1, 400]]);
  var c = (await pool.query('SELECT * FROM customers WHERE id = $1', [inv.customer_id])).rows[0];
  assert.equal(c.name, 'Zqh Kofi Boateng');
  assert.equal(c.origin_channel, 'shop');
  assert.equal(c.category, 'lead');
  // Its link opens the invoice to pay.
  var doc = await http('GET', '/api/share/' + ok.body.token);
  assert.equal(doc.status, 200);
  assert.equal(doc.body.docNo, ok.body.invoiceNo);
  assert.ok(sent.some(function (m) { return m.to === 'zqh.kofi@example.com' && /Your order SHOP-/.test(m.subject); }));
  var told = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE title = $1", ['🛍️ New shop order ' + ok.body.orderNo])).rows[0].n;
  assert.ok(told >= 1);

  // The same phone again: the same customer.
  var second = await order({ name: 'Zqh Kofi B.', email: '', fulfilment: 'pickup', address: '', lines: [{ variationId: varL, qty: 1 }] });
  assert.equal(second.status, 201);
  var inv2 = (await pool.query('SELECT customer_id FROM invoices WHERE invoice_no = $1', [second.body.invoiceNo])).rows[0];
  assert.equal(inv2.customer_id, c.id);

  // Staff: the orders, marked ready and done; cancelled voids an unpaid invoice.
  var listed = await shop.list(boss, {});
  var mine = listed.orders.find(function (o) { return o.orderNo === ok.body.orderNo; });
  assert.equal(mine.status, 'new');
  assert.equal(mine.invoice.balance, 900);
  assert.ok(listed.totals.fresh >= 2);
  var r = await shop.setStatus(boss, mine.id, { status: 'ready' });
  assert.equal(r.status, 'ready');
  r = await shop.setStatus(boss, mine.id, { status: 'done' });
  assert.equal(r.status, 'done');
  var other2 = listed.orders.find(function (o) { return o.orderNo === second.body.orderNo; });
  r = await shop.setStatus(boss, other2.id, { status: 'cancelled' });
  assert.equal(r.status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM invoices WHERE invoice_no = $1', [second.body.invoiceNo])).rows[0].status, 'void');
  await assert.rejects(shop.setStatus(boss, other2.id, { status: 'ready' }), /was cancelled/);
});

test('booking a consultation: open days and free times, a lead and a site visit, one per slot, cancelled from its page; staff confirm and assign', async function () {
  await pool.query("UPDATE settings SET booking = '{}' WHERE id = 1");
  assert.deepEqual(await bookings.options({}), { on: false });
  await assert.rejects(bookings.book({ service: 'showroom' }, '10.7.1.1'), /not open/);

  await assert.rejects(bookings.saveSettings(boss, { on: true, services: [], from: '08:00', to: '17:00', days: [0, 1, 2, 3, 4, 5, 6] }), /at least one/);
  await assert.rejects(bookings.saveSettings(boss, { on: true, services: bookings.DEFAULT_SERVICES, from: '17:00', to: '08:00', days: [1] }), /opening hours/);
  await bookings.saveSettings(boss, { on: true, intro: 'Zqh: come and see', services: bookings.DEFAULT_SERVICES, from: '08:00', to: '12:00', step: 60, perSlot: 1, daysAhead: 10, noticeHours: 0, days: [0, 1, 2, 3, 4, 5, 6], assignTo: boss.employee.id });
  var o = await bookings.options({ service: 'measure', date: day(2) });
  assert.equal(o.on, true);
  assert.ok(o.days.indexOf(day(2)) >= 0);
  assert.equal(o.service, 'measure');
  assert.deepEqual(o.slots.map(function (s) { return s.time; }), ['08:00', '09:00', '10:00']); // 90 minutes, done by 12:00

  var book = function (p, ip) { return bookings.book(Object.assign({ service: 'measure', date: day(2), time: '09:00', name: 'Zqh Abena Owusu', phone: '0244000222', email: 'zqh.abena@example.com', location: 'Zqh: Spintex road' }, p), ip || '10.7.1.2'); };
  await assert.rejects(book({ service: 'dance' }), /Choose what/);
  await assert.rejects(book({ date: day(40) }), /day we are open/);
  await assert.rejects(book({ time: '11:00' }), /not open/);
  await assert.rejects(book({ location: '' }), /Where should we come/);

  var made = await book({ note: 'Zqh: 4 windows' });
  assert.match(made.token, /^[A-Za-z0-9_-]{24}$/);
  var a = (await pool.query('SELECT * FROM appointments WHERE token = $1', [made.token])).rows[0];
  assert.equal(a.status, 'requested');
  assert.equal(a.assigned_to, boss.employee.id);
  var lead = (await pool.query('SELECT * FROM crm_leads WHERE id = $1', [a.lead_id])).rows[0];
  assert.equal(lead.source, 'Website booking');
  assert.equal(lead.item, 'Site measurement');
  assert.equal(lead.rep_id, boss.employee.id);
  var visit = (await pool.query('SELECT * FROM crm_site_visits WHERE id = $1', [a.site_visit_id])).rows[0];
  assert.equal(visit.location, 'Zqh: Spintex road');
  assert.deepEqual(visit.assessor_ids, [boss.employee.id]);

  // That time overlaps it now (one at a time); two at once for the last place: one gets it.
  o = await bookings.options({ service: 'measure', date: day(2) });
  assert.deepEqual(o.slots.filter(function (s) { return s.full; }).map(function (s) { return s.time; }), ['08:00', '09:00', '10:00']);
  await assert.rejects(book({ time: '10:00' }, '10.7.1.3'), /just took/);
  var both = await Promise.allSettled([book({ date: day(3), time: '08:00' }, '10.7.1.4'), book({ date: day(3), time: '08:00', name: 'Zqh Yaa Asante' }, '10.7.1.5')]);
  assert.equal(both.filter(function (x) { return x.status === 'fulfilled'; }).length, 1);
  assert.match(both.find(function (x) { return x.status === 'rejected'; }).reason.message, /just took/);

  // The customer's page, and over HTTP.
  var v = await http('GET', '/api/book/' + made.token);
  assert.equal(v.status, 200);
  assert.equal(v.body.serviceName, 'Site measurement');
  assert.equal(v.body.canCancel, true);
  assert.equal(v.body.phone, undefined, 'its page does not repeat the phone number');
  var bad = await http('GET', '/api/book/zqh-not-a-real-token-0000');
  assert.equal(bad.status, 404);

  // Staff confirm: the lead is contacted; done: the site visit is visited.
  var list = await bookings.list(boss, {});
  assert.ok(list.appointments.some(function (x) { return x.id === a.id && x.leadRef === lead.ref; }));
  var u = await bookings.update(boss, a.id, { status: 'confirmed' });
  assert.equal(u.status, 'confirmed');
  assert.equal((await pool.query('SELECT stage FROM crm_leads WHERE id = $1', [a.lead_id])).rows[0].stage, 'contacted');
  assert.ok(sent.some(function (m) { return m.to === 'zqh.abena@example.com' && /confirmed/.test(m.subject); }));
  await assert.rejects(bookings.update(boss, a.id, { status: 'requested' }), /Confirmed, done or cancelled/);

  // Cancelled by the customer: the time is free again and the visit called off.
  var cancelled = await http('POST', '/api/book/' + made.token + '/cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM crm_site_visits WHERE id = $1', [a.site_visit_id])).rows[0].status, 'cancelled');
  o = await bookings.options({ service: 'measure', date: day(2) });
  assert.equal(o.slots.find(function (s) { return s.time === '09:00'; }).full, false);
  var again = await http('POST', '/api/book/' + made.token + '/cancel');
  assert.equal(again.status, 409);

  // A call: no site visit.
  var call = await book({ service: 'call', date: day(4), time: '11:00', location: '' }, '10.7.1.6');
  var ca = (await pool.query('SELECT site_visit_id FROM appointments WHERE token = $1', [call.token])).rows[0];
  assert.equal(ca.site_visit_id, null);
});

test('a quotation approved online with a deposit is invoiced at once, and its page offers to pay the deposit', async function () {
  cust = await customers.create(boss, { name: 'Zqh Garden Lodge', phone: '0240000881', email: 'zqh.lodge@example.com', category: 'active' });
  var mk = async function (schedule) {
    var q = await quotations.create(boss, { customerId: cust.id, currency: 'GHS', items: [{ description: 'Zqh bamboo pergola', qty: 1, unitPrice: 10000 }], validUntil: day(20), paymentSchedule: schedule });
    await quotations.setStatus(boss, q.id, 'sent');
    return { q: q, link: await shares.createShareLink(boss, 'quotation', q.id, 7) };
  };
  var DEPOSIT = [{ label: 'Zqh deposit', type: 'percent', value: 30, dueDate: day(2) }, { label: 'Zqh balance', type: 'percent', value: 70, dueDate: day(30) }];

  // Online payments not set up: approved, nothing more.
  config.paystackBpl.secretKey = '';
  var a = await mk(DEPOSIT);
  var r = await http('POST', '/api/share/' + a.link.token + '/answer', { action: 'approved', name: 'Zqh Esi Mensah', signature: SIG });
  assert.equal(r.status, 200);
  assert.equal(r.body.pay, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM invoices WHERE quotation_id = $1', [a.q.id])).rows[0].n, 0);

  config.paystackBpl.secretKey = 'zqh-fake-bpl-paystack-key';
  // No schedule, and the setting is "deposit" (the default): left to the rep.
  var b = await mk([]);
  r = await http('POST', '/api/share/' + b.link.token + '/answer', { action: 'approved', name: 'Zqh Esi Mensah', signature: SIG });
  assert.equal(r.body.pay, null);

  // With a deposit: invoiced at once, its link kept, the rep told.
  var c = await mk(DEPOSIT);
  r = await http('POST', '/api/share/' + c.link.token + '/answer', { action: 'approved', name: 'Zqh Esi Mensah', signature: SIG });
  assert.equal(r.status, 200);
  assert.ok(r.body.pay && r.body.pay.token);
  assert.equal(r.body.pay.deposit, 3000);
  var inv = (await pool.query('SELECT * FROM invoices WHERE quotation_id = $1', [c.q.id])).rows[0];
  assert.equal(Number(inv.grand_total), 10000);
  assert.equal(inv.status, 'unpaid');
  var q = (await pool.query('SELECT pay_share_id FROM quotations WHERE id = $1', [c.q.id])).rows[0];
  assert.ok(q.pay_share_id);
  var page = await http('GET', '/api/share/' + c.link.token);
  assert.equal(page.body.pay.invoice.token, r.body.pay.token);
  assert.equal(page.body.pay.invoice.deposit, 3000);
  assert.equal(page.body.pay.invoice.depositPaid, false);
  // The invoice's page offers the deposit first.
  var invPage = await http('GET', '/api/share/' + r.body.pay.token);
  assert.equal(invPage.body.pay.on, true);
  assert.deepEqual(invPage.body.pay.options.map(function (o) { return [o.kind, o.amount]; }), [['next', 3000], ['all', 10000]]);
  var told = (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 AND title = $2', [boss.employee.id, '🧾 ' + inv.invoice_no + ' raised from ' + c.q.quoteNo])).rows;
  assert.equal(told.length, 1);

  // "Never": approved, nothing more.
  await pool.query("UPDATE settings SET commercial = jsonb_set(commercial, '{templates,invoiceOnApproval}', '\"never\"') WHERE id = 1");
  var d = await mk(DEPOSIT);
  r = await http('POST', '/api/share/' + d.link.token + '/answer', { action: 'approved', name: 'Zqh Esi Mensah', signature: SIG });
  assert.equal(r.body.pay, null);
  // "Always": even without a schedule.
  await pool.query("UPDATE settings SET commercial = jsonb_set(commercial, '{templates,invoiceOnApproval}', '\"always\"') WHERE id = 1");
  var e = await mk([]);
  r = await http('POST', '/api/share/' + e.link.token + '/answer', { action: 'approved', name: 'Zqh Esi Mensah', signature: SIG });
  assert.ok(r.body.pay.token);
  assert.equal(r.body.pay.deposit, null);
  await pool.query("UPDATE settings SET commercial = commercial #- '{templates,invoiceOnApproval}' WHERE id = 1");
});
