/*
 * Rent-side invoices in Bamboo Products' invoices (CAM, water & power, Square
 * repeat invoices) found and moved to Poki (rentSideMove.service.js).
 * Customers use the ZRS prefix and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var invoices = require('../src/services/invoices.service');
var move = require('../src/services/rentSideMove.service');
var poki = require('../src/services/poki.service');

var admin, shop, mixed, buyer, pokiId;

async function cleanup() {
  var cust = "(SELECT id FROM customers WHERE name LIKE 'ZRS%')";
  var inv = '(SELECT id FROM invoices WHERE customer_id IN ' + cust + ')';
  await pool.query('DELETE FROM receipts WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query("DELETE FROM document_line_items WHERE document_type = 'invoice' AND document_id IN " + inv);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query('DELETE FROM poki_tenants WHERE customer_id IN ' + cust);
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZRS%'");
}
async function custOf(name, phone) { return (await pool.query('INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id', [name, phone])).rows[0].id; }
function inv(customerId, description, price) { return invoices.createManual(admin, { customerId: customerId, items: [{ description: description, qty: 1, unitPrice: price }] }); }
async function row(id) { return (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0]; }

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  pokiId = await poki.pokiCompanyId();
  shop = await custOf('ZRS Jobadee Paint', '0240001111');
  mixed = await custOf('ZRS Electricals', '0240002222');
  buyer = await custOf('ZRS Bamboo Buyer', '0240003333');
});
test.after(async function () { await cleanup(); await pool.end(); });

test('finds the rent-side invoices among Bamboo Products\' own, and suggests what they are', async function () {
  var cam = await inv(shop, 'CAM fee — September', 100);
  await invoices.recordPayment(admin, cam.id, { amount: 100, method: 'cash' });
  var wp = await inv(shop, 'Water and power — September', 400);
  var sq = await inv(shop, 'Square invoice 000553-R-0011', 100);
  await pool.query("UPDATE invoices SET invoice_no = 'ZRS-SQ-000553-R-0011' WHERE id = $1", [sq.id]);
  var elec = await inv(mixed, 'Electricity bill', 250);
  var chairs = await inv(mixed, 'Bamboo chairs', 900);
  var plain = await inv(buyer, 'Bamboo floor panels', 5000);

  var found = (await move.candidates(admin)).filter(function (g) { return /^ZRS/.test(g.customerName); });
  var byName = Object.fromEntries(found.map(function (g) { return [g.customerName, g]; }));
  assert.ok(!byName['ZRS Bamboo Buyer'], 'an ordinary sale is not picked');
  var s = byName['ZRS Jobadee Paint'];
  assert.deepEqual(s.invoices.map(function (i) { return i.invoiceNo; }).sort(), [cam.invoiceNo, wp.invoiceNo, 'ZRS-SQ-000553-R-0011'].sort());
  assert.equal(s.invoices.find(function (i) { return i.id === cam.id; }).kind, 'cam');
  assert.equal(s.invoices.find(function (i) { return i.id === wp.id; }).kind, 'utility');
  assert.equal(s.invoices.find(function (i) { return i.id === sq.id; }).kind, null, 'a Square repeat with no words: for a person to say');
  assert.equal(s.suggestedKind, 'other', 'CAM and water & power together');
  var m = byName['ZRS Electricals'];
  assert.deepEqual(m.invoices.map(function (i) { return i.id; }), [elec.id], 'only the electricity bill, not the chairs');
  assert.equal(m.suggestedKind, 'utility');
  assert.equal(move.guessKind('Service charge Q3'), 'cam');

  var noRights = Object.assign({}, admin, { can: function (p) { return p === 'poki.manage'; } });
  await assert.rejects(move.candidates(noRights), /invoice\.manage/);

  // Move: the shop as one tenant (all it has is rent-side); Electricals keeps its chairs at Bamboo Products.
  var r = await move.move(admin, { groups: [
    { customerId: shop, invoiceIds: [cam.id, wp.id, sq.id], kind: 'other' },
    { customerId: mixed, invoiceIds: [elec.id], kind: 'utility' }
  ] });
  assert.equal(r.moved, 4);
  assert.equal(r.tenantsMade, 2);

  var c1 = await row(cam.id);
  assert.equal(c1.company_id, pokiId);
  assert.equal(c1.doc_kind, 'cam', 'each keeps what its lines say');
  assert.equal((await row(wp.id)).doc_kind, 'utility');
  assert.equal((await row(sq.id)).doc_kind, 'other', 'the person\'s choice for the one that does not say');
  assert.equal(c1.customer_id, shop, 'the same customer, now Poki\'s');
  assert.equal(c1.status, 'paid', 'its payment came with it');
  assert.equal((await pool.query('SELECT company_id FROM customers WHERE id = $1', [shop])).rows[0].company_id, pokiId);
  assert.ok((await pool.query('SELECT 1 FROM poki_tenants WHERE customer_id = $1', [shop])).rows[0], 'now a Poki tenant');

  var e1 = await row(elec.id);
  assert.notEqual(e1.customer_id, mixed, 'a Poki copy of Electricals');
  assert.equal(e1.doc_kind, 'utility');
  assert.equal((await pool.query('SELECT company_id FROM customers WHERE id = $1', [mixed])).rows[0].company_id, null, 'Electricals stays a Bamboo Products customer');
  assert.equal((await row(chairs.id)).company_id, null, 'its chairs invoice stays');
  assert.equal((await row(plain.id)).company_id, null);

  // Poki's own list has them; nothing left to move; moving again is refused.
  var pokiList = await require('../src/services/pokiBilling.service').listInvoices(admin, {});
  assert.ok(pokiList.some(function (i) { return i.id === cam.id; }));
  assert.equal((await move.candidates(admin)).filter(function (g) { return /^ZRS/.test(g.customerName); }).length, 0);
  await assert.rejects(move.move(admin, { groups: [{ customerId: shop, invoiceIds: [cam.id], kind: 'cam' }] }), /changed or moved already/);
  var mystery = await inv(buyer, 'Square invoice 000999-R-0001', 50);
  await assert.rejects(move.move(admin, { groups: [{ customerId: buyer, invoiceIds: [mystery.id] }] }), /some of them do not say/);
});

test('into a Poki tenant that already exists', async function () {
  var t = await poki.createTenant(admin, { name: 'ZRS Seyvens Auto', phone: '0240004444' });
  var dup = await custOf('ZRS Seyvens Auto (Square)', '+233 24 000 4444');
  var b = await inv(dup, 'Water & power', 400);
  var g = (await move.candidates(admin)).find(function (x) { return x.customerId === dup; });
  assert.equal(g.matchTenantId, t.id, 'matched by phone number');
  await move.move(admin, { groups: [{ customerId: dup, invoiceIds: [b.id], kind: 'utility', tenantId: t.id }] });
  var tc = (await pool.query('SELECT customer_id FROM poki_tenants WHERE id = $1', [t.id])).rows[0].customer_id;
  assert.equal((await row(b.id)).customer_id, tc);
});
