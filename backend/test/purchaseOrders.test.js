// Purchase orders to suppliers and bamboo farmers (purchaseOrders.service.js,
// migration 0219): numbered per company, lines and totals, the supplier's
// details from the list, quality requirements, delivery and who prepared it;
// sent, delivered with what came, cancelled; who may do what.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var po = require('../src/services/purchaseOrders.service');
var { buildContext } = require('../src/services/context.service');

var boss, staff, reader, bpl, sbr, supplier;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

async function cleanUp() {
  await pool.query("DELETE FROM purchase_orders WHERE title LIKE 'Zq%'");
  await pool.query("DELETE FROM suppliers WHERE name LIKE 'Zq%'");
}
test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com'); // asks for things, orders none
  reader = Object.assign({}, staff);
  reader.can = function (p) { return p === 'procurement.read.all'; };
  bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
  sbr = (await pool.query("SELECT id FROM companies WHERE code = 'SBR'")).rows[0].id;
  await cleanUp();
  supplier = (await pool.query("INSERT INTO suppliers (name, phone, town, outgrower, status) VALUES ('Zq Farm & Sons', '0200000000', 'Zq Town', true, 'active') RETURNING id")).rows[0].id;
});
test.after(async function () { await cleanUp(); await pool.end(); });

function draft(o) {
  return Object.assign({
    companyId: bpl, title: 'Zq Bamboo poles', poDate: today(), supplierId: supplier,
    lines: [{ description: 'Bamboo poles', specification: 'Minimum length: 14ft', quantity: '2,600', unit: 'pcs', unitPrice: '8' }],
    quality: ['Minimum length of 14 feet.', '', 'The agreed price is GHS 8.00 per pole'],
    deliveryLocation: 'Zq yard, Tema', deliveryDate: addDays(10)
  }, o || {});
}

test('made like the paper one: numbered for the company, totals, the farmer\'s details, prepared by me', async function () {
  var list = await po.list(boss);
  var next = list.options.companies.find(function (c) { return c.id === bpl; }).next;
  assert.match(next, /^BPL \d{3}$/);
  assert.ok(list.options.suppliers.some(function (s) { return s.id === supplier && s.outgrower && s.location === 'Zq Town'; }));
  assert.ok(list.options.me.name);

  var a = await po.create(boss, draft());
  assert.equal(a.number, next);
  assert.equal(a.status, 'draft');
  assert.equal(a.total, 20800);
  assert.deepEqual(a.lines.map(function (l) { return [l.quantity, l.unitPrice, l.total, l.unit]; }), [[2600, 8, 20800, 'pcs']]);
  assert.equal(a.supplier.name, 'Zq Farm & Sons', 'from the supplier list');
  assert.equal(a.supplier.location, 'Zq Town');
  assert.equal(a.supplier.contact, '0200000000');
  assert.deepEqual(a.quality, ['Minimum length of 14 feet.', 'The agreed price is GHS 8.00 per pole'], 'empty lines left out');
  assert.equal(a.preparedBy.id, boss.employee.id);
  assert.ok(a.preparedBy.name && a.preparedBy.signature);
  assert.equal(a.preparedBy.on, today());
  assert.equal(a.company.code, 'BPL');

  // The next one follows; a number from paper can be given; never twice.
  var b = await po.create(boss, draft({ title: 'Zq Bamboo poles 2' }));
  assert.equal(Number(b.number.slice(4)), Number(a.number.slice(4)) + 1);
  var paper = await po.create(boss, draft({ title: 'Zq from paper', number: 'bpl 904' }));
  assert.equal(paper.number, 'BPL 904');
  await rejects(po.create(boss, draft({ title: 'Zq twice', number: 'BPL 904' })), 'conflict');
  assert.equal((await po.list(boss)).options.companies.find(function (c) { return c.id === bpl; }).next, 'BPL 905');
  // Another company has its own numbers.
  var s = await po.create(boss, draft({ title: 'Zq for Star Bar', companyId: sbr, number: '' }));
  assert.match(s.number, /^SBR \d{3}$/);

  // A farmer not on the list: typed in.
  var typed = await po.create(boss, draft({ title: 'Zq typed', supplierId: '', supplierName: 'Zq Madam Ama', supplierLocation: 'Zq Village', supplierContact: '0240000000',
    lines: [{ description: 'Poles', quantity: 100, unitPrice: 7.5 }, { description: 'Transport', quantity: 1, unit: 'trip', unitPrice: 350 }] }));
  assert.equal(typed.supplier.id, null);
  assert.equal(typed.total, 1100);

  // What it needs.
  await rejects(po.create(boss, draft({ lines: [] })), 'invalid');
  await rejects(po.create(boss, draft({ lines: [{ description: 'Zq', quantity: 0, unitPrice: 1 }] })), 'invalid');
  await rejects(po.create(boss, draft({ title: '' })), 'invalid');
  await rejects(po.create(boss, draft({ supplierId: '', supplierName: '' })), 'invalid');
  await rejects(po.create(boss, draft({ deliveryDate: 'soon' })), 'invalid');
});

test('changed while a draft or sent; sent, delivered with what came; cancelled with a reason', async function () {
  var a = await po.create(boss, draft({ title: 'Zq lifecycle' }));
  var changed = await po.update(boss, a.id, { lines: [{ description: 'Bamboo poles', specification: 'Minimum length: 14ft', quantity: 3000, unitPrice: 8 }], deliveryDate: addDays(3) });
  assert.equal(changed.total, 24000);
  assert.equal(changed.supplier.name, 'Zq Farm & Sons', 'what is not sent stays');

  var sent = await po.setStatus(boss, a.id, { status: 'issued' });
  assert.equal(sent.status, 'issued');
  assert.ok(sent.issuedAt);
  await rejects(po.setStatus(boss, a.id, { status: 'issued' }), 'conflict');
  await rejects(po.remove(boss, a.id), 'conflict');
  assert.equal((await po.update(boss, a.id, { notes: 'Zq call before coming' })).notes, 'Zq call before coming');

  await rejects(po.setStatus(boss, a.id, { status: 'delivered', deliveredOn: addDays(1) }), 'invalid');
  var got = await po.setStatus(boss, a.id, { status: 'delivered', received: [2850], note: 'Zq 150 too short, sent back' });
  assert.equal(got.status, 'delivered');
  assert.equal(got.deliveredOn, today());
  assert.equal(got.received, 2850);
  assert.equal(got.ordered, 3000);
  assert.equal(got.lines[0].receivedQty, 2850);
  await rejects(po.update(boss, a.id, { notes: 'x' }), 'conflict');
  // A delivery recorded by mistake: back to a draft.
  var back = await po.setStatus(boss, a.id, { status: 'draft' });
  assert.equal(back.received, null);

  await rejects(po.setStatus(boss, a.id, { status: 'cancelled' }), 'invalid');
  var off = await po.setStatus(boss, a.id, { status: 'cancelled', reason: 'Zq farmer could not cut in time' });
  assert.equal(off.status, 'cancelled');
  assert.equal(off.cancelReason, 'Zq farmer could not cut in time');
  assert.deepEqual(await po.remove(boss, a.id), { ok: true });
  await rejects(po.get(boss, a.id), 'notfound');

  // Late: past its delivery date, still waiting.
  var late = await po.create(boss, draft({ title: 'Zq late', poDate: addDays(-20), deliveryDate: addDays(-2) }));
  assert.equal(late.late, true);
});

test('who: the approvers make them; those who see every request read them; others nothing', async function () {
  var a = await po.create(boss, draft({ title: 'Zq who' }));
  await rejects(po.list(staff), 'forbidden');
  await rejects(po.get(staff, a.id), 'forbidden');
  await rejects(po.create(staff, draft()), 'forbidden');
  assert.ok((await po.list(reader)).orders.some(function (o) { return o.id === a.id; }));
  assert.equal((await po.list(reader)).can.edit, false);
  await rejects(po.create(reader, draft()), 'forbidden');
  await rejects(po.setStatus(reader, a.id, { status: 'issued' }), 'forbidden');
  await rejects(po.remove(reader, a.id), 'forbidden');
});
