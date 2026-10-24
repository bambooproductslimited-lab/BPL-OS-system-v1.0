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
var invoices = require('../src/services/invoices.service');
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
// An order's invoice paid in full, as staff record it: the order is placed.
async function payFor(invoiceNo) {
  var inv = (await pool.query('SELECT id, balance_due FROM invoices WHERE invoice_no = $1', [invoiceNo])).rows[0];
  return invoices.recordPayment(boss, inv.id, { amount: Number(inv.balance_due), method: 'mobile_money', reference: 'Zqh MoMo' });
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
  await pool.query("DELETE FROM shop_orders WHERE name LIKE 'Zqh %'");
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
  config.paystackBpl.secretKey = '';
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
  // Paid first: until then nobody is told and staff do not see it.
  assert.deepEqual([ok.body.status, ok.body.payUrl, ok.body.payOnline], ['unpaid', null, false]);
  assert.ok(!sent.some(function (m) { return m.to === 'zqh.kofi@example.com'; }), 'no "we have your order" before it is paid');
  var told = function () { return pool.query("SELECT count(*)::int AS n FROM notifications WHERE title = $1", ['🛍️ New shop order ' + ok.body.orderNo + ' · paid']).then(function (x) { return x.rows[0].n; }); };
  assert.equal(await told(), 0);
  var waiting = await shop.list(boss, {});
  assert.ok(!waiting.orders.some(function (o) { return o.orderNo === ok.body.orderNo; }), 'not among the orders until paid');
  assert.ok(waiting.totals.unpaid >= 1);
  var unpaid = (await shop.list(boss, { status: 'unpaid' })).orders.find(function (o) { return o.orderNo === ok.body.orderNo; });
  await assert.rejects(shop.setStatus(boss, unpaid.id, { status: 'ready' }), /Not paid yet/);
  await assert.rejects(shop.setStatus(boss, unpaid.id, { status: 'unpaid' }), /unpaid until/);
  // Paid (staff record it on the invoice, or Paystack does): placed, staff told, the customer emailed once.
  await payFor(ok.body.invoiceNo);
  assert.ok(await told() >= 1);
  var mails = sent.filter(function (m) { return m.to === 'zqh.kofi@example.com' && /Your order SHOP-/.test(m.subject); });
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /We have your payment and your order SHOP-/);
  assert.equal(await shop.invoicePaid(inv.id), null, 'once');

  // The same phone again: the same customer.
  var second = await order({ name: 'Zqh Kofi B.', email: '', fulfilment: 'pickup', address: '', lines: [{ variationId: varL, qty: 1 }] });
  assert.equal(second.status, 201);
  var inv2 = (await pool.query('SELECT customer_id FROM invoices WHERE invoice_no = $1', [second.body.invoiceNo])).rows[0];
  assert.equal(inv2.customer_id, c.id);
  // Someone else's email typed with that phone is not made theirs: it would
  // sign in to "My account" as them.
  var third = await order({ email: 'zqh.stranger@example.com', fulfilment: 'pickup', address: '', lines: [{ variationId: varL, qty: 1 }] });
  assert.equal((await pool.query('SELECT customer_id FROM invoices WHERE invoice_no = $1', [third.body.invoiceNo])).rows[0].customer_id, c.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM customer_identities WHERE value = 'zqh.stranger@example.com'")).rows[0].n, 0);
  assert.equal((await pool.query('SELECT email FROM customers WHERE id = $1', [c.id])).rows[0].email, 'zqh.kofi@example.com');
  await payFor(second.body.invoiceNo);

  // Staff: the orders, marked ready and done; cancelled voids an unpaid invoice.
  var listed = await shop.list(boss, {});
  var mine = listed.orders.find(function (o) { return o.orderNo === ok.body.orderNo; });
  assert.equal(mine.status, 'new');
  assert.deepEqual([mine.invoice.balance, mine.invoice.paid, mine.invoice.status], [0, 900, 'paid']);
  assert.ok(listed.totals.fresh >= 2);
  var r = await shop.setStatus(boss, mine.id, { status: 'ready' });
  assert.equal(r.status, 'ready');
  r = await shop.setStatus(boss, mine.id, { status: 'done' });
  assert.equal(r.status, 'done');
  var other2 = listed.orders.find(function (o) { return o.orderNo === second.body.orderNo; });
  await assert.rejects(shop.setStatus(boss, other2.id, { status: 'cancelled' }), /refund it from the invoice first/);
  // An unpaid one cancelled: its invoice voided.
  var other3 = (await shop.list(boss, { status: 'unpaid' })).orders.find(function (o) { return o.orderNo === third.body.orderNo; });
  r = await shop.setStatus(boss, other3.id, { status: 'cancelled' });
  assert.equal(r.status, 'cancelled');
  assert.equal((await pool.query('SELECT status FROM invoices WHERE invoice_no = $1', [third.body.invoiceNo])).rows[0].status, 'void');
  await assert.rejects(shop.setStatus(boss, other3.id, { status: 'ready' }), /was cancelled/);

  // Never paid: cancelled after two days, its invoice voided; a paid one kept.
  var late = await order({ email: '', fulfilment: 'pickup', address: '', lines: [{ variationId: varM, qty: 1 }] });
  await pool.query("UPDATE shop_orders SET created_at = now() - interval '50 hours' WHERE order_no = ANY($1)", [[late.body.orderNo, second.body.orderNo]]);
  var swept = await shop.sweepUnpaid();
  assert.ok(swept.cancelled >= 1);
  var lateRow = (await pool.query('SELECT o.status, o.steps, i.status AS inv FROM shop_orders o JOIN invoices i ON i.id = o.invoice_id WHERE o.order_no = $1', [late.body.orderNo])).rows[0];
  assert.deepEqual([lateRow.status, lateRow.inv], ['cancelled', 'void']);
  assert.ok(lateRow.steps.cancelled);
  assert.equal((await pool.query('SELECT status FROM shop_orders WHERE order_no = $1', [second.body.orderNo])).rows[0].status, 'new');
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

test('booking fees: each service its own, a visit by its area; invoiced at once to pay on the customer website, voided if cancelled unpaid', async function () {
  await bookings.saveSettings(boss, { on: true, services: [
    { id: 'showroom', name: 'Showroom consultation', minutes: 60, fee: 100 },
    { id: 'measure', name: 'Site measurement', minutes: 60, visit: true, fee: 150 },
    { id: 'call', name: 'Phone call', minutes: 30, fee: 0 }
  ], areas: [{ name: 'Zqh Accra', fee: 200 }, { name: 'Zqh Kumasi', fee: 450 }], feeNote: 'Zqh: deducted from your order', from: '08:00', to: '12:00', step: 60, perSlot: 3, daysAhead: 10, noticeHours: 0, days: [0, 1, 2, 3, 4, 5, 6] });
  var o = await bookings.options({});
  assert.deepEqual(o.services.map(function (s) { return [s.id, s.fee]; }), [['showroom', 100], ['measure', 150], ['call', 0]]);
  assert.deepEqual(o.areas, [{ name: 'Zqh Accra', fee: 200 }, { name: 'Zqh Kumasi', fee: 450 }]);
  assert.equal(o.feeNote, 'Zqh: deducted from your order');

  var book = function (p, ip) { return bookings.book(Object.assign({ date: day(5), time: '09:00', name: 'Zqh Kojo Fee', phone: '0244000333', email: 'zqh.kojo@example.com', location: 'Zqh: Osu, by the castle' }, p), ip); };
  // A consultation: its own fee, invoiced to the customer, its page on the customer website.
  var c = await book({ service: 'showroom' }, '10.7.2.1');
  assert.equal(c.booking.fee.amount, 100);
  assert.equal(c.booking.fee.paid, false);
  assert.ok(c.booking.fee.token);
  var a = (await pool.query('SELECT * FROM appointments WHERE token = $1', [c.token])).rows[0];
  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [a.fee_invoice_id])).rows[0];
  assert.equal(Number(inv.grand_total), 100);
  assert.equal(inv.status, 'unpaid');
  assert.equal(String(inv.due_date).slice(0, 10), day(5));
  var line = (await pool.query("SELECT description FROM document_line_items WHERE document_type = 'invoice' AND document_id = $1", [inv.id])).rows[0];
  assert.equal(line.description, 'Showroom consultation fee');
  var cust = (await pool.query('SELECT * FROM customers WHERE id = $1', [a.customer_id])).rows[0];
  assert.equal(cust.name, 'Zqh Kojo Fee');
  assert.equal((await pool.query('SELECT customer_id FROM crm_leads WHERE id = $1', [a.lead_id])).rows[0].customer_id, cust.id);
  var mailed = sent.find(function (m) { return m.to === 'zqh.kojo@example.com' && /Your booking/.test(m.subject); });
  assert.match(mailed.text, /fee of GHS 100\.00 is on invoice/);
  assert.match(mailed.text, /https:\/\/online\.bplghana\.com\/share\//);
  assert.match(mailed.text, /https:\/\/online\.bplghana\.com\/book\//);
  // Its fee's page opens (to pay it).
  var page = await http('GET', '/api/share/' + c.booking.fee.token);
  assert.equal(page.status, 200);
  assert.equal(page.body.grandTotal, 100);

  // A visit: the area's fee, chosen; without an area, refused.
  await assert.rejects(book({ service: 'measure', time: '10:00' }, '10.7.2.2'), /Choose your area/);
  var v = await book({ service: 'measure', time: '10:00', area: 'zqh kumasi' }, '10.7.2.3');
  assert.equal(v.booking.fee.amount, 450);
  assert.equal(v.booking.area, 'Zqh Kumasi');
  // A free call: no invoice.
  var f = await book({ service: 'call', time: '11:00' }, '10.7.2.4');
  assert.equal(f.booking.fee, null);
  assert.equal((await pool.query('SELECT fee_invoice_id FROM appointments WHERE token = $1', [f.token])).rows[0].fee_invoice_id, null);

  // Staff see the fee due; cancelled unpaid, its invoice is voided.
  var listed = await bookings.list(boss, { from: day(4), to: day(6) });
  var mine = listed.appointments.find(function (x) { return x.name === 'Zqh Kojo Fee' && x.serviceName === 'Site measurement'; });
  assert.equal(mine.fee.due, 450);
  assert.equal(mine.area, 'Zqh Kumasi');
  var gone = await http('POST', '/api/book/' + v.token + '/cancel');
  assert.equal(gone.body.status, 'cancelled');
  assert.equal(gone.body.fee.void, true);
  assert.equal((await pool.query('SELECT i.status FROM appointments a JOIN invoices i ON i.id = a.fee_invoice_id WHERE a.token = $1', [v.token])).rows[0].status, 'void');
  // Paid, then cancelled by staff: the invoice stays, to refund.
  await pool.query("UPDATE invoices SET status = 'paid', amount_paid = grand_total, balance_due = 0 WHERE id = $1", [inv.id]);
  var paidView = await http('GET', '/api/book/' + c.token);
  assert.equal(paidView.body.fee.paid, true);
  await bookings.update(boss, a.id, { status: 'cancelled' });
  assert.equal((await pool.query('SELECT status FROM invoices WHERE id = $1', [inv.id])).rows[0].status, 'paid');
});

test('the customer website online.bplghana.com reaches the shop, the bookings and documents\' pages, nothing else', async function () {
  var call = function (path) { return fetch(base + path, { headers: { Origin: 'https://online.bplghana.com' } }); };
  var ok = await call('/api/book');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://online.bplghana.com');
  ok = await call('/api/shop');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://online.bplghana.com');
  ok = await call('/api/share/zqh-not-a-token');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://online.bplghana.com');
  var no = await call('/api/employees');
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  no = await call('/api/shop-orders');
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  no = await call('/api/bookings');
  assert.equal(no.headers.get('access-control-allow-origin'), null);
  var listed = await shop.list(boss, {});
  assert.equal(listed.url, 'https://online.bplghana.com');
});

// The ninth batch's shop and booking changes (migrations 0189-0190), here
// because this file owns the shop's and the booking page's settings while
// it runs: days to make, discount codes, and the reminder before a booking.
test('made to order: each item\'s days to make on the shop and at checkout, the order ready between those days', async function () {
  var s = (await shop.getSettings(boss)).settings;
  await shop.saveSettings(boss, Object.assign({}, s, { on: true, categories: [catA] }));
  await assert.rejects(shop.saveMakeDays(boss, { items: [{ itemId: item, from: 7, to: 3 }] }), /e\.g\. 3 to 7/);
  await assert.rejects(shop.saveMakeDays(boss, { items: [{ itemId: item, from: 3, to: 400 }] }), /from 0 to 180/);
  var got = await shop.saveMakeDays(boss, { items: [{ itemId: item, from: 3, to: 7 }] });
  assert.deepEqual(got.items.find(function (i) { return i.id === item; }).makeDays, { from: 3, to: 7 });
  var page = await http('GET', '/api/shop');
  assert.deepEqual(page.body.items.find(function (i) { return i.id === item; }).makeDays, { from: 3, to: 7 });

  shop._placedBy.clear();
  config.paystackBpl.secretKey = '';
  var r = await http('POST', '/api/shop/orders', { name: 'Zqh Make Days', phone: '024 400 0611', email: 'zqh.make@example.com', fulfilment: 'pickup', lines: [{ variationId: varM, qty: 1 }] });
  assert.equal(r.status, 201);
  await payFor(r.body.invoiceNo);
  var ready = shop.readyOf([{ makeDays: { from: 3, to: 7 } }]);
  assert.deepEqual(r.body.ready, ready);
  assert.notEqual(new Date(ready.from + 'T00:00:00Z').getUTCDay(), 0, 'never a Sunday');
  var o = (await pool.query('SELECT ready_from, ready_by, lines FROM shop_orders WHERE order_no = $1', [r.body.orderNo])).rows[0];
  assert.deepEqual([o.ready_from, o.ready_by], [ready.from, ready.by]);
  assert.deepEqual(o.lines[0].makeDays, { from: 3, to: 7 });
  var inv = (await pool.query('SELECT notes FROM invoices WHERE invoice_no = $1', [r.body.invoiceNo])).rows[0];
  assert.match(inv.notes, /Made to order: ready between /);
  assert.ok(sent.some(function (m) { return m.to === 'zqh.make@example.com' && /made to order: it will be ready between/.test(m.text); }));
  var listed = (await shop.list(boss, {})).orders.find(function (x) { return x.orderNo === r.body.orderNo; });
  assert.equal(listed.readyBy, ready.by);
  assert.equal(listed.status, 'new');

  // Cleared: in stock, no days; an order of it is ready now (none kept).
  await shop.saveMakeDays(boss, { items: [{ itemId: item, from: '', to: '' }] });
  page = await http('GET', '/api/shop');
  assert.equal(page.body.items.find(function (i) { return i.id === item; }).makeDays, null);
  r = await http('POST', '/api/shop/orders', { name: 'Zqh Make Days', phone: '024 400 0611', fulfilment: 'pickup', lines: [{ variationId: varM, qty: 1 }] });
  assert.equal(r.body.ready, null);
  // One of the two given: both that.
  got = await shop.saveMakeDays(boss, { items: [{ itemId: item, from: 5 }] });
  assert.deepEqual(got.items.find(function (i) { return i.id === item; }).makeDays, { from: 5, to: 5 });
  await shop.saveMakeDays(boss, { items: [{ itemId: item, from: null, to: null }] });
});

test('shop discount codes: a percentage or an amount off, a least order, an end date, a number of uses; checked at checkout and taken off the invoice', async function () {
  var s = (await shop.getSettings(boss)).settings;
  await assert.rejects(shop.saveSettings(boss, Object.assign({}, s, { codes: [{ code: 'ZQH95', kind: 'percent', value: 95 }] })), /a percentage up to 90/);
  await shop.saveSettings(boss, Object.assign({}, s, { on: true, categories: [catA], codes: [
    { code: 'zqh10', kind: 'percent', value: 10 },
    { code: 'ZQH-50', kind: 'amount', value: 50, minTotal: 500, maxUses: 1 },
    { code: 'ZQHOLD', kind: 'amount', value: 20, endsOn: day(-1) },
    { code: 'ZQHOFF', kind: 'amount', value: 20, on: false }
  ] }));
  var saved = (await shop.getSettings(boss)).settings.codes;
  assert.deepEqual(saved.map(function (c) { return c.code; }), ['ZQH10', 'ZQH-50', 'ZQHOLD', 'ZQHOFF']);
  assert.equal((await http('GET', '/api/shop')).body.shop.codes, true);

  var check = function (code, subtotal) { return http('GET', '/api/shop/code?code=' + encodeURIComponent(code) + '&subtotal=' + subtotal); };
  var c = await check('zqh10', 250);
  assert.equal(c.status, 200);
  assert.deepEqual([c.body.code, c.body.discount], ['ZQH10', 25]);
  c = await check('ZQH-50', 250);
  assert.match(c.body.error.message, /orders of GHS 500\.00 or more/);
  c = await check('ZQHOLD', 250);
  assert.match(c.body.error.message, /not right, or has ended/);
  c = await check('ZQHOFF', 250);
  assert.match(c.body.error.message, /not right, or has ended/);

  shop._placedBy.clear();
  config.paystackBpl.secretKey = '';
  var order = function (code, lines) { return http('POST', '/api/shop/orders', { name: 'Zqh Code Buyer', phone: '024 400 0612', fulfilment: 'pickup', code: code, lines: lines }); };
  var r = await order('zqh10', [{ variationId: varM, qty: 2 }]);
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.total, r.body.discount, r.body.code], [450, 50, 'ZQH10']);
  var inv = (await pool.query('SELECT grand_total, discount_total, notes FROM invoices WHERE invoice_no = $1', [r.body.invoiceNo])).rows[0];
  assert.deepEqual([Number(inv.grand_total), Number(inv.discount_total)], [450, 50]);
  assert.match(inv.notes, /Code ZQH10: GHS 50\.00 off/);
  var row = (await pool.query('SELECT promo_code, discount FROM shop_orders WHERE order_no = $1', [r.body.orderNo])).rows[0];
  assert.deepEqual([row.promo_code, Number(row.discount)], ['ZQH10', 50]);

  // An amount off, once: used up after.
  r = await order('ZQH-50', [{ variationId: varL, qty: 2 }]);
  assert.deepEqual([r.body.total, r.body.discount], [750, 50]);
  r = await order('ZQH-50', [{ variationId: varL, qty: 2 }]);
  assert.match(r.body.error.message, /used up/);
  r = await order('NOPE', [{ variationId: varL, qty: 1 }]);
  assert.match(r.body.error.message, /not right/);
  var uses = (await shop.getSettings(boss)).codeUses;
  assert.deepEqual(uses.ZQH10, { uses: 1, off: 50 });
  // A cancelled order gives its use back.
  var gone = (await shop.list(boss, { status: 'unpaid' })).orders.find(function (x) { return x.promoCode === 'ZQH-50'; });
  await shop.setStatus(boss, gone.id, { status: 'cancelled' });
  c = await check('ZQH-50', 800);
  assert.equal(c.body.discount, 50);
});

test('the reminder before a booking: confirmed ones, the day before, once, with the fee still to pay; none when set to none', async function () {
  await bookings.saveSettings(boss, { on: true, services: [
    { id: 'showroom', name: 'Showroom consultation', minutes: 60, fee: 100 },
    { id: 'call', name: 'Phone call', minutes: 30, fee: 0 }
  ], from: '08:00', to: '12:00', step: 60, perSlot: 3, daysAhead: 10, noticeHours: 0, days: [0, 1, 2, 3, 4, 5, 6], remindHours: 24 });
  assert.equal((await bookings.settingsOf()).remindHours, 24);
  var made = await bookings.book({ service: 'showroom', date: day(3), time: '09:00', name: 'Zqh Remind Me', phone: '0244000444', email: 'zqh.remind@example.com', location: 'Zqh: Labone' }, '10.7.3.1');
  var asked = await bookings.book({ service: 'call', date: day(3), time: '10:00', name: 'Zqh Not Confirmed', phone: '0244000445', email: 'zqh.unconfirmed@example.com' }, '10.7.3.2');
  var a = (await pool.query('SELECT * FROM appointments WHERE token = $1', [made.token])).rows[0];
  await bookings.update(boss, a.id, { status: 'confirmed' });
  var before = new Date(new Date(a.starts_at).getTime() - 20 * 3600000);
  sent.length = 0;
  // Too early: not yet.
  assert.equal(await bookings.remindDue(new Date(new Date(a.starts_at).getTime() - 30 * 3600000)), 0);
  assert.equal(await bookings.remindDue(before), 1);
  var m = sent.find(function (x) { return x.to === 'zqh.remind@example.com'; });
  assert.equal(m.subject, 'A reminder of your booking');
  assert.match(m.text, /^Bamboo Products: a reminder of your showroom consultation on /);
  assert.match(m.text, /The fee of GHS 100\.00 is still to pay: https:\/\/online\.bplghana\.com\/share\//);
  assert.match(m.text, /See or cancel it: https:\/\/online\.bplghana\.com\/book\//);
  assert.ok(!sent.some(function (x) { return x.to === 'zqh.unconfirmed@example.com'; }), 'only confirmed bookings');
  assert.equal(await bookings.remindDue(before), 0, 'once');
  var listed = (await bookings.list(boss, { from: day(2), to: day(4) })).appointments.find(function (x) { return x.id === a.id; });
  assert.ok(listed.remindedAt);
  // Paid: the reminder does not ask for it.
  await pool.query('UPDATE appointments SET reminded_at = NULL WHERE id = $1', [a.id]);
  await pool.query("UPDATE invoices SET status = 'paid', amount_paid = grand_total, balance_due = 0 WHERE id = $1", [a.fee_invoice_id]);
  sent.length = 0;
  await bookings.remindDue(before);
  assert.doesNotMatch(sent[0].text, /still to pay/);
  // None: nothing goes.
  await pool.query("UPDATE settings SET booking = jsonb_set(booking, '{remindHours}', '0') WHERE id = 1");
  await pool.query('UPDATE appointments SET reminded_at = NULL WHERE id = $1', [a.id]);
  assert.equal(await bookings.remindDue(before), 0);
  assert.ok(asked.token);
});

// The tenth batch's shop changes (migration 0191): delivery by area, and
// the order's own page to follow it as staff move it along.
test('shop delivery by area and the order\'s own page: being made, ready, on its way, delivered; the customer told', async function () {
  shop._placedBy.clear();
  var s = (await shop.getSettings(boss)).settings;
  await shop.saveSettings(boss, Object.assign({}, s, { on: true, categories: [catA], delivery: true, pickup: true, pickupAddress: 'Zqh showroom', codes: [],
    areas: [{ name: 'Zqh Accra', fee: 50 }, { name: 'Zqh Tema', fee: 80 }, { name: 'x', fee: 9 }, { name: 'Zqh Accra', fee: 99 }] }));
  var page = await http('GET', '/api/shop');
  assert.deepEqual(page.body.shop.areas, [{ name: 'Zqh Accra', fee: 50 }, { name: 'Zqh Tema', fee: 80 }]);
  // Paystack stubbed: the checkout goes straight to its page, back to the order's.
  var asked = [];
  config.paystackBpl.secretKey = 'zqh-fake-bpl-paystack-key';
  invoicePay.setFetchForTests(async function (url, o) {
    asked.push({ url: url, body: o.body ? JSON.parse(o.body) : null });
    return { ok: true, status: 200, json: async function () { return { status: true, data: { authorization_url: 'https://checkout.paystack.test/zqh-' + asked.length } }; } };
  });
  var order = function (p) { return http('POST', '/api/shop/orders', Object.assign({ name: 'Zqh Track Me', phone: '024 400 0711', email: 'zqh.track@example.com', fulfilment: 'delivery', address: 'Zqh: Tema Community 5', lines: [{ variationId: varM, qty: 1 }] }, p)); };
  var bad = await order({});
  assert.match(bad.body.error.message, /Choose your area/);
  var r = await order({ area: 'zqh tema' });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 330, '250 and the area\'s 80');
  assert.deepEqual([r.body.area, r.body.deliveryFee], ['Zqh Tema', 80]);
  assert.match(r.body.trackUrl, /^https:\/\/online\.bplghana\.com\/o\/[A-Za-z0-9_-]{24}$/);
  var lines = (await pool.query("SELECT description, unit_price FROM document_line_items WHERE document_type = 'invoice' AND document_id = (SELECT id FROM invoices WHERE invoice_no = $1) ORDER BY sort_order", [r.body.invoiceNo])).rows;
  assert.deepEqual(lines.map(function (l) { return [l.description, Number(l.unit_price)]; }), [['Zqh roller blind — Medium', 250], ['Delivery (Zqh Tema)', 80]]);
  assert.equal(r.body.payUrl, 'https://checkout.paystack.test/zqh-1');
  var init = asked.find(function (x) { return /\/transaction\/initialize$/.test(x.url); });
  assert.equal(init.body.amount, 33000, 'all of it, in pesewas');
  assert.equal(init.body.callback_url, r.body.trackUrl, 'back to the order\'s own page');
  // A pickup pays no fee and needs no area.
  var pick = await order({ fulfilment: 'pickup', address: '', email: '' });
  assert.equal(pick.body.total, 250);

  // Its own page: unpaid until paid, no phone or email.
  var t = await http('GET', '/api/shop/orders/' + r.body.orderToken);
  assert.equal(t.status, 200);
  assert.deepEqual([t.body.status, t.body.area, t.body.deliveryFee, t.body.name], ['unpaid', 'Zqh Tema', 80, 'Zqh']);
  assert.equal(t.body.phone, undefined);
  assert.equal(t.body.email, undefined);
  assert.equal(t.body.invoice.paid, false);
  assert.ok(t.body.invoice.token);
  assert.equal(t.body.payOnline, true);
  assert.equal((await http('GET', '/api/shop/orders/zqh-not-an-order-token-00')).status, 404);
  sent.length = 0;
  await payFor(r.body.invoiceNo);
  await payFor(pick.body.invoiceNo);
  invoicePay.setFetchForTests(null);
  config.paystackBpl.secretKey = '';
  assert.ok(sent.some(function (m) { return m.to === 'zqh.track@example.com' && m.text.indexOf(r.body.trackUrl) >= 0; }), 'the order email has its page');
  t = await http('GET', '/api/shop/orders/' + r.body.orderToken);
  assert.deepEqual([t.body.status, t.body.invoice.paid], ['new', true]);
  assert.ok(t.body.steps.new && t.body.steps.paid);

  // Staff move it along; each step is kept and the customer emailed.
  var mine = (await shop.list(boss, {})).orders.find(function (o) { return o.orderNo === r.body.orderNo; });
  assert.equal(mine.trackUrl, r.body.trackUrl);
  sent.length = 0;
  var u = await shop.setStatus(boss, mine.id, { status: 'making' });
  assert.equal(u.status, 'making');
  assert.equal(u.emailed, true);
  assert.match(sent[0].subject, /being made/);
  await shop.setStatus(boss, mine.id, { status: 'ready' });
  u = await shop.setStatus(boss, mine.id, { status: 'out' });
  assert.match(sent[sent.length - 1].text, /on its way to you/);
  await shop.setStatus(boss, mine.id, { status: 'done' });
  t = await http('GET', '/api/shop/orders/' + r.body.orderToken);
  assert.equal(t.body.status, 'done');
  assert.deepEqual(Object.keys(t.body.steps).sort(), ['done', 'making', 'new', 'out', 'paid', 'ready']);
  var pk = (await shop.list(boss, {})).orders.find(function (o) { return o.orderNo === pick.body.orderNo; });
  await assert.rejects(shop.setStatus(boss, pk.id, { status: 'out' }), /Only a delivery goes out/);
  assert.ok((await shop.list(boss, {})).totals.making >= 0);
});
