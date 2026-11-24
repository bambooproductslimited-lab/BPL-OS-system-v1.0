// Groups of leads (crmLeadGroups.service.js, lib/contactRows.js): a fair's
// contacts brought in from a spreadsheet, a phone's contacts or a pasted
// list; nobody added twice; the group's progress; who may do what.
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var crm = require('../src/services/crm.service');
var groups = require('../src/services/crmLeadGroups.service');
var contactRows = require('../src/lib/contactRows');
var ExcelJS = require('exceljs');

var boss, reader, nobody, repA, repB, server, base, token;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function rejects(p, code) { await assert.rejects(p, function (e) { return e.code === code; }); }
function file(name, buf) { return { originalname: name, buffer: Buffer.isBuffer(buf) ? buf : Buffer.from(buf) }; }

async function cleanup() {
  await pool.query("DELETE FROM crm_lead_groups WHERE name LIKE 'Zqg%'");
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'Zqg%' OR company LIKE 'Zqg%' OR email LIKE 'zqg%'");
}
test.before(async function () {
  await cleanup();
  boss = await ctxFor('kelvin.duho@bplghana.com');
  reader = await ctxFor('andy.chou@bplghana.com');
  nobody = await ctxFor('alice.kamau@bplghana.com');
  repA = boss.employee.id;
  repB = (await ctxFor('samuel.kiptoo@bplghana.com')).employee.id;
  await new Promise(function (done) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); }); });
});
test.after(async function () { await cleanup(); server.close(); await pool.end(); });

test('reading contacts: headings spelt any way, no headings at all, a phone\'s contacts', async function () {
  var t = contactRows.fromText('Full Name\tOrganisation\tTel.\tE-mail\tInterested in\n' +
    'Zqg Kofi Mensah\tZqg Mensah Ltd\t244123456\tKOFI@zqg.example\tbamboo beds\n');
  assert.equal(t.contacts.length, 1);
  assert.deepEqual(t.contacts[0], { name: 'Zqg Kofi Mensah', company: 'Zqg Mensah Ltd', phone: '0244123456', email: 'kofi@zqg.example', location: '', interest: 'bamboo beds', notes: '' });
  var loose = contactRows.fromText('Zqg Ama Owusu 020 123 4567 ama@zqg.example\nZqg Yaw, Zqg Hub, Kumasi, wants poles');
  assert.equal(loose.contacts[0].name, 'Zqg Ama Owusu');
  assert.equal(loose.contacts[0].phone, '020 123 4567');
  assert.equal(loose.contacts[1].company, 'Zqg Hub');
  assert.match(loose.contacts[1].notes, /Kumasi/);
  var v = contactRows.fromVcf('BEGIN:VCARD\nVERSION:3.0\nN:Boateng;Zqg Esi;;;\nORG:Zqg Esi Designs\nTEL;TYPE=CELL:+233 55 000 1111\nTITLE:Architect\nEND:VCARD\n');
  assert.equal(v.contacts[0].name, 'Zqg Esi Boateng');
  assert.match(v.contacts[0].notes, /Position: Architect/);
  assert.equal(contactRows.phoneKey('+233 55 000 1111'), contactRows.phoneKey('0550001111'));
});

test('a group from an event: contacts from a spreadsheet, nobody twice, shared between reps', async function () {
  await rejects(groups.save(reader, null, { name: 'Zqg nope' }), 'forbidden');
  await rejects(groups.list(nobody), 'forbidden');
  var g = await groups.save(boss, null, { name: 'Zqg GEXPO 2026', kind: 'event', heldOn: '2026-11-20', place: 'Accra' });
  assert.equal(g.counts.total, 0);
  await rejects(groups.save(boss, null, { name: 'zqg gexpo 2026' }), 'conflict');

  // Someone already among the leads, met again at the fair.
  var old = await crm.createLead(boss, { name: 'Zqg Old Friend', phone: '+233 27 999 8888' });

  var wb = new ExcelJS.Workbook();
  var ws = wb.addWorksheet('Visitors');
  ws.addRow(['GEXPO 2026 — visitors at our stand']);
  ws.addRow(['S/N', 'Name', 'Company', 'Phone Number', 'Email Address', 'Location', 'Interested in']);
  ws.addRow([1, 'Zqg Kofi Mensah', 'Zqg Mensah Ltd', 244123456, 'kofi@zqg.example', 'Accra', 'Bamboo beds']);
  ws.addRow([2, 'Zqg Ama Owusu', '', '020 123 4567', '', 'Tema', 'Poles']);
  ws.addRow([3, 'Zqg Old Friend', '', '0279998888', '', '', 'Doors']);
  ws.addRow([4, 'Zqg Kofi M.', 'Zqg Mensah Ltd', '+233 24 412 3456', '', '', '']);   // Kofi again
  ws.addRow([5, 'Zqg No Number', 'Zqg Shop', '', '', '', '']);
  ws.addRow([6, '', '', '', '', '', '']);
  var xlsx = await wb.xlsx.writeBuffer();

  await rejects(groups.importPreview(reader, g.id, file('v.xlsx', xlsx)), 'forbidden');
  var pre = await groups.importPreview(boss, g.id, file('visitors.xlsx', xlsx));
  assert.equal(pre.format, 'xlsx');
  assert.deepEqual(pre.counts, { new: 3, existing: 1, inGroup: 0, repeat: 1, empty: 0, noContact: 1, onWhatsapp: 0 });
  assert.equal(pre.rows.find(function (r) { return r.name === 'Zqg Old Friend'; }).lead.id, old.id);
  assert.equal(pre.rows.find(function (r) { return r.name === 'Zqg Kofi M.'; }).status, 'repeat');
  assert.equal(await pool.query("SELECT count(*)::int AS n FROM crm_leads WHERE name = 'Zqg Ama Owusu'").then(function (r) { return r.rows[0].n; }), 0, 'nothing saved by a preview');

  await rejects(groups.importRun(boss, g.id, file('visitors.xlsx', xlsx), null, { repIds: ['00000000-0000-0000-0000-000000000000'] }), 'invalid');
  var run = await groups.importRun(boss, g.id, file('visitors.xlsx', xlsx), null, { repIds: [repA, repB], followUpOn: '2026-11-27' });
  assert.equal(run.added, 3);
  assert.equal(run.joined, 1);
  assert.deepEqual(run.perRep.map(function (x) { return x.leads; }).sort(), [1, 2]);
  assert.equal(run.group.counts.total, 4);
  assert.equal(run.group.counts.notContacted, 4, 'the old friend is not contacted yet either');

  var kofi = (await crm.listLeads(boss, { stage: 'all', group: g.id, q: 'Kofi Mensah' }))[0];
  assert.equal(kofi.phone, '0244123456');
  assert.equal(kofi.source, 'Fair or event');
  assert.equal(kofi.receivedOn, '2026-11-20');
  assert.equal(kofi.nextFollowUp, '2026-11-27');
  assert.equal(kofi.item, 'Bamboo beds');
  assert.deepEqual(kofi.groups, [{ id: g.id, name: 'Zqg GEXPO 2026' }]);
  assert.match(kofi.comments, /^Met at Zqg GEXPO 2026 \(2026-11-20\)\./);
  var oldNow = await crm.getLead(boss, old.id);
  assert.ok(oldNow.notes.some(function (n) { return /Met again at Zqg GEXPO 2026/.test(n.body); }));
  var noNumber = (await crm.listLeads(boss, { stage: 'all', group: g.id, q: 'Zqg No Number' }))[0];
  assert.equal(noNumber.company, 'Zqg Shop');

  // The same file again adds nothing.
  var again = await groups.importRun(boss, g.id, file('visitors.xlsx', xlsx), null, {});
  assert.deepEqual([again.added, again.joined, again.inGroup], [0, 0, 4]);

  // A pasted list and a phone's contacts, into the same group.
  var pasted = await groups.importRun(boss, g.id, null, 'Zqg Yaw Darko, Zqg Darko & Sons, 0501112222\nzqg Kofi again 0244 123 456', {});
  assert.deepEqual([pasted.added, pasted.inGroup], [1, 1]);
  var vcf = await groups.importRun(boss, g.id, file('contacts.vcf', 'BEGIN:VCARD\nFN:Zqg Esi Boateng\nTEL:0550001111\nEMAIL:zqg.esi@example.com\nEND:VCARD\n'), null, {});
  assert.equal(vcf.added, 1);

  // Progress moves with the leads.
  await crm.setStage(boss, kofi.id, { stage: 'qualified' });
  var listed = (await groups.list(reader)).find(function (x) { return x.id === g.id; });
  assert.equal(listed.counts.total, 6);
  assert.equal(listed.counts.prospects, 1);

  // Leads in and out by hand; deleting the group keeps them.
  var other = await crm.createLead(boss, { name: 'Zqg Walk-in' });
  assert.equal((await groups.addLeads(boss, g.id, { leadIds: [other.id, kofi.id] })).added, 1);
  assert.equal((await groups.removeLeads(boss, g.id, { leadIds: [other.id] })).removed, 1);
  await rejects(groups.addLeads(reader, g.id, { leadIds: [other.id] }), 'forbidden');
  await groups.remove(boss, g.id);
  assert.ok(await crm.getLead(boss, kofi.id), 'the leads stay');
  assert.deepEqual((await crm.getLead(boss, kofi.id)).groups, []);
});

test('over HTTP: a pasted list as the phone or the page sends it', async function () {
  var login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kelvin.duho@bplghana.com', password: 'bamboo123' }) });
  token = (await login.json()).token;
  assert.ok(token, 'signed in');
  var g = await fetch(base + '/api/crm/groups', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name: 'Zqg Http fair' }) }).then(function (r) { return r.json(); });
  var form = new FormData();
  form.append('text', 'Zqg Http One, 0209998877\nZqg Http Two, zqg.two@example.com');
  form.append('options', JSON.stringify({ source: 'Walk-in' }));
  var res = await fetch(base + '/api/crm/groups/' + g.id + '/import', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  assert.equal(res.status, 200);
  var out = await res.json();
  assert.equal(out.added, 2);
  var leads = await crm.listLeads(boss, { stage: 'all', group: g.id });
  assert.ok(leads.every(function (l) { return l.source === 'Walk-in'; }));
  var bad = new FormData();
  bad.append('file', new Blob(['x']), 'contacts.pdf');
  assert.equal((await fetch(base + '/api/crm/groups/' + g.id + '/import/preview', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: bad })).status, 400);
});
