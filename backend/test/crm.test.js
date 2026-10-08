// The CRM (migration 0102, services/crm.service.js and crmImport.service.js):
// who may see and do what; a lead from first message to a won sale with its
// history; a sale is an OS invoice and the commission is the base rate
// minus the discount given; the overview adds it all up; Lead → Prospect →
// Customer (a quotation makes a prospect, the first payment a customer, and
// the old contact lists become leads); site visits and referrals; and the
// spreadsheet import, run twice; and a rep's sales board, ranked.
// Test data: ZQC codes and "Zq" names, all removed afterwards.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var bcrypt = require('bcrypt');
var { pool } = require('../src/db/pool');
var crm = require('../src/services/crm.service');
var crmImport = require('../src/services/crmImport.service');
var crmBoard = require('../src/services/crmBoard.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, andy, alice, rep, rep2, bpl, cust, inv = {};   // bpl: the test's own company, standing in for BPL
function iso(d) { return d.toISOString().slice(0, 10); }
var today = iso(new Date());
function daysAgo(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); }

// Everything with money in it belongs to the test's own company (ZQC), and
// the CRM counts that company's invoices while the test runs, so tests that
// add up another company's sales in parallel never see these. Only this
// file uses the crm_* tables.
async function cleanup() {
  await pool.query('DELETE FROM crm_deals');
  await pool.query('DELETE FROM crm_referrals');
  await pool.query('DELETE FROM crm_site_visits');
  await pool.query('DELETE FROM crm_leads');
  await pool.query('DELETE FROM crm_prospects');
  var co = (await pool.query("SELECT id FROM companies WHERE code = 'ZQC'")).rows[0];
  if (co) {
    await pool.query('DELETE FROM quotations WHERE customer_id IN (SELECT id FROM customers WHERE company_id = $1)', [co.id]);
    await pool.query('DELETE FROM invoices WHERE company_id = $1', [co.id]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [co.id]);
    await pool.query('UPDATE crm_settings SET company_id = NULL WHERE company_id = $1', [co.id]);
    await pool.query('DELETE FROM companies WHERE id = $1', [co.id]);
  }
  await pool.query("DELETE FROM crm_conversations WHERE external_thread_id LIKE 'zqb-%'");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqc.%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQC-%'");
}
async function repUser(code, first, email) {
  var dept = (await pool.query('SELECT id FROM departments LIMIT 1')).rows[0].id;
  var emp = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date, status, employment_type) VALUES ($1, $2, 'Zqrep', $3, $4, current_date, 'active', 'permanent') RETURNING id",
    [code, first, email, dept])).rows[0].id;
  var user = (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id", [emp, email, await bcrypt.hash('x-1234567', 4)])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'sales_rep'", [user]);
  return buildContext(user);
}
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function invoice(no, subtotal, discount, paid, issued) {
  var grand = subtotal - discount;
  return (await pool.query(
    "INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, company_id) " +
    "VALUES ($1,$2,$3,$4,0,$5,$6,$7,$8,$9,$10) RETURNING id", [no, cust, subtotal, discount, grand, paid, grand - paid, paid >= grand ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid', issued, bpl])).rows[0].id;
}

// The CRM settings are one row for the whole OS, and this file points them
// at its own company while it runs; crmExecutive.test.js and crmHub.test.js
// work with the default company, so the files take turns (a Postgres
// advisory lock).
var settingsLock;
test.before(async function () {
  settingsLock = await pool.connect();
  await settingsLock.query('SELECT pg_advisory_lock(7102)');
  await cleanup();
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  andy = await ctxFor('andy.chou@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  rep = await repUser('ZQC-REP1', 'Zq Kofi', 'zqc.rep1@example.com');
  rep2 = await repUser('ZQC-REP2', 'Zq Esi', 'zqc.rep2@example.com');
  bpl = (await pool.query("INSERT INTO companies (code, name) VALUES ('ZQC', 'Zqc Crafts Group') RETURNING id")).rows[0].id;
  await crm._settingsRow();
  await pool.query('UPDATE crm_settings SET company_id = $1 WHERE id = 1', [bpl]);
  cust = (await pool.query("INSERT INTO customers (name, phone, company_id) VALUES ('Zqc Crafts Ltd', '0240000111', $1) RETURNING id", [bpl])).rows[0].id;
  inv.paid = await invoice('ZQC-001', 1000, 50, 950, today);           // 5% off, fully paid
  inv.part = await invoice('ZQC-002', 2000, 0, 500, today);            // no discount, 1,500 owed
  inv.big = await invoice('ZQC-003', 1000, 300, 700, today);           // 30% off
  inv.loose = await invoice('ZQC-004', 400, 0, 400, today);            // never linked
});
test.after(async function () {
  await cleanup();
  await settingsLock.query('SELECT pg_advisory_unlock(7102)');
  settingsLock.release();
  await pool.end();
});

test('commission is the base rate minus the discount given, never below zero', function () {
  var five = crm.commission({ subtotal: 1000, discount_total: 50, grand_total: 950, amount_paid: 950, balance_due: 0 }, 20);
  assert.deepEqual([five.value, five.discountPct, five.rate, five.commission, five.ready], [950, 5, 15, 142.5, true]);
  var sheetDoor = crm.commission({ subtotal: 31966.20, discount_total: 3966.20, grand_total: 28000, amount_paid: 28000, balance_due: 0 }, 20);
  assert.equal(sheetDoor.rate, 7.59);
  var thirty = crm.commission({ subtotal: 1000, discount_total: 300, grand_total: 700, amount_paid: 0, balance_due: 700 }, 20);
  assert.deepEqual([thirty.rate, thirty.commission, thirty.ready], [0, 0, false]);
});

test('who may do what', async function () {
  await assert.rejects(crm.overview(alice, {}), /crm.read/);
  await assert.rejects(crm.createLead(andy, { name: 'Zq Nope' }), /crm.manage/);
  assert.ok(await crm.overview(andy, {}));
  var l = await crm.createLead(rep, { name: 'Zq Perm lead' });
  await assert.rejects(crm.setDealStatus(rep, '00000000-0000-0000-0000-000000000000', 'paid'), /crm.commission/);
  await crm.removeLead(rep, l.id);
});

var lead;
test('a lead: added, contacted, followed up, made a customer, won with its sale', async function () {
  lead = await crm.createLead(rep, { name: 'Zq Ama Owusu', phone: '024 000 0111', source: 'Instagram', item: 'Zq sliding door', location: 'Zq Town' });
  assert.match(lead.ref, /^L-\d{4}$/);
  assert.equal(lead.stage, 'new');
  assert.equal(lead.repId, rep.employee.id);                              // the person adding it is its rep
  // a call on a new lead means it has been contacted
  lead = await crm.addNote(rep, lead.id, { kind: 'call', body: 'Zq called, wants a quote', nextFollowUp: daysAgo(1) });
  assert.equal(lead.stage, 'contacted');
  assert.equal(lead.nextFollowUp, daysAgo(1));
  var overdue = await crm.listLeads(rep, { followUp: 'overdue', rep: 'me' });
  assert.deepEqual(overdue.map(function (l) { return l.id; }), [lead.id]);
  lead = await crm.setStage(rep, lead.id, { stage: 'quote_sent', note: 'Zq quote sent' });
  assert.deepEqual(lead.notes.filter(function (n) { return n.kind === 'stage'; }).map(function (n) { return n.toStage; }), ['quote_sent', 'contacted', 'new']);

  // the customer with the same phone already exists: linked, not duplicated
  lead = await crm.toCustomer(rep, lead.id);
  assert.equal(lead.customerId, cust);

  var toLink = await crm.invoicesToLink(rep, { leadId: lead.id });
  assert.equal(toLink.invoices[0].sameCustomer, true);
  assert.equal(toLink.why, null);
  var deal = await crm.linkInvoice(rep, lead.id, { invoiceId: inv.paid });
  assert.equal(deal.value, 950);
  assert.equal(deal.rate, 15);
  assert.equal(deal.commission, 142.5);                                   // the rep sees their own
  assert.equal(deal.ready, true);
  await assert.rejects(crm.linkInvoice(rep, lead.id, { invoiceId: inv.paid }), /already linked/);
  // searching for an invoice that can't be linked says why
  var already = await crm.invoicesToLink(rep, { leadId: lead.id, q: 'zqc-001' });
  assert.deepEqual([already.invoices.length, already.why.reason, already.why.leadRef], [0, 'linked', lead.ref]);
  assert.equal((await crm.invoicesToLink(rep, { q: 'ZQC-NOPE' })).why.reason, 'notFound');
  lead = await crm.getLead(rep, lead.id);
  assert.equal(lead.stage, 'won');
  assert.equal(lead.nextFollowUp, null);
  assert.equal(lead.dealValue, 950);

  // a second deal on it, for the other rep, as a kick-back
  var d2 = await crm.linkInvoice(kelvin, lead.id, { invoiceId: inv.part, kind: 'kickback', repId: rep2.employee.id });
  assert.equal(d2.kind, 'kickback');
  var seenByRep = (await crm.getLead(rep, lead.id)).deals.find(function (d) { return d.id === d2.id; });
  assert.equal(seenByRep.commission, null);                               // someone else's commission is hidden
  assert.equal(seenByRep.ready, false);

  await assert.rejects(crm.removeLead(rep, lead.id), /sale linked/);
  var paid = await crm.setDealStatus(kelvin, deal.id, 'paid');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paidOn, today);
  await assert.rejects(crm.unlinkDeal(rep, deal.id), /already paid/);
  assert.equal((await crm.listDeals(rep, {})).length, 1);                 // a rep lists their own
  assert.equal((await crm.listDeals(kelvin, {})).length, 2);
});

test('a lead with no matching customer becomes a new customer of the CRM\'s company', async function () {
  var l = await crm.createLead(rep, { name: 'Zq Kwesi Newman', company: 'Zqc New Build Ltd', phone: '0209999444', email: 'zq.newbuild@example.com', location: 'Zq Hills', item: 'Zq louvres' });
  l = await crm.toCustomer(rep, l.id);
  var c = (await pool.query('SELECT * FROM customers WHERE id = $1', [l.customerId])).rows[0];
  assert.deepEqual([c.name, c.contact_person, c.phone, c.email, c.address, c.company_id, c.category, c.account_manager_id],
    ['Zqc New Build Ltd', 'Zq Kwesi Newman', '0209999444', 'zq.newbuild@example.com', 'Zq Hills', bpl, 'lead', rep.employee.id]);
  assert.match(c.notes, new RegExp(l.ref));
  assert.equal((await crm.toCustomer(rep, l.id)).customerId, c.id);        // twice does nothing more
  await assert.rejects(crm.toCustomer(andy, l.id), /crm.manage/);
  await crm.removeLead(rep, l.id);
});

test('an invoice with no company counts as Bamboo Products\', as everywhere in the OS', async function () {
  var bplCo = (await pool.query("SELECT id, name, code FROM companies WHERE code = 'BPL'")).rows[0];
  var zqc = { id: bpl, code: 'ZQC' };
  // void, so no report counting invoices while this runs in parallel sees it
  var c0 = (await pool.query("INSERT INTO customers (name) VALUES ('Zqc No Company Customer') RETURNING id")).rows[0].id;
  var i0 = (await pool.query("INSERT INTO invoices (invoice_no, customer_id, status) VALUES ('ZQC-NULL-1', $1, 'void') RETURNING id", [c0])).rows[0].id;
  async function inScope(co) {
    var args = [i0];
    var sql = 'SELECT count(*)::int AS n FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.id = $1 AND ' + crm._invoiceScope(co, function (v) { args.push(v); return '$' + args.length; });
    return (await pool.query(sql, args)).rows[0].n === 1;
  }
  try {
    assert.equal(await inScope(bplCo), true);                              // BPL's: no company at all
    assert.equal(await inScope(zqc), false);                               // not another company's
    await pool.query('UPDATE customers SET company_id = $2 WHERE id = $1', [c0, bpl]);
    assert.equal(await inScope(bplCo), false);                             // its customer is another company's
    assert.equal(await inScope({ id: null }), true);                       // no company chosen at all: everything
  } finally {
    await pool.query('DELETE FROM invoices WHERE id = $1', [i0]);
    await pool.query('DELETE FROM customers WHERE id = $1', [c0]);
  }
});

test('a lost lead keeps its reason; the same phone is flagged as probably the same person', async function () {
  var a = await crm.createLead(rep2, { name: 'Zq Kojo', phone: '0550000222' });
  var b = await crm.createLead(rep2, { name: 'Zq Kojo Mensah', phone: '055 000 0222' });
  var lost = await crm.setStage(rep2, a.id, { stage: 'lost', lostReason: 'Zq went elsewhere' });
  assert.equal(lost.lostReason, 'Zq went elsewhere');
  assert.deepEqual((await crm.getLead(rep2, b.id)).sameContact.map(function (x) { return x.id; }), [a.id]);
});

test('the overview adds up the sales, the pipeline, the team and what needs doing', async function () {
  var o = await crm.overview(kelvin, {});
  assert.equal(o.totals.deals, 2);
  assert.equal(o.totals.revenue, 2950);
  assert.equal(o.totals.cash, 1450);
  assert.equal(o.totals.arrears, 1500);
  assert.equal(o.unlinkedSales.count, 2);                                 // ZQC-003 and ZQC-004 aren't deals
  assert.equal(o.unlinkedSales.total, 1100);
  assert.equal(o.stages.find(function (s) { return s.stage === 'won'; }).count, 1);
  assert.equal(o.stages.find(function (s) { return s.stage === 'lost'; }).count, 1);
  var kofi = o.team.find(function (t) { return t.repId === rep.employee.id; });
  assert.equal(kofi.revenue, 950);
  assert.equal(kofi.commissionPaid, 142.5);
  var esi = o.team.find(function (t) { return t.repId === rep2.employee.id; });
  assert.equal(esi.commissionDue, 400);                                   // the kick-back: 20% of 2,000, not paid yet
  assert.equal(o.commission.waitingCount, 1);                             // the part-paid one waits for its money
  // a rep sees their own commission only
  var repView = await crm.overview(rep, {});
  assert.equal(repView.team.find(function (t) { return t.repId === rep2.employee.id; }).commissionDue, null);
  assert.equal(repView.seeAllCommission, false);
});

test('the contact lists kept before become new leads, once (migration 0132)', async function () {
  var sql = require('fs').readFileSync(require('path').join(__dirname, '../src/db/migrations/0132_crm_lead_prospect_customer.up.sql'), 'utf8');
  var moveLists = sql.slice(0, sql.indexOf('-- 2.'));
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var p = (await client.query("INSERT INTO crm_prospects (list_name, market, company, name, phone, interest, website, notes) VALUES ('Zq Fair 2026', 'export', 'Zq Hotels', 'Zq Yaw', '0200000333', 'Zq louvres', 'zq.example', 'Zq met at stand 4') RETURNING id")).rows[0].id;
    var done = (await client.query("INSERT INTO crm_prospects (list_name, company, name) VALUES ('Zq Fair 2026', '', 'Zq Already') RETURNING id")).rows[0].id;
    await client.query("INSERT INTO crm_leads (name, prospect_id) VALUES ('Zq Already', $1)", [done]);
    await client.query(moveLists);
    var l = (await client.query('SELECT l.*, (SELECT body FROM crm_lead_notes n WHERE n.lead_id = l.id) AS note FROM crm_leads l WHERE prospect_id = $1', [p])).rows;
    assert.equal(l.length, 1);
    assert.deepEqual([l[0].name, l[0].company, l[0].phone, l[0].source, l[0].item, l[0].stage], ['Zq Yaw', 'Zq Hotels', '0200000333', 'Zq Fair 2026', 'Zq louvres', 'new']);
    assert.equal(l[0].comments, 'From the contact list "Zq Fair 2026" (export market). Website: zq.example. Zq met at stand 4');
    assert.equal(l[0].note, 'Moved from the contact lists.');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM crm_leads WHERE prospect_id = $1', [done])).rows[0].n, 1, 'one already a lead is not added again');
    await client.query(moveLists);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM crm_leads WHERE prospect_id = $1', [p])).rows[0].n, 1, 'run again: nothing twice');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('site visits and referrals', async function () {
  var v = await crm.saveVisit(rep, null, { leadId: lead.id, scheduledOn: today, assessorIds: [rep.employee.id, rep2.employee.id], assessorsText: 'Zq Carpenter' });
  assert.equal(v.client, 'Zq Ama Owusu');
  assert.equal(v.assessors.length, 2);
  v = await crm.saveVisit(rep, v.id, { status: 'visited', findings: 'Zq measured 3 doors' });
  assert.equal(v.status, 'visited');
  assert.ok((await crm.getLead(rep, lead.id)).notes.some(function (n) { return n.kind === 'visit' && /measured/.test(n.body); }));

  var r = await crm.saveReferral(rep, null, { referrerName: 'Zq Friend', customerReferred: 'Zq Ama', dealValue: 5000 });
  assert.equal(r.rate, 20);
  assert.equal(r.amount, 1000);
  var linked = await crm.saveReferral(rep, r.id, { invoiceId: inv.paid });
  assert.equal(linked.dealValue, 950);                                    // the invoice's value wins
  await assert.rejects(crm.setReferralStatus(rep, r.id, 'paid'), /crm.commission/);
  assert.equal((await crm.setReferralStatus(kelvin, r.id, 'paid')).status, 'paid');
  await assert.rejects(crm.removeReferral(rep, r.id), /paid referral/);
});

test('settings: rates and sources', async function () {
  await assert.rejects(crm.saveSettings(rep, { commissionRate: 25 }), /crm.commission/);
  var s = await crm.saveSettings(kelvin, { commissionRate: 25, sources: ['Zq Radio', 'WhatsApp', 'Zq Radio'] });
  assert.equal(s.commissionRate, 25);
  assert.deepEqual(s.sources, ['Zq Radio', 'WhatsApp']);
  // a deal keeps the rate it was linked at
  var d = (await crm.listDeals(kelvin, {})).find(function (x) { return x.invoiceNo === 'ZQC-001'; });
  assert.equal(d.baseRate, 20);
  await crm.saveSettings(kelvin, { commissionRate: 20, sources: ['WhatsApp', 'Phone call', 'Walk-in', 'Referral', 'Instagram', 'Facebook', 'TikTok', 'Website', 'Fair or event'] });
});

test('dates, phones and stages as the sheets write them', function () {
  assert.equal(crmImport.parseDate('25-Sep-2026'), '2026-09-25');
  assert.equal(crmImport.parseDate('01-July-2026'), '2026-07-01');
  assert.equal(crmImport.parseDate('9-September-2026'), '2026-09-09');
  assert.equal(crmImport.parseDate('7/16/2026'), '2026-07-16');
  assert.equal(crmImport.parseDate('31-Feb-2026'), null);
  assert.equal(crmImport.phone('542195087'), '0542195087');
  assert.equal(crmImport.phone('instagram'), '');
  assert.equal(crmImport.stageOf('Closed Won'), 'won');
  assert.equal(crmImport.stageOf('Follow-Up'), 'follow_up');
  assert.equal(crmImport.stageOf('Quote Sent'), 'quote_sent');
});

async function workbook() {
  var wb = new ExcelJS.Workbook();
  var dash = wb.addWorksheet('Dash-Board');
  dash.addRow(['Zq Weekly Report Review']);
  var leads = wb.addWorksheet('Leads');
  leads.addRow(['Date', 'Lead ID', 'Customer Name', 'Location', 'Phone', 'Product Interest', 'Custom Project/Item ', 'Status', 'Next Follow-Up', 'Sales rep', 'Comments']);
  leads.addRow([]);
  leads.addRow(['25-Sep-2026', 'ZQ38', 'Zq Etta', '', 'Tiktok', '', 'Zq louver', 'New Lead', '', '', '']);
  leads.addRow(['24-Sep-2026', 'ZQ39', 'Zq Kwame', 'Zq Tema', '559000444', 'Door', 'Zq sliding door', 'Follow-Up', '30-Sep-2026', 'Zq Kofi', 'Zq wants two']);
  leads.addRow(['24-Sep-2026', 'ZQ40', 'Zq Abena', '', '0559000555', 'Custom', 'Zq bed', 'Closed Lost', '', 'Nobody Zq', '']);
  var buys = wb.addWorksheet('Purchases');
  buys.addRow(['Customer Name', 'Location', 'Phone Number', 'Source', 'Product Purchased', 'Custom Project/Item', 'Purchase Date', 'Month', 'Original Price', 'Discount in %', 'Discount in Amount', 'Value (GHS)', 'Amount Paid', 'Balance', 'Repeat Customer', 'Sales Representative', 'Core Team', 'Commission Payable', 'Commission After Discount', 'Actual Commission', 'Kick back applied']);
  buys.addRow(['Zqc Crafts', 'Zq Town', '', 'WhatsApp', 'Custom', 'Zq table', new Date(today + 'T00:00:00Z'), 9, '1000.00', '30%', '300', '700.00', '700', '0', 'No', 'Mr. Zq Kofi', 'Zq Team', '0.00', '0%', '20%', 'TRUE']);
  buys.addRow(['Zq Unknown Buyer', 'Zq Town', '', 'Walk-in', 'Board', '', '01-July-2026', 7, '250.00', '0%', '0', '250.00', '250', '0', 'No', 'Zq Esi', '', '', '', '', 'FALSE']);
  // the same buyer again (a second sale), and a buyer already on the Leads tab
  buys.addRow(['Zq Unknown Buyer', 'Zq Town', '', 'Walk-in', 'Board', '', '09-July-2026', 7, '300.00', '0%', '0', '300.00', '300', '0', 'Yes', 'Zq Esi', '', '', '', '', 'FALSE']);
  buys.addRow(['Mr. Zq Kwame', 'Zq Tema', '0559000444', 'Phone Call', 'Door', 'Zq sliding door', '26-Sep-2026', 9, '2000', '0%', '0', '2000', '2000', '0', 'No', 'Zq Kofi', '', '400', '20%', '20%', 'FALSE']);
  // the sheet's other tabs, which aren't imported: Kick back repeats Purchases rows
  var kick = wb.addWorksheet('Kick back');
  kick.addRow(['Purchase Date', 'Customer Name', 'Source', 'Custom Project/Item', 'Original Price', 'Discount in %', 'Discount in Amount', 'Value (GHS)', 'Amount Paid', 'Balance', 'Sales Representative', 'Kick back rate', 'Kick back rate payable', 'Kick back amount', 'For Co.']);
  kick.addRow([new Date(today + 'T00:00:00Z'), 'Zqc Crafts', 'WhatsApp', 'Zq table', '1000', '30%', '300', '700', '700', '0', 'Zq Kofi', '20%', '0%', '0', '700']);
  var quote = wb.addWorksheet('Quotation');
  quote.addRow(['Quote No.', 'Customer', 'Location', 'Product', 'Custom Project/Item', 'Amount (GHS)', 'Status', 'Date Sent ']);
  quote.addRow(['ZQ13', 'Zq Quote Person', 'Zq Town', 'Custom', 'Zq stool', '', 'Approved', '16-July-2026']);
  var summary = wb.addWorksheet('Summary');
  summary.addRow(['Month', 'Total Leads', 'Closed Won Deals', 'Sales Revenue Received (GHS)', 'Revenue In Arears(GHS)', 'Total Revenue (GHS)', 'Comments']);
  summary.addRow(['July', 21, 11, 1000, 0, 1000, '']);
  var data = wb.addWorksheet('Data');
  data.addRow(['Items', 'Source', 'Leads', 'Commision', 'Sales rep', 'Repeat Customer', 'Quotation', 'Month', 'Site Visit Status']);
  data.addRow(['Board', 'WhatsApp', 'New Lead', 'Paid', 'Zq Kofi', 'Yes', 'Draft', 'January', 'Visited']);
  var visits = wb.addWorksheet('Site Visits');
  visits.addRow(['Client ', 'Location ', 'Scheduled Date for Visit', 'Status', 'Site Assessors –']);
  visits.addRow(['Zq Kwame', 'Zq Tema', '10-July-2026', 'Visited', 'Zq Kofi & Zq Carpenter']);
  visits.addRow(['Zq Later', 'Zq Hills', '15-August-2026', '', 'Zq Esi, Zq Kofi']);
  var ref = wb.addWorksheet('Referral');
  ref.addRow(['Referrer', 'Phone Number ', 'Location', 'Customer Referred', 'Deal Value (GHS)', 'Commission(20 %)', 'Commission Due', 'Status']);
  ref.addRow(['', '', '', '', '', '', '0', '']);
  ref.addRow(['Zq Referrer', '244000666', 'Zq Town', 'Zq Kwame', '3000', '600', '600', 'Pending']);
  var db = wb.addWorksheet('Data Base');
  db.addRow(['Fair/Event', 'Market', 'Company', 'Prospect Name', 'Contact', 'Website', 'Email', 'Interest', 'Notes', 'Others']);
  db.addRow(['Zq Fair 2025', 'Local', 'n/a', 'Zq Isaac', '542000777', '', '', '', 'Zq Isaac | side bed drawer', '']);
  db.addRow(['Furniture', 'Local', 'n/a', '', '', '', '', '', 'Company Name | Main Country | Website', '']);
  db.addRow(['Furniture', 'Local', 'Zq Deco Ltd', 'Zq Deco Ltd', '', '', 'sales@zqdeco.example', '', '', '']);
  db.addRow(['Real Estate', 'Export', 'Zq Estates', 'Zq Estates', '2024-06-25', '', '', '', '', '']);
  return { originalname: 'zq-crm.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

test('the spreadsheet import: preview, import, and again adds nothing', async function () {
  var file = await workbook();
  await assert.rejects(crmImport.preview(andy, file), /crm.manage/);
  var pv = await crmImport.preview(rep, file);
  assert.deepEqual(pv.tabs.map(function (t) { return t.kind; }), ['leads', 'purchases', 'visits', 'referrals', 'prospects']);
  assert.deepEqual([pv.leads.new, pv.sales.new, pv.visits.new, pv.referrals.new, pv.prospects.new], [3, 4, 2, 1, 3]);
  assert.equal(pv.salesJoiningLeads, 2);                                  // Zq Kwame's, and the second Unknown Buyer sale
  assert.deepEqual(pv.stages, { new: 1, follow_up: 1, lost: 1 });
  assert.deepEqual(pv.unknownPeople, ['Nobody Zq', 'Zq Carpenter']);

  var r = await crmImport.run(rep, file);
  assert.deepEqual([r.leads, r.sales, r.joined, r.linked, r.visits, r.referrals, r.prospects], [3, 4, 2, 1, 2, 1, 3]);
  assert.deepEqual(r.unlinkedSales.map(function (x) { return x.name; }), ['Zq Unknown Buyer', 'Zq Unknown Buyer', 'Mr. Zq Kwame']);   // each sale with no OS invoice yet
  // nobody is counted twice: one lead per buyer
  assert.equal((await crm.listLeads(rep, { q: 'Zq Unknown Buyer', stage: 'all' })).length, 1);
  assert.equal((await crm.listLeads(rep, { q: 'Zq Kwame', stage: 'all' })).length, 1);

  var etta = (await crm.listLeads(rep, { q: 'Zq Etta', stage: 'all' }))[0];
  assert.equal(etta.source, 'TikTok');                                    // the "phone" said TikTok
  assert.equal(etta.phone, '');
  var kwame = (await crm.listLeads(rep, { q: 'Zq Kwame', stage: 'all' }))[0];
  // on the Leads tab as Follow-Up, and in Purchases: won, with no follow-up left
  assert.deepEqual([kwame.phone, kwame.stage, kwame.nextFollowUp, kwame.repId, kwame.sheetRef, kwame.item], ['0559000444', 'won', null, rep.employee.id, 'ZQ39', 'Door — Zq sliding door']);
  assert.match(kwame.comments, /Zq wants two/);
  assert.match(kwame.comments, /GHS 2000\.00.*no matching OS invoice/);
  var abena = (await crm.listLeads(rep, { q: 'Zq Abena', stage: 'all' }))[0];
  assert.equal(abena.repName, 'Nobody Zq');                               // not in the OS: kept as a name
  // the sale that matched ZQC-003 (700 after 30% off, today, "Zqc Crafts") is a won deal, as a kick-back
  var deal = (await crm.listDeals(kelvin, {})).find(function (d) { return d.invoiceNo === 'ZQC-003'; });
  assert.equal(deal.kind, 'kickback');
  assert.equal(deal.coreTeam, 'Zq Team');
  assert.equal(deal.status, 'pending');
  var buyer = (await crm.listLeads(rep, { q: 'Zq Unknown Buyer', stage: 'all' }))[0];
  assert.equal(buyer.stage, 'won');
  assert.match(buyer.comments, /no matching OS invoice/);
  var visits = await crm.listVisits(rep, {});
  var kv = visits.find(function (v) { return v.client === 'Zq Kwame'; });
  assert.equal(kv.status, 'visited');
  assert.equal(kv.leadId, kwame.id);
  assert.deepEqual(kv.assessors.map(function (a) { return a.id; }), [rep.employee.id]);
  assert.equal(kv.assessorsText, 'Zq Carpenter');
  // The contact lists ("Data Base") come in as new leads, the list as their source.
  var isaac = (await crm.listLeads(rep, { q: 'Zq Isaac', stage: 'all' }))[0];
  assert.deepEqual([isaac.stage, isaac.phase, isaac.source, isaac.phone, isaac.company], ['new', 'lead', 'Zq Fair 2025', '0542000777', '']);
  assert.match(isaac.comments, /^From the contact list "Zq Fair 2025"\. Zq Isaac \| side bed drawer$/);
  var est = (await crm.listLeads(rep, { q: 'Zq Estates', stage: 'all' }))[0];
  assert.equal(est.phone, '');
  assert.match(est.comments, /\(export market\)/);

  var again = await crmImport.run(rep, file);
  assert.deepEqual([again.leads, again.sales, again.visits, again.referrals, again.prospects], [0, 0, 0, 0, 0]);
  assert.deepEqual(again.skipped, { leads: 3, sales: 4, visits: 2, referrals: 1, prospects: 3 });
  assert.equal((await crm.listLeads(rep, { q: 'Zq Kwame', stage: 'all' }))[0].comments.match(/no matching OS invoice/g).length, 1);

  await assert.rejects(crmImport.run(rep, { originalname: 'x.xlsx', buffer: Buffer.from('not a workbook') }), /couldn’t be read/);
});

test('who is this: a spreadsheet name is linked to staff once, everywhere, and remembered for the next import', async function () {
  var names = await crm.unmatchedNames(rep);
  var nobody = names.find(function (n) { return n.name.toLowerCase() === 'nobody zq'; });
  var carpenter = names.find(function (n) { return n.name === 'Zq Carpenter'; });
  assert.deepEqual([nobody.leads, carpenter.visits], [1, 2]);            // Zq Carpenter: the imported visit and the one booked earlier
  await assert.rejects(crm.assignName(andy, { name: 'Nobody Zq', employeeId: rep2.employee.id }), /crm.manage/);
  await assert.rejects(crm.assignName(rep, { name: 'Nobody Zq', employeeId: '00000000-0000-0000-0000-000000000000' }), /Choose the staff member/);

  var r = await crm.assignName(rep, { name: '  NOBODY   zq ', employeeId: rep2.employee.id });   // any capitals and spacing
  assert.deepEqual([r.leads, r.deals, r.visits], [1, 0, 0]);
  var abena = (await crm.listLeads(rep, { q: 'Zq Abena', stage: 'all' }))[0];
  assert.deepEqual([abena.repId, abena.repName], [rep2.employee.id, 'Zq Esi Zqrep']);

  var v = await crm.assignName(rep, { name: 'Zq Carpenter', employeeId: rep2.employee.id });
  assert.equal(v.visits, 2);
  var visit = (await crm.listVisits(rep, {})).find(function (x) { return x.client === 'Zq Kwame'; });
  assert.deepEqual(visit.assessors.map(function (a) { return a.id; }).sort(), [rep.employee.id, rep2.employee.id].sort());
  assert.equal(visit.assessorsText, '');
  var left = (await crm.unmatchedNames(rep)).map(function (n) { return n.name.toLowerCase(); });
  assert.equal(left.indexOf('nobody zq'), -1);
  assert.equal(left.indexOf('zq carpenter'), -1);

  // the next spreadsheet with the same name matches straight away
  var wb = new ExcelJS.Workbook();
  var leads = wb.addWorksheet('Leads');
  leads.addRow(['Date', 'Lead ID', 'Customer Name', 'Location', 'Phone', 'Product Interest', 'Custom Project/Item ', 'Status', 'Next Follow-Up', 'Sales rep', 'Comments']);
  leads.addRow(['27-Sep-2026', 'ZQ90', 'Zq Later Lead', '', '0559000999', '', 'Zq shelf', 'New Lead', '', 'Nobody Zq', '']);
  var file = { originalname: 'zq-next.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  assert.deepEqual((await crmImport.preview(rep, file)).unknownPeople, []);
  await crmImport.run(rep, file);
  assert.equal((await crm.listLeads(rep, { q: 'Zq Later Lead', stage: 'all' }))[0].repId, rep2.employee.id);
});

test('Lead → Prospect → Customer: qualified or quoted makes a prospect; the first payment, a customer', async function () {
  // A lead, with a profile so it can be quoted: both say Lead.
  var a = await crm.createLead(rep, { name: 'Zq Phase Ama', phone: '0209990001', item: 'Zq stools' });
  assert.equal(a.phase, 'lead');
  a = await crm.toCustomer(kelvin, a.id);
  var cat = async function (id) { return (await pool.query('SELECT category FROM customers WHERE id = $1', [id])).rows[0].category; };
  assert.equal(await cat(a.customerId), 'lead');
  assert.ok((await crm.listLeads(rep, { phase: 'lead' })).some(function (l) { return l.id === a.id; }));
  assert.ok(!(await crm.listLeads(rep, { phase: 'prospect' })).some(function (l) { return l.id === a.id; }));

  // Qualified: a prospect, and the profile says so.
  a = await crm.setStage(rep, a.id, { stage: 'qualified' });
  assert.equal(a.phase, 'prospect');
  assert.equal(await cat(a.customerId), 'prospect');

  // Another lead: sending them a quotation makes them a prospect at Quote sent.
  var b = await crm.toCustomer(kelvin, (await crm.createLead(rep, { name: 'Zq Phase Kojo', phone: '0209990002' })).id);
  await pool.query("INSERT INTO quotations (quote_no, customer_id, grand_total, status, created_by) VALUES ('ZQC-Q-9', $1, 800, 'draft', $2)", [b.customerId, kelvin.employee.id]);
  assert.equal((await crm.getLead(rep, b.id)).stage, 'new', 'a draft changes nothing');
  await pool.query("UPDATE quotations SET status = 'sent', sent_at = now() WHERE quote_no = 'ZQC-Q-9'");
  b = await crm.getLead(rep, b.id);
  assert.deepEqual([b.stage, b.phase], ['quote_sent', 'prospect']);
  assert.equal(b.notes[0].body, 'Quotation ZQC-Q-9 sent.');
  assert.equal(await cat(b.customerId), 'prospect');

  // Won without the money yet: still with the prospects, waiting for payment.
  b = await crm.setStage(rep, b.id, { stage: 'won' });
  assert.deepEqual([b.phase, b.paid], ['won', false]);
  // Won by hand from a lead's stage: their profile says Prospect until they pay.
  var c = await crm.toCustomer(kelvin, (await crm.createLead(rep, { name: 'Zq Phase Esi', phone: '0209990003' })).id);
  await crm.setStage(rep, c.id, { stage: 'won' });
  assert.equal(await cat(c.customerId), 'prospect');
  assert.ok((await crm.listLeads(rep, { phase: 'prospect' })).some(function (l) { return l.id === b.id; }));

  // The first payment on a sale: Ama is a customer, and her lead is won.
  var saleFor = async function (customerId, no) {
    return (await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, company_id, doc_kind) VALUES ($1,$2,300,0,0,300,0,300,'unpaid',CURRENT_DATE,$3,'sale') RETURNING id", [no, customerId, bpl])).rows[0].id;
  };
  var pay = function (invoiceId, customerId, amount) {
    return pool.query("INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, received_by) VALUES ($1,$2,CURRENT_DATE,$3,'GHS','cash',$4)", [invoiceId, customerId, amount, kelvin.employee.id]);
  };
  var ia = await saleFor(a.customerId, 'ZQC-P1');
  await pay(ia, a.customerId, 100);
  a = await crm.getLead(rep, a.id);
  assert.deepEqual([a.stage, a.paid, a.phase], ['won', true, 'customer']);
  assert.equal(a.notes[0].body, 'Paid ZQC-P1 — now a customer.');
  assert.equal(await cat(a.customerId), 'active');
  assert.ok((await crm.listLeads(rep, { phase: 'customer' })).some(function (l) { return l.id === a.id; }));
  assert.ok(!(await crm.listLeads(rep, { phase: 'prospect' })).some(function (l) { return l.id === a.id; }));

  // Kojo pays too: from won to customer.
  await pay(await saleFor(b.customerId, 'ZQC-P2'), b.customerId, 300);
  assert.equal((await crm.getLead(rep, b.id)).phase, 'customer');
  assert.equal(await cat(b.customerId), 'active');

  // A refund (a negative payment) changes nothing back; a VIP stays a VIP.
  await pool.query("UPDATE customers SET category = 'vip' WHERE id = $1", [a.customerId]);
  await pay(ia, a.customerId, 50);
  assert.equal(await cat(a.customerId), 'vip');

  // The overview and the CEO's figures count them by phase.
  var o = await crm.overview(kelvin, {});
  assert.ok(o.phases.customer >= 2);
  assert.equal(o.phases.lead + o.phases.prospect + o.phases.won + o.phases.customer + o.phases.lost, o.totalLeads);
  var x = await require('../src/services/crmExecutive.service').summary(kelvin, {});
  assert.ok(x.now.leadsCustomers >= 2);
  assert.ok(x.now.leadsProspects >= x.now.leadsWon);
  await assert.rejects(crm.listLeads(rep, { phase: 'nope' }), /Phase is not a valid option/);
});

test('the sales board: three lanes ranked by what needs the rep, and points for what they did', async function () {
  var ama = await repUser('ZQC-REP3', 'Zq Ama', 'zqc.rep3@example.com');
  var yaw = await repUser('ZQC-REP4', 'Zq Yaw', 'zqc.rep4@example.com');
  var me = ama.employee.id;
  var inDays = function (n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  // Everything in the test's own company (the CRM's while this file runs),
  // each with its own number, so other files' customer lists never see them.
  var phone = 0;
  var lead = async function (name, stage, extra) {
    extra = extra || {};
    return (await pool.query(
      'INSERT INTO crm_leads (ref, name, phone, stage, rep_id, next_follow_up, customer_id, received_on, created_at, source) ' +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), now() - make_interval(hours => $9), $10) RETURNING id",
      ['ZQB-' + name.slice(-3), name, '02099910' + String(++phone).padStart(2, '0'), stage, extra.rep || me, extra.followUp || null, extra.customer || null, extra.received || null, extra.hoursAgo || 0, extra.source || ''])).rows[0].id;
  };
  var customer = async function (name, category, extra) {
    extra = extra || {};
    return (await pool.query(
      "INSERT INTO customers (name, phone, category, status, account_manager_id, follow_up_on, last_contact_at, company_id) VALUES ($1, $2, $3, 'active', $4, $5, $6, $7) RETURNING id",
      [name, '02099920' + String(++phone).padStart(2, '0'), category, extra.rep || me, extra.followUp || null, extra.lastContact || null, bpl])).rows[0].id;
  };
  var conversation = async function (key, customerId, direction, hoursAgo) {
    return (await pool.query(
      "INSERT INTO crm_conversations (company_id, channel, external_thread_id, customer_id, status, last_direction, last_message_at, last_preview) VALUES ($1, 'whatsapp', $2, $3, 'open', $4, now() - make_interval(hours => $5), 'Zq is the price still the same?') RETURNING id",
      [bpl, 'zqb-' + key, customerId, direction, hoursAgo])).rows[0].id;
  };

  // Leads: one nobody has called (a day and more), one whose follow-up was two days ago.
  var untouched = await lead('Zqb Lead New', 'new', { received: daysAgo(3), hoursAgo: 30 });
  var overdue = await lead('Zqb Lead Due', 'follow_up', { followUp: daysAgo(2) });
  // Prospects: talking price with a large quotation running out in two days;
  // won but not paid; one on track with its next call planned.
  var quoted = (await pool.query("INSERT INTO customers (name, phone, company_id) VALUES ('Zqc Board Quoted', '0209993001', $1) RETURNING id", [bpl])).rows[0].id;
  await pool.query("INSERT INTO quotations (quote_no, customer_id, grand_total, status, created_by, sent_at, valid_until) VALUES ('ZQB-Q-1', $1, 20000, 'sent', $2, now(), $3)", [quoted, me, inDays(2)]);
  var talking = await lead('Zqb Lead Neg', 'negotiation', { customer: quoted });
  var wonUnpaid = await lead('Zqb Lead Won', 'won');
  var onTrack = await lead('Zqb Lead Qua', 'qualified', { followUp: inDays(5) });
  await lead('Zqb Lead Yaw', 'new', { rep: yaw.employee.id });
  await lead('Zqb Lead Los', 'lost');
  // Customers: one waiting for an answer with an invoice ten days overdue; a
  // VIP nobody has spoken to for two months; one to call today.
  var owing = await customer('Zqb Owing', 'active');
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, company_id) VALUES ('ZQB-I-1', $1, 5000, 0, 0, 5000, 0, 5000, 'unpaid', $2, $3, $4)", [owing, daysAgo(40), daysAgo(10), bpl]);
  var waitingConv = await conversation('owing', owing, 'in', 5);
  var quiet = await customer('Zqb Quiet', 'vip', { lastContact: new Date(Date.now() - 60 * 86400000) });
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, company_id) VALUES ('ZQB-I-2', $1, 1200, 0, 0, 1200, 1200, 0, 'paid', $2, $2, $3)", [quiet, daysAgo(60), bpl]);
  // A profile that wrote in on WhatsApp, with no lead behind it: a lead card.
  var enquiry = await customer('Zqb Enquiry', 'lead');
  await conversation('enquiry', enquiry, 'in', 3);
  var callToday = await customer('Zqb Today', 'active', { followUp: today });
  var answered = await conversation('today', callToday, 'out', 0);
  await customer('Zqb Yaws', 'active', { rep: yaw.employee.id });

  // What Ama did: three days in a row over the daily goal of 60 points.
  var note = function (leadId, kind, from, to, when) {
    return pool.query('INSERT INTO crm_lead_notes (lead_id, kind, body, from_stage, to_stage, by_employee, at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [leadId, kind, 'Zq ' + kind, from || null, to || null, me, when || new Date()]);
  };
  await note(onTrack, 'call');                                  // 10
  await note(onTrack, 'note');                                  // 5
  await note(onTrack, 'stage', 'new', 'contacted');             // 10
  await note(onTrack, 'stage', 'contacted', 'qualified');       // 25, a prospect
  await note(wonUnpaid, 'stage', 'negotiation', 'won');         // 100, a win
  await pool.query("INSERT INTO crm_messages (conversation_id, direction, body, sent_at, sent_by) VALUES ($1, 'out', 'Zq yes it is', now(), $2)", [answered, me]);   // 8, and the quotation 30
  for (var back = 1; back <= 2; back++) {
    var then = new Date(Date.now() - back * 86400000);
    for (var k = 0; k < 6; k++) await note(onTrack, 'call', null, null, then);   // 60 a day
  }
  await pool.query('INSERT INTO crm_lead_notes (lead_id, kind, body, by_employee) VALUES ($1, $2, $3, $4)', [overdue, 'call', 'Zq Yaw called', yaw.employee.id]);
  await pool.query("UPDATE crm_lead_notes SET at = now() - interval '20 days' WHERE lead_id = $1", [overdue]);   // Yaw's call was long ago

  var b = await crmBoard.board(ama, {});
  var keys = function (lane) { return b.lanes[lane].map(function (c) { return c.name; }); };
  var cardOf = function (name) { return ['lead', 'prospect', 'customer'].map(function (l) { return b.lanes[l]; }).flat().find(function (c) { return c.name === name; }); };
  var types = function (name) { return cardOf(name).signals.map(function (s) { return s.type; }); };

  // Three lanes, Ama's only, the most urgent first.
  assert.deepEqual(keys('lead'), ['Zqb Enquiry', 'Zqb Lead New', 'Zqb Lead Due']);
  assert.deepEqual(keys('prospect'), ['Zqb Lead Neg', 'Zqb Lead Won', 'Zqb Lead Qua']);
  assert.deepEqual(keys('customer'), ['Zqb Owing', 'Zqb Quiet', 'Zqb Today']);
  assert.deepEqual(b.lanes.prospect.map(function (c) { return c.rank; }), [1, 2, 3]);
  assert.equal(b.rep.id, me);

  // Why each card is where it is, and what to do next.
  var c = cardOf('Zqb Lead New');
  assert.deepEqual([c.score, c.level, c.next, types(c.name)], [35, 'warm', 'call', ['untouched']]);
  c = cardOf('Zqb Enquiry');
  assert.deepEqual([c.kind, c.lane, c.score, c.level, c.next, types(c.name)], ['customer', 'lead', 45, 'warm', 'reply', ['waiting']]);
  c = cardOf('Zqb Lead Due');
  assert.deepEqual([c.score, c.level, c.next, c.signals[0].days], [31, 'warm', 'call', 2]);
  assert.deepEqual(types(c.name), ['followup_overdue']);
  c = cardOf('Zqb Lead Neg');
  assert.deepEqual(types(c.name), ['quote_expiring', 'negotiation', 'big_deal', 'no_next_step']);
  assert.deepEqual([c.score, c.level, c.next, c.value, c.signals[0].ref], [62, 'hot', 'chase_quote', 20000, 'ZQB-Q-1']);
  c = cardOf('Zqb Lead Won');
  assert.deepEqual([c.score, c.level, c.next, types(c.name)], [30, 'warm', 'collect', ['won_unpaid']]);
  c = cardOf('Zqb Lead Qua');
  assert.deepEqual([c.score, c.level, c.signals.length, !!c.lastNote], [0, 'cool', 0, true]);
  c = cardOf('Zqb Owing');
  assert.deepEqual(types(c.name), ['waiting', 'overdue_invoice']);
  assert.deepEqual([c.score, c.level, c.next, c.signals[0].conversationId, c.signals[1].days, c.signals[1].amount], [77, 'hot', 'reply', waitingConv, 10, 5000]);
  c = cardOf('Zqb Quiet');
  assert.deepEqual(types(c.name), ['quiet', 'vip']);
  assert.deepEqual([c.score, c.level, c.next, c.signals[0].days, c.value], [28, 'warm', 'check_in', 60, 1200]);
  c = cardOf('Zqb Today');
  assert.deepEqual([c.score, c.level, c.next, types(c.name)], [22, 'cool', 'call', ['followup_today']]);

  // The three to do first, from any lane; each lane's count, heat and pipeline.
  assert.deepEqual(b.focus.map(function (x) { return x.name; }), ['Zqb Owing', 'Zqb Lead Neg', 'Zqb Enquiry']);
  assert.deepEqual(b.counts.prospect, { total: 3, hot: 1, warm: 1, value: 20000 });
  assert.deepEqual(b.counts.customer, { total: 3, hot: 1, warm: 1, value: 0 });

  // Points: 188 today (call, note, contacted, prospect, win, reply, quotation),
  // 60 the two days before, so a streak of three and the bronze level.
  var p = b.progress;
  assert.equal(p.goal, 60);
  assert.equal(p.today, 188);
  assert.deepEqual(p.todayDone, { calls: 1, replies: 1, notes: 1, moves: 2, quotes: 1, wins: 1 });
  assert.equal(p.streak, 3);
  assert.equal(p.month, 308);
  assert.deepEqual(p.level, { key: 'bronze', from: 300, next: { key: 'silver', at: 800 } });
  assert.deepEqual(p.days.slice(-3).map(function (d) { return d.points; }), [60, 60, 188]);
  assert.equal(p.weekWins, 1);
  assert.ok(p.weekDone.prospects >= 1 && p.weekDone.wins === 1 && p.weekDone.calls >= 1 && p.weekDone.quotes === 1);
  assert.ok(p.week >= 188);
  assert.deepEqual(p.badges.map(function (x) { return x.key; }), ['closer', 'streak']);
  var mine = p.leaderboard.find(function (x) { return x.id === me; });
  assert.ok(p.rank >= 1 && p.of >= 1);
  if (mine) assert.equal(mine.wins, 1);

  // A rep sees only their own board; a manager picks a rep, or everyone.
  await assert.rejects(crmBoard.board(ama, { rep: 'all' }), /crm\.assign/);
  await assert.rejects(crmBoard.board(ama, { rep: yaw.employee.id }), /crm\.assign/);
  var asManager = await crmBoard.board(kelvin, { rep: me });
  assert.deepEqual(asManager.lanes.customer.map(function (x) { return x.name; }), keys('customer'));
  assert.equal(asManager.progress.today, 188);
  assert.ok(asManager.canAssign);
  assert.ok(asManager.reps.some(function (r) { return r.id === me; }) && asManager.reps.some(function (r) { return r.id === yaw.employee.id; }));
  var everyone = await crmBoard.board(kelvin, { rep: 'all' });
  var names = ['lead', 'prospect', 'customer'].map(function (l) { return everyone.lanes[l]; }).flat().map(function (x) { return x.name; });
  ['Zqb Lead New', 'Zqb Lead Yaw', 'Zqb Owing', 'Zqb Yaws'].forEach(function (n) { assert.ok(names.indexOf(n) >= 0, n); });
  assert.ok(names.indexOf('Zqb Lead Los') < 0);
  assert.equal(everyone.rep, null);
  await assert.rejects(crmBoard.board(kelvin, { rep: '00000000-0000-0000-0000-000000000000' }), /not found/);

  // A lead made for the profile takes its place: one card, not two.
  await lead('Zqb Lead Enq', 'contacted', { customer: enquiry, followUp: inDays(1) });
  b = await crmBoard.board(ama, {});
  assert.deepEqual(keys('lead'), ['Zqb Lead Enq', 'Zqb Lead New', 'Zqb Lead Due']);
  assert.deepEqual(types('Zqb Lead Enq'), ['waiting']);

  // Once the money comes in, the won deal leaves the prospects.
  var paidCust = await customer('Zqb Paid', 'prospect');
  await pool.query('UPDATE crm_leads SET customer_id = $1 WHERE id = $2', [paidCust, wonUnpaid]);
  var sale = (await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, company_id, doc_kind) VALUES ('ZQB-I-3', $1, 300, 0, 0, 300, 0, 300, 'unpaid', CURRENT_DATE, $2, 'sale') RETURNING id", [paidCust, bpl])).rows[0].id;
  await pool.query("INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, received_by) VALUES ($1, $2, CURRENT_DATE, 300, 'GHS', 'cash', $3)", [sale, paidCust, me]);
  b = await crmBoard.board(ama, {});
  assert.deepEqual(keys('prospect'), ['Zqb Lead Neg', 'Zqb Lead Qua']);
  assert.ok(keys('customer').indexOf('Zqb Paid') >= 0, 'paid: a customer now');
  void untouched; void talking; void quiet;
});
