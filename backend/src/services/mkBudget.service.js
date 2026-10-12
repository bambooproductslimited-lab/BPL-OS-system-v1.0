var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');
var S = require('./mkShared');

// The marketing budget and what is spent: a yearly budget per category
// (digital ads, content, print, events…), every spend with its vendor,
// date, campaign or event and receipt; paid, or committed (agreed, not yet
// paid). The year's view: each category's budget against what has gone,
// month by month, by campaign, and whether spending is ahead of the
// year's pace. Money is in cedis.

function spendOut(r) {
  return {
    id: r.id, category: r.category, vendor: r.vendor, description: r.description, amount: S.num(r.amount), spentOn: r.spent_on, status: r.status,
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name } : null, event: r.event_id ? { id: r.event_id, name: r.event_name } : null,
    receipt: r.receipt_key ? { name: r.receipt_name } : null, by: S.employeeName(r.by_first, r.by_last), createdAt: r.created_at
  };
}

// GET /api/mk/budget?company=&year=
async function overview(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var year = Number(opts && opts.year) || new Date().getFullYear();
  if (year < 2000 || year > 2100) fail('invalid', 'Pick a year.');
  var from = year + '-01-01', to = year + '-12-31';
  var q = await Promise.all([
    pool.query('SELECT category, amount FROM marketing_budgets WHERE company_id = $1 AND year = $2', [co.id, year]),
    pool.query(
      'SELECT s.*, c.name AS campaign_name, ev.name AS event_name, e.first_name AS by_first, e.last_name AS by_last FROM marketing_spend s ' +
      'LEFT JOIN marketing_campaigns c ON c.id = s.campaign_id LEFT JOIN marketing_events ev ON ev.id = s.event_id LEFT JOIN employees e ON e.id = s.created_by ' +
      'WHERE s.company_id = $1 AND s.spent_on BETWEEN $2 AND $3 ORDER BY s.spent_on DESC, s.created_at DESC', [co.id, from, to]),
    pool.query('SELECT coalesce(sum(amount), 0) AS v FROM marketing_spend WHERE company_id = $1 AND spent_on BETWEEN $2 AND $3', [co.id, (year - 1) + '-01-01', (year - 1) + '-12-31'])
  ]);
  var budget = {};
  q[0].rows.forEach(function (r) { budget[r.category] = S.num(r.amount); });
  var lines = q[1].rows.map(spendOut);
  var cats = S.SPEND_CATEGORIES.map(function (k) {
    var mine = lines.filter(function (l) { return l.category === k; });
    var paid = mine.filter(function (l) { return l.status === 'paid'; }).reduce(function (s, l) { return s + l.amount; }, 0);
    var committed = mine.filter(function (l) { return l.status === 'committed'; }).reduce(function (s, l) { return s + l.amount; }, 0);
    var b = budget[k] || 0, spent = S.num(paid + committed);
    return { category: k, budget: b, paid: S.num(paid), committed: S.num(committed), spent: spent, left: S.num(b - spent), pct: b > 0 ? Math.round((spent / b) * 100) : null, lines: mine.length };
  }).filter(function (c) { return c.budget > 0 || c.lines > 0; });
  var months = Array.from({ length: 12 }, function (_, i) {
    var key = year + '-' + String(i + 1).padStart(2, '0');
    var mine = lines.filter(function (l) { return String(l.spentOn).slice(0, 7) === key; });
    return { month: key, spent: S.num(mine.reduce(function (s, l) { return s + l.amount; }, 0)) };
  });
  var byCampaign = {};
  lines.forEach(function (l) {
    var k = l.campaign ? l.campaign.id : '';
    if (!byCampaign[k]) byCampaign[k] = { id: k || null, name: l.campaign ? l.campaign.name : null, spent: 0, lines: 0 };
    byCampaign[k].spent = S.num(byCampaign[k].spent + l.amount); byCampaign[k].lines += 1;
  });
  var totalBudget = S.num(cats.reduce(function (s, c) { return s + c.budget; }, 0));
  var spent = S.num(lines.reduce(function (s, l) { return s + l.amount; }, 0));
  var paid = S.num(lines.filter(function (l) { return l.status === 'paid'; }).reduce(function (s, l) { return s + l.amount; }, 0));
  // How far through the year: all of it for a past year, none for a future one.
  var now = new Date(), thisYear = now.getFullYear();
  var through = year < thisYear ? 1 : year > thisYear ? 0 : (Date.UTC(thisYear, now.getMonth(), now.getDate()) - Date.UTC(thisYear, 0, 1) + 86400000) / ((Date.UTC(thisYear + 1, 0, 1) - Date.UTC(thisYear, 0, 1)));
  return {
    company: { code: co.code, name: co.name }, year: year, canManage: ctx.can('marketing.manage'),
    categories: cats, months: months,
    campaigns: Object.values(byCampaign).sort(function (a, b) { return b.spent - a.spent; }),
    spend: lines,
    totals: {
      budget: totalBudget, spent: spent, paid: paid, committed: S.num(spent - paid), left: S.num(totalBudget - spent),
      pct: totalBudget > 0 ? Math.round((spent / totalBudget) * 100) : null,
      yearThrough: Math.round(through * 100), onPace: totalBudget > 0 ? S.num(totalBudget * through) : null,
      lastYear: S.num(q[2].rows[0].v)
    }
  };
}

// PUT /api/mk/budget { company, year, lines: [{ category, amount }] } — the
// year's budget, category by category; a category left out keeps its amount.
async function setBudget(ctx, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var year = Number(p.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail('invalid', 'Pick a year.');
  var lines = Array.isArray(p.lines) ? p.lines : [];
  if (!lines.length) fail('invalid', 'Give at least one category an amount.');
  for (var l of lines) {
    var cat = S.oneOf(l.category, S.SPEND_CATEGORIES, 'Category');
    var amount = S.money(l.amount || 0, 'Budget');
    await pool.query(
      'INSERT INTO marketing_budgets (company_id, year, category, amount, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5, now()) ' +
      'ON CONFLICT (company_id, year, category) DO UPDATE SET amount = $4, updated_by = $5, updated_at = now()', [co.id, year, cat, amount, ctx.employee.id]);
  }
  var total = (await pool.query('SELECT coalesce(sum(amount), 0) AS v FROM marketing_budgets WHERE company_id = $1 AND year = $2', [co.id, year])).rows[0].v;
  await audit(pool, ctx, 'marketing.budget.set', 'company', co.id, co.name + ' marketing budget for ' + year + ' set to ' + S.num(total) + '.');
  return overview(ctx, { company: co.code, year: year });
}

async function checkLinks(p, companyId) {
  if (p.campaignId) {
    var c = (await pool.query('SELECT company_id FROM marketing_campaigns WHERE id = $1', [p.campaignId])).rows[0];
    if (!c || c.company_id !== companyId) fail('invalid', 'That campaign is not this company\'s.');
  }
  if (p.eventId) {
    var e = (await pool.query('SELECT company_id FROM marketing_events WHERE id = $1', [p.eventId])).rows[0];
    if (!e || e.company_id !== companyId) fail('invalid', 'That event is not this company\'s.');
  }
}
function spendFields(p) {
  var description = S.text(p.description, 300);
  if (!description) fail('invalid', 'Say what the money was for.');
  var spentOn = S.dateOrNull(p.spentOn, 'Date');
  if (!spentOn) fail('invalid', 'Give the date.');
  return {
    category: S.oneOf(p.category, S.SPEND_CATEGORIES, 'Category'), vendor: S.text(p.vendor, 160), description: description,
    amount: S.money(p.amount, 'Amount', { positive: true }), spentOn: spentOn, status: S.oneOf(p.status, ['paid', 'committed'], 'Status', 'paid'),
    campaignId: p.campaignId || null, eventId: p.eventId || null
  };
}
async function lineRow(id) {
  var r = (await pool.query(
    'SELECT s.*, c.name AS campaign_name, ev.name AS event_name, e.first_name AS by_first, e.last_name AS by_last FROM marketing_spend s ' +
    'LEFT JOIN marketing_campaigns c ON c.id = s.campaign_id LEFT JOIN marketing_events ev ON ev.id = s.event_id LEFT JOIN employees e ON e.id = s.created_by WHERE s.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Spend not found.');
  return r;
}

// POST /api/mk/spend (multipart: the fields, and receipt? a file)
async function addSpend(ctx, p, file) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var f = spendFields(p);
  await checkLinks(f, co.id);
  var key = file ? await fileStore.put(file.originalname, file.buffer, file.mimetype) : null;
  var r = (await pool.query(
    'INSERT INTO marketing_spend (company_id, campaign_id, event_id, category, vendor, description, amount, spent_on, status, receipt_key, receipt_name, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
    [co.id, f.campaignId, f.eventId, f.category, f.vendor, f.description, f.amount, f.spentOn, f.status, key, file ? file.originalname : null, ctx.employee.id])).rows[0];
  await audit(pool, ctx, 'marketing.spend.add', 'marketing_spend', r.id, 'Spent ' + f.amount + ' on ' + f.description + (f.vendor ? ' (' + f.vendor + ')' : '') + '.');
  return spendOut(await lineRow(r.id));
}

// PUT /api/mk/spend/:id (multipart, receipt? replaces the receipt)
async function updateSpend(ctx, id, p, file) {
  S.requireManage(ctx);
  var row = await lineRow(id);
  var f = spendFields(p);
  await checkLinks(f, row.company_id);
  var key = row.receipt_key, name = row.receipt_name;
  if (file) { key = await fileStore.put(file.originalname, file.buffer, file.mimetype); name = file.originalname; }
  else if (p.removeReceipt === true || p.removeReceipt === 'true') { key = null; name = null; }
  await pool.query(
    'UPDATE marketing_spend SET campaign_id = $2, event_id = $3, category = $4, vendor = $5, description = $6, amount = $7, spent_on = $8, status = $9, receipt_key = $10, receipt_name = $11 WHERE id = $1',
    [id, f.campaignId, f.eventId, f.category, f.vendor, f.description, f.amount, f.spentOn, f.status, key, name]);
  if (row.receipt_key && row.receipt_key !== key) await fileStore.del(row.receipt_key).catch(function () {});
  await audit(pool, ctx, 'marketing.spend.update', 'marketing_spend', id, 'Updated spend: ' + f.description + ', ' + f.amount + '.');
  return spendOut(await lineRow(id));
}

// DELETE /api/mk/spend/:id
async function removeSpend(ctx, id) {
  S.requireManage(ctx);
  var row = await lineRow(id);
  await pool.query('DELETE FROM marketing_spend WHERE id = $1', [id]);
  if (row.receipt_key) await fileStore.del(row.receipt_key).catch(function () {});
  await audit(pool, ctx, 'marketing.spend.delete', 'marketing_spend', id, 'Removed spend: ' + row.description + ', ' + S.num(row.amount) + '.');
  return { ok: true };
}

// The receipt's file, for GET /api/mk/spend/:id/receipt.
async function receipt(ctx, id) {
  S.requireRead(ctx);
  var row = await lineRow(id);
  if (!row.receipt_key) fail('notfound', 'No receipt was kept for this.');
  return { key: row.receipt_key, fileName: row.receipt_name };
}

module.exports = { overview: overview, setBudget: setBudget, addSpend: addSpend, updateSpend: updateSpend, removeSpend: removeSpend, receipt: receipt };
