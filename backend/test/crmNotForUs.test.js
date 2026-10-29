/*
 * Not everyone who gets in touch is a lead, a prospect or a customer, and
 * not every lead should be chased (migration 0208): "Not a lead" on a lead,
 * "Just a contact" on a customer profile, and "Stop following up" on both.
 * Fake people (Znfu …), fake numbers (020 555 09…).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var bcrypt = require('bcrypt');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var crm = require('../src/services/crm.service');
var profiles = require('../src/services/crmProfiles.service');
var followUps = require('../src/services/crmFollowUps.service');

var admin, rep;
var today = new Date().toISOString().slice(0, 10);
var tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

async function cleanup() {
  var ids = (await pool.query("SELECT id FROM customers WHERE name LIKE 'Znfu%'")).rows.map(function (r) { return r.id; });
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'Znfu%' OR customer_id = ANY($1)", [ids]);
  await pool.query('DELETE FROM customers WHERE id = ANY($1)', [ids]);
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = 'znfu.rep@example.com')");
  await pool.query("DELETE FROM users WHERE email = 'znfu.rep@example.com'");
  await pool.query("DELETE FROM employees WHERE code = 'ZNFU-REP'");
}

// The CRM settings are one row for the whole OS, and crm.test.js points them
// at its own company while it runs: this file waits its turn (the same lock).
var settingsLock;
test.before(async function () {
  settingsLock = await pool.connect();
  await settingsLock.query('SELECT pg_advisory_lock(7102)');
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT id FROM departments LIMIT 1')).rows[0].id;
  var emp = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) VALUES ('ZNFU-REP', 'Znfu', 'Rep', 'znfu.rep@example.com', $1, current_date, 'active', 'permanent') RETURNING id",
    [dept])).rows[0].id;
  var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, 'znfu.rep@example.com', $2, 'active') RETURNING id", [emp, await bcrypt.hash('x-1234567', 4)])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'sales_rep'", [user]);
  rep = await buildContext(user);
});
test.after(async function () {
  await cleanup();
  await settingsLock.query('SELECT pg_advisory_unlock(7102)');
  settingsLock.release();
  await pool.end();
});

test('not a lead: out of Leads and Prospects and their counts, with a reason; one press puts it back', async function () {
  var l = await crm.createLead(rep, { name: 'Znfu Poles Supplier', phone: '020 555 0901', item: 'Znfu poles', nextFollowUp: today });
  assert.equal(l.phase, 'lead');
  await assert.rejects(crm.setNotLead(rep, l.id, { on: true, reason: 'other' }), /Say who they are/);
  await assert.rejects(crm.setNotLead(rep, l.id, { on: true, reason: 'cousin' }), /Reason/);

  var out = await crm.setNotLead(rep, l.id, { on: true, reason: 'supplier', note: 'sells us poles' });
  assert.equal(out.stage, 'not_lead');
  assert.equal(out.phase, 'notlead');
  assert.equal(out.lostReason, 'supplier: sells us poles');
  assert.equal(out.nextFollowUp, null, 'nothing reminds anyone to call a supplier back');
  assert.ok(out.notes.some(function (n) { return n.toStage === 'not_lead' && n.body === 'sells us poles'; }));
  assert.equal((await followUps.forRep(rep.employee.id)).items.filter(function (i) { return i.lead && i.lead.id === l.id; }).length, 0);

  var open = await crm.listLeads(rep, {});
  assert.ok(!open.some(function (x) { return x.id === l.id; }), 'not among the open leads');
  var all = await crm.listLeads(rep, { stage: 'all', limit: 1000 });
  assert.equal(all.find(function (x) { return x.id === l.id; }).phase, 'notlead', 'still there, under Not leads');
  var audit = (await pool.query("SELECT summary FROM audit_logs WHERE action = 'crm.lead.not_lead' AND entity_id = $1 ORDER BY at DESC LIMIT 1", [l.id])).rows[0];
  assert.match(audit.summary, /not a lead \(supplier: sells us poles\)/);

  var back = await crm.setNotLead(rep, l.id, { on: false });
  assert.equal(back.stage, 'new');
  assert.equal(back.phase, 'lead');
  assert.equal(back.lostReason, null);
});

test('stop following up a lead: no date, out of the follow-ups and the priorities; a date is refused until it is back on', async function () {
  var l = await crm.createLead(rep, { name: 'Znfu Not Interested', phone: '020 555 0902', item: 'Znfu door', nextFollowUp: today });
  assert.equal((await followUps.forRep(rep.employee.id)).items.filter(function (i) { return i.lead && i.lead.id === l.id; }).length, 1, 'due today');

  var stopped = await crm.setLeadNoFollowUp(rep, l.id, { reason: 'not_interested', note: 'said no twice' });
  assert.equal(stopped.stage, 'new', 'still a lead');
  assert.equal(stopped.nextFollowUp, null);
  assert.equal(stopped.noFollowUp.reason, 'not_interested: said no twice');
  assert.equal(stopped.noFollowUp.by, 'Znfu Rep');
  assert.equal(stopped.noFollowUp.onProfile, false);
  assert.equal(stopped.priority, null, 'not ranked among the leads to work');
  assert.equal((await followUps.forRep(rep.employee.id)).items.filter(function (i) { return i.lead && i.lead.id === l.id; }).length, 0);
  await assert.rejects(crm.updateLead(rep, l.id, { nextFollowUp: tomorrow }), /not to be followed up/i);

  var flagged = await crm.listLeads(rep, { stage: 'all', noFollowUp: '1', limit: 1000 });
  assert.ok(flagged.some(function (x) { return x.id === l.id; }));
  var due = await crm.listLeads(rep, { stage: 'all', followUp: 'none', limit: 1000 });
  assert.ok(!due.some(function (x) { return x.id === l.id; }), 'not among the leads waiting for a date');

  var on = await crm.setLeadNoFollowUp(rep, l.id, { on: false });
  assert.equal(on.noFollowUp, null);
  assert.equal((await crm.updateLead(rep, l.id, { nextFollowUp: tomorrow })).nextFollowUp, tomorrow);
});

test('just a contact: out of the customer lists and counts, its open leads closed; put back as a lead', async function () {
  var c = (await pool.query("INSERT INTO customers (name, phone, category, follow_up_on) VALUES ('Znfu Cousin', '0205550903', 'lead', $1) RETURNING id", [today])).rows[0].id;
  var l = await crm.createLead(rep, { name: 'Znfu Cousin', phone: '020 555 0903', item: 'Znfu chat' });
  await pool.query('UPDATE crm_leads SET customer_id = $2 WHERE id = $1', [l.id, c]);
  var before = (await profiles.listProfiles(admin, {})).summary;

  await assert.rejects(profiles.setContact(rep, c, { on: true, reason: 'other' }), /Say who they are/);
  var p = await profiles.setContact(rep, c, { on: true, reason: 'staff_family', note: 'the driver\'s cousin' });
  assert.equal(p.category, 'contact');
  assert.equal(p.contactReason, 'staff_family: the driver\'s cousin');
  assert.equal(p.followUpOn, null);
  assert.equal((await crm.getLead(rep, l.id)).stage, 'not_lead', 'their open lead is closed as not a lead');

  var list = await profiles.listProfiles(admin, { search: 'Znfu Cousin' });
  assert.equal(list.profiles.length, 0, 'not among the customers, prospects or leads');
  assert.equal((await profiles.listProfiles(admin, { search: 'Znfu Cousin', category: 'all' })).profiles.length, 0, 'nor in All profiles');
  assert.equal((await profiles.listProfiles(admin, { search: 'Znfu Cousin', category: 'contact' })).profiles.length, 1, 'under Just contacts');
  assert.equal((await profiles.listProfiles(admin, { search: 'Znfu Cousin', category: 'any' })).profiles.length, 1, 'found when looking for anyone');
  var after = (await profiles.listProfiles(admin, {})).summary;
  assert.equal(after.contacts, before.contacts + 1);
  assert.equal(after.total, before.total - 1);
  assert.equal(after.leads, before.leads - 1);

  var back = await profiles.setContact(rep, c, { on: false });
  assert.equal(back.category, 'lead', 'never paid, so back as a lead');
  assert.equal(back.contactReason, null);
});

test('stop following up a customer: no date, out of the follow-ups, and every lead of theirs with them', async function () {
  var c = (await pool.query("INSERT INTO customers (name, phone, category, account_manager_id, follow_up_on) VALUES ('Znfu Bought Elsewhere', '0205550904', 'prospect', $1, $2) RETURNING id", [rep.employee.id, today])).rows[0].id;
  var l = await crm.createLead(rep, { name: 'Znfu Bought Elsewhere', item: 'Znfu table', nextFollowUp: today });
  await pool.query('UPDATE crm_leads SET customer_id = $2 WHERE id = $1', [l.id, c]);
  assert.ok((await followUps.forRep(rep.employee.id)).items.some(function (i) { return i.customer && i.customer.id === c; }));

  var p = await profiles.setNoFollowUp(rep, c, { reason: 'bought_elsewhere' });
  assert.equal(p.noFollowUp.reason, 'bought_elsewhere');
  assert.equal(p.followUpOn, null);
  assert.equal(p.category, 'prospect', 'still a prospect');
  assert.ok(!(await followUps.forRep(rep.employee.id)).items.some(function (i) { return i.customer && i.customer.id === c; }));
  await assert.rejects(profiles.setFollowUp(rep, c, { on: tomorrow }), /set not to be followed up/);

  var lead = await crm.getLead(rep, l.id);
  assert.equal(lead.nextFollowUp, null, 'their lead\'s date is cleared too');
  assert.equal(lead.noFollowUp.onProfile, true, 'and it says why');
  await assert.rejects(crm.updateLead(rep, l.id, { nextFollowUp: tomorrow }), /not to be followed up/i);
  assert.ok((await profiles.listProfiles(admin, { noFollowUp: '1', search: 'Znfu Bought' })).profiles.some(function (x) { return x.id === c; }));

  p = await profiles.setNoFollowUp(rep, c, { on: false });
  assert.equal(p.noFollowUp, null);
  assert.equal((await profiles.setFollowUp(rep, c, { on: tomorrow })).followUpOn, tomorrow);
});
