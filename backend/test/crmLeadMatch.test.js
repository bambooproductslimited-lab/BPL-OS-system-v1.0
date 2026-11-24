// A lead who is a WhatsApp contact (crmLeadMatch.service.js): the same
// number, however it is written, puts the lead on the chat's profile —
// whichever came first — and the lead shows the chat.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var crm = require('../src/services/crm.service');
var inbox = require('../src/services/crmInbox.service');
var groups = require('../src/services/crmLeadGroups.service');
var match = require('../src/services/crmLeadMatch.service');

var boss;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function whatsapp(number, name, direction, body) {
  return inbox.ingest({
    channel: 'whatsapp', threadId: 'zqm-' + number, contact: { name: name, handles: [{ kind: 'phone', value: number }] },
    messages: [{ externalId: 'zqm-' + number + '-' + Date.now() + Math.random(), direction: direction || 'in', body: body || 'Zqm hello, how much is a bamboo bed?', sentAt: new Date().toISOString() }]
  });
}
async function cleanup() {
  await pool.query("DELETE FROM crm_lead_groups WHERE name LIKE 'Zqm%'");
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'Zqm%'");
  await pool.query("DELETE FROM crm_conversations WHERE external_thread_id LIKE 'zqm-%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'Zqm%' OR name LIKE '+233 2_ 555 01%'");
}
test.before(async function () { await cleanup(); boss = await ctxFor('kelvin.duho@bplghana.com'); });
test.after(async function () { await cleanup(); await pool.end(); });

test('they wrote on WhatsApp first: the lead added later goes on their chat', async function () {
  var w = await whatsapp('+233 24 555 0199', 'Zqm Ama Owusu');
  assert.ok(w.customerCreated, 'the WhatsApp number became a profile');
  var lead = await crm.createLead(boss, { name: 'Zqm Ama (from the fair)', phone: '024 555 0199' });
  assert.equal(lead.customerId, w.customerId, 'the same number, written another way');
  assert.equal(lead.conversations.length, 1);
  assert.equal(lead.conversations[0].channel, 'whatsapp');
  assert.ok(lead.notes.some(function (n) { return /Recognised as Zqm Ama Owusu on WhatsApp/.test(n.body); }));
  var listed = (await crm.listLeads(boss, { stage: 'all', q: 'Zqm Ama (from' }))[0];
  assert.ok(listed.whatsapp && listed.whatsapp.lastAt, 'the list knows they are on WhatsApp');
});

test('the lead came first: their first WhatsApp message puts the lead on the chat', async function () {
  var lead = await crm.createLead(boss, { name: 'Zqm Kofi Mensah', phone: '0205550188 / 0244000000', repId: boss.employee.id });
  assert.equal(lead.customerId, null, 'nobody with that number yet');
  var w = await whatsapp('233205550188', 'Zqm Kofi');
  var now = await crm.getLead(boss, lead.id);
  assert.equal(now.customerId, w.customerId);
  assert.equal(now.conversations[0].id, w.conversationId);
  assert.ok(now.notes.some(function (n) { return /on WhatsApp/.test(n.body); }));
  var rep = (await pool.query('SELECT account_manager_id FROM customers WHERE id = $1', [w.customerId])).rows[0].account_manager_id;
  assert.equal(rep, boss.employee.id, 'the lead\'s rep now looks after the WhatsApp profile');
});

test('a number we wrote to but who never answered: the chat shows on the lead; an existing profile is kept', async function () {
  await whatsapp('+233 20 555 0177', 'Zqm Silent', 'out', 'Zqm our price list');
  var lead = await crm.createLead(boss, { name: 'Zqm Silent Lead', phone: '020 555 0177' });
  assert.equal(lead.customerId, null, 'no profile to go on');
  assert.equal(lead.conversations.length, 1, 'but the chat with that number is shown');

  // A lead already on a profile stays there.
  var other = (await pool.query("INSERT INTO customers (name, phone) VALUES ('Zqm Other Profile', '') RETURNING id")).rows[0].id;
  var kept = await crm.createLead(boss, { name: 'Zqm Kept' });
  await pool.query('UPDATE crm_leads SET customer_id = $2 WHERE id = $1', [kept.id, other]);
  await crm.updateLead(boss, kept.id, { phone: '024 555 0199' });
  assert.equal((await crm.getLead(boss, kept.id)).customerId, other);
});

test('contacts from a fair who are on WhatsApp: shown in the import, put on their chat', async function () {
  var w = await whatsapp('+233 27 555 0166', 'Zqm Efua');
  var g = await groups.save(boss, null, { name: 'Zqm Fair' });
  var pre = await groups.importPreview(boss, g.id, null, 'Zqm Efua Quaye, Zqm Quaye Ltd, 027 555 0166\nZqm New Person, 027 555 0155');
  assert.equal(pre.counts.new, 2);
  assert.equal(pre.counts.onWhatsapp, 1);
  assert.equal(pre.rows[0].whatsapp.name, 'Zqm Efua');
  var run = await groups.importRun(boss, g.id, null, 'Zqm Efua Quaye, Zqm Quaye Ltd, 027 555 0166\nZqm New Person, 027 555 0155', {});
  assert.equal(run.linked, 1);
  var efua = (await crm.listLeads(boss, { stage: 'all', q: 'Zqm Efua Quaye' }))[0];
  assert.equal(efua.customerId, w.customerId);
});

test('the hourly sweep: an old lead with a WhatsApp number is put on the chat', async function () {
  var w = await whatsapp('+233 55 555 0144', 'Zqm Old Chat');
  var id = (await pool.query("INSERT INTO crm_leads (name, phone) VALUES ('Zqm Old Lead', '+233 (0)55 555 0144') RETURNING id")).rows[0].id;
  assert.ok(await match.linkAll() >= 1);
  assert.equal((await crm.getLead(boss, id)).customerId, w.customerId);
});
