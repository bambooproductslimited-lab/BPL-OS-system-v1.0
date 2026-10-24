// The tenth batch on Bamboo Products' side (migration 0191): "My account" on
// the customer website — a code by email or text, then the customer's own
// orders, invoices, quotations, bookings and contracts. Fake Zqt data only;
// nothing goes out: email to a test transport, texts to a stand-in.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var customers = require('../src/services/customers.service');
var quotations = require('../src/services/quotations.service');
var invoices = require('../src/services/invoices.service');
var contracts = require('../src/services/contracts.service');
var portal = require('../src/services/portal.service');
var mail = require('../src/services/mail.service');
var sms = require('../src/services/sms.service');
var { buildContext } = require('../src/services/context.service');

var boss, server, base, fam, other, inv, paidInv, q;
var sent = [], texts = [];
var real = { configured: sms.configured, send: sms.send };
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
async function http(method, path, body, headers) {
  var res = await fetch(base + path, { method: method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: body == null ? undefined : JSON.stringify(body) });
  var json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, body: json, headers: res.headers };
}
function codeIn(text) { var m = /(?:code|account) is (\d{6})/.exec(text || ''); return m ? m[1] : null; }
async function cleanup() {
  var custs = (await pool.query("SELECT id FROM customers WHERE name LIKE 'Zqt %'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM portal_codes WHERE address LIKE 'zqt.%' OR address IN ('233240000991', '233240000992', '233240000993')");
  await pool.query("DELETE FROM appointments WHERE name LIKE 'Zqt %'");
  if (custs.length) {
    await pool.query('DELETE FROM contracts WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM shop_orders WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM receipts WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1))', [custs]);
    await pool.query('DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1))', [custs]);
    await pool.query("DELETE FROM document_shares WHERE document_id IN (SELECT id FROM quotations WHERE customer_id = ANY($1) UNION SELECT id FROM invoices WHERE customer_id = ANY($1))", [custs]);
    await pool.query("DELETE FROM document_line_items WHERE document_id IN (SELECT id FROM invoices WHERE customer_id = ANY($1) UNION SELECT id FROM quotations WHERE customer_id = ANY($1))", [custs]);
    await pool.query('DELETE FROM invoices WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM quotations WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM customer_identities WHERE customer_id = ANY($1)', [custs]);
    await pool.query('DELETE FROM customers WHERE id = ANY($1)', [custs]);
  }
}

test.before(async function () {
  await cleanup();
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  fam = await customers.create(boss, { name: 'Zqt Owusu Family', phone: '0240000991', email: 'zqt.owusu@example.com', category: 'active' });
  other = await customers.create(boss, { name: 'Zqt Someone Else', phone: '0240000992', email: 'zqt.else@example.com', category: 'active' });
  inv = await invoices.createManual(boss, { customerId: fam.id, currency: 'GHS', items: [{ description: 'Zqt bamboo blinds', qty: 2, unitPrice: 400 }], dueDate: day(-3) });
  paidInv = await invoices.createManual(boss, { customerId: fam.id, currency: 'GHS', items: [{ description: 'Zqt lamp', qty: 1, unitPrice: 300 }] });
  await invoices.recordPayment(boss, paidInv.id, { amount: 300, method: 'mobile_money' });
  await invoices.createManual(boss, { customerId: other.id, currency: 'GHS', items: [{ description: 'Zqt not theirs', qty: 1, unitPrice: 999 }] });
  q = await quotations.create(boss, { customerId: fam.id, currency: 'GHS', title: 'Zqt pergola', items: [{ description: 'Zqt pergola kit', qty: 1, unitPrice: 18000 }], validUntil: day(20) });
  await quotations.setStatus(boss, q.id, 'sent');
  var k = await contracts.create(boss, { customerId: fam.id, title: 'Zqt pergola agreement', body: 'Zqt: we build the pergola for {customer}.' });
  await contracts.send(boss, k.id);
  await pool.query("INSERT INTO shop_orders (order_no, customer_id, name, phone, fulfilment, total, status, token) VALUES ('ZQT-1', $1, 'Zqt Owusu', '+233240000991', 'pickup', 760, 'making', 'zqt-order-token-0000000001')", [fam.id]);
  await pool.query("INSERT INTO appointments (service, service_name, starts_at, ends_at, name, phone, email, token, status) VALUES ('showroom', 'Showroom consultation', now() + interval '3 days', now() + interval '3 days 1 hour', 'Zqt Owusu', '+233240000991', 'zqt.owusu@example.com', 'zqt-booking-token-000000001', 'confirmed')");
  mail.setTransportForTests({ sendMail: async function (m) { sent.push(m); return { messageId: 'zqt-' + sent.length }; } });
  sms.configured = function () { return true; };
  sms.send = async function (o) { texts.push(o); return { id: 'zqt-' + texts.length, to: o.to }; };
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () {
  sms.configured = real.configured; sms.send = real.send;
  mail.setTransportForTests(null);
  if (server) await new Promise(function (r) { server.close(r); });
  await cleanup();
  await pool.end();
});

test('my account: a code by email, then only that customer\'s own orders, invoices to pay, quotations to approve, bookings and contracts to sign', async function () {
  portal._askedBy.clear();
  assert.deepEqual(portal.addressOf(' ZQT.Owusu@Example.com '), { kind: 'email', address: 'zqt.owusu@example.com' });
  assert.deepEqual(portal.addressOf('024 000 0991'), { kind: 'phone', address: '233240000991' });
  assert.equal(portal.addressOf('hello'), null);
  var bad = await http('POST', '/api/portal/code', { address: 'nope' });
  assert.match(bad.body.error.message, /email or the phone number/);

  // An address we do not have: the same answer, nothing sent.
  var none = await http('POST', '/api/portal/code', { address: 'zqt.stranger@example.com' });
  assert.equal(none.status, 200);
  assert.equal(none.body.sent, true);
  assert.equal(sent.length, 0);

  var r = await http('POST', '/api/portal/code', { address: 'ZQT.owusu@example.com' });
  assert.deepEqual([r.body.sent, r.body.kind, r.body.to], [true, 'email', 'zq•••@example.com']);
  var code = codeIn(sent[0].text);
  assert.match(code, /^\d{6}$/);
  assert.equal((await pool.query("SELECT code_hash FROM portal_codes WHERE address = 'zqt.owusu@example.com'")).rows[0].code_hash.length, 64, 'the code is kept hashed');

  var wrong = await http('POST', '/api/portal/login', { address: 'zqt.owusu@example.com', code: code === '000000' ? '111111' : '000000' });
  assert.match(wrong.body.error.message, /not right/);
  var ok = await http('POST', '/api/portal/login', { address: 'zqt.owusu@example.com', code: code });
  assert.equal(ok.status, 200);
  var token = ok.body.token;
  var again = await http('POST', '/api/portal/login', { address: 'zqt.owusu@example.com', code: code });
  assert.equal(again.status, 400, 'a code works once');

  var me = await http('GET', '/api/portal/me', null, { 'X-Portal-Token': token });
  assert.equal(me.status, 200);
  var b = me.body;
  assert.equal(b.name, 'Zqt Owusu Family');
  assert.deepEqual(b.invoices.map(function (x) { return [x.status, x.balance]; }), [['unpaid', 800], ['paid', 0]]);
  assert.equal(b.invoices[0].overdue, true);
  assert.match(b.invoices[0].url, /^https:\/\/online\.bplghana\.com\/share\//);
  assert.ok(!b.invoices.some(function (x) { return x.total === 999; }), 'not someone else\'s');
  assert.deepEqual([b.quotes[0].no, b.quotes[0].toAnswer], [q.quoteNo, true]);
  assert.deepEqual([b.contracts[0].status, b.contracts[0].title], ['sent', 'Zqt pergola agreement']);
  assert.match(b.contracts[0].url, /\/c\//);
  assert.deepEqual([b.orders[0].orderNo, b.orders[0].status], ['ZQT-1', 'making']);
  assert.equal(b.orders[0].url, 'https://online.bplghana.com/o/zqt-order-token-0000000001');
  assert.equal(b.bookings[0].upcoming, true);
  assert.deepEqual(b.waiting, { toPay: 800, invoices: 1, toApprove: 1, toSign: 1, upcoming: 1, orders: 1 });
  // The same document's link is kept, not a new one each time.
  var me2 = await http('GET', '/api/portal/me', null, { 'X-Portal-Token': token });
  assert.equal(me2.body.invoices[0].url, b.invoices[0].url);

  var out = await http('POST', '/api/portal/logout', {}, { 'X-Portal-Token': token });
  assert.equal(out.status, 200);
  assert.equal((await http('GET', '/api/portal/me', null, { 'X-Portal-Token': token })).status, 401);
});

test('my account by text: the phone on file, five tries, three codes in a quarter of an hour; the website reaches it', async function () {
  portal._askedBy.clear();
  var r = await http('POST', '/api/portal/code', { address: '024 000 0991' });
  assert.equal(r.body.kind, 'phone');
  assert.equal(texts.length, 1);
  assert.equal(texts[0].to, '+233240000991');
  assert.equal(texts[0].logMessage, 'Your Bamboo Products sign-in code is ••••••.', 'the code is not kept in the text log');
  var code = codeIn(texts[0].message);
  for (var i = 0; i < 5; i++) await http('POST', '/api/portal/login', { address: '0240000991', code: '00000' + i === code ? '999999' : '00000' + i });
  var locked = await http('POST', '/api/portal/login', { address: '0240000991', code: code });
  assert.equal(locked.status, 400, 'five wrong tries and the code is spent');
  await http('POST', '/api/portal/code', { address: '0240000991' });
  var third = await http('POST', '/api/portal/code', { address: '0240000991' });
  assert.equal(third.status, 200);
  var fourth = await http('POST', '/api/portal/code', { address: '0240000991' });
  assert.equal(fourth.status, 429);
  var last = codeIn(texts[texts.length - 1].message);
  var ok = await http('POST', '/api/portal/login', { address: '+233 24 000 0991', code: last });
  assert.equal(ok.status, 200);
  var me = await http('GET', '/api/portal/me', null, { 'X-Portal-Token': ok.body.token });
  assert.equal(me.body.invoices.length, 2);
  assert.match(me.body.signedInAs, /^\+233 ••• 991$/);

  // Texts not set up: say so, and suggest email.
  sms.configured = function () { return false; };
  var off = await http('POST', '/api/portal/code', { address: '0240000992' });
  assert.match(off.body.error.message, /Use your email address/);
  sms.configured = function () { return true; };

  var pre = await fetch(base + '/api/portal/me', { method: 'OPTIONS', headers: { Origin: 'https://online.bplghana.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-portal-token' } });
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://online.bplghana.com');
  assert.match(String(pre.headers.get('access-control-allow-headers')), /x-portal-token/i);
});

test('making an account: a code to the email given, the customer made only once it is typed back; one we have just signs in; another\'s phone not taken', async function () {
  portal._askedBy.clear();
  var r = await http('POST', '/api/portal/signup', { name: ' ', email: 'zqt.new@example.com' });
  assert.match(r.body.error.message, /Type your name/);
  r = await http('POST', '/api/portal/signup', { name: 'Zqt New Customer' });
  assert.match(r.body.error.message, /email or your phone/);
  r = await http('POST', '/api/portal/signup', { name: 'Zqt New Customer', email: 'zqt.new@' });
  assert.match(r.body.error.message, /does not look right/);

  sent.length = 0;
  r = await http('POST', '/api/portal/signup', { name: 'Zqt New Customer', email: 'ZQT.New@example.com', phone: '024 000 0993' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.sent, r.body.kind, r.body.to, r.body.address], [true, 'email', 'zq•••@example.com', 'zqt.new@example.com']);
  assert.match(sent[0].text, /code to make your account is \d{6}/);
  var made = function () { return pool.query("SELECT * FROM customers WHERE lower(email) = 'zqt.new@example.com'").then(function (x) { return x.rows; }); };
  assert.equal((await made()).length, 0, 'nobody made before the code is typed back');
  var ok = await http('POST', '/api/portal/login', { address: 'zqt.new@example.com', code: codeIn(sent[0].text) });
  assert.equal(ok.status, 200);
  var c = (await made())[0];
  assert.deepEqual([c.name, c.phone, c.category, c.origin_channel], ['Zqt New Customer', '+233240000993', 'lead', 'website']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM customer_identities WHERE customer_id = $1', [c.id])).rows[0].n, 2);
  var me = await http('GET', '/api/portal/me', null, { 'X-Portal-Token': ok.body.token });
  assert.equal(me.body.name, 'Zqt New Customer');
  assert.deepEqual(me.body.profile, { name: 'Zqt New Customer', phone: '+233240000993', email: 'zqt.new@example.com', address: '' });
  assert.deepEqual([me.body.orders.length, me.body.invoices.length], [0, 0]);

  // An address we have: just a sign-in code, nobody new.
  sent.length = 0;
  r = await http('POST', '/api/portal/signup', { name: 'Zqt Owusu Again', email: 'zqt.owusu@example.com' });
  assert.equal(r.status, 200);
  assert.match(sent[0].text, /sign-in code is \d{6}/);
  ok = await http('POST', '/api/portal/login', { address: 'zqt.owusu@example.com', code: codeIn(sent[0].text) });
  me = await http('GET', '/api/portal/me', null, { 'X-Portal-Token': ok.body.token });
  assert.equal(me.body.name, 'Zqt Owusu Family');
  assert.equal(me.body.profile.phone, '0240000991', 'as kept on their record');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM customers WHERE name = 'Zqt Owusu Again'")).rows[0].n, 0);

  // Someone else's phone with a new email: the account is made without it.
  sent.length = 0;
  await http('POST', '/api/portal/signup', { name: 'Zqt Sneaky', email: 'zqt.sneaky@example.com', phone: '0240000992' });
  ok = await http('POST', '/api/portal/login', { address: 'zqt.sneaky@example.com', code: codeIn(sent[0].text) });
  me = await http('GET', '/api/portal/me', null, { 'X-Portal-Token': ok.body.token });
  assert.equal(me.body.name, 'Zqt Sneaky');
  assert.equal(me.body.profile.phone, '');
  assert.equal(me.body.invoices.length, 0, 'nothing of the phone\'s owner');
});
