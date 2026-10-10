/*
 * The Saturday sales review (crmWeekly.service.js): one week's new leads —
 * from the leads list and from people who messaged the inbox for the first
 * time — where they came from, who has them, whether they were answered;
 * what moved (prospects, won, lost); the money; site visits; the team.
 * Uses the week of 3 June 2019, which no other test touches. Everything is
 * named ZWK and removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var weekly = require('../src/services/crmWeekly.service');

var admin, adminEmp;
var L = {};

async function cleanup() {
  var cust = "(SELECT id FROM customers WHERE name LIKE 'ZWK%')";
  var inv = '(SELECT id FROM invoices WHERE customer_id IN ' + cust + ')';
  await pool.query('DELETE FROM payments WHERE invoice_id IN ' + inv);
  await pool.query('DELETE FROM invoices WHERE id IN ' + inv);
  await pool.query("DELETE FROM crm_site_visits WHERE client LIKE 'ZWK%'");
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'ZWK%'");
  await pool.query("DELETE FROM crm_conversations WHERE external_thread_id LIKE 'zwk-%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZWK%'");
}

async function lead(name, received, fields) {
  fields = fields || {};
  var r = (await pool.query(
    'INSERT INTO crm_leads (name, received_on, source, item, stage, rep_id, lost_reason, customer_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$2::date + time \'09:00\') RETURNING id',
    [name, received, fields.source || '', fields.item || '', fields.stage || 'new', fields.rep || null, fields.lostReason || '', fields.customer || null])).rows[0];
  await pool.query("INSERT INTO crm_lead_notes (lead_id, kind, body, to_stage, at) VALUES ($1, 'stage', 'Lead added.', $2, $3::date + time '09:00')", [r.id, fields.firstStage || fields.stage || 'new', received]);
  return r.id;
}
async function move(id, fromStage, toStage, at) {
  await pool.query("INSERT INTO crm_lead_notes (lead_id, kind, from_stage, to_stage, at) VALUES ($1, 'stage', $2, $3, $4)", [id, fromStage, toStage, at]);
}
async function chat(customer, key, messages) {
  var c = (await pool.query("INSERT INTO crm_conversations (channel, external_thread_id, contact_name, customer_id) VALUES ('whatsapp', $1, 'ZWK', $2) RETURNING id", ['zwk-' + key, customer])).rows[0].id;
  for (var m of messages) await pool.query("INSERT INTO crm_messages (conversation_id, direction, author_name, body, sent_at) VALUES ($1,$2,'ZWK','hello',$3)", [c, m[0], m[1]]);
}

// The CRM settings are one row for the whole OS; crm.test.js and
// crmExecutive.test.js change them while they run, so take turns.
var settingsLock;
test.before(async function () {
  settingsLock = await pool.connect();
  await settingsLock.query('SELECT pg_advisory_lock(7102)');
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  adminEmp = admin.employee.id;

  // The week: Monday 3 June 2019 to Sunday 9 June.
  L.chairs = await lead('ZWK Chairs', '2019-06-03', { source: 'WhatsApp', item: 'Bamboo chairs', rep: adminEmp });
  L.quoted = await lead('ZWK Quoted', '2019-06-04', { source: 'WhatsApp', item: 'bamboo chairs ', rep: adminEmp, stage: 'quote_sent', firstStage: 'contacted' });
  await move(L.quoted, 'contacted', 'quote_sent', '2019-06-05 14:00');
  var linked = (await pool.query("INSERT INTO customers (name, source, origin_channel, category) VALUES ('ZWK Linked', 'crm', 'whatsapp', 'lead') RETURNING id")).rows[0].id;
  L.lanterns = await lead('ZWK Lanterns', '2019-06-06', { source: 'Referral', item: 'Lanterns', customer: linked });
  await pool.query("INSERT INTO crm_lead_notes (lead_id, kind, body, at) VALUES ($1, 'call', 'Called back', '2019-06-06 15:00')", [L.lanterns]);
  await chat(linked, 'linked', [['in', '2019-06-06 08:00']]); // on the leads list: not counted twice
  // Outside the week.
  await lead('ZWK Next week', '2019-06-10', { source: 'WhatsApp' });
  await lead('ZWK Last week', '2019-05-29', { source: 'Walk-in' });
  // Older leads that moved this week.
  L.won = await lead('ZWK Won', '2019-05-20', { item: 'Gazebo', rep: adminEmp, stage: 'won', firstStage: 'quote_sent' });
  await move(L.won, 'quote_sent', 'won', '2019-06-07 10:00');
  L.lost = await lead('ZWK Lost', '2019-05-21', { stage: 'lost', lostReason: 'Too expensive', firstStage: 'contacted' });
  await move(L.lost, 'contacted', 'lost', '2019-06-08 10:00');

  // The inbox: someone new who wrote on Wednesday and was answered; someone
  // whose chat goes back to January (history brought in) is not new.
  var fresh = (await pool.query("INSERT INTO customers (name, source, origin_channel, category, account_manager_id) VALUES ('ZWK New Writer', 'crm', 'whatsapp', 'lead', $1) RETURNING id", [adminEmp])).rows[0].id;
  await chat(fresh, 'fresh', [['in', '2019-06-05 10:00'], ['out', '2019-06-05 11:00']]);
  var old = (await pool.query("INSERT INTO customers (name, source, origin_channel, category) VALUES ('ZWK Old Writer', 'crm', 'whatsapp', 'lead') RETURNING id")).rows[0].id;
  await chat(old, 'old', [['in', '2019-01-10 10:00'], ['in', '2019-06-05 12:00']]);

  // A sale and money in, a visit made and one next week.
  var buyer = (await pool.query('INSERT INTO customers (name, account_manager_id) VALUES (\'ZWK Buyer\', $1) RETURNING id', [adminEmp])).rows[0].id;
  var inv = (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind) " +
    "VALUES ($1,$2,1000,0,0,1000,0,1000,'unpaid','2019-06-05','2019-06-20','sale') RETURNING id", ['ZWK-' + Date.now(), buyer])).rows[0].id;
  await pool.query("INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, received_by) VALUES ($1,$2,'2019-06-06',400,'GHS','cash',$3)", [inv, buyer, adminEmp]);
  await pool.query("INSERT INTO crm_site_visits (client, scheduled_on, status) VALUES ('ZWK Site A', '2019-06-05', 'visited'), ('ZWK Site B', '2019-06-12', 'scheduled')");
});

test.after(async function () {
  await cleanup();
  await settingsLock.query('SELECT pg_advisory_unlock(7102)');
  settingsLock.release();
});

test('any day of the week gives that Monday to Sunday', async function () {
  var w = await weekly.week(admin, { from: '2019-06-05' });
  assert.deepEqual(w.week, { from: '2019-06-03', to: '2019-06-09' });
  assert.deepEqual([w.previous.from, w.next.from], ['2019-05-27', '2019-06-10']);
  assert.equal(weekly._monday('2019-06-09'), '2019-06-03', 'Sunday belongs to the week before it');
});

test('the week\'s new leads: the leads list and first-time writers to the inbox, nobody twice', async function () {
  var w = await weekly.week(admin, { from: '2019-06-03' });
  var x = w.leads;
  assert.deepEqual([x.listed, x.fromInbox, x.total], [3, 1, 4]);
  assert.deepEqual(x.list.map(function (l) { return l.name; }), ['ZWK Chairs', 'ZWK Quoted', 'ZWK Lanterns']);
  assert.equal(x.inbox[0].name, 'ZWK New Writer', 'history going back to January is not a new lead');
  assert.equal(x.before, 1, 'the week before');
  assert.equal(x.weeks.length, 8);
  assert.deepEqual([x.weeks[7].leads, x.weeks[7].inbox, x.weeks[6].leads], [3, 1, 1]);
  assert.deepEqual(x.days.map(function (d) { return d.leads + d.inbox; }), [1, 1, 1, 1, 0, 0, 0]);
});

test('where they came from, what they asked for, who has them, and who was answered', async function () {
  var x = (await weekly.week(admin, { from: '2019-06-03' })).leads;
  assert.deepEqual(x.sources, [{ source: 'WhatsApp', n: 2 }, { source: 'Referral', n: 1 }]);
  assert.deepEqual(x.channels, [{ channel: 'whatsapp', n: 1 }]);
  assert.deepEqual(x.items, [{ item: 'Bamboo chairs', n: 2 }, { item: 'Lanterns', n: 1 }], 'the same thing asked for twice, however typed');
  assert.deepEqual([x.contacted, x.notContacted], [3, 1], 'a call logged or a stage moved counts; the inbox writer was answered');
  assert.equal(x.list.find(function (l) { return l.name === 'ZWK Chairs'; }).contacted, false);
  assert.equal(x.noRep, 1);
  assert.equal(x.prospectsAlready, 1, 'one is already quoted');
});

test('what moved this week: a new prospect, a win and a loss with its reason', async function () {
  var m = (await weekly.week(admin, { from: '2019-06-03' })).moved;
  assert.deepEqual(m.prospects.map(function (l) { return l.name; }), ['ZWK Quoted']);
  assert.deepEqual(m.won.map(function (l) { return l.name; }), ['ZWK Won']);
  assert.deepEqual(m.lost.map(function (l) { return [l.name, l.reason]; }), [['ZWK Lost', 'Too expensive']]);
  assert.deepEqual(m.lostReasons, [{ reason: 'Too expensive', n: 1 }]);
});

test('the money, the visits and the team', async function () {
  var w = await weekly.week(admin, { from: '2019-06-03' });
  assert.deepEqual([w.money.sales, w.money.cash, w.money.invoices], [1000, 400, 1]);
  assert.deepEqual([w.visits.done, w.visits.planned, w.visits.nextWeek.map(function (v) { return v.client; })], [1, 1, ['ZWK Site B']]);
  var me = w.team.find(function (r) { return r.repId === adminEmp; });
  assert.deepEqual([me.newLeads, me.contacted, me.inbox, me.prospects, me.won, me.sales, me.cash], [2, 1, 1, 1, 1, 1000, 400]);
});

test('only for those who can see the CRM', async function () {
  await assert.rejects(weekly.week({ can: function () { return false; } }, {}), /crm\.read/);
});
