var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var S = require('./mkShared');

// Audiences: who to talk to, written as rules the OS counts and lists —
// "bought in the last 90 days", "bought before but not for 6 months",
// "asked about chairs", "VIPs in Accra on WhatsApp". Saved, they can be
// counted again any day and exported (name, phone, email) for a WhatsApp
// broadcast list, an SMS blast or a Facebook custom audience. Anyone who
// asked not to get marketing (customers.marketing_opt_out) is always left
// out and counted apart.
//
// Two kinds: the company's customers (Bamboo Products and Poki), and a
// restaurant's guests (by their visits on the till and phone orders).
// Seeing names and numbers needs customer.read as well as marketing.read;
// exporting needs marketing.manage.

var STAGES = ['lead', 'prospect', 'active', 'vip', 'inactive'];
var CHANNELS = ['whatsapp', 'facebook', 'instagram', 'email', 'phone', 'walk_in', 'website', 'other'];

function cleanRules(r) {
  r = r || {};
  var base = S.oneOf(r.base, ['customers', 'guests'], 'Who', 'customers');
  function days(v, label) { var n = S.wholeOrNull(v, label); if (n !== null && n > 3650) fail('invalid', label + ' is too long.'); return n; }
  return {
    base: base,
    stages: base === 'customers' ? S.list(r.stages, STAGES) : [],
    channels: base === 'customers' ? S.list(r.channels, CHANNELS) : [],
    boughtWithinDays: days(r.boughtWithinDays, 'Bought within'),
    notBoughtForDays: days(r.notBoughtForDays, 'Not bought for'),
    neverBought: !!r.neverBought,
    minSpend: S.money(r.minSpend, 'Spent at least', { optional: true }),
    minVisits: base === 'guests' ? S.wholeOrNull(r.minVisits, 'Visits') : null,
    product: S.text(r.product, 80),
    location: S.text(r.location, 80),
    hasPhone: !!r.hasPhone, hasEmail: base === 'customers' ? !!r.hasEmail : false
  };
}

// The SQL for one audience: SELECT id, name, phone, email, last_at, spent, opted_out.
function audienceSql(co, rules) {
  var args = [co.id];
  function p(v) { args.push(v); return '$' + args.length; }
  var where = [];
  var sql;
  if (rules.base === 'customers') {
    var scope = co.code === 'BPL' ? '(c.company_id = $1 OR c.company_id IS NULL)' : 'c.company_id = $1';
    sql = 'WITH s AS (SELECT i.customer_id, max(i.issued_at) AS last_at, sum(i.grand_total - i.credit_total) AS spent FROM invoices i ' +
      "WHERE i.doc_kind = 'sale' AND i.status <> 'void' GROUP BY 1) " +
      'SELECT c.id, c.name, c.phone, c.email, s.last_at, coalesce(s.spent, 0) AS spent, c.marketing_opt_out AS opted_out, c.category AS stage, c.location ' +
      'FROM customers c LEFT JOIN s ON s.customer_id = c.id ';
    where.push(scope, "c.status = 'active'", "c.category <> 'contact'", 'c.no_follow_up_at IS NULL');
    if (rules.stages.length) where.push('c.category = ANY(' + p(rules.stages) + ')');
    if (rules.channels.length) where.push('c.origin_channel = ANY(' + p(rules.channels) + ')');
    if (rules.location) where.push("(c.location ILIKE " + p('%' + rules.location + '%') + " OR c.address ILIKE $" + args.length + ')');
    if (rules.hasEmail) where.push("coalesce(c.email, '') <> ''");
    if (rules.hasPhone) where.push("coalesce(c.phone, '') <> ''");
    if (rules.product) {
      var like = p('%' + rules.product + '%');
      where.push('(EXISTS (SELECT 1 FROM invoices i JOIN document_line_items li ON li.document_type = \'invoice\' AND li.document_id = i.id WHERE i.customer_id = c.id AND li.description ILIKE ' + like + ') ' +
        'OR EXISTS (SELECT 1 FROM quotations q JOIN document_line_items li ON li.document_type = \'quotation\' AND li.document_id = q.id WHERE q.customer_id = c.id AND li.description ILIKE ' + like + ') ' +
        'OR EXISTS (SELECT 1 FROM crm_leads l WHERE l.customer_id = c.id AND l.item ILIKE ' + like + '))');
    }
  } else {
    sql = 'WITH v AS (SELECT guest_id, max(at) AS last_at, count(*) AS visits, sum(amount) AS spent FROM (' +
      "  SELECT o.guest_id, o.created_at::date AS at, o.total AS amount FROM restaurant_orders o WHERE o.company_id = $1 AND o.status = 'completed' AND o.guest_id IS NOT NULL " +
      '  UNION ALL SELECT g.guest_id, g.ordered_on, coalesce(g.amount, 0) FROM restaurant_guest_orders g WHERE g.company_id = $1 AND g.guest_id IS NOT NULL AND g.till_order_id IS NULL' +
      ') x GROUP BY 1) ' +
      "SELECT g.id, g.name, g.phone, '' AS email, v.last_at, coalesce(v.spent, 0) AS spent, false AS opted_out, NULL AS stage, '' AS location, coalesce(v.visits, 0) AS visits " +
      'FROM restaurant_guests g LEFT JOIN v ON v.guest_id = g.id ';
    where.push('g.company_id = $1');
    if (rules.minVisits) where.push('coalesce(v.visits, 0) >= ' + p(rules.minVisits));
    if (rules.hasPhone) where.push("coalesce(g.phone, '') <> ''");
    if (rules.product) where.push("EXISTS (SELECT 1 FROM restaurant_orders o JOIN restaurant_order_items oi ON oi.order_id = o.id WHERE o.guest_id = g.id AND oi.name ILIKE " + p('%' + rules.product + '%') + ')');
  }
  // On the purchases, so on the outer row.
  var after = [];
  if (rules.boughtWithinDays !== null) after.push('a.last_at >= current_date - ' + p(rules.boughtWithinDays) + '::int');
  if (rules.notBoughtForDays !== null) after.push('a.last_at < current_date - ' + p(rules.notBoughtForDays) + '::int');
  if (rules.neverBought) after.push('a.last_at IS NULL');
  if (rules.minSpend !== null) after.push('a.spent >= ' + p(rules.minSpend));
  return { sql: 'SELECT * FROM (' + sql + 'WHERE ' + where.join(' AND ') + ') a ' + (after.length ? 'WHERE ' + after.join(' AND ') : '') +
    ' ORDER BY a.spent DESC, a.name', args: args };
}

async function run(ctx, co, rules, limit) {
  var q = audienceSql(co, rules);
  var rows = (await pool.query(q.sql, q.args)).rows;
  var reachable = rows.filter(function (r) { return !r.opted_out; });
  var seeNames = ctx.can('customer.read');
  return {
    count: reachable.length, optedOut: rows.length - reachable.length,
    withPhone: reachable.filter(function (r) { return r.phone; }).length, withEmail: reachable.filter(function (r) { return r.email; }).length,
    spent: S.num(reachable.reduce(function (s, r) { return s + Number(r.spent || 0); }, 0)),
    people: seeNames ? reachable.slice(0, limit || 50).map(function (r) {
      return { id: r.id, name: r.name, phone: r.phone || '', email: r.email || '', lastAt: r.last_at ? S.iso(r.last_at) : null, spent: S.num(r.spent), stage: r.stage, visits: r.visits !== undefined ? Number(r.visits) : null };
    }) : null,
    rows: reachable
  };
}
function strip(res) { var o = Object.assign({}, res); delete o.rows; return o; }

// POST /api/mk/audiences/preview { company, rules } — count and the first 50.
async function preview(ctx, p) {
  S.requireRead(ctx);
  var co = await S.company(p.company);
  return strip(await run(ctx, co, cleanRules(p.rules)));
}

// GET /api/mk/audiences?company= — the saved ones, counted today.
async function list(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var rows = (await pool.query('SELECT a.*, e.first_name, e.last_name FROM marketing_audiences a JOIN employees e ON e.id = a.created_by WHERE a.company_id = $1 ORDER BY a.updated_at DESC', [co.id])).rows;
  var out = [];
  for (var r of rows) {
    var rules = cleanRules(r.rules);
    var res = await run(ctx, co, rules, 0);
    out.push({ id: r.id, name: r.name, description: r.description, rules: rules, count: res.count, optedOut: res.optedOut, withPhone: res.withPhone, withEmail: res.withEmail,
      spent: res.spent, by: S.employeeName(r.first_name, r.last_name), updatedAt: r.updated_at });
  }
  // A restaurant (it has a menu or guests) can also build from its guests.
  var restaurant = (await pool.query('SELECT EXISTS (SELECT 1 FROM restaurant_menu_items WHERE company_id = $1) OR EXISTS (SELECT 1 FROM restaurant_guests WHERE company_id = $1) AS r', [co.id])).rows[0].r;
  return { company: { code: co.code, name: co.name }, restaurant: restaurant, canManage: ctx.can('marketing.manage'), canSeePeople: ctx.can('customer.read'), canExport: ctx.can('marketing.manage') && ctx.can('customer.read'), audiences: out };
}

async function save(ctx, id, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var name = S.text(p.name, 120);
  if (!name) fail('invalid', 'Give the audience a name.');
  var rules = cleanRules(p.rules);
  if (id) {
    var row = (await pool.query('SELECT company_id FROM marketing_audiences WHERE id = $1', [id])).rows[0];
    if (!row) fail('notfound', 'Audience not found.');
    await pool.query('UPDATE marketing_audiences SET name = $2, description = $3, rules = $4, updated_at = now() WHERE id = $1', [id, name, S.text(p.description, 500), JSON.stringify(rules)]);
  } else {
    id = (await pool.query('INSERT INTO marketing_audiences (company_id, name, description, rules, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [co.id, name, S.text(p.description, 500), JSON.stringify(rules), ctx.employee.id])).rows[0].id;
  }
  await audit(pool, ctx, 'marketing.audience.save', 'marketing_audience', id, 'Saved audience ' + name + '.');
  return list(ctx, { company: co.code });
}
async function create(ctx, p) { return save(ctx, null, p); }
async function update(ctx, id, p) { return save(ctx, id, p); }
async function remove(ctx, id) {
  S.requireManage(ctx);
  var row = (await pool.query('SELECT a.name, co.code FROM marketing_audiences a JOIN companies co ON co.id = a.company_id WHERE a.id = $1', [id])).rows[0];
  if (!row) fail('notfound', 'Audience not found.');
  await pool.query('DELETE FROM marketing_audiences WHERE id = $1', [id]);
  return list(ctx, { company: row.code });
}

function csvCell(v) { var s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
// GET /api/mk/audiences/:id/export — a CSV of everyone in it (not those
// who opted out): name, phone, email, last purchase, spent.
async function exportCsv(ctx, id) {
  S.requireManage(ctx);
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  var row = (await pool.query('SELECT a.*, co.code FROM marketing_audiences a JOIN companies co ON co.id = a.company_id WHERE a.id = $1', [id])).rows[0];
  if (!row) fail('notfound', 'Audience not found.');
  var co = await S.company(row.code);
  var res = await run(ctx, co, cleanRules(row.rules));
  var lines = [['Name', 'Phone', 'Email', 'Last purchase', 'Spent'].join(',')].concat(res.rows.map(function (r) {
    return [r.name, r.phone, r.email, r.last_at ? S.iso(r.last_at) : '', S.num(r.spent)].map(csvCell).join(',');
  }));
  await audit(pool, ctx, 'marketing.audience.export', 'marketing_audience', id, 'Exported ' + res.count + ' people from ' + row.name + '.');
  return { fileName: row.name.replace(/[^\w-]+/g, '-').toLowerCase() + '.csv', csv: lines.join('\n') + '\n', count: res.count };
}

module.exports = { preview: preview, list: list, create: create, update: update, remove: remove, exportCsv: exportCsv, STAGES: STAGES, CHANNELS: CHANNELS, _cleanRules: cleanRules };
