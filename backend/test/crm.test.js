// The CRM (migration 0102, services/crm.service.js and crmImport.service.js):
// who may see and do what; a lead from first message to a won sale with its
// history; a sale is an OS invoice and the commission is the base rate
// minus the discount given; the overview adds it all up; prospects become
// leads; site visits and referrals; and the spreadsheet import, run twice.
// Test data: ZQC codes and "Zq" names, all removed afterwards.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var bcrypt = require('bcrypt');
var { pool } = require('../src/db/pool');
var crm = require('../src/services/crm.service');
var crmImport = require('../src/services/crmImport.service');
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
    await pool.query('DELETE FROM invoices WHERE company_id = $1', [co.id]);
    await pool.query('DELETE FROM customers WHERE company_id = $1', [co.id]);
    await pool.query('UPDATE crm_settings SET company_id = NULL WHERE company_id = $1', [co.id]);
    await pool.query('DELETE FROM companies WHERE id = $1', [co.id]);
  }
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

test.before(async function () {
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
test.after(async function () { await cleanup(); await pool.end(); });

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
  assert.equal(toLink[0].sameCustomer, true);
  var deal = await crm.linkInvoice(rep, lead.id, { invoiceId: inv.paid });
  assert.equal(deal.value, 950);
  assert.equal(deal.rate, 15);
  assert.equal(deal.commission, 142.5);                                   // the rep sees their own
  assert.equal(deal.ready, true);
  await assert.rejects(crm.linkInvoice(rep, lead.id, { invoiceId: inv.paid }), /already linked/);
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

test('prospects become leads once, keeping where they came from', async function () {
  var p = await crm.saveProspect(rep, null, { listName: 'Zq Fair 2026', company: 'Zq Hotels', name: 'Zq Yaw', phone: '0200000333', interest: 'Zq louvres' });
  var list = await crm.listProspects(rep, {});
  assert.equal(list.lists.find(function (l) { return l.listName === 'Zq Fair 2026'; }).count, 1);
  var l = await crm.prospectToLead(rep, p.id, {});
  assert.equal(l.prospectId, p.id);
  assert.equal(l.company, 'Zq Hotels');
  assert.match(l.comments, /Zq Fair 2026/);
  await assert.rejects(crm.prospectToLead(rep, p.id, {}), /already lead/);
  assert.equal((await crm.listProspects(rep, {})).lists[0].converted, 1);
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
  var pr = await crm.listProspects(rep, { list: 'Zq Fair 2025' });
  assert.equal(pr.prospects[0].phone, '0542000777');
  assert.equal(pr.prospects[0].company, '');
  var est = (await crm.listProspects(rep, { q: 'Zq Estates' })).prospects[0];
  assert.deepEqual([est.market, est.phone], ['export', '']);

  var again = await crmImport.run(rep, file);
  assert.deepEqual([again.leads, again.sales, again.visits, again.referrals, again.prospects], [0, 0, 0, 0, 0]);
  assert.deepEqual(again.skipped, { leads: 3, sales: 4, visits: 2, referrals: 1, prospects: 3 });
  assert.equal((await crm.listLeads(rep, { q: 'Zq Kwame', stage: 'all' }))[0].comments.match(/no matching OS invoice/g).length, 1);

  await assert.rejects(crmImport.run(rep, { originalname: 'x.xlsx', buffer: Buffer.from('not a workbook') }), /couldn’t be read/);
});
