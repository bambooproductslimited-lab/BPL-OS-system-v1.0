var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var S = require('./mkShared');

// Campaigns as the department plans and judges them: what it is for
// (objective), who it speaks to, the one thing it says, where it runs,
// the budget, who owns it, its targets and a tracking code; then what it
// did, worked out from the OS rather than typed in:
//  - spend: what was recorded against it (mkBudget.service.js);
//  - leads: the CRM's leads credited to it — set on the campaign, or left
//    empty with the campaign's tracking code as the lead's source, received
//    while it ran (up to 14 days after it ended);
//  - sales: what those leads' customers were invoiced from the day the
//    lead came in until 90 days after the campaign ended (the same sales
//    the CRM counts: GHS sale invoices, not void, less credit notes);
//  - its posts' reach, clicks and engagement (the social tracker), its
//    promotions' uses and its events' visitors, leads and sales;
//  - cost per lead, and the return: (sales − spend) ÷ spend.
// The old tracker's campaign form (marketing.service.js) still works on
// the same rows; it only changes name, description, dates and status.

var STATUSES = ['draft', 'planned', 'active', 'paused', 'completed', 'cancelled'];
var OBJECTIVES = ['awareness', 'leads', 'sales', 'launch', 'loyalty', 'event'];
var LEAD_WINDOW_DAYS = 14;
var SALES_WINDOW_DAYS = 90;

// Every campaign's results in one go: { [id]: results }.
async function resultsFor(ids) {
  var out = {};
  if (!ids.length) return out;
  var rows = (await pool.query(
    'WITH c AS (SELECT id, code, start_date, end_date, budget FROM marketing_campaigns WHERE id = ANY($1)), ' +
    'cl AS (' +
    '  SELECT c.id AS campaign_id, l.id AS lead_id, l.stage, l.customer_id, l.received_on FROM c JOIN crm_leads l ON l.campaign_id = c.id ' +
    '  UNION ' +
    '  SELECT c.id, l.id, l.stage, l.customer_id, l.received_on FROM c JOIN crm_leads l ON l.campaign_id IS NULL ' +
    "    AND coalesce(c.code, '') <> '' AND lower(trim(l.source)) = lower(trim(c.code)) " +
    '    AND (c.start_date IS NULL OR l.received_on >= c.start_date) AND (c.end_date IS NULL OR l.received_on <= c.end_date + ' + LEAD_WINDOW_DAYS + ')), ' +
    'leads AS (SELECT campaign_id, count(*)::int AS leads, ' +
    "  count(*) FILTER (WHERE stage IN ('qualified', 'quote_sent', 'negotiation'))::int AS prospects, count(*) FILTER (WHERE stage = 'won')::int AS won, " +
    "  count(*) FILTER (WHERE stage = 'lost')::int AS lost FROM cl GROUP BY 1), " +
    'cust AS (SELECT campaign_id, customer_id, min(received_on) AS since FROM cl WHERE customer_id IS NOT NULL GROUP BY 1, 2), ' +
    'sales AS (SELECT cust.campaign_id, coalesce(sum(i.grand_total - i.credit_total), 0) AS revenue, count(DISTINCT cust.customer_id)::int AS buyers ' +
    '  FROM cust JOIN c ON c.id = cust.campaign_id JOIN invoices i ON i.customer_id = cust.customer_id ' +
    "  AND i.doc_kind = 'sale' AND i.status <> 'void' AND i.currency = 'GHS' " +
    '  AND i.issued_at >= cust.since AND i.issued_at <= coalesce(c.end_date, current_date) + ' + SALES_WINDOW_DAYS + ' GROUP BY 1), ' +
    "spend AS (SELECT campaign_id, coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0) AS paid, coalesce(sum(amount) FILTER (WHERE status = 'committed'), 0) AS committed " +
    '  FROM marketing_spend WHERE campaign_id = ANY($1) GROUP BY 1), ' +
    "posts AS (SELECT campaign_id, count(*)::int AS posts, count(*) FILTER (WHERE status = 'published')::int AS published, " +
    '  coalesce(sum(reach), 0)::bigint AS reach, coalesce(sum(impressions), 0)::bigint AS impressions, coalesce(sum(clicks), 0)::bigint AS clicks, ' +
    '  coalesce(sum(likes + comments + shares), 0)::bigint AS engagement, coalesce(sum(leads), 0)::int AS post_leads FROM marketing_posts WHERE campaign_id = ANY($1) GROUP BY 1), ' +
    'promos AS (SELECT p.campaign_id, coalesce(sum(u.uses), 0)::int AS uses, coalesce(sum(u.revenue), 0) AS revenue FROM marketing_promotions p ' +
    '  JOIN marketing_promotion_uses u ON u.promotion_id = p.id WHERE p.campaign_id = ANY($1) GROUP BY 1), ' +
    "events AS (SELECT campaign_id, count(*)::int AS events, coalesce(sum(leads_captured), 0)::int AS leads, coalesce(sum(visitors), 0)::int AS visitors, coalesce(sum(sales), 0) AS sales " +
    "  FROM marketing_events WHERE campaign_id = ANY($1) AND status <> 'cancelled' GROUP BY 1), " +
    "reqs AS (SELECT campaign_id, count(*) FILTER (WHERE status IN ('new', 'in_progress', 'review'))::int AS open FROM marketing_requests WHERE campaign_id = ANY($1) GROUP BY 1) " +
    'SELECT c.id, c.budget, leads.leads, leads.prospects, leads.won, leads.lost, sales.revenue, sales.buyers, spend.paid, spend.committed, ' +
    '  posts.posts, posts.published, posts.reach, posts.impressions, posts.clicks, posts.engagement, posts.post_leads, ' +
    '  promos.uses AS promo_uses, promos.revenue AS promo_revenue, events.events, events.leads AS event_leads, events.visitors, events.sales AS event_sales, reqs.open AS open_requests ' +
    'FROM c LEFT JOIN leads ON leads.campaign_id = c.id LEFT JOIN sales ON sales.campaign_id = c.id LEFT JOIN spend ON spend.campaign_id = c.id ' +
    'LEFT JOIN posts ON posts.campaign_id = c.id LEFT JOIN promos ON promos.campaign_id = c.id LEFT JOIN events ON events.campaign_id = c.id LEFT JOIN reqs ON reqs.campaign_id = c.id',
    [ids]
  )).rows;
  rows.forEach(function (r) {
    var spent = S.num(r.paid) + S.num(r.committed);
    var revenue = S.num(r.revenue) + S.num(r.promo_revenue) + S.num(r.event_sales);
    var leads = r.leads || 0;
    out[r.id] = {
      spend: spent, paid: S.num(r.paid), committed: S.num(r.committed),
      budgetUsed: Number(r.budget) > 0 ? Math.round((spent / Number(r.budget)) * 100) : null,
      leads: leads, prospects: r.prospects || 0, won: r.won || 0, lost: r.lost || 0, buyers: r.buyers || 0,
      invoiced: S.num(r.revenue), promoUses: r.promo_uses || 0, promoRevenue: S.num(r.promo_revenue),
      events: r.events || 0, eventLeads: r.event_leads || 0, visitors: r.visitors || 0, eventSales: S.num(r.event_sales),
      revenue: revenue,
      posts: r.posts || 0, published: r.published || 0, reach: Number(r.reach || 0), impressions: Number(r.impressions || 0),
      clicks: Number(r.clicks || 0), engagement: Number(r.engagement || 0), postLeads: r.post_leads || 0,
      openRequests: r.open_requests || 0,
      costPerLead: leads > 0 && spent > 0 ? S.num(spent / leads) : null,
      roi: spent > 0 ? Math.round(((revenue - spent) / spent) * 100) : null
    };
  });
  return out;
}

// Where the campaign is in its life, from its status and its dates.
function phaseOf(r, today) {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'completed') return 'ended';
  if (r.status === 'draft') return 'draft';
  if (r.status === 'paused') return 'paused';
  if (r.end_date && r.end_date < today) return 'overdue';
  if (r.start_date && r.start_date > today) return 'upcoming';
  return r.status === 'active' ? 'running' : 'upcoming';
}

function rowOut(r, results, today) {
  return {
    id: r.id, name: r.name, description: r.description, status: r.status, phase: phaseOf(r, today),
    objective: r.objective, audience: r.audience, keyMessage: r.key_message, channels: r.channels || [],
    budget: S.num(r.budget), code: r.code || '', startDate: r.start_date, endDate: r.end_date,
    targetLeads: r.target_leads, targetRevenue: r.target_revenue === null ? null : S.num(r.target_revenue), targetReach: r.target_reach,
    review: r.review, owner: r.owner_id ? { id: r.owner_id, name: S.employeeName(r.owner_first, r.owner_last), photo: r.owner_photo ? new Date(r.owner_photo).getTime() : null } : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    results: results[r.id] || null
  };
}

var SELECT = 'SELECT c.*, e.first_name AS owner_first, e.last_name AS owner_last, CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END AS owner_photo ' +
  'FROM marketing_campaigns c LEFT JOIN employees e ON e.id = c.owner_id ';

// GET /api/mk/campaigns?company= — every campaign of the company with its
// results, newest first, and the totals across them.
async function list(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var rows = (await pool.query(SELECT + 'WHERE c.company_id = $1 ORDER BY coalesce(c.start_date, c.created_at::date) DESC, c.created_at DESC', [co.id])).rows;
  var results = await resultsFor(rows.map(function (r) { return r.id; }));
  var today = S.todayIso();
  var items = rows.map(function (r) { return rowOut(r, results, today); });
  var counted = items.filter(function (c) { return c.status !== 'cancelled' && c.status !== 'draft'; });
  function sum(f) { return counted.reduce(function (s, c) { return s + (c.results ? c.results[f] : 0); }, 0); }
  var spend = sum('spend'), revenue = sum('revenue'), leads = sum('leads');
  return {
    company: { code: co.code, name: co.name },
    campaigns: items,
    totals: {
      live: items.filter(function (c) { return c.phase === 'running'; }).length,
      budget: counted.reduce(function (s, c) { return s + c.budget; }, 0), spend: S.num(spend), leads: leads, won: sum('won'), revenue: S.num(revenue),
      costPerLead: leads > 0 && spend > 0 ? S.num(spend / leads) : null, roi: spend > 0 ? Math.round(((revenue - spend) / spend) * 100) : null
    }
  };
}

async function findRow(id) {
  var r = (await pool.query(SELECT + 'WHERE c.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Campaign not found.');
  return r;
}

// GET /api/mk/campaigns/:id — the campaign, its results, and everything
// behind them: its leads (for those who can see the CRM), posts, spend,
// events, promotions and requests.
async function get(ctx, id) {
  S.requireRead(ctx);
  var r = await findRow(id);
  var results = await resultsFor([id]);
  var out = rowOut(r, results, S.todayIso());
  var q = await Promise.all([
    ctx.can('crm.read') ? pool.query(
      'SELECT l.id, l.name, l.company, l.stage, l.received_on, l.source, l.item, l.campaign_id IS NOT NULL AS credited FROM crm_leads l ' +
      'WHERE l.campaign_id = $1 OR (l.campaign_id IS NULL AND $2::text <> \'\' AND lower(trim(l.source)) = lower(trim($2)) ' +
      'AND ($3::date IS NULL OR l.received_on >= $3) AND ($4::date IS NULL OR l.received_on <= $4::date + ' + LEAD_WINDOW_DAYS + ')) ' +
      'ORDER BY l.received_on DESC LIMIT 200', [id, r.code || '', r.start_date, r.end_date]) : { rows: null },
    pool.query('SELECT p.id, p.title, p.status, p.scheduled_at, p.published_at, p.reach, p.clicks, p.likes + p.comments + p.shares AS engagement, ch.name AS channel, ch.platform ' +
      'FROM marketing_posts p JOIN marketing_channels ch ON ch.id = p.channel_id WHERE p.campaign_id = $1 ORDER BY coalesce(p.published_at, p.scheduled_at, p.created_at) DESC LIMIT 100', [id]),
    pool.query('SELECT id, category, vendor, description, amount, spent_on, status FROM marketing_spend WHERE campaign_id = $1 ORDER BY spent_on DESC', [id]),
    pool.query('SELECT id, name, kind, starts_on, ends_on, status, leads_captured, visitors, sales FROM marketing_events WHERE campaign_id = $1 ORDER BY starts_on', [id]),
    pool.query('SELECT p.id, p.name, p.code, p.starts_on, p.ends_on, p.active, coalesce(sum(u.uses), 0)::int AS uses, coalesce(sum(u.revenue), 0) AS revenue ' +
      'FROM marketing_promotions p LEFT JOIN marketing_promotion_uses u ON u.promotion_id = p.id WHERE p.campaign_id = $1 GROUP BY p.id ORDER BY p.starts_on', [id]),
    pool.query('SELECT id, number, title, kind, status, due_on FROM marketing_requests WHERE campaign_id = $1 ORDER BY created_at DESC', [id])
  ]);
  out.leads = q[0].rows ? q[0].rows.map(function (l) {
    return { id: l.id, name: l.name, company: l.company, stage: l.stage, receivedOn: l.received_on, source: l.source, item: l.item, credited: l.credited };
  }) : null;
  out.posts = q[1].rows.map(function (p) {
    return { id: p.id, title: p.title, status: p.status, at: p.published_at || p.scheduled_at, reach: p.reach, clicks: p.clicks, engagement: p.engagement, channel: p.channel, platform: p.platform };
  });
  out.spend = q[2].rows.map(function (s) { return { id: s.id, category: s.category, vendor: s.vendor, description: s.description, amount: S.num(s.amount), spentOn: s.spent_on, status: s.status }; });
  out.events = q[3].rows.map(function (e) { return { id: e.id, name: e.name, kind: e.kind, startsOn: e.starts_on, endsOn: e.ends_on, status: e.status, leads: e.leads_captured, visitors: e.visitors, sales: S.num(e.sales) }; });
  out.promotions = q[4].rows.map(function (p) { return { id: p.id, name: p.name, code: p.code, startsOn: p.starts_on, endsOn: p.ends_on, active: p.active, uses: p.uses, revenue: S.num(p.revenue) }; });
  out.requests = q[5].rows.map(function (x) { return { id: x.id, number: x.number, title: x.title, kind: x.kind, status: x.status, dueOn: x.due_on }; });
  return out;
}

async function fields(p, co) {
  var name = S.text(p.name, 120);
  if (!name) fail('invalid', 'Give the campaign a name.');
  var start = S.dateOrNull(p.startDate, 'Start date'), end = S.dateOrNull(p.endDate, 'End date');
  if (start && end && end < start) fail('invalid', 'The campaign ends before it starts.');
  var owner = p.ownerId || null;
  if (owner && !(await pool.query('SELECT 1 FROM employees WHERE id = $1', [owner])).rows[0]) fail('invalid', 'Unknown owner.');
  var code = S.text(p.code, 40).replace(/\s+/g, '-');
  return {
    name: name, description: S.text(p.description, 2000), status: S.oneOf(p.status, STATUSES, 'Status', 'draft'),
    objective: S.oneOf(p.objective, OBJECTIVES, 'Objective', 'awareness'), audience: S.text(p.audience, 500), keyMessage: S.text(p.keyMessage, 500),
    channels: S.list(p.channels, S.CHANNELS), budget: S.money(p.budget || 0, 'Budget'), ownerId: owner, code: code || null,
    startDate: start, endDate: end, targetLeads: S.wholeOrNull(p.targetLeads, 'Target leads'),
    targetRevenue: S.money(p.targetRevenue, 'Target sales', { optional: true }), targetReach: S.wholeOrNull(p.targetReach, 'Target reach'),
    review: S.text(p.review, 4000), companyId: co.id
  };
}
function codeTaken(err) {
  if (err && err.code === '23505') fail('invalid', 'Another campaign already uses that tracking code.');
  throw err;
}

// POST /api/mk/campaigns
async function create(ctx, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var f = await fields(p, co);
  var r;
  try {
    r = (await pool.query(
      'INSERT INTO marketing_campaigns (company_id, name, description, status, objective, audience, key_message, channels, budget, owner_id, code, start_date, end_date, ' +
      'target_leads, target_revenue, target_reach, review, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id',
      [co.id, f.name, f.description, f.status, f.objective, f.audience, f.keyMessage, f.channels, f.budget, f.ownerId, f.code, f.startDate, f.endDate,
        f.targetLeads, f.targetRevenue, f.targetReach, f.review, ctx.employee.id])).rows[0];
  } catch (err) { codeTaken(err); }
  await audit(pool, ctx, 'marketing.campaign.create', 'marketing_campaign', r.id, 'Planned campaign ' + f.name + '.');
  return get(ctx, r.id);
}

// PUT /api/mk/campaigns/:id — the whole plan.
async function update(ctx, id, p) {
  S.requireManage(ctx);
  var row = await findRow(id);
  var f = await fields(p, { id: row.company_id });
  try {
    await pool.query(
      'UPDATE marketing_campaigns SET name = $2, description = $3, status = $4, objective = $5, audience = $6, key_message = $7, channels = $8, budget = $9, ' +
      'owner_id = $10, code = $11, start_date = $12, end_date = $13, target_leads = $14, target_revenue = $15, target_reach = $16, review = $17, updated_at = now() WHERE id = $1',
      [id, f.name, f.description, f.status, f.objective, f.audience, f.keyMessage, f.channels, f.budget, f.ownerId, f.code, f.startDate, f.endDate,
        f.targetLeads, f.targetRevenue, f.targetReach, f.review]);
  } catch (err) { codeTaken(err); }
  await audit(pool, ctx, 'marketing.campaign.update', 'marketing_campaign', id, 'Updated campaign ' + f.name + '.');
  return get(ctx, id);
}

// POST /api/mk/campaigns/:id/status { status, review? } — launch, pause,
// finish (with what was learned) or cancel.
async function setStatus(ctx, id, p) {
  S.requireManage(ctx);
  var row = await findRow(id);
  var status = S.oneOf(p.status, STATUSES, 'Status');
  var review = p.review === undefined ? row.review : S.text(p.review, 4000);
  await pool.query('UPDATE marketing_campaigns SET status = $2, review = $3, updated_at = now() WHERE id = $1', [id, status, review]);
  await audit(pool, ctx, 'marketing.campaign.status', 'marketing_campaign', id, row.name + ': ' + row.status + ' → ' + status + '.');
  return get(ctx, id);
}

// DELETE /api/mk/campaigns/:id — its posts, spend, leads, events and
// promotions stay, no longer tied to it.
async function remove(ctx, id) {
  S.requireManage(ctx);
  var row = await findRow(id);
  await pool.query('DELETE FROM marketing_campaigns WHERE id = $1', [id]);
  await audit(pool, ctx, 'marketing.campaign.delete', 'marketing_campaign', id, 'Deleted campaign ' + row.name + '.');
  return { ok: true };
}

// GET /api/mk/campaigns/:id/lead-candidates — leads received while the
// campaign ran (from a week before it), to credit to it: those credited
// to it, and those credited to no campaign.
async function leadCandidates(ctx, id) {
  S.requireRead(ctx);
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  var row = await findRow(id);
  var from = row.start_date ? row.start_date : S.iso(new Date(Date.now() - 60 * 86400000));
  var rows = (await pool.query(
    'SELECT l.id, l.name, l.company, l.stage, l.received_on, l.source, l.item, l.campaign_id FROM crm_leads l ' +
    'WHERE (l.campaign_id = $1 OR l.campaign_id IS NULL) AND l.received_on >= $2::date - 7 AND ($3::date IS NULL OR l.received_on <= $3::date + ' + LEAD_WINDOW_DAYS + ') ' +
    'ORDER BY l.received_on DESC LIMIT 300', [id, from, row.end_date])).rows;
  return rows.map(function (l) {
    return { id: l.id, name: l.name, company: l.company, stage: l.stage, receivedOn: l.received_on, source: l.source, item: l.item, credited: l.campaign_id === id };
  });
}

// POST /api/mk/campaigns/:id/leads { leadIds, credit } — credit leads to
// the campaign, or take the credit back. A lead credited to another
// campaign is left alone.
async function creditLeads(ctx, id, p) {
  S.requireManage(ctx);
  if (!ctx.can('crm.read')) fail('forbidden', 'Your role does not allow this action (crm.read).');
  var row = await findRow(id);
  var ids = S.list(p.leadIds).slice(0, 500);
  if (!ids.length) fail('invalid', 'Pick at least one lead.');
  var res = p.credit === false
    ? await pool.query('UPDATE crm_leads SET campaign_id = NULL WHERE id = ANY($1) AND campaign_id = $2', [ids, id])
    : await pool.query('UPDATE crm_leads SET campaign_id = $2 WHERE id = ANY($1) AND (campaign_id IS NULL OR campaign_id = $2)', [ids, id]);
  await audit(pool, ctx, 'marketing.campaign.leads', 'marketing_campaign', id,
    (p.credit === false ? 'Took ' : 'Credited ') + res.rowCount + ' lead(s) ' + (p.credit === false ? 'off ' : 'to ') + row.name + '.');
  return get(ctx, id);
}

// The campaigns to pick from elsewhere (spend, events, promotions, requests).
async function options(ctx, company) {
  var co = await S.company(company);
  return (await pool.query(
    "SELECT id, name, status, start_date, end_date FROM marketing_campaigns WHERE company_id = $1 AND status NOT IN ('cancelled') ORDER BY coalesce(start_date, created_at::date) DESC", [co.id]
  )).rows.map(function (r) { return { id: r.id, name: r.name, status: r.status, startDate: r.start_date, endDate: r.end_date }; });
}

module.exports = {
  list: list, get: get, create: create, update: update, setStatus: setStatus, remove: remove,
  leadCandidates: leadCandidates, creditLeads: creditLeads, options: options, resultsFor: resultsFor,
  STATUSES: STATUSES, OBJECTIVES: OBJECTIVES
};
