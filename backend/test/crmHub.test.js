/*
 * The CRM's customer side: conversations from every channel becoming
 * customer profiles, duplicates found and merged, reps and coverage, follow-
 * ups at sign-in, the channels (WhatsApp webhook and chat exports, email,
 * Facebook/Instagram) and the marketing scans. Fake people (Zcrm …), fake
 * numbers (+233 20 555 …), fake channels; nothing leaves the machine.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var inbox = require('../src/services/crmInbox.service');
var profiles = require('../src/services/crmProfiles.service');
var followUps = require('../src/services/crmFollowUps.service');
var health = require('../src/services/crmHealth.service');
var marketing = require('../src/services/crmMarketing.service');
var waImport = require('../src/services/crmWhatsappImport.service');
var email = require('../src/services/crmEmail.service');
var meta = require('../src/services/crmMeta.service');
var whatsapp = require('../src/services/whatsapp.service');
var salesOrders = require('../src/services/salesOrders.service');
var config = require('../src/config');
var mailboxes = require('../src/services/crmMailbox.service');

var admin, repA, repB, repACtx, repBCtx, deptId;
var sent = [];

async function zcrmCustomers() { return (await pool.query("SELECT id FROM customers WHERE name LIKE 'Zcrm%' OR phone LIKE '%20 555%' OR email LIKE '%@zcrm.example'")).rows.map(function (r) { return r.id; }); }
async function cleanup() {
  var ids = await zcrmCustomers();
  await pool.query("DELETE FROM crm_conversations WHERE contact_name LIKE 'Zcrm%' OR external_thread_id LIKE '23320555%' OR external_thread_id LIKE 'mail:%zcrm%' OR external_thread_id LIKE 'zcrm-%' OR customer_id = ANY($1)", [ids]);
  for (var t of ['payments', 'document_line_items', 'invoices', 'sales_orders', 'quotations', 'crm_leads']) {
    if (t === 'document_line_items') await pool.query("DELETE FROM document_line_items WHERE description LIKE 'Zcrm%'");
    else await pool.query('DELETE FROM ' + t + ' WHERE customer_id = ANY($1)', [ids]);
  }
  await pool.query('DELETE FROM customer_merges WHERE kept_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM customers WHERE id = ANY($1)', [ids]);
  await pool.query("DELETE FROM products WHERE sku LIKE 'ZCRM-%'");
  await pool.query("DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'zcrm.%')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zcrm.%'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZCRM-%'");
  await pool.query("DELETE FROM crm_channel_state WHERE key IN ('coverage_alert', 'facebook', 'instagram') OR key LIKE 'email:%' OR key LIKE 'whatsapp:%'");
  await pool.query("DELETE FROM crm_contact_names WHERE value LIKE '23320555%'");
  await pool.query("DELETE FROM marketing_oauth_tokens WHERE channel_key IN ('facebook', 'instagram') AND open_id LIKE 'zcrm-%'");
  await pool.query("DELETE FROM crm_mailbox WHERE address LIKE '%zcrm.example'");
  await pool.query("DELETE FROM audit_logs WHERE action LIKE 'crm.mailbox.%' AND summary LIKE '%zcrm.example%'");
}
async function makeRep(code, first) {
  var e = (await pool.query("INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date) VALUES ($1,$2,'Zcrm',$3,$4,'2025-01-01') RETURNING id",
    [code, first, code.toLowerCase() + '@zcrm.example', deptId])).rows[0].id;
  var u = (await pool.query("INSERT INTO users (employee_id, email, password_hash) VALUES ($1,$2,'x') RETURNING id", [e, 'zcrm.' + code.toLowerCase() + '@example.com'])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'sales_rep'", [u]);
  return { employeeId: e, userId: u };
}
function wa(from, name, text, at, id) {
  return { entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: name } }], messages: [{ from: from, id: id, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body: text } }] } }] }] };
}

test.before(async function () {
  await cleanup();
  admin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  deptId = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
  repA = await makeRep('ZCRM-A', 'Abena');
  repB = await makeRep('ZCRM-B', 'Kwesi');
  repACtx = await buildContext(repA.userId);
  repBCtx = await buildContext(repB.userId);
  inbox.setSendersForTests({ whatsapp: async function (conv, body) { sent.push({ to: conv.external_thread_id, body: body }); return { externalId: 'wamid.out.' + sent.length }; } });
});
test.after(async function () { inbox.setSendersForTests(null); email.setMailboxForTests(null); mailboxes.setProbeForTests(null); mailboxes.setTransportForTests(null); meta.setFetchForTests(null); await cleanup(); await pool.end(); });

test('a WhatsApp message makes a customer profile; the same number in another form lands on it', async function () {
  var t = Date.now() - 5 * 3600000;
  await whatsapp.handleWebhookEvent(wa('233205550101', 'Zcrm Ama Mensah', 'Hello, how much are the Zcrm bamboo straws? Do you deliver to Tema?', t, 'wamid.zcrm.1'));
  var c = (await pool.query("SELECT * FROM customers WHERE name = 'Zcrm Ama Mensah'")).rows[0];
  assert.ok(c, 'profile made');
  assert.deepEqual([c.source, c.category, c.origin_channel, c.phone], ['crm', 'lead', 'whatsapp', '+233 20 555 0101']);
  // A customer typed the number as 020 555 0101 elsewhere: same person.
  var r = await inbox.ingest({ channel: 'sms', threadId: 'zcrm-sms-1', contact: { name: 'Ama', handles: [{ kind: 'phone', value: '020 555 0101' }] },
    messages: [{ direction: 'in', body: 'Zcrm I sent you a WhatsApp', sentAt: new Date(t + 60000) }] });
  assert.equal(r.customerId, c.id);
  assert.equal(r.customerCreated, false);
  // Delivered twice: kept once.
  await whatsapp.handleWebhookEvent(wa('233205550101', 'Zcrm Ama Mensah', 'Hello, how much are the Zcrm bamboo straws? Do you deliver to Tema?', t, 'wamid.zcrm.1'));
  var conv = (await pool.query("SELECT * FROM crm_conversations WHERE channel = 'whatsapp' AND external_thread_id = '233205550101'")).rows[0];
  assert.deepEqual([conv.message_count, conv.last_direction], [1, 'in']);
});

test('staff and automatic mail never become profiles', async function () {
  var staffEmail = (await pool.query('SELECT email FROM employees WHERE email IS NOT NULL AND email <> \'\' LIMIT 1')).rows[0].email;
  var a = await inbox.ingest({ channel: 'email', threadId: 'mail:zcrm-staff', contact: { name: 'Staff', handles: [{ kind: 'email', value: staffEmail }] }, messages: [{ direction: 'in', body: 'Zcrm lunch?', sentAt: new Date() }] });
  var b = await inbox.ingest({ channel: 'email', threadId: 'mail:zcrm-noreply', contact: { name: 'Zcrm Bank', handles: [{ kind: 'email', value: 'no-reply@bank.zcrm.example' }] }, messages: [{ direction: 'in', body: 'Statement', sentAt: new Date() }] });
  assert.equal(a.customerId, null);
  assert.equal(b.customerId, null);
});

test('the inbox, a reply on WhatsApp, a logged call, and moving a conversation to another profile', async function () {
  var list = await inbox.listConversations(admin, { waiting: '1', search: 'Zcrm Ama', channel: 'whatsapp' });
  assert.equal(list.conversations.length, 1);
  var conv = list.conversations[0];
  assert.equal(conv.waiting, true);
  var after = await inbox.reply(admin, conv.id, { body: 'Hello Ama, GHS 2 each. Yes, we deliver to Tema.' });
  assert.equal(sent[0].to, '233205550101');
  assert.equal(after.waiting, false);
  assert.equal(after.messages[after.messages.length - 1].sentBy.id, admin.employee.id);
  await assert.rejects(inbox.reply(repACtx, conv.id, { body: '' }), /Write the reply/);

  var ama = (await pool.query("SELECT id FROM customers WHERE name = 'Zcrm Ama Mensah'")).rows[0].id;
  await inbox.logInteraction(admin, ama, { channel: 'call', body: 'Zcrm called: wants 500 straws for her café', direction: 'out' });
  var p = await profiles.getProfile(admin, ama);
  assert.ok(p.timeline.some(function (x) { return x.kind === 'message' && x.channel === 'call'; }));
  assert.ok(p.identities.some(function (i) { return i.kind === 'phone' && i.value === '233205550101'; }));

  // A number that was put on the wrong person.
  var other = await inbox.ingest({ channel: 'whatsapp', threadId: '233205550199', contact: { name: 'Zcrm Ama (shop)', handles: [{ kind: 'phone', value: '233205550199' }] },
    messages: [{ externalId: 'wamid.zcrm.shop', direction: 'in', body: 'Zcrm this is Ama from the shop', sentAt: new Date() }] });
  assert.notEqual(other.customerId, ama);
  await inbox.linkConversation(admin, other.conversationId, { customerId: ama });
  var moved = (await pool.query("SELECT customer_id FROM customer_identities WHERE kind = 'phone' AND value = '233205550199'")).rows[0];
  assert.equal(moved.customer_id, ama, 'the number now belongs to Ama');
});

test('duplicates: same phone → merge (everything moved), empty look-alike → delete, near names with other numbers → edit', async function () {
  var ama = (await pool.query("SELECT id FROM customers WHERE name = 'Zcrm Ama Mensah'")).rows[0].id;
  // Typed in by hand last year, with an invoice and a quotation.
  var old = (await pool.query("INSERT INTO customers (name, phone, category, created_at) VALUES ('Zcrm Mensah Ama', '0205550101', 'active', now() - interval '400 days') RETURNING id")).rows[0].id;
  var inv = (await pool.query("INSERT INTO invoices (invoice_no, customer_id, grand_total, amount_paid, balance_due, status, issued_at, due_date) VALUES ('ZCRM-INV-1', $1, 900, 600, 300, 'partially_paid', CURRENT_DATE - 40, CURRENT_DATE - 10) RETURNING id", [old])).rows[0].id;
  await pool.query("INSERT INTO document_line_items (document_type, document_id, sort_order, description, qty, unit_price) VALUES ('invoice', $1, 0, 'Zcrm Bamboo straws (pack of 50)', 6, 150)", [inv]);
  await pool.query("INSERT INTO quotations (quote_no, customer_id, created_by, grand_total, status, created_at, sent_at, valid_until) VALUES ('ZCRM-Q-1', $1, $2, 5000, 'sent', now() - interval '6 days', now() - interval '6 days', CURRENT_DATE + 20)", [old, admin.employee.id]);
  // Two look-alikes: one empty, one with a different number and a sale.
  var empty = (await pool.query("INSERT INTO customers (name) VALUES ('Zcrm Kojo Badu Enterprise') RETURNING id")).rows[0].id;
  var kojo = (await pool.query("INSERT INTO customers (name, phone, category) VALUES ('Zcrm Kojo Badu', '0205550300', 'active') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, grand_total, status, issued_at) VALUES ('ZCRM-INV-2', $1, 100, 'paid', CURRENT_DATE - 3)", [kojo]);
  var kojo2 = (await pool.query("INSERT INTO customers (name, phone, category) VALUES ('Zcrm Kojo Baddu', '0205550301', 'active') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, grand_total, status, issued_at) VALUES ('ZCRM-INV-3', $1, 100, 'paid', CURRENT_DATE - 3)", [kojo2]);

  await inbox.backfillIdentities();
  await health.scanDuplicates();
  var dups = await health.listDuplicates(admin);
  function pairOf(x, y) { return dups.find(function (d) { return (d.a.id === x && d.b.id === y) || (d.a.id === y && d.b.id === x); }); }
  var same = pairOf(ama, old);
  assert.ok(same, 'same phone found');
  assert.equal(same.suggestion, 'merge');
  assert.ok(same.reasons.some(function (r) { return /same phone 233205550101/.test(r); }));
  assert.equal(same.keepId, old, 'keep the one with the invoice');
  assert.equal(pairOf(empty, kojo).suggestion, 'delete');
  assert.equal(pairOf(kojo, kojo2).suggestion, 'edit');

  await assert.rejects(health.merge(repACtx, { keepId: old, dropId: ama }), /crm\.assign/);
  var m = await health.merge(admin, { keepId: old, dropId: ama, suggestionId: same.id });
  assert.ok(m.moved.crm_conversations >= 3 && m.moved.customer_identities >= 1, JSON.stringify(m.moved));
  assert.equal((await pool.query('SELECT 1 FROM customers WHERE id = $1', [ama])).rows.length, 0, 'the dropped profile is gone');
  var kept = await profiles.getProfile(admin, old);
  assert.equal(kept.conversations >= 3, true);
  assert.ok(kept.timeline.some(function (x) { return x.kind === 'merge'; }));
  assert.ok(kept.lastContactAt, 'contact dates now on the kept profile');

  await assert.rejects(health.deleteEmpty(admin, kojo), /has records/);
  await health.deleteEmpty(admin, empty, pairOf(empty, kojo).id);
  await health.decide(admin, pairOf(kojo, kojo2).id, 'dismissed');
  await health.scanDuplicates();
  assert.ok(!(await health.listDuplicates(admin)).some(function (d) { return d.a.id === kojo || d.b.id === kojo; }), 'a dismissed pair stays dismissed');
});

test('coverage: customers with no rep get a suggested rep, managers are told once a day, reps can take unassigned ones', async function () {
  var kept = (await pool.query("SELECT id FROM customers WHERE name = 'Zcrm Mensah Ama'")).rows[0].id;
  var kojo = (await pool.query("SELECT id FROM customers WHERE name = 'Zcrm Kojo Badu'")).rows[0].id;
  await pool.query("INSERT INTO crm_leads (name, customer_id, rep_id, item, stage) VALUES ('Zcrm Kojo Badu', $1, $2, 'Zcrm bamboo lantern', 'contacted')", [kojo, repB.employeeId]);
  var list = await health.unassigned(admin);
  var k = list.find(function (c) { return c.id === kojo; });
  assert.deepEqual([k.suggested.id, k.suggested.why], [repB.employeeId, 'works their lead']);
  assert.equal(k.suggested.whyKey, 'lead', 'the reason as a key, for the page to word');
  var a = list.find(function (c) { return c.id === kept; });
  assert.ok(a.suggested && a.suggested.id, 'a suggestion for everyone');

  var n1 = await health.raiseCoverageConcern(new Date('2031-01-05T09:00:00Z'));
  var n2 = await health.raiseCoverageConcern(new Date('2031-01-05T15:00:00Z'));
  assert.ok(n1.sent >= 1 && n1.customers >= 2);
  assert.equal(n2.sent, 0, 'once a day');

  await assert.rejects(profiles.assignRep(repACtx, { customerIds: [kojo], repId: repB.employeeId }), /crm\.assign/);
  await profiles.assignRep(repACtx, { customerIds: [kept], repId: repA.employeeId });
  await health.assignSuggested(admin, { customerIds: [kojo] });
  var reps = await profiles.reps(admin);
  assert.equal(reps.find(function (r) { return r.id === repA.employeeId; }).customers, 1);
  assert.equal((await pool.query('SELECT account_manager_id FROM customers WHERE id = $1', [kojo])).rows[0].account_manager_id, repB.employeeId);
  var note = (await pool.query("SELECT title FROM notifications WHERE employee_id = $1 ORDER BY at DESC LIMIT 1", [repB.employeeId])).rows[0];
  assert.match(note.title, /Zcrm Kojo Badu is now your customer/);
});

test('follow-ups at sign-in: waiting, planned, overdue, quotation, quiet — with the details and the next step', async function () {
  var kept = (await pool.query("SELECT id FROM customers WHERE name = 'Zcrm Mensah Ama'")).rows[0].id;
  // Our reply was this morning; a new message from her 3 hours ago is still unanswered.
  await pool.query("UPDATE crm_messages SET sent_at = now() - interval '5 hours' WHERE direction = 'out' AND conversation_id = (SELECT id FROM crm_conversations WHERE channel = 'whatsapp' AND external_thread_id = '233205550101')");
  await inbox.ingest({ channel: 'whatsapp', threadId: '233205550101', contact: { name: 'Zcrm Ama Mensah', handles: [{ kind: 'phone', value: '233205550101' }] },
    messages: [{ externalId: 'wamid.zcrm.2', direction: 'in', body: 'Zcrm can I get 500 by Friday?', sentAt: new Date(Date.now() - 3 * 3600000) }] });
  await pool.query("UPDATE crm_conversations SET status = 'closed' WHERE channel = 'sms' AND external_thread_id = 'zcrm-sms-1'");
  await profiles.setFollowUp(admin, kept, { on: new Date().toISOString().slice(0, 10), note: 'Confirm the café order' });
  var mine = await followUps.mine(repACtx);
  var item = mine.items.find(function (i) { return i.customer && i.customer.id === kept; });
  assert.ok(item, 'on the rep\'s list');
  var types = item.reasons.map(function (r) { return r.type; });
  assert.deepEqual(types.slice(0, 4), ['waiting', 'planned', 'overdue', 'quote'], JSON.stringify(item.reasons));
  assert.match(item.reasons[0].text, /WhatsApp 3 hours ago.*500 by Friday/);
  assert.deepEqual([item.reasons[0].channel, item.reasons[0].hours, /500 by Friday/.test(item.reasons[0].preview)], ['whatsapp', 3, true], 'the numbers behind the words');
  assert.equal(item.nextStep, 'Reply on WhatsApp — they are waiting.');
  assert.ok(item.customer.identities.length && item.customer.interests[0] === 'Zcrm Bamboo straws (pack of 50)');
  assert.equal(item.customer.outstanding, 300);
  // A buying customer gone quiet.
  var quiet = (await pool.query("INSERT INTO customers (name, category, account_manager_id, last_contact_at) VALUES ('Zcrm Quiet Hotel', 'vip', $1, now() - interval '60 days') RETURNING id", [repA.employeeId])).rows[0].id;
  var again = await followUps.mine(repACtx);
  assert.match(again.items.find(function (i) { return i.customer && i.customer.id === quiet; }).reasons[0].text, /No contact for 60 days/);
  await assert.rejects(followUps.team(repACtx), /crm\.assign/);
  var team = await followUps.team(admin);
  assert.ok(team.reps.some(function (r) { return r.rep && r.rep.id === repA.employeeId && r.waiting >= 1; }));
});

test('a sales order takes the customer\'s rep, and its invoice shows it', async function () {
  var kept = (await pool.query("SELECT id FROM customers WHERE name = 'Zcrm Mensah Ama'")).rows[0].id;
  var q = (await pool.query("INSERT INTO quotations (quote_no, customer_id, created_by, grand_total, status) VALUES ('ZCRM-Q-2', $1, $2, 700, 'accepted') RETURNING id", [kept, admin.employee.id])).rows[0].id;
  var so = await salesOrders.createFromQuotation(admin, q, {});
  assert.equal(so.repId, repA.employeeId);
  var other = await salesOrders.update(admin, so.id, { repId: repB.employeeId });
  assert.equal(other.repId, repB.employeeId);
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, sales_order_id, grand_total, status) VALUES ('ZCRM-INV-4', $1, $2, 700, 'unpaid')", [kept, so.id]);
  var inv = (await require('../src/services/invoices.service').list(admin)).find(function (i) { return i.invoiceNo === 'ZCRM-INV-4'; });
  assert.equal(inv.rep.id, repB.employeeId);
});

test('a WhatsApp chat export brings the history onto the profile; importing it again adds nothing', async function () {
  var text = '01/02/2026, 09:00 - Messages and calls are end-to-end encrypted.\n' +
    '01/02/2026, 09:01 - Zcrm Yaw Boakye: Good morning, do you make bamboo beds?\n' +
    '01/02/2026, 09:05 - BPL Sales: Yes! Queen and king size.\nPrices from GHS 4,500.\n' +
    '02/02/2026, 18:30 - Zcrm Yaw Boakye: <Media omitted>\n';
  var file = { buffer: Buffer.from(text), size: text.length, originalname: 'WhatsApp Chat with Zcrm Yaw Boakye.txt' };
  var pv = await waImport.preview(admin, file);
  assert.deepEqual([pv.messages, pv.guessCustomer], [3, 'Zcrm Yaw Boakye']);
  await assert.rejects(waImport.run(admin, file, { ourNames: ['BPL Sales'] }), /WhatsApp number/);
  var r = await waImport.run(admin, file, { ourNames: ['BPL Sales'], phone: '020 555 0420' });
  assert.deepEqual([r.added, r.customerCreated], [3, true]);
  var again = await waImport.run(admin, file, { ourNames: ['BPL Sales'], phone: '020 555 0420' });
  assert.equal(again.added, 0);
  var conv = await inbox.getConversation(admin, r.conversationId);
  assert.deepEqual(conv.messages.map(function (m) { return m.direction; }), ['in', 'out', 'in']);
  assert.match(conv.messages[1].body, /Queen and king size\.\nPrices from GHS 4,500\./);
  // His live WhatsApp lands on the same conversation.
  await whatsapp.handleWebhookEvent(wa('233205550420', 'Yaw', 'Zcrm is the queen bed in stock?', Date.now(), 'wamid.zcrm.yaw'));
  assert.equal((await inbox.getConversation(admin, r.conversationId)).messageCount, 4);
});

test('email: customers\' mail lands on profiles (quotes cut), newsletters are skipped, replies from Sent are kept', async function () {
  var saved = { user: config.crmImap.user, sent: config.crmImap.sent };
  config.crmImap.user = 'sales@bpl.zcrm.example';
  config.crmImap.sent = 'Sent';
  function mail(from, to, subject, body, id, extra) {
    return Buffer.from('From: ' + from + '\r\nTo: ' + to + '\r\nSubject: ' + subject + '\r\nMessage-ID: <' + id + '>\r\nDate: ' + new Date(Date.now() - 86400000).toUTCString() + '\r\n' + (extra || '') + 'Content-Type: text/plain\r\n\r\n' + body);
  }
  var boxes = {
    INBOX: [{ uid: 1, source: mail('Zcrm Esi Annan <esi@zcrm.example>', 'sales@bpl.zcrm.example', 'Bamboo panels for my office', 'Hi, I need a price for 20 bamboo wall panels.\n\nOn Mon, someone wrote:\n> old', 'esi-1@zcrm.example') },
      { uid: 2, source: mail('Deals <deals@shop.zcrm.example>', 'sales@bpl.zcrm.example', 'Big sale', 'Buy now', 'news-1@zcrm.example', 'List-Unsubscribe: <mailto:x@y>\r\n') }],
    Sent: [{ uid: 7, source: mail('BPL Sales <sales@bpl.zcrm.example>', 'esi@zcrm.example', 'Re: Bamboo panels for my office', 'Hello Esi, GHS 350 each.', 'reply-1@zcrm.example', 'In-Reply-To: <esi-1@zcrm.example>\r\nReferences: <esi-1@zcrm.example>\r\n') }]
  };
  email.setMailboxForTests({ open: async function () {}, close: async function () {}, listNew: async function (folder, cursor) {
    return { v: '1', messages: (boxes[folder] || []).filter(function (m) { return !cursor || m.uid > cursor.uid; }) };
  } });
  try {
    var r = await email.sync();
    assert.deepEqual([r.kept, r.skipped], [2, 1]);
    var esi = (await pool.query("SELECT * FROM customers WHERE email = 'esi@zcrm.example'")).rows[0];
    assert.equal(esi.name, 'Zcrm Esi Annan');
    var thread = (await inbox.listConversations(admin, { customerId: esi.id })).conversations;
    assert.equal(thread.length, 1, 'question and reply in one thread');
    var c = await inbox.getConversation(admin, thread[0].id);
    assert.deepEqual(c.messages.map(function (m) { return m.direction + ':' + m.body; }), ['in:Hi, I need a price for 20 bamboo wall panels.', 'out:Hello Esi, GHS 350 each.']);
    assert.equal((await email.sync()).kept, 0, 'nothing twice');
  } finally { config.crmImap.user = saved.user; config.crmImap.sent = saved.sent; }
});

test('the mailbox connected on Integrations: checked first, the password sealed and never shown, read and replied from', async function () {
  var tried = [];
  mailboxes.setProbeForTests(async function (s) {
    tried.push(s.imap.host + '|' + s.pass);
    if (s.pass !== 'zcrm-right-pass') { var e = new Error('Invalid credentials (Failure)'); e.authenticationFailed = true; e.stage = 'imap'; throw e; }
    return { sentFolder: 'INBOX.Sent' };
  });
  await assert.rejects(mailboxes.info(repACtx), /settings\.manage/);
  await assert.rejects(mailboxes.connect(repACtx, { provider: 'hostinger', address: 'shop@bpl.zcrm.example', password: 'zcrm-right-pass' }), /settings\.manage/);
  // A wrong password is said there and then, in words to act on.
  await assert.rejects(mailboxes.test(admin, { provider: 'gmail', address: 'shop@bpl.zcrm.example', password: 'zcrm-normal-pass' }), /app password/);
  await assert.rejects(mailboxes.connect(admin, { provider: 'hostinger', address: 'shop@bpl.zcrm.example', password: 'zcrm-wrong' }), /hPanel/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM crm_mailbox')).rows[0].n, 0, 'nothing kept when the check fails');
  await assert.rejects(mailboxes.test(admin, { provider: 'other', address: 'shop@bpl.zcrm.example', password: 'x', imapHost: 'not a host' }), /server name/);

  var info = await mailboxes.connect(admin, { provider: 'hostinger', address: 'Shop@BPL.zcrm.example', password: 'zcrm-right-pass', fromName: 'Zcrm Sales' });
  assert.deepEqual([info.source, info.address, info.imapHost, info.smtpHost, info.sent, info.canSend], ['os', 'shop@bpl.zcrm.example', 'imap.hostinger.com', 'smtp.hostinger.com', 'INBOX.Sent', true]);
  assert.equal(info.connectedByName, admin.employee.first_name + ' ' + admin.employee.last_name);
  assert.ok(!/zcrm-right-pass/.test(JSON.stringify(info)), 'the password is never sent back');
  var row = (await pool.query('SELECT password_enc FROM crm_mailbox WHERE id = 1')).rows[0];
  assert.ok(!/zcrm-right-pass/.test(row.password_enc), 'kept sealed');
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'crm.mailbox.connect' AND summary LIKE '%shop@bpl.zcrm.example%'")).rows.length);

  // Other settings changed without typing the password again — the same mailbox only.
  info = await mailboxes.connect(admin, { provider: 'other', address: 'shop@bpl.zcrm.example', imapHost: 'mail.zcrm.example', smtpHost: 'mail.zcrm.example', smtpPort: 587 });
  assert.deepEqual([info.imapHost, tried[tried.length - 1]], ['mail.zcrm.example', 'mail.zcrm.example|zcrm-right-pass']);
  await assert.rejects(mailboxes.connect(admin, { provider: 'hostinger', address: 'other@bpl.zcrm.example' }), /Enter the mailbox's password/);

  // Reading: the connected mailbox, from its own last 30 days (not the cursor of the one before).
  function mail(from, to, subject, body, id, extra) {
    return Buffer.from('From: ' + from + '\r\nTo: ' + to + '\r\nSubject: ' + subject + '\r\nMessage-ID: <' + id + '>\r\nDate: ' + new Date(Date.now() - 3600000).toUTCString() + '\r\n' + (extra || '') + 'Content-Type: text/plain\r\n\r\n' + body);
  }
  var cursors = {};
  email.setMailboxForTests({ open: async function () {}, close: async function () {}, listNew: async function (folder, cursor) {
    cursors[folder] = cursor;
    return { v: '1', messages: folder === 'INBOX' ? [
      { uid: 1, source: mail('Zcrm Kofi Asare <kofi@zcrm.example>', 'shop@bpl.zcrm.example', 'Bamboo blinds', 'How much for 6 bamboo blinds?', 'kofi-1@zcrm.example') },
      { uid: 2, source: mail('Zcrm Kofi Asare <kofi@zcrm.example>', 'shop@bpl.zcrm.example', 'Re: Bamboo blinds', 'And can you fit them?', 'kofi-2@zcrm.example', 'In-Reply-To: <kofi-1@zcrm.example>\r\nReferences: <kofi-1@zcrm.example>\r\n') }] : [] };
  } });
  var r = await email.sync();
  assert.equal(r.kept, 2);
  assert.equal(cursors.INBOX, null, 'the earlier mailbox\'s place is not used');
  assert.ok('INBOX.Sent' in cursors, 'its sent folder is read too');
  var st = (await pool.query("SELECT cursor FROM crm_channel_state WHERE key = 'email:INBOX'")).rows[0];
  assert.equal(JSON.parse(st.cursor).a, 'shop@bpl.zcrm.example');

  // Replying: from the mailbox, in the thread, with a copy in its sent folder.
  var conv = (await pool.query("SELECT id FROM crm_conversations WHERE channel = 'email' AND contact_key = 'kofi@zcrm.example'")).rows[0];
  var mails = [], copies = [];
  mailboxes.setTransportForTests({ sendMail: async function (m) { mails.push(m); } }, async function (folder, raw) { copies.push({ folder: folder, raw: raw.toString() }); });
  inbox.setSendersForTests(null);
  try {
    var after = await inbox.reply(admin, conv.id, { body: 'Zcrm hello Kofi, GHS 450 each, fitting included.' });
  } finally { inbox.setSendersForTests({ whatsapp: async function (c, body) { sent.push({ to: c.external_thread_id, body: body }); return { externalId: 'wamid.out.' + sent.length }; } }); }
  assert.equal(mails.length, 1);
  var m = mails[0];
  assert.deepEqual([m.from.address, m.to, m.subject, m.inReplyTo], ['shop@bpl.zcrm.example', 'kofi@zcrm.example', 'Re: Bamboo blinds', '<kofi-2@zcrm.example>']);
  assert.deepEqual(m.references, ['<kofi-1@zcrm.example>', '<kofi-2@zcrm.example>'], 'the thread\'s first message, then the one answered');
  assert.equal(m.from.name, admin.employee.first_name + ' ' + admin.employee.last_name + ' \u00b7 Bamboo Products', 'signed by who wrote it, then the mailbox\'s name');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].folder, 'INBOX.Sent');
  assert.ok(copies[0].raw.indexOf(m.messageId) >= 0 && /GHS 450 each/.test(copies[0].raw));
  assert.equal(after.messages[after.messages.length - 1].direction, 'out');

  // A password that can no longer be opened (the server's secret changed): said, and nothing sent.
  mailboxes.setTransportForTests(null);
  await pool.query("UPDATE crm_mailbox SET password_enc = 'x.y.z' WHERE id = 1");
  info = await mailboxes.info(admin);
  assert.deepEqual([info.broken, info.canSend], [true, false]);
  email.setMailboxForTests(null);
  assert.deepEqual(await email.sync(), { skipped: 'not set up' }, 'the real mailbox is not tried without its password');

  // Disconnected: back to the server's own settings.
  info = await mailboxes.disconnect(admin);
  assert.notEqual(info.source, 'os');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM crm_mailbox')).rows[0].n, 0);
  assert.ok((await pool.query("SELECT 1 FROM audit_logs WHERE action = 'crm.mailbox.disconnect' AND summary LIKE '%shop@bpl.zcrm.example%'")).rows.length);
  mailboxes.setProbeForTests(null);
});

test('Facebook and Instagram messages come in through the connected Page', async function () {
  await pool.query("INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ('facebook', 'tok', '', 'zcrm-page', 'pages_messaging,instagram_manage_messages', now() + interval '1 year') ON CONFLICT (channel_key) DO UPDATE SET access_token = 'tok', open_id = 'zcrm-page', scope = EXCLUDED.scope");
  await pool.query("INSERT INTO marketing_oauth_tokens (channel_key, access_token, refresh_token, open_id, scope, expires_at) VALUES ('instagram', 'tok', '', 'zcrm-ig', 'pages_messaging,instagram_manage_messages', now() + interval '1 year') ON CONFLICT (channel_key) DO UPDATE SET open_id = 'zcrm-ig'");
  var updated = new Date(Date.now() - 300000).toISOString();
  meta.setFetchForTests(async function (url) {
    var ig = /platform=instagram/.test(url);
    var data = [{ id: ig ? 'zcrm-igconv-1' : 'zcrm-fbconv-1', updated_time: updated,
      participants: { data: ig ? [{ id: 'zcrm-ig' }, { id: 'zcrm-igsid-1', username: 'zcrm_kwame' }] : [{ id: 'zcrm-page', name: 'BPL' }, { id: 'zcrm-psid-1', name: 'Zcrm Efua Nyarko' }] },
      messages: { data: [{ id: ig ? 'ig-m1' : 'fb-m1', message: ig ? 'do you have Zcrm bamboo lanterns?' : 'Zcrm price of a bamboo chair?', from: ig ? { id: 'zcrm-igsid-1', username: 'zcrm_kwame' } : { id: 'zcrm-psid-1', name: 'Zcrm Efua Nyarko' }, created_time: new Date(Date.now() - 600000).toISOString() }] } }];
    return { ok: true, json: async function () { return { data: data }; } };
  });
  var r = await meta.sync();
  assert.deepEqual([r.facebook.conversations, r.instagram.conversations], [1, 1]);
  var efua = (await pool.query("SELECT c.* FROM customers c JOIN customer_identities i ON i.customer_id = c.id WHERE i.kind = 'facebook' AND i.value = 'zcrm-psid-1'")).rows[0];
  assert.equal(efua.name, 'Zcrm Efua Nyarko');
  var kw = (await pool.query("SELECT c.name, c.origin_channel FROM customers c JOIN customer_identities i ON i.customer_id = c.id WHERE i.kind = 'instagram' AND i.value = 'zcrm-igsid-1'")).rows[0];
  assert.deepEqual([kw.name, kw.origin_channel], ['@zcrm_kwame', 'instagram']);
  assert.equal((await meta.sync()).facebook.conversations, 0, 'only what changed since');
});

test('marketing: what customers ask about, posts to make, and who to tell about a product', async function () {
  await pool.query("INSERT INTO products (sku, name, category, active) VALUES ('ZCRM-1', 'Zcrm Bamboo straws (pack of 50)', 'Zcrm Tableware', true), ('ZCRM-2', 'Zcrm Bamboo lantern', 'Zcrm Decor', true), ('ZCRM-3', 'Zcrm Bamboo cups', 'Zcrm Tableware', true)");
  var t = await marketing.topics(admin, { days: 30 });
  var straws = t.products.find(function (p) { return p.name === 'Zcrm Bamboo straws (pack of 50)'; });
  assert.ok(straws && straws.customers >= 1 && straws.questions.price >= 1, 'asked about, with the price');
  assert.ok(t.questions.some(function (q) { return q.key === 'delivery'; }));
  var ideas = await marketing.contentIdeas(admin, { days: 30 });
  assert.equal(ideas.source, 'rules');
  assert.ok(ideas.ideas.length >= 1 && ideas.ideas.every(function (i) { return i.title && i.why && i.platform; }));
  assert.ok(ideas.ideas.every(function (i) { return i.kind && i.vars; }), 'every rule idea has its kind and numbers');
  // With the AI Assistant: only counts and product names leave — never customers' words.
  var claude = require('../src/ai/claude');
  var seen = null;
  var fakeCreate = async function (params) { seen = params; return { stop_reason: 'end_turn', content: [{ type: 'text', text: '[{"product":null,"title":"Zcrm idea","format":"Post","platform":"Instagram","why":"3 asked","hook":"Hi","points":["a","b","c"]}]' }] }; };
  claude.setClientForTests({ messages: { create: fakeCreate }, beta: { messages: { create: fakeCreate } } });
  try {
    var ai = await marketing.contentIdeas(admin, { days: 30, ai: '1' });
    assert.equal(ai.source, 'ai');
    var sent = JSON.stringify(seen.messages);
    assert.ok(!/how much|deliver to Tema|Zcrm I sent/i.test(sent), 'no message text is sent to the AI');
    var facts = JSON.parse(seen.messages[0].content);
    assert.ok(facts.questions.length && facts.questions.every(function (q) { return typeof q.customers === 'number' && !q.examples; }), 'the counts are, without examples');
  } finally { claude.setClientForTests(null); }

  var lantern = (await pool.query("SELECT id FROM products WHERE sku = 'ZCRM-2'")).rows[0].id;
  var aud = await marketing.audience(admin, { productId: lantern });
  var names = aud.people.map(function (p) { return p.name; });
  assert.ok(names.indexOf('@zcrm_kwame') >= 0, 'asked on Instagram');
  assert.ok(names.indexOf('Zcrm Kojo Badu') >= 0, 'has a lead for it');
  var straw = (await pool.query("SELECT id FROM products WHERE sku = 'ZCRM-1'")).rows[0].id;
  var byStraw = await marketing.audience(admin, { productId: straw });
  var ama = byStraw.people.find(function (p) { return p.name === 'Zcrm Mensah Ama'; });
  assert.ok(ama.reasons.some(function (r) { return /Bought Zcrm Bamboo straws/.test(r); }));
  // Said no to marketing: never on a list.
  await pool.query("UPDATE customers SET marketing_opt_out = true WHERE name = 'Zcrm Mensah Ama'");
  var after = await marketing.audience(admin, { productId: straw });
  assert.ok(!after.people.some(function (p) { return p.name === 'Zcrm Mensah Ama'; }));
  assert.equal(after.left.optedOut, 1);
  var cups = (await pool.query("SELECT id FROM products WHERE sku = 'ZCRM-3'")).rows[0].id;
  await pool.query("UPDATE customers SET marketing_opt_out = false WHERE name = 'Zcrm Mensah Ama'");
  var kin = await marketing.audience(admin, { productId: cups });
  assert.ok(kin.people.some(function (p) { return p.name === 'Zcrm Mensah Ama' && /Buys other Zcrm Tableware/.test(p.reasons[0]); }), 'buys the same kind of thing');
  assert.ok(kin.people.every(function (p) { return p.why.length === p.reasons.length && p.why.every(function (w) { return w && w.type; }); }), 'each reason also as data');

  var handed = await marketing.handToReps(admin, { customerIds: aud.people.map(function (p) { return p.id; }), what: 'Zcrm Bamboo lantern' });
  assert.ok(handed.customers >= 2);
  var kojo = (await pool.query("SELECT follow_up_note FROM customers WHERE name = 'Zcrm Kojo Badu'")).rows[0];
  assert.match(kojo.follow_up_note, /Tell them about Zcrm Bamboo lantern/);
});

test('profiles list: the summary and the filters', async function () {
  var all = await profiles.listProfiles(admin, { search: 'Zcrm' });
  assert.ok(all.profiles.length >= 5);
  var mine = await profiles.listProfiles(repACtx, { rep: 'me' });
  assert.ok(mine.profiles.every(function (p) { return p.rep && p.rep.id === repA.employeeId; }));
  var none = await profiles.listProfiles(admin, { rep: 'none', search: 'Zcrm' });
  assert.ok(none.profiles.every(function (p) { return !p.rep; }));
  var byPhone = await profiles.listProfiles(admin, { search: '0205550420' });
  assert.equal(byPhone.profiles[0].name, 'Zcrm Yaw Boakye', 'found by any form of the number');
  await assert.rejects(profiles.addIdentity(admin, byPhone.profiles[0].id, { kind: 'phone', value: '0205550300' }), /already belongs to Zcrm Kojo Badu/);
});

test('coexistence: names saved on the phone, replies typed on the phone, and the chats from before', async function () {
  function change(value) { return { entry: [{ changes: [{ field: 'x', value: Object.assign({ messaging_product: 'whatsapp', metadata: { display_phone_number: '233205550000', phone_number_id: 'zcrm-pn' } }, value) }] }] }; }
  var ts = function (msAgo) { return String(Math.floor((Date.now() - msAgo) / 1000)); };
  // The phone's contacts arrive first: kept for when the chats come.
  await whatsapp.handleWebhookEvent(change({ state_sync: [
    { type: 'contact', action: 'add', contact: { full_name: 'Zcrm Esi Tema Juice', first_name: 'Esi', phone_number: '233205550901' }, metadata: { timestamp: ts(0) } },
    { type: 'contact', action: 'add', contact: { full_name: 'Zcrm Yaw Carpenter', phone_number: '233205550902' }, metadata: { timestamp: ts(0) } }] }));

  // Past chats: one that ended long ago, one where the customer wrote yesterday.
  await whatsapp.handleWebhookEvent(change({ history: [{ metadata: { phase: 0, chunk_order: 1, progress: 55 }, threads: [
    { id: '233205550901', messages: [
      { from: '233205550901', id: 'wamid.zcrm.h1', timestamp: ts(40 * 86400000), type: 'text', text: { body: 'Zcrm how much are the straws?' }, history_context: { status: 'READ' } },
      { from: '233205550000', to: '233205550901', id: 'wamid.zcrm.h2', timestamp: ts(40 * 86400000 - 600000), type: 'text', text: { body: 'GHS 60 per pack.' }, history_context: { status: 'READ' } },
      { from: '233205550901', id: 'wamid.zcrm.h3', timestamp: ts(39 * 86400000), type: 'text', text: { body: 'Thanks, I will come by.' } }] },
    { id: '233205550902', messages: [
      { from: '233205550902', id: 'wamid.zcrm.h4', timestamp: ts(86400000), type: 'image', image: { caption: 'Zcrm can you make this door?', mime_type: 'image/jpeg' } }] },
    { id: '120363000000000000@g.us', messages: [{ from: '233205550903', id: 'wamid.zcrm.g1', timestamp: ts(5000), type: 'text', text: { body: 'a group' } }] }] }] }));

  var esi = (await pool.query("SELECT * FROM customers WHERE name = 'Zcrm Esi Tema Juice'")).rows[0];
  assert.ok(esi, 'profile named as saved on the phone');
  var old = (await pool.query("SELECT * FROM crm_conversations WHERE channel = 'whatsapp' AND external_thread_id = '233205550901'")).rows[0];
  assert.deepEqual([old.imported, old.status, old.message_count, old.customer_id], [true, 'closed', 3, esi.id], 'an old chat is filed, not waiting');
  var dirs = (await pool.query('SELECT direction, author_name FROM crm_messages WHERE conversation_id = $1 ORDER BY sent_at', [old.id])).rows;
  assert.deepEqual(dirs.map(function (d) { return d.direction; }), ['in', 'out', 'in'], 'our side told apart from theirs');
  assert.equal(dirs[1].author_name, 'Bamboo Products (phone)');
  var yaw = (await pool.query("SELECT * FROM crm_conversations WHERE channel = 'whatsapp' AND external_thread_id = '233205550902'")).rows[0];
  assert.deepEqual([yaw.status, yaw.last_direction, yaw.contact_name], ['open', 'in', 'Zcrm Yaw Carpenter'], 'a recent one still waits');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM crm_conversations WHERE external_thread_id LIKE '%@g.us'")).rows[0].n, 0, 'group chats left out');
  var notes = (await pool.query("SELECT count(*)::int AS n FROM notifications WHERE (title LIKE '%Esi Tema%' OR title LIKE '%Yaw Carpenter%') AND at > now() - interval '1 minute'")).rows[0].n;
  assert.equal(notes, 0, 'nobody is notified about old chats');

  // A reply typed on the phone: the customer is answered.
  await whatsapp.handleWebhookEvent(change({ message_echoes: [{ from: '233205550000', to: '233205550902', id: 'wamid.zcrm.e1', timestamp: ts(1000), type: 'text', text: { body: 'Yes we can, come Monday.' } }] }));
  yaw = (await pool.query('SELECT * FROM crm_conversations WHERE id = $1', [yaw.id])).rows[0];
  assert.deepEqual([yaw.last_direction, yaw.message_count], ['out', 2]);
  // Delivered twice: kept once.
  await whatsapp.handleWebhookEvent(change({ message_echoes: [{ from: '233205550000', to: '233205550902', id: 'wamid.zcrm.e1', timestamp: ts(1000), type: 'text', text: { body: 'Yes we can, come Monday.' } }] }));
  assert.equal((await pool.query('SELECT message_count FROM crm_conversations WHERE id = $1', [yaw.id])).rows[0].message_count, 2);

  // A contact renamed on the phone renames a profile that only had the number.
  var bare = (await pool.query("INSERT INTO customers (name, phone, category) VALUES ('+233 20 555 0904', '+233 20 555 0904', 'lead') RETURNING id")).rows[0].id;
  await inbox.addIdentities(pool, bare, [inbox.normIdentity({ kind: 'phone', value: '+233 20 555 0904' })]);
  await whatsapp.handleWebhookEvent(change({ state_sync: [{ type: 'contact', action: 'add', contact: { full_name: 'Zcrm Kofi Site Manager', phone_number: '233205550904' } }] }));
  assert.equal((await pool.query('SELECT name FROM customers WHERE id = $1', [bare])).rows[0].name, 'Zcrm Kofi Site Manager');

  var st = await whatsapp.status();
  assert.deepEqual([st.history.progress, st.history.items >= 4, st.phoneReplies.items >= 1], [55, true, true], 'Data health sees it');
  // History the business declined to share: the reason is shown.
  await whatsapp.handleWebhookEvent(change({ history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business' }] }] }));
  assert.match((await whatsapp.status()).history.error, /turned off/);
});

