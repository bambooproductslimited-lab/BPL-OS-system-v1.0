/*
 * CRM customer profiles: the customers (the same clients invoices and
 * quotations point at) seen whole — every way to reach them, every
 * conversation on every channel, their quotations, orders, invoices and
 * payments, leads and deals, their sales rep and when to follow up.
 *
 * A profile's sales rep is customers.account_manager_id. Giving customers
 * to reps needs crm.assign; a rep (crm.manage) may take an unassigned
 * customer for themselves.
 */
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { bplScopeClause } = require('../utils/documents');
var inbox = require('./crmInbox.service');

var CATEGORIES = ['lead', 'prospect', 'active', 'vip'];

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx && ctx.employee ? ctx.employee.id : null; }
function str(v, max) { v = v == null ? '' : String(v).trim(); return max ? v.slice(0, max) : v; }
function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function like(q) { return '%' + String(q || '').trim().replace(/[\\%_]/g, '\\$&') + '%'; }
function photoOf(key, at) { return key && at ? new Date(at).getTime() : null; }

// The customers the CRM holds (Bamboo Products' for now).
var SCOPE = bplScopeClause('c');

// ── the list ─────────────────────────────────────────────────────────
var LIST_SQL =
  'SELECT c.*, e.first_name AS rep_first, e.last_name AS rep_last, e.photo_key AS rep_photo_key, e.photo_updated_at AS rep_photo_at, ' +
  '  cv.channels, cv.conversations, cv.waiting_since, ' +
  '  inv.invoices, inv.lifetime, inv.outstanding, inv.overdue, q.open_quotes, ' +
  '  (SELECT count(*)::int FROM crm_duplicate_suggestions d WHERE d.status = \'open\' AND (d.a_id = c.id OR d.b_id = c.id)) AS duplicates ' +
  'FROM customers c LEFT JOIN employees e ON e.id = c.account_manager_id ' +
  'LEFT JOIN LATERAL (SELECT array_agg(DISTINCT channel) AS channels, count(*)::int AS conversations, ' +
  "   min(last_message_at) FILTER (WHERE last_direction = 'in' AND status = 'open') AS waiting_since FROM crm_conversations WHERE customer_id = c.id) cv ON true " +
  "LEFT JOIN LATERAL (SELECT count(*)::int AS invoices, COALESCE(sum(grand_total), 0) AS lifetime, COALESCE(sum(balance_due), 0) AS outstanding, " +
  "   COALESCE(sum(balance_due) FILTER (WHERE due_date < CURRENT_DATE), 0) AS overdue FROM invoices WHERE customer_id = c.id AND status <> 'void') inv ON true " +
  "LEFT JOIN LATERAL (SELECT count(*)::int AS open_quotes FROM quotations WHERE customer_id = c.id AND status IN ('sent', 'viewed') AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)) q ON true ";

function rowToProfile(r) {
  return {
    id: r.id, name: r.name, contactPerson: r.contact_person, phone: r.phone, email: r.email, location: r.location || '', address: r.address,
    category: r.category, status: r.status, source: r.source, origin: r.origin_channel || '', notes: r.notes,
    rep: r.account_manager_id ? { id: r.account_manager_id, name: (r.rep_first || '') + ' ' + (r.rep_last || ''), photo: photoOf(r.rep_photo_key, r.rep_photo_at) } : null,
    repAssignedAt: r.rep_assigned_at,
    followUpOn: day(r.follow_up_on), followUpNote: r.follow_up_note || '',
    lastContactAt: r.last_contact_at, lastInboundAt: r.last_inbound_at, lastOutboundAt: r.last_outbound_at,
    waitingSince: r.waiting_since || null,
    marketingOptOut: !!r.marketing_opt_out, createdAt: r.created_at,
    channels: (r.channels || []).filter(Boolean), conversations: r.conversations || 0,
    invoices: r.invoices || 0, lifetime: Number(r.lifetime || 0), outstanding: Number(r.outstanding || 0), overdue: Number(r.overdue || 0),
    openQuotes: r.open_quotes || 0, duplicates: r.duplicates || 0
  };
}

async function listProfiles(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var where = [SCOPE], args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  where.push("c.status = " + arg(q.status === 'inactive' ? 'inactive' : 'active'));
  if (q.rep === 'me') where.push('c.account_manager_id = ' + arg(me(ctx)));
  else if (q.rep === 'none') where.push('c.account_manager_id IS NULL');
  else if (q.rep) where.push('c.account_manager_id = ' + arg(q.rep));
  if (CATEGORIES.indexOf(q.category) >= 0) where.push('c.category = ' + arg(q.category));
  if (q.followUp === 'due') where.push('c.follow_up_on <= CURRENT_DATE');
  if (q.waiting === '1') where.push("EXISTS (SELECT 1 FROM crm_conversations w WHERE w.customer_id = c.id AND w.status = 'open' AND w.last_direction = 'in')");
  if (q.channel && inbox.CHANNELS.indexOf(q.channel) >= 0) where.push('EXISTS (SELECT 1 FROM crm_conversations w WHERE w.customer_id = c.id AND w.channel = ' + arg(q.channel) + ')');
  if (q.search) {
    var s = arg(like(q.search));
    // A number in any form: "020 555 0420" finds +233 20 555 0420.
    var digits = String(q.search).replace(/\D/g, '');
    if (digits.length >= 9) digits = require('../utils/phone').internationalNumber(digits) || digits;
    where.push('(c.name ILIKE ' + s + ' OR c.contact_person ILIKE ' + s + ' OR c.email ILIKE ' + s + ' OR c.phone ILIKE ' + s + ' OR c.location ILIKE ' + s +
      ' OR EXISTS (SELECT 1 FROM customer_identities i WHERE i.customer_id = c.id AND (i.label ILIKE ' + s + (digits.length >= 4 ? ' OR i.value LIKE ' + arg('%' + digits + '%') : '') + ')))');
  }
  var order = q.sort === 'name' ? 'c.name' : q.sort === 'value' ? 'inv.lifetime DESC NULLS LAST, c.name' : 'COALESCE(cv.waiting_since, c.last_contact_at, c.created_at) DESC NULLS LAST, c.name';
  var limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
  var rows = (await pool.query(LIST_SQL + 'WHERE ' + where.join(' AND ') + ' ORDER BY ' + order + ' LIMIT ' + limit, args)).rows;
  var sum = (await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE c.account_manager_id = $1)::int AS mine, count(*) FILTER (WHERE c.account_manager_id IS NULL)::int AS unassigned, " +
    "count(*) FILTER (WHERE c.follow_up_on <= CURRENT_DATE)::int AS follow_up_due, " +
    "count(*) FILTER (WHERE EXISTS (SELECT 1 FROM crm_conversations w WHERE w.customer_id = c.id AND w.status = 'open' AND w.last_direction = 'in'))::int AS waiting, " +
    "count(*) FILTER (WHERE c.source = 'crm')::int AS from_conversations, " +
    "(SELECT count(*)::int FROM crm_duplicate_suggestions WHERE status = 'open') AS duplicates " +
    "FROM customers c WHERE " + SCOPE + " AND c.status = 'active'", [me(ctx)])).rows[0];
  return { profiles: rows.map(rowToProfile), summary: sum };
}

// ── one profile, whole ───────────────────────────────────────────────
async function loadProfile(id) {
  var r = (await pool.query(LIST_SQL + 'WHERE c.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Customer not found.');
  return r;
}

async function getProfile(ctx, id) {
  need(ctx, 'crm.read');
  var r = await loadProfile(id);
  var q = await Promise.all([
    pool.query('SELECT id, kind, value, label, created_at FROM customer_identities WHERE customer_id = $1 ORDER BY kind, created_at', [id]),
    pool.query('SELECT * FROM crm_conversations WHERE customer_id = $1 ORDER BY last_message_at DESC NULLS LAST', [id]),
    pool.query(
      "SELECT m.id, m.direction, m.author_name, m.body, m.sent_at, m.attachments, cv.channel, cv.id AS conversation_id, cv.subject, e.first_name || ' ' || e.last_name AS sent_by_name " +
      'FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id LEFT JOIN employees e ON e.id = m.sent_by ' +
      'WHERE cv.customer_id = $1 ORDER BY m.sent_at DESC LIMIT 300', [id]),
    pool.query("SELECT id, quote_no, title, status, grand_total, currency, created_at, valid_until, sent_at FROM quotations WHERE customer_id = $1 ORDER BY created_at DESC", [id]),
    pool.query("SELECT so.id, so.order_no, so.status, so.total, so.currency, so.created_at, so.rep_id, e.first_name || ' ' || e.last_name AS rep_name " +
      'FROM sales_orders so LEFT JOIN employees e ON e.id = so.rep_id WHERE so.customer_id = $1 ORDER BY so.created_at DESC', [id]),
    pool.query("SELECT id, invoice_no, status, grand_total, balance_due, currency, issued_at, due_date, sales_order_id FROM invoices WHERE customer_id = $1 AND status <> 'void' ORDER BY issued_at DESC", [id]),
    pool.query('SELECT id, amount, currency, date, method FROM payments WHERE customer_id = $1 ORDER BY date DESC LIMIT 100', [id]),
    pool.query("SELECT l.id, l.ref, l.name, l.item, l.stage, l.next_follow_up, l.received_on, e.first_name || ' ' || e.last_name AS rep_name FROM crm_leads l LEFT JOIN employees e ON e.id = l.rep_id WHERE l.customer_id = $1 ORDER BY l.received_on DESC", [id]),
    // What they buy and ask prices for: the lines of their invoices and quotations.
    pool.query(
      "SELECT li.description AS name, sum(li.qty) AS qty, count(DISTINCT li.document_id)::int AS times, max(li.document_type) AS kind FROM document_line_items li " +
      "WHERE (li.document_type = 'invoice' AND li.document_id IN (SELECT id FROM invoices WHERE customer_id = $1 AND status <> 'void')) " +
      "   OR (li.document_type = 'quotation' AND li.document_id IN (SELECT id FROM quotations WHERE customer_id = $1)) " +
      "GROUP BY li.description ORDER BY count(DISTINCT li.document_id) DESC, sum(li.qty) DESC LIMIT 8", [id]),
    pool.query(
      "SELECT d.id, d.score, d.reasons, d.suggestion, CASE WHEN d.a_id = $1 THEN d.b_id ELSE d.a_id END AS other_id, o.name AS other_name " +
      "FROM crm_duplicate_suggestions d JOIN customers o ON o.id = CASE WHEN d.a_id = $1 THEN d.b_id ELSE d.a_id END WHERE d.status = 'open' AND (d.a_id = $1 OR d.b_id = $1)", [id]),
    pool.query('SELECT merged_name, merged_at, moved FROM customer_merges WHERE kept_id = $1 ORDER BY merged_at DESC', [id])
  ]);
  var timeline = [];
  q[2].rows.forEach(function (m) {
    timeline.push({ kind: 'message', at: m.sent_at, channel: m.channel, direction: m.direction, author: m.author_name, body: m.body, conversationId: m.conversation_id, subject: m.subject, sentBy: m.sent_by_name || null });
  });
  q[3].rows.forEach(function (x) { timeline.push({ kind: 'quotation', at: x.sent_at || x.created_at, id: x.id, ref: x.quote_no, title: x.title, status: x.status, amount: Number(x.grand_total), currency: x.currency }); });
  q[4].rows.forEach(function (x) { timeline.push({ kind: 'order', at: x.created_at, id: x.id, ref: x.order_no, status: x.status, amount: Number(x.total), currency: x.currency, rep: x.rep_name }); });
  q[5].rows.forEach(function (x) { timeline.push({ kind: 'invoice', at: x.issued_at, id: x.id, ref: x.invoice_no, status: x.status, amount: Number(x.grand_total), balance: Number(x.balance_due), currency: x.currency }); });
  q[6].rows.forEach(function (x) { timeline.push({ kind: 'payment', at: x.date, id: x.id, amount: Number(x.amount), currency: x.currency, method: x.method }); });
  q[7].rows.forEach(function (x) { timeline.push({ kind: 'lead', at: x.received_on, id: x.id, ref: x.ref, title: x.item, status: x.stage }); });
  q[10].rows.forEach(function (x) { timeline.push({ kind: 'merge', at: x.merged_at, title: x.merged_name, moved: x.moved }); });
  timeline.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });

  var followUps = await require('./crmFollowUps.service').reasonsForCustomer(id);
  return Object.assign(rowToProfile(r), {
    identities: q[0].rows.map(function (i) { return { id: i.id, kind: i.kind, value: i.value, label: i.label }; }),
    threads: q[1].rows.map(function (c) {
      return { id: c.id, channel: c.channel, subject: c.subject, status: c.status, messageCount: c.message_count, lastMessageAt: c.last_message_at, lastDirection: c.last_direction, lastPreview: c.last_preview, contact: c.contact_label || c.contact_name };
    }),
    quotations: q[3].rows.map(function (x) { return { id: x.id, ref: x.quote_no, title: x.title, status: x.status, amount: Number(x.grand_total), currency: x.currency, createdAt: x.created_at, validUntil: day(x.valid_until) }; }),
    orders: q[4].rows.map(function (x) { return { id: x.id, ref: x.order_no, status: x.status, amount: Number(x.total), currency: x.currency, createdAt: x.created_at, rep: x.rep_id ? { id: x.rep_id, name: x.rep_name } : null }; }),
    invoiceList: q[5].rows.map(function (x) { return { id: x.id, ref: x.invoice_no, status: x.status, amount: Number(x.grand_total), balance: Number(x.balance_due), currency: x.currency, issuedAt: day(x.issued_at), dueDate: day(x.due_date), salesOrderId: x.sales_order_id }; }),
    leads: q[7].rows.map(function (x) { return { id: x.id, ref: x.ref, item: x.item, stage: x.stage, nextFollowUp: day(x.next_follow_up), receivedOn: day(x.received_on), rep: x.rep_name }; }),
    interests: q[8].rows.map(function (x) { return { name: x.name, qty: Number(x.qty), times: x.times, bought: x.kind === 'quotation' ? false : true }; }),
    duplicateOf: q[9].rows.map(function (x) { return { suggestionId: x.id, id: x.other_id, name: x.other_name, score: x.score, reasons: x.reasons, suggestion: x.suggestion }; }),
    followUps: followUps,
    timeline: timeline.slice(0, 400)
  });
}

// ── changing a profile ───────────────────────────────────────────────
async function updateProfile(ctx, id, p) {
  need(ctx, 'crm.manage');
  var cur = await loadProfile(id);
  var name = p.name !== undefined ? str(p.name, 200) : cur.name;
  if (!name) fail('invalid', 'Give the customer a name.');
  var category = p.category !== undefined ? V.oneOf(p.category, CATEGORIES, 'Category') : cur.category;
  var phone = p.phone !== undefined ? str(p.phone, 60) : cur.phone;
  var email = p.email !== undefined ? str(p.email, 200) : cur.email;
  if (email && !inbox.isEmail(email)) fail('invalid', 'That email address isn\'t right.');
  await withTransaction(async function (db) {
    await db.query(
      'UPDATE customers SET name = $2, contact_person = $3, phone = $4, email = $5, location = $6, address = $7, category = $8, notes = $9, marketing_opt_out = $10 WHERE id = $1',
      [id, name, p.contactPerson !== undefined ? str(p.contactPerson, 200) : cur.contact_person, phone, email,
        p.location !== undefined ? str(p.location, 200) : cur.location, p.address !== undefined ? str(p.address, 500) : cur.address,
        category, p.notes !== undefined ? str(p.notes, 4000) : cur.notes, p.marketingOptOut !== undefined ? !!p.marketingOptOut : cur.marketing_opt_out]);
    var ids = [];
    if (phone !== cur.phone) String(phone).split(/[\/,;]/).forEach(function (x) { var n = inbox.normIdentity({ kind: 'phone', value: x }); if (n) ids.push(n); });
    if (email !== cur.email) { var e = inbox.normIdentity({ kind: 'email', value: email }); if (e) ids.push(e); }
    await inbox.addIdentities(db, id, ids);
    await audit(db, ctx, 'crm.profile.update', 'customer', id, 'Updated the profile of ' + name + '.');
  });
  return getProfile(ctx, id);
}

async function addIdentity(ctx, id, p) {
  need(ctx, 'crm.manage');
  await loadProfile(id);
  var n = inbox.normIdentity(p);
  if (!n) fail('invalid', p && p.kind === 'phone' ? 'That isn\'t a phone number.' : p && p.kind === 'email' ? 'That isn\'t an email address.' : 'Give the number, address or account.');
  var other = (await pool.query('SELECT c.id, c.name FROM customer_identities i JOIN customers c ON c.id = i.customer_id WHERE i.kind = $1 AND i.value = $2', [n.kind, n.value])).rows[0];
  if (other && other.id !== id) fail('conflict', n.label + ' already belongs to ' + other.name + '. If they are the same customer, merge the two profiles.');
  await inbox.addIdentities(pool, id, [n]);
  await audit(pool, ctx, 'crm.identity.add', 'customer', id, 'Added ' + n.label + ' to a customer profile.');
  return getProfile(ctx, id);
}
async function removeIdentity(ctx, id, identityId) {
  need(ctx, 'crm.manage');
  var r = (await pool.query('DELETE FROM customer_identities WHERE id = $1 AND customer_id = $2 RETURNING label', [identityId, id])).rows[0];
  if (!r) fail('notfound', 'Not found.');
  await audit(pool, ctx, 'crm.identity.remove', 'customer', id, 'Removed ' + r.label + ' from a customer profile.');
  return getProfile(ctx, id);
}

// A follow-up date (and what for); empty clears it.
async function setFollowUp(ctx, id, p) {
  need(ctx, 'crm.manage');
  var cur = await loadProfile(id);
  var on = p && p.on ? V.date(p.on, 'Follow-up date') : null;
  var note = str(p && p.note, 500);
  await pool.query('UPDATE customers SET follow_up_on = $2, follow_up_note = $3 WHERE id = $1', [id, on, on ? note : '']);
  await audit(pool, ctx, 'crm.follow_up', 'customer', id, on ? 'Follow up with ' + cur.name + ' on ' + on + (note ? ': ' + note : '') + '.' : 'Follow-up with ' + cur.name + ' done.');
  if (on && cur.account_manager_id && cur.account_manager_id !== me(ctx)) {
    await notify(pool, cur.account_manager_id, 'Follow up with ' + cur.name + ' on ' + on, note || 'Set by ' + (ctx.employee ? ctx.employee.first_name : 'a colleague') + '.', '/crmcustomers?id=' + id);
  }
  return getProfile(ctx, id);
}

// ── sales reps ───────────────────────────────────────────────────────
// Who can be given customers: the sales representatives, and anyone else
// who works the CRM and already has customers.
async function reps(ctx) {
  need(ctx, 'crm.read');
  var rows = (await pool.query(
    "SELECT e.id, e.first_name, e.last_name, e.position_title, e.photo_key, e.photo_updated_at, " +
    "  bool_or(r.key = 'sales_rep') AS is_rep, " +
    "  (SELECT count(*)::int FROM customers c WHERE c.account_manager_id = e.id AND c.status = 'active') AS customers, " +
    "  (SELECT count(*)::int FROM customers c WHERE c.account_manager_id = e.id AND c.status = 'active' AND c.follow_up_on <= CURRENT_DATE) AS follow_ups_due " +
    "FROM employees e JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id " +
    "LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = 'crm.manage' " +
    "WHERE e.status = 'active' AND u.status = 'active' AND (r.key = 'sales_rep' OR rp.permission_key IS NOT NULL) " +
    "GROUP BY e.id ORDER BY bool_or(r.key = 'sales_rep') DESC, e.first_name")).rows;
  return rows.map(function (r) {
    return { id: r.id, name: r.first_name + ' ' + r.last_name, title: r.position_title || '', photo: photoOf(r.photo_key, r.photo_updated_at), isRep: !!r.is_rep, customers: r.customers, followUpsDue: r.follow_ups_due };
  });
}

// Gives customers to a rep (or takes them from one, repId null).
async function assignRep(ctx, p) {
  var ids = Array.from(new Set((p && p.customerIds) || [])).filter(Boolean);
  if (!ids.length) fail('invalid', 'Choose the customers.');
  if (ids.length > 500) fail('invalid', 'At most 500 at a time.');
  var repId = p.repId || null;
  var selfTake = repId && repId === me(ctx) && !ctx.can('crm.assign');
  if (!ctx.can('crm.assign')) {
    need(ctx, 'crm.manage');
    if (!selfTake) fail('forbidden', 'Your role does not allow this action (crm.assign).');
    var taken = (await pool.query('SELECT count(*)::int AS n FROM customers WHERE id = ANY($1) AND account_manager_id IS NOT NULL AND account_manager_id <> $2', [ids, repId])).rows[0].n;
    if (taken) fail('forbidden', 'Some of these customers already have a rep. Ask a sales manager to move them.');
  }
  var rep = null;
  if (repId) {
    rep = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE id = $1 AND status = 'active'", [repId])).rows[0];
    if (!rep) fail('invalid', 'That rep isn\'t an active employee.');
  }
  var changed = (await pool.query(
    'UPDATE customers c SET account_manager_id = $2, rep_assigned_at = now() WHERE c.id = ANY($1) AND ' + SCOPE +
    ' AND c.account_manager_id IS DISTINCT FROM $2 RETURNING c.id, c.name', [ids, repId])).rows;
  if (changed.length) {
    await audit(pool, ctx, 'crm.assign', 'customer', changed.length === 1 ? changed[0].id : 'many',
      (rep ? 'Gave ' + changed.length + ' customer(s) to ' + rep.first_name + ' ' + rep.last_name : 'Took the rep off ' + changed.length + ' customer(s)') +
      ': ' + changed.slice(0, 10).map(function (c) { return c.name; }).join(', ') + (changed.length > 10 ? ' …' : '') + '.');
    if (rep && repId !== me(ctx)) {
      await notify(pool, repId, changed.length === 1 ? changed[0].name + ' is now your customer' : changed.length + ' customers are now yours',
        changed.slice(0, 5).map(function (c) { return c.name; }).join(', ') + (changed.length > 5 ? ' and more' : '') + '.',
        changed.length === 1 ? '/crmcustomers?id=' + changed[0].id : '/crmcustomers?rep=me');
    }
  }
  return { changed: changed.length };
}

module.exports = {
  CATEGORIES: CATEGORIES, SCOPE: SCOPE,
  listProfiles: listProfiles, getProfile: getProfile, updateProfile: updateProfile, addIdentity: addIdentity, removeIdentity: removeIdentity,
  setFollowUp: setFollowUp, reps: reps, assignRep: assignRep
};
