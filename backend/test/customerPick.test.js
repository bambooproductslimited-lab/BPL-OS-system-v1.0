// The customer field of estimates, quotations and invoices
// (customers.service leadsToPick, fromLead, create): leads that are not
// customers yet can be picked — the lead becomes a customer, or goes on the
// one with the same number — and a new customer takes over the leads with
// its number.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var crm = require('../src/services/crm.service');
var customers = require('../src/services/customers.service');

var boss, staff;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
async function cleanup() {
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'Zqcp%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqcp%'");
}
test.before(async function () { await cleanup(); boss = await ctxFor('kelvin.duho@bplghana.com'); staff = await ctxFor('alice.kamau@bplghana.com'); });
test.after(async function () { await cleanup(); await pool.end(); });

test('a lead picked for a document becomes a customer, or goes on the one with its number', async function () {
  var lead = await crm.createLead(boss, { name: 'Zqcp Ama Owusu', company: 'Zqcp Owusu Interiors', phone: '024 777 0001', item: 'Bamboo ceiling' });
  var list = await customers.leadsToPick(boss);
  assert.ok(list.some(function (l) { return l.id === lead.id && l.ref === lead.ref && l.item === 'Bamboo ceiling'; }));
  await rejects(customers.fromLead(staff, { leadId: lead.id }), 'forbidden');
  await rejects(customers.fromLead(boss, { leadId: 'not-an-id' }), 'notfound');

  var c = await customers.fromLead(boss, { leadId: lead.id });
  assert.equal(c.made, true);
  assert.equal(c.name, 'Zqcp Owusu Interiors');
  assert.equal(c.contactPerson, 'Zqcp Ama Owusu');
  assert.equal((await crm.getLead(boss, lead.id)).customerId, c.id);
  assert.ok(!(await customers.leadsToPick(boss)).some(function (l) { return l.id === lead.id; }), 'a customer now: off the list');
  var again = await customers.fromLead(boss, { leadId: lead.id });
  assert.equal(again.id, c.id, 'picked again: the same customer');

  // A second lead with that number, written another way: on the same customer.
  var twin = (await pool.query("INSERT INTO crm_leads (name, phone) VALUES ('Zqcp Ama again', '+233 24 777 0001') RETURNING id")).rows[0].id;
  var c2 = await customers.fromLead(boss, { leadId: twin });
  assert.equal(c2.id, c.id);
  assert.equal(c2.made, false);
});

test('a new customer takes over the leads with its number', async function () {
  var lead = await crm.createLead(boss, { name: 'Zqcp Kofi Lead', phone: '+233 24 777 0002' });
  assert.equal(lead.customerId, null);
  var c = await customers.create(boss, { name: 'Zqcp Kofi Mensah', phone: '0247770002', email: 'zqcp.kofi@example.com' });
  assert.equal((await crm.getLead(boss, lead.id)).customerId, c.id);
  var ids = (await pool.query('SELECT kind, value FROM customer_identities WHERE customer_id = $1 ORDER BY kind', [c.id])).rows;
  assert.deepEqual(ids, [{ kind: 'email', value: 'zqcp.kofi@example.com' }, { kind: 'phone', value: '233247770002' }], 'WhatsApp and email land on it');
});
