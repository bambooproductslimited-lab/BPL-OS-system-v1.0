var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var S = require('./mkShared');

// Events and promotions.
//
// An event — a trade fair, an exhibition, a launch, a showroom day, a
// tasting, a sponsorship — has its dates, venue, budget, owner and the
// campaign it belongs to; a checklist (a standard one for its kind, dated
// from the event, to start from); what it cost (the spend recorded
// against it, mkBudget.service.js); and afterwards how it went: visitors,
// leads captured, sales on the day and a few words on the outcome.
//
// A promotion — a discount code, a bundle, a free item — runs between two
// dates on some channels, maybe within a campaign; each time it is used
// (or at the end of the day, in a batch) the uses, the sales they brought
// and the discount given are logged, so it shows whether it paid.

var EVENT_KINDS = ['trade_fair', 'exhibition', 'launch', 'showroom', 'tasting', 'sponsorship', 'community', 'webinar', 'other'];
var EVENT_STATUSES = ['planned', 'confirmed', 'done', 'cancelled'];
var PROMO_KINDS = ['percent', 'amount', 'bundle', 'free_item', 'other'];

// The checklist an event starts with: [what, days from the start].
var CHECKLISTS = {
  stand: [['Book the stand or space', -45], ['Design the stand, banners and roll-ups', -21], ['Print flyers, brochures and price lists', -14],
    ['Rota the staff for the stand', -7], ['Pack samples, stand and lead forms', -2], ['Collect every visitor\'s details', 0],
    ['Enter the leads in the CRM', 2], ['Follow up every lead', 7], ['Write up how it went', 7]],
  launch: [['Fix the date and guest list', -30], ['Send the invitations', -14], ['Invite press and influencers', -10],
    ['Tease it on social media', -7], ['Photos and video on the day', 0], ['Post the thank-yous and photos', 1], ['Write up how it went', 5]],
  general: [['Confirm the venue and date', -21], ['Get the promotion material ready', -7], ['Post about it', -3],
    ['Photos on the day', 0], ['Write up how it went', 3]]
};
function checklistFor(kind) {
  if (kind === 'trade_fair' || kind === 'exhibition') return CHECKLISTS.stand;
  if (kind === 'launch' || kind === 'showroom') return CHECKLISTS.launch;
  return CHECKLISTS.general;
}
function addDays(isoDate, n) { var d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function eventOut(r, today) {
  var end = r.ends_on || r.starts_on;
  return {
    id: r.id, name: r.name, kind: r.kind, startsOn: r.starts_on, endsOn: r.ends_on, venue: r.venue, budget: S.num(r.budget), status: r.status,
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name } : null,
    owner: r.owner_id ? { id: r.owner_id, name: S.employeeName(r.owner_first, r.owner_last), photo: r.owner_photo ? new Date(r.owner_photo).getTime() : null } : null,
    targetLeads: r.target_leads, leadsCaptured: r.leads_captured, visitors: r.visitors, sales: S.num(r.sales), notes: r.notes, outcome: r.outcome,
    spent: S.num(r.spent), tasks: Number(r.tasks || 0), tasksDone: Number(r.tasks_done || 0), tasksLate: Number(r.tasks_late || 0),
    when: r.status === 'cancelled' ? 'cancelled' : end < today ? 'past' : r.starts_on <= today ? 'now' : 'upcoming',
    daysTo: Math.round((new Date(r.starts_on + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000),
    costPerLead: r.leads_captured > 0 && Number(r.spent) > 0 ? S.num(Number(r.spent) / r.leads_captured) : null
  };
}
var EVENT_SELECT = 'SELECT ev.*, c.name AS campaign_name, e.first_name AS owner_first, e.last_name AS owner_last, CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END AS owner_photo, ' +
  '(SELECT coalesce(sum(amount), 0) FROM marketing_spend s WHERE s.event_id = ev.id) AS spent, ' +
  '(SELECT count(*) FROM marketing_event_tasks t WHERE t.event_id = ev.id) AS tasks, ' +
  '(SELECT count(*) FROM marketing_event_tasks t WHERE t.event_id = ev.id AND t.done) AS tasks_done, ' +
  '(SELECT count(*) FROM marketing_event_tasks t WHERE t.event_id = ev.id AND NOT t.done AND t.due_on < current_date) AS tasks_late ' +
  'FROM marketing_events ev LEFT JOIN marketing_campaigns c ON c.id = ev.campaign_id LEFT JOIN employees e ON e.id = ev.owner_id ';

// GET /api/mk/events?company=
async function listEvents(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var today = S.todayIso();
  var rows = (await pool.query(EVENT_SELECT + 'WHERE ev.company_id = $1 ORDER BY ev.starts_on DESC', [co.id])).rows;
  var events = rows.map(function (r) { return eventOut(r, today); });
  var year = today.slice(0, 4);
  var thisYear = events.filter(function (e) { return e.startsOn.slice(0, 4) === year && e.status !== 'cancelled'; });
  return {
    company: { code: co.code, name: co.name }, canManage: ctx.can('marketing.manage'), events: events,
    totals: {
      upcoming: events.filter(function (e) { return e.when === 'upcoming' || e.when === 'now'; }).length,
      thisYear: thisYear.length, leads: thisYear.reduce(function (s, e) { return s + e.leadsCaptured; }, 0),
      visitors: thisYear.reduce(function (s, e) { return s + e.visitors; }, 0), sales: S.num(thisYear.reduce(function (s, e) { return s + e.sales; }, 0)),
      spent: S.num(thisYear.reduce(function (s, e) { return s + e.spent; }, 0))
    }
  };
}

async function eventRow(id) {
  var r = (await pool.query(EVENT_SELECT + 'WHERE ev.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Event not found.');
  return r;
}
// GET /api/mk/events/:id — with its checklist and spend.
async function getEvent(ctx, id) {
  S.requireRead(ctx);
  var r = await eventRow(id);
  var o = eventOut(r, S.todayIso());
  var q = await Promise.all([
    pool.query('SELECT t.*, e.first_name, e.last_name FROM marketing_event_tasks t LEFT JOIN employees e ON e.id = t.done_by WHERE t.event_id = $1 ORDER BY t.done, t.due_on NULLS LAST, t.sort', [id]),
    pool.query('SELECT id, category, vendor, description, amount, spent_on, status FROM marketing_spend WHERE event_id = $1 ORDER BY spent_on DESC', [id])
  ]);
  o.checklist = q[0].rows.map(function (t) { return { id: t.id, title: t.title, dueOn: t.due_on, done: t.done, doneBy: S.employeeName(t.first_name, t.last_name), doneAt: t.done_at }; });
  o.spend = q[1].rows.map(function (s) { return { id: s.id, category: s.category, vendor: s.vendor, description: s.description, amount: S.num(s.amount), spentOn: s.spent_on, status: s.status }; });
  o.canManage = ctx.can('marketing.manage');
  return o;
}

async function eventFields(p, companyId) {
  var name = S.text(p.name, 160);
  if (!name) fail('invalid', 'Give the event a name.');
  var startsOn = S.dateOrNull(p.startsOn, 'Start date');
  if (!startsOn) fail('invalid', 'Give the date it starts.');
  var endsOn = S.dateOrNull(p.endsOn, 'End date');
  if (endsOn && endsOn < startsOn) fail('invalid', 'The event ends before it starts.');
  if (p.campaignId) {
    var c = (await pool.query('SELECT company_id FROM marketing_campaigns WHERE id = $1', [p.campaignId])).rows[0];
    if (!c || c.company_id !== companyId) fail('invalid', 'That campaign is not this company\'s.');
  }
  return {
    name: name, kind: S.oneOf(p.kind, EVENT_KINDS, 'Kind', 'other'), startsOn: startsOn, endsOn: endsOn, venue: S.text(p.venue, 200),
    budget: S.money(p.budget || 0, 'Budget'), campaignId: p.campaignId || null, status: S.oneOf(p.status, EVENT_STATUSES, 'Status', 'planned'),
    ownerId: p.ownerId || null, targetLeads: S.wholeOrNull(p.targetLeads, 'Target leads'),
    leadsCaptured: S.wholeOrNull(p.leadsCaptured, 'Leads captured') || 0, visitors: S.wholeOrNull(p.visitors, 'Visitors') || 0,
    sales: S.money(p.sales || 0, 'Sales'), notes: S.text(p.notes, 4000), outcome: S.text(p.outcome, 4000)
  };
}

// POST /api/mk/events { …, checklist: true } — with the standard checklist for its kind.
async function createEvent(ctx, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var f = await eventFields(p, co.id);
  var id = await withTransaction(async function (db) {
    var r = (await db.query(
      'INSERT INTO marketing_events (company_id, name, kind, starts_on, ends_on, venue, budget, campaign_id, status, owner_id, target_leads, leads_captured, visitors, sales, notes, outcome, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id',
      [co.id, f.name, f.kind, f.startsOn, f.endsOn, f.venue, f.budget, f.campaignId, f.status, f.ownerId, f.targetLeads, f.leadsCaptured, f.visitors, f.sales, f.notes, f.outcome, ctx.employee.id])).rows[0];
    if (p.checklist !== false) {
      var items = checklistFor(f.kind);
      for (var i = 0; i < items.length; i++) {
        await db.query('INSERT INTO marketing_event_tasks (event_id, title, due_on, sort) VALUES ($1,$2,$3,$4)', [r.id, items[i][0], addDays(f.startsOn, items[i][1]), i]);
      }
    }
    await audit(db, ctx, 'marketing.event.create', 'marketing_event', r.id, 'Planned event ' + f.name + ' on ' + f.startsOn + '.');
    return r.id;
  });
  return getEvent(ctx, id);
}

// PUT /api/mk/events/:id
async function updateEvent(ctx, id, p) {
  S.requireManage(ctx);
  var row = await eventRow(id);
  var f = await eventFields(p, row.company_id);
  await pool.query(
    'UPDATE marketing_events SET name = $2, kind = $3, starts_on = $4, ends_on = $5, venue = $6, budget = $7, campaign_id = $8, status = $9, owner_id = $10, target_leads = $11, ' +
    'leads_captured = $12, visitors = $13, sales = $14, notes = $15, outcome = $16, updated_at = now() WHERE id = $1',
    [id, f.name, f.kind, f.startsOn, f.endsOn, f.venue, f.budget, f.campaignId, f.status, f.ownerId, f.targetLeads, f.leadsCaptured, f.visitors, f.sales, f.notes, f.outcome]);
  await audit(pool, ctx, 'marketing.event.update', 'marketing_event', id, 'Updated event ' + f.name + '.');
  return getEvent(ctx, id);
}
async function removeEvent(ctx, id) {
  S.requireManage(ctx);
  var row = await eventRow(id);
  await pool.query('DELETE FROM marketing_events WHERE id = $1', [id]);
  await audit(pool, ctx, 'marketing.event.delete', 'marketing_event', id, 'Deleted event ' + row.name + '.');
  return { ok: true };
}

// POST /api/mk/events/:id/tasks { title, dueOn }
async function addTask(ctx, id, p) {
  S.requireManage(ctx);
  await eventRow(id);
  var title = S.text(p.title, 200);
  if (!title) fail('invalid', 'Say what needs doing.');
  await pool.query('INSERT INTO marketing_event_tasks (event_id, title, due_on, sort) VALUES ($1,$2,$3, (SELECT coalesce(max(sort), 0) + 1 FROM marketing_event_tasks WHERE event_id = $1))',
    [id, title, S.dateOrNull(p.dueOn, 'Due date')]);
  return getEvent(ctx, id);
}
// POST /api/mk/events/:id/tasks/:taskId { done }
async function setTask(ctx, id, taskId, p) {
  S.requireManage(ctx);
  var res = await pool.query('UPDATE marketing_event_tasks SET done = $3, done_by = CASE WHEN $3 THEN $4::uuid END, done_at = CASE WHEN $3 THEN now() END WHERE id = $2 AND event_id = $1',
    [id, taskId, !!p.done, ctx.employee.id]);
  if (!res.rowCount) fail('notfound', 'Task not found.');
  return getEvent(ctx, id);
}
async function removeTask(ctx, id, taskId) {
  S.requireManage(ctx);
  await pool.query('DELETE FROM marketing_event_tasks WHERE id = $2 AND event_id = $1', [id, taskId]);
  return getEvent(ctx, id);
}

// ── promotions ────────────────────────────────────────────────────────
function promoOut(r, today) {
  var state = !r.active ? 'paused' : r.starts_on > today ? 'upcoming' : r.ends_on && r.ends_on < today ? 'ended' : 'running';
  var uses = Number(r.uses || 0), revenue = S.num(r.revenue), discount = S.num(r.discount);
  return {
    id: r.id, name: r.name, code: r.code || '', kind: r.kind, value: r.value === null ? null : S.num(r.value), details: r.details,
    startsOn: r.starts_on, endsOn: r.ends_on, channels: r.channels || [], active: r.active, targetUses: r.target_uses, state: state,
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name } : null,
    uses: uses, revenue: revenue, discount: discount, averageSale: uses > 0 ? S.num(revenue / uses) : null,
    daysLeft: r.ends_on && state === 'running' ? Math.round((new Date(r.ends_on + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000) : null,
    lastUsed: r.last_used
  };
}
var PROMO_SELECT = 'SELECT p.*, c.name AS campaign_name, coalesce(sum(u.uses), 0) AS uses, coalesce(sum(u.revenue), 0) AS revenue, coalesce(sum(u.discount), 0) AS discount, max(u.used_on) AS last_used ' +
  'FROM marketing_promotions p LEFT JOIN marketing_campaigns c ON c.id = p.campaign_id LEFT JOIN marketing_promotion_uses u ON u.promotion_id = p.id ';

// GET /api/mk/promotions?company=
async function listPromotions(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var today = S.todayIso();
  var rows = (await pool.query(PROMO_SELECT + 'WHERE p.company_id = $1 GROUP BY p.id, c.name ORDER BY p.starts_on DESC', [co.id])).rows;
  var promos = rows.map(function (r) { return promoOut(r, today); });
  return {
    company: { code: co.code, name: co.name }, canManage: ctx.can('marketing.manage'), promotions: promos,
    totals: {
      running: promos.filter(function (p) { return p.state === 'running'; }).length,
      uses: promos.reduce(function (s, p) { return s + p.uses; }, 0), revenue: S.num(promos.reduce(function (s, p) { return s + p.revenue; }, 0)),
      discount: S.num(promos.reduce(function (s, p) { return s + p.discount; }, 0))
    }
  };
}
async function promoRow(id) {
  var r = (await pool.query(PROMO_SELECT + 'WHERE p.id = $1 GROUP BY p.id, c.name', [id])).rows[0];
  if (!r) fail('notfound', 'Promotion not found.');
  return r;
}
// GET /api/mk/promotions/:id — with every use logged.
async function getPromotion(ctx, id) {
  S.requireRead(ctx);
  var o = promoOut(await promoRow(id), S.todayIso());
  o.log = (await pool.query('SELECT u.*, e.first_name, e.last_name FROM marketing_promotion_uses u JOIN employees e ON e.id = u.created_by WHERE u.promotion_id = $1 ORDER BY u.used_on DESC, u.created_at DESC', [id])).rows
    .map(function (u) { return { id: u.id, usedOn: u.used_on, uses: u.uses, revenue: S.num(u.revenue), discount: S.num(u.discount), note: u.note, by: S.employeeName(u.first_name, u.last_name) }; });
  o.canManage = ctx.can('marketing.manage');
  return o;
}
async function promoFields(p, companyId) {
  var name = S.text(p.name, 160);
  if (!name) fail('invalid', 'Give the promotion a name.');
  var startsOn = S.dateOrNull(p.startsOn, 'Start date');
  if (!startsOn) fail('invalid', 'Give the date it starts.');
  var endsOn = S.dateOrNull(p.endsOn, 'End date');
  if (endsOn && endsOn < startsOn) fail('invalid', 'The promotion ends before it starts.');
  var kind = S.oneOf(p.kind, PROMO_KINDS, 'Kind', 'percent');
  var value = S.money(p.value, 'Value', { optional: true });
  if (kind === 'percent' && value !== null && value > 100) fail('invalid', 'A percentage off cannot be more than 100.');
  if (p.campaignId) {
    var c = (await pool.query('SELECT company_id FROM marketing_campaigns WHERE id = $1', [p.campaignId])).rows[0];
    if (!c || c.company_id !== companyId) fail('invalid', 'That campaign is not this company\'s.');
  }
  return {
    name: name, code: S.text(p.code, 40).toUpperCase().replace(/\s+/g, '') || null, kind: kind, value: value, details: S.text(p.details, 2000),
    startsOn: startsOn, endsOn: endsOn, channels: S.list(p.channels, S.CHANNELS), campaignId: p.campaignId || null,
    active: p.active !== false, targetUses: S.wholeOrNull(p.targetUses, 'Target uses')
  };
}
async function createPromotion(ctx, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var f = await promoFields(p, co.id);
  var r = (await pool.query(
    'INSERT INTO marketing_promotions (company_id, name, code, kind, value, details, starts_on, ends_on, channels, campaign_id, active, target_uses, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
    [co.id, f.name, f.code, f.kind, f.value, f.details, f.startsOn, f.endsOn, f.channels, f.campaignId, f.active, f.targetUses, ctx.employee.id])).rows[0];
  await audit(pool, ctx, 'marketing.promotion.create', 'marketing_promotion', r.id, 'Promotion ' + f.name + (f.code ? ' (' + f.code + ')' : '') + ' from ' + f.startsOn + '.');
  return getPromotion(ctx, r.id);
}
async function updatePromotion(ctx, id, p) {
  S.requireManage(ctx);
  var row = await promoRow(id);
  var f = await promoFields(p, row.company_id);
  await pool.query(
    'UPDATE marketing_promotions SET name = $2, code = $3, kind = $4, value = $5, details = $6, starts_on = $7, ends_on = $8, channels = $9, campaign_id = $10, active = $11, target_uses = $12, updated_at = now() WHERE id = $1',
    [id, f.name, f.code, f.kind, f.value, f.details, f.startsOn, f.endsOn, f.channels, f.campaignId, f.active, f.targetUses]);
  await audit(pool, ctx, 'marketing.promotion.update', 'marketing_promotion', id, 'Updated promotion ' + f.name + '.');
  return getPromotion(ctx, id);
}
async function removePromotion(ctx, id) {
  S.requireManage(ctx);
  var row = await promoRow(id);
  await pool.query('DELETE FROM marketing_promotions WHERE id = $1', [id]);
  await audit(pool, ctx, 'marketing.promotion.delete', 'marketing_promotion', id, 'Deleted promotion ' + row.name + '.');
  return { ok: true };
}
// POST /api/mk/promotions/:id/uses { usedOn, uses, revenue, discount, note }
async function logUse(ctx, id, p) {
  S.requireManage(ctx);
  var row = await promoRow(id);
  var usedOn = S.dateOrNull(p.usedOn, 'Date') || S.todayIso();
  if (usedOn > S.todayIso()) fail('invalid', 'That date has not come yet.');
  var uses = S.wholeOrNull(p.uses, 'Times used');
  if (!uses) fail('invalid', 'Say how many times it was used.');
  await pool.query('INSERT INTO marketing_promotion_uses (promotion_id, used_on, uses, revenue, discount, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, usedOn, uses, S.money(p.revenue || 0, 'Sales'), S.money(p.discount || 0, 'Discount given'), S.text(p.note, 300), ctx.employee.id]);
  await audit(pool, ctx, 'marketing.promotion.use', 'marketing_promotion', id, row.name + ' used ' + uses + ' time(s) on ' + usedOn + '.');
  return getPromotion(ctx, id);
}
async function removeUse(ctx, id, useId) {
  S.requireManage(ctx);
  await pool.query('DELETE FROM marketing_promotion_uses WHERE id = $2 AND promotion_id = $1', [id, useId]);
  return getPromotion(ctx, id);
}

module.exports = {
  listEvents: listEvents, getEvent: getEvent, createEvent: createEvent, updateEvent: updateEvent, removeEvent: removeEvent,
  addTask: addTask, setTask: setTask, removeTask: removeTask,
  listPromotions: listPromotions, getPromotion: getPromotion, createPromotion: createPromotion, updatePromotion: updatePromotion, removePromotion: removePromotion,
  logUse: logUse, removeUse: removeUse, EVENT_KINDS: EVENT_KINDS, PROMO_KINDS: PROMO_KINDS, CHECKLISTS: CHECKLISTS
};
