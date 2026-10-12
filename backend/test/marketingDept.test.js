/*
 * The marketing department (mk*.service.js): campaigns with their results
 * worked out from the OS (leads by tracking code or credit, their sales,
 * spend, cost per lead, return), the budget and spend, requests from the
 * rest of the company, events with their checklist, promotions and their
 * uses, the brand kit, the market, audiences, the home page and the
 * calendar. Everything is named ZMK and removed afterwards; the budget
 * uses 2031, which nothing else touches.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var campaigns = require('../src/services/mkCampaigns.service');
var budget = require('../src/services/mkBudget.service');
var requests = require('../src/services/mkRequests.service');
var events = require('../src/services/mkEvents.service');
var brand = require('../src/services/mkBrand.service');
var audiences = require('../src/services/mkAudiences.service');
var home = require('../src/services/mkHome.service');
var marketing = require('../src/services/marketing.service');

var boss, staff, bpl;
function day(n) { var d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }

async function cleanup() {
  var cust = "(SELECT id FROM customers WHERE name LIKE 'ZMK%')";
  await pool.query('DELETE FROM invoices WHERE customer_id IN ' + cust);
  await pool.query("DELETE FROM crm_leads WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_posts WHERE title LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_spend WHERE description LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_events WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_promotions WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_campaigns WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_assets WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_competitors WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_intel WHERE body LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_audiences WHERE name LIKE 'ZMK%'");
  await pool.query("DELETE FROM marketing_budgets WHERE year = 2031");
  await pool.query("DELETE FROM notifications WHERE link LIKE '/mkrequests%'");
  await pool.query("DELETE FROM customers WHERE name LIKE 'ZMK%'");
}

test.before(async function () {
  await cleanup();
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  bpl = (await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0].id;
});
test.after(async function () { await cleanup(); });

test('a campaign is planned in full and its results come from the OS: leads by code or credit, their sales, spend, cost per lead and return', async function () {
  var c = await campaigns.create(boss, {
    company: 'BPL', name: 'ZMK Bamboo chairs', objective: 'leads', audience: 'Hotels in Accra', keyMessage: 'Cooler than plastic',
    channels: ['facebook', 'whatsapp', 'nonsense'], budget: 2000, code: 'ZMK-CHAIRS', startDate: day(-10), endDate: day(20), status: 'active', targetLeads: 4, targetRevenue: 5000
  });
  assert.deepEqual(c.channels, ['facebook', 'whatsapp'], 'unknown channels are dropped');
  assert.equal(c.phase, 'running');
  await assert.rejects(campaigns.create(boss, { company: 'BPL', name: 'ZMK Again', code: 'zmk-chairs' }), /already uses that tracking code/);
  await assert.rejects(campaigns.create(staff, { company: 'BPL', name: 'ZMK Nope' }), /marketing.manage/);

  var buyer = (await pool.query("INSERT INTO customers (name, category) VALUES ('ZMK Buyer', 'active') RETURNING id")).rows[0].id;
  // by tracking code: the lead's source is the code
  await pool.query("INSERT INTO crm_leads (name, received_on, source, stage, customer_id) VALUES ('ZMK Lead code', $1, ' zmk-chairs ', 'won', $2)", [day(-5), buyer]);
  // outside the window: not counted
  await pool.query("INSERT INTO crm_leads (name, received_on, source, stage) VALUES ('ZMK Lead too early', $1, 'ZMK-CHAIRS', 'new')", [day(-40)]);
  // credited by hand
  var other = (await pool.query("INSERT INTO crm_leads (name, received_on, source, stage) VALUES ('ZMK Lead walk-in', $1, 'Walk-in', 'quote_sent') RETURNING id", [day(-3)])).rows[0].id;
  var cands = await campaigns.leadCandidates(boss, c.id);
  assert.ok(cands.some(function (l) { return l.id === other && !l.credited; }));
  await campaigns.creditLeads(boss, c.id, { leadIds: [other] });
  // the buyer's invoice after the lead came in (and a void one, not counted)
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind) VALUES ($1,$2,3000,0,0,3000,3000,0,'paid',$3,$3,'sale')", ['ZMK-' + Date.now(), buyer, day(-2)]);
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind) VALUES ($1,$2,900,0,0,900,0,900,'void',$3,$3,'sale')", ['ZMK-V' + Date.now(), buyer, day(-1)]);
  await budget.addSpend(boss, { company: 'BPL', campaignId: c.id, category: 'digital_ads', description: 'ZMK Facebook ads', amount: 600, spentOn: day(-4) });
  await budget.addSpend(boss, { company: 'BPL', campaignId: c.id, category: 'print', description: 'ZMK Flyers', amount: 400, spentOn: day(-1), status: 'committed' });
  var ch = (await pool.query("SELECT id FROM marketing_channels WHERE company_id = $1 LIMIT 1", [bpl])).rows[0].id;
  await pool.query("INSERT INTO marketing_posts (channel_id, campaign_id, title, status, published_at, reach, clicks, likes, created_by) VALUES ($1,$2,'ZMK Post','published', now(), 1200, 40, 30, $3)", [ch, c.id, boss.employee.id]);

  var g = await campaigns.get(boss, c.id);
  var r = g.results;
  assert.deepEqual([r.leads, r.won, r.prospects], [2, 1, 1], 'one by code, one credited; the early one is not');
  assert.deepEqual([r.spend, r.paid, r.committed, r.budgetUsed], [1000, 600, 400, 50]);
  assert.equal(r.invoiced, 3000, 'the void invoice is not a sale');
  assert.deepEqual([r.costPerLead, r.roi], [500, 200], '1000 for 2 leads; (3000 − 1000) ÷ 1000');
  assert.deepEqual([r.reach, r.clicks, r.engagement, r.posts], [1200, 40, 30, 1]);
  assert.equal(g.leads.length, 2);
  assert.equal(g.spend.length, 2);

  var all = await campaigns.list(boss, { company: 'BPL' });
  var mine = all.campaigns.find(function (x) { return x.id === c.id; });
  assert.ok(mine && all.totals.spend >= 1000);

  // finishing it, with what was learned; the old tracker still edits it
  var done = await campaigns.setStatus(boss, c.id, { status: 'completed', review: 'ZMK Hotels answered WhatsApp best.' });
  assert.deepEqual([done.status, done.phase, done.review], ['completed', 'ended', 'ZMK Hotels answered WhatsApp best.']);
  var t = await marketing.updateCampaign(boss, c.id, { name: 'ZMK Bamboo chairs', status: 'paused', startDate: c.startDate, endDate: c.endDate });
  assert.equal(t.status, 'paused');
  assert.equal((await campaigns.get(boss, c.id)).budget, 2000, 'the tracker leaves the plan alone');
  await campaigns.creditLeads(boss, c.id, { leadIds: [other], credit: false });
  assert.equal((await campaigns.get(boss, c.id)).results.leads, 1);
});

test('the budget: a year\'s budget by category against what was spent, month by month, with receipts', async function () {
  await assert.rejects(budget.setBudget(staff, { company: 'BPL', year: 2031, lines: [{ category: 'print', amount: 1 }] }), /marketing.manage/);
  var o = await budget.setBudget(boss, { company: 'BPL', year: 2031, lines: [{ category: 'digital_ads', amount: 12000 }, { category: 'events', amount: 8000 }] });
  assert.equal(o.totals.budget, 20000);
  var s = await budget.addSpend(boss, { company: 'BPL', category: 'events', description: 'ZMK Trade fair stand', vendor: 'ZMK Expo Ltd', amount: 3500, spentOn: '2031-03-10' },
    { originalname: 'receipt.pdf', buffer: Buffer.from('%PDF-1.4 zmk'), mimetype: 'application/pdf', size: 12 });
  assert.equal(s.receipt.name, 'receipt.pdf');
  await budget.addSpend(boss, { company: 'BPL', category: 'digital_ads', description: 'ZMK Google ads', amount: 1500, spentOn: '2031-04-02', status: 'committed' });
  await assert.rejects(budget.addSpend(boss, { company: 'BPL', category: 'print', description: 'ZMK zero', amount: 0, spentOn: '2031-04-02' }), /more than 0/);
  o = await budget.overview(boss, { company: 'BPL', year: 2031 });
  var ev = o.categories.find(function (c) { return c.category === 'events'; });
  assert.deepEqual([ev.budget, ev.spent, ev.left, ev.pct], [8000, 3500, 4500, 44]);
  assert.deepEqual([o.totals.spent, o.totals.paid, o.totals.committed, o.totals.left], [5000, 3500, 1500, 15000]);
  assert.deepEqual([o.months[2].spent, o.months[3].spent], [3500, 1500]);
  assert.equal(o.totals.yearThrough, 0, 'a year still to come is 0% through');
  var file = await budget.receipt(boss, s.id);
  assert.equal(file.fileName, 'receipt.pdf');
  var upd = await budget.updateSpend(boss, s.id, { category: 'events', description: 'ZMK Trade fair stand', amount: 3000, spentOn: '2031-03-10', removeReceipt: 'true' });
  assert.deepEqual([upd.amount, upd.receipt], [3000, null]);
  await budget.removeSpend(boss, s.id);
  assert.equal((await budget.overview(boss, { company: 'BPL', year: 2031 })).totals.spent, 1500);
});

test('requests: anyone asks, marketing is told, assigns, delivers; the one who asked approves', async function () {
  var r = await requests.create(staff, { company: 'BPL', title: 'ZMK Flyer for the showroom', kind: 'flyer', brief: 'A5, both sides', dueOn: day(5), priority: 'urgent' });
  assert.match(r.ref, /^MR-\d{4}$/);
  assert.equal(r.status, 'new');
  var told = (await pool.query('SELECT employee_id, title FROM notifications WHERE link = $1', ['/mkrequests?open=' + r.id])).rows;
  assert.ok(told.some(function (n) { return n.employee_id === boss.employee.id && /Urgent request/.test(n.title); }), 'marketing is told');
  await assert.rejects(requests.create(staff, { company: 'BPL', title: 'ZMK Late', dueOn: day(-1) }), /already passed/);

  var mine = await requests.list(staff, { scope: 'all' });
  assert.equal(mine.scope, 'mine', 'without marketing.read, only your own');
  assert.ok(mine.requests.every(function (x) { return x.requester.id === staff.employee.id || (x.assignee && x.assignee.id === staff.employee.id); }));
  assert.ok((await requests.list(boss, { scope: 'all', company: 'BPL' })).requests.some(function (x) { return x.id === r.id; }));

  // the one who asked can change the brief while it is new
  r = await requests.update(staff, r.id, { title: 'ZMK Flyer for the showroom', kind: 'flyer', brief: 'A5, both sides, with prices', dueOn: day(5), priority: 'urgent' });
  r = await requests.update(boss, r.id, { title: r.title, kind: r.kind, brief: r.brief, dueOn: r.dueOn, priority: r.priority, assignedTo: boss.employee.id });
  r = await requests.setStatus(boss, r.id, { status: 'in_progress' });
  await assert.rejects(requests.update(staff, r.id, { title: 'ZMK changed' }), /Marketing has started/);
  await assert.rejects(requests.setStatus(boss, r.id, { status: 'declined' }), /why/);
  r = await requests.comment(staff, r.id, { body: 'ZMK Our logo is the new one' });
  assert.equal(r.thread.length, 1);
  r = await requests.addFile(boss, r.id, { originalname: 'flyer.pdf', buffer: Buffer.from('%PDF zmk'), mimetype: 'application/pdf', size: 8 }, { delivered: 'true' });
  assert.equal(r.attachments[0].delivered, true);
  r = await requests.setStatus(boss, r.id, { status: 'review' });
  var toAsker = (await pool.query('SELECT title FROM notifications WHERE employee_id = $1 AND link = $2', [staff.employee.id, '/mkrequests?open=' + r.id])).rows.map(function (n) { return n.title; });
  assert.ok(toAsker.some(function (t) { return /ready for you to look at/.test(t); }));
  assert.ok(toAsker.some(function (t) { return /is attached/.test(t); }));
  r = await requests.setStatus(staff, r.id, { status: 'done' });
  assert.equal(r.status, 'done');
  await assert.rejects(requests.setStatus(staff, r.id, { status: 'new' }), /marketing.manage/);
  var other = await ctxFor('john.sitati@bplghana.com');
  await assert.rejects(requests.get(other, r.id), /not yours/);
});

test('events start with a checklist for their kind; promotions add up their uses', async function () {
  var e = await events.createEvent(boss, { company: 'BPL', name: 'ZMK Home & Garden Expo', kind: 'trade_fair', startsOn: day(30), endsOn: day(32), venue: 'ZMK Hall', budget: 5000, targetLeads: 40 });
  assert.equal(e.checklist.length, events.CHECKLISTS.stand.length);
  assert.ok(e.checklist.some(function (t) { return t.title === 'Book the stand or space' && t.dueOn === day(-15); }), '45 days before');
  e = await events.setTask(boss, e.id, e.checklist[0].id, { done: true });
  assert.equal(e.tasksDone, 1);
  e = await events.addTask(boss, e.id, { title: 'ZMK Bring the chairs', dueOn: day(29) });
  assert.equal(e.tasks, events.CHECKLISTS.stand.length + 1);
  await budget.addSpend(boss, { company: 'BPL', eventId: e.id, category: 'events', description: 'ZMK Stand fee', amount: 2000, spentOn: day(0) });
  e = await events.updateEvent(boss, e.id, { name: e.name, kind: e.kind, startsOn: e.startsOn, endsOn: e.endsOn, budget: 5000, status: 'done', leadsCaptured: 25, visitors: 300, sales: 4000, outcome: 'ZMK Good' });
  assert.deepEqual([e.spent, e.costPerLead, e.leadsCaptured], [2000, 80, 25]);
  await assert.rejects(events.createEvent(boss, { company: 'BPL', name: 'ZMK Backwards', startsOn: day(5), endsOn: day(1) }), /before it starts/);

  var p = await events.createPromotion(boss, { company: 'BPL', name: 'ZMK Ten off', code: 'zmk 10', kind: 'percent', value: 10, startsOn: day(-3), endsOn: day(4), channels: ['instagram'] });
  assert.deepEqual([p.code, p.state, p.daysLeft], ['ZMK10', 'running', 4]);
  await assert.rejects(events.createPromotion(boss, { company: 'BPL', name: 'ZMK Too much', kind: 'percent', value: 150, startsOn: day(0) }), /more than 100/);
  p = await events.logUse(boss, p.id, { usedOn: day(-1), uses: 3, revenue: 900, discount: 90 });
  p = await events.logUse(boss, p.id, { usedOn: day(0), uses: 2, revenue: 500, discount: 50 });
  assert.deepEqual([p.uses, p.revenue, p.discount, p.averageSale, p.log.length], [5, 1400, 140, 280, 2]);
  await assert.rejects(events.logUse(boss, p.id, { usedOn: day(2), uses: 1 }), /not come yet/);
});

test('the brand kit is for everyone to see; only marketing keeps it', async function () {
  var b = await brand.updateBrand(boss, { company: 'BPL', tagline: 'ZMK Naturally strong', colours: [{ name: 'Bamboo green', hex: '#3F7D3B' }], voice: 'Warm and plain' });
  assert.deepEqual(b.brand.colours, [{ name: 'Bamboo green', hex: '#3f7d3b' }]);
  await assert.rejects(brand.updateBrand(boss, { company: 'BPL', colours: [{ name: 'x', hex: 'green' }] }), /hex code/);
  await assert.rejects(brand.updateBrand(staff, { company: 'BPL', tagline: 'x' }), /marketing.manage/);
  b = await brand.addAsset(boss, { company: 'BPL', kind: 'logo', name: 'ZMK Logo', tags: 'Main, green' }, { originalname: 'logo.png', buffer: Buffer.from('png'), mimetype: 'image/png', size: 3 });
  var asset = b.assets.find(function (a) { return a.name === 'ZMK Logo'; });
  assert.deepEqual([asset.kind, asset.tags, asset.isImage], ['logo', ['main', 'green'], true]);
  var seen = await brand.brand(staff, { company: 'BPL' });
  assert.ok(seen.assets.some(function (a) { return a.id === asset.id; }), 'anyone signed in sees it');
  assert.equal(seen.canManage, false);
  await brand.assetFile(staff, asset.id, true);
  assert.equal((await brand.brand(boss, { company: 'BPL' })).assets.find(function (a) { return a.id === asset.id; }).downloads, 1);
});

test('the market: competitors, sightings, and how their prices sit against ours', async function () {
  var m = await brand.addCompetitor(boss, { company: 'BPL', name: 'ZMK Rival Furniture', pricePosition: 'lower', strengths: 'Cheap' });
  var rival = m.competitors.find(function (c) { return c.name === 'ZMK Rival Furniture'; });
  m = await brand.addIntel(boss, { company: 'BPL', competitorId: rival.id, kind: 'price', body: 'ZMK Chair at the market', product: 'Bamboo chair', price: 400, ourPrice: 500 });
  var row = m.intel.find(function (i) { return i.body === 'ZMK Chair at the market'; });
  assert.equal(row.gap, -20, 'theirs is 20% below ours');
  assert.equal(m.competitors.find(function (c) { return c.id === rival.id; }).averageGap, -20);
  await assert.rejects(brand.market(staff, { company: 'BPL' }), /marketing.read/);
});

test('audiences count the right people, never those who opted out, and export them', async function () {
  var a1 = (await pool.query("INSERT INTO customers (name, phone, email, category, location) VALUES ('ZMK Aud One', '0200009001', 'zmk1@example.com', 'vip', 'ZMK Accra') RETURNING id")).rows[0].id;
  var a2 = (await pool.query("INSERT INTO customers (name, phone, category, location, marketing_opt_out) VALUES ('ZMK Aud Two', '0200009002', 'vip', 'ZMK Accra', true) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO customers (name, category, location) VALUES ('ZMK Aud Three', 'lead', 'ZMK Kumasi')");
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind) VALUES ($1,$2,800,0,0,800,800,0,'paid',$3,$3,'sale')", ['ZMK-A' + Date.now(), a1, day(-20)]);
  await pool.query("INSERT INTO invoices (invoice_no, customer_id, subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, doc_kind) VALUES ($1,$2,800,0,0,800,800,0,'paid',$3,$3,'sale')", ['ZMK-B' + Date.now(), a2, day(-20)]);
  var pv = await audiences.preview(boss, { company: 'BPL', rules: { stages: ['vip'], location: 'ZMK Accra', boughtWithinDays: 30 } });
  assert.deepEqual([pv.count, pv.optedOut, pv.withEmail], [1, 1, 1]);
  assert.equal(pv.people[0].name, 'ZMK Aud One');
  var lapsed = await audiences.preview(boss, { company: 'BPL', rules: { location: 'ZMK', notBoughtForDays: 10 } });
  assert.equal(lapsed.count, 1, 'bought 20 days ago: not for 10 days');
  var never = await audiences.preview(boss, { company: 'BPL', rules: { location: 'ZMK', neverBought: true } });
  assert.deepEqual(never.people.map(function (p) { return p.name; }), ['ZMK Aud Three']);
  var saved = await audiences.create(boss, { company: 'BPL', name: 'ZMK VIPs in Accra', rules: { stages: ['vip'], location: 'ZMK Accra' } });
  var aud = saved.audiences.find(function (x) { return x.name === 'ZMK VIPs in Accra'; });
  assert.equal(aud.count, 1);
  var csv = await audiences.exportCsv(boss, aud.id);
  assert.match(csv.csv, /^Name,Phone,Email,Last purchase,Spent\nZMK Aud One,0200009001,zmk1@example.com,/);
  assert.doesNotMatch(csv.csv, /ZMK Aud Two/);
  await assert.rejects(audiences.exportCsv(staff, aud.id), /marketing.manage/);
});

test('the home page adds it all up, and the calendar has everything with a date and the year\'s moments', async function () {
  var h = await home.home(boss, { company: 'BPL' });
  assert.ok(h.leads.month >= 1, 'the leads received this month');
  assert.ok(h.spend.month > 0 || h.spend.year > 0);
  assert.ok(Array.isArray(h.insights) && Array.isArray(h.week));
  assert.ok(h.requests.open >= 0);
  var cal = await home.calendar(boss, { company: 'BPL', from: day(-12), to: day(40) });
  var kinds = new Set(cal.items.map(function (i) { return i.kind; }));
  ['campaign', 'event', 'promotion', 'task'].forEach(function (k) { assert.ok(kinds.has(k), k + ' on the calendar'); });
  assert.equal(home._easter(2026), '2026-04-05');
  var m26 = home._moments(2026);
  assert.ok(m26.some(function (m) { return m.key === 'mothers_day' && m.date === '2026-05-10'; }));
  assert.ok(m26.some(function (m) { return m.key === 'black_friday' && m.date === '2026-11-27'; }));
  var feb = await home.calendar(boss, { company: 'BPL', from: '2031-02-01', to: '2031-02-28' });
  assert.ok(feb.items.some(function (i) { return i.kind === 'moment' && i.key === 'valentines' && i.start === '2031-02-14'; }));
  await assert.rejects(home.home(staff, { company: 'BPL' }), /marketing.read/);
});
