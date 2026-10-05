/*
 * Keeping the CRM's customers clean and covered.
 *
 * Duplicates — profiles that look like one customer (the same phone or
 * email; the same name, in any order; a nearly identical name with
 * something else in common). Each pair gets a suggestion:
 *   merge  — they are one customer: fold one into the other;
 *   delete — one of them is empty (nothing on it at all): remove it;
 *   edit   — a near-identical name with different numbers: probably two
 *            people, so tell them apart (or fix a typo).
 * A merge moves everything that points at the dropped profile — invoices,
 * quotations, orders, payments, receipts, credit notes, leads,
 * conversations, phone numbers and addresses — onto the kept one, fills the
 * kept profile's blanks from the other, records what it did
 * (customer_merges), then deletes the dropped one; anything left pointing
 * at it stops the delete, so nothing can be lost silently.
 *
 * Coverage — customers with no sales rep who need one (they write, have an
 * open lead, or bought or were quoted this year). Each gets a suggested rep:
 * the rep on their lead, else whoever made their documents or answered
 * them, else the rep with the fewest customers. Sales managers are told
 * once a day while any are waiting (raiseCoverageConcern).
 */
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { bplScopeClause } = require('../utils/documents');
var { internationalNumber } = require('../utils/phone');
var inbox = require('./crmInbox.service');

var SCOPE = bplScopeClause('c');
var CATEGORY_RANK = { lead: 0, prospect: 1, active: 2, vip: 3 };

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx && ctx.employee ? ctx.employee.id : null; }

// ── names ────────────────────────────────────────────────────────────
var STOP = ['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'hon', 'madam', 'sir', 'ltd', 'limited', 'co', 'company', 'enterprise', 'enterprises',
  'ventures', 'the', 'and', 'gh', 'ghana', 'inc', 'plc', 'llc'];
function nameTokens(n) {
  return String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/).filter(function (t) { return t && STOP.indexOf(t) < 0; });
}
function nameKey(n) { return nameTokens(n).sort().join(' '); }
function levenshtein(a, b) {
  if (a === b) return 0;
  var prev = [], cur = [];
  for (var j = 0; j <= b.length; j++) prev[j] = j;
  for (var i = 1; i <= a.length; i++) {
    cur = [i];
    for (var k = 1; k <= b.length; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function similarity(a, b) { if (!a || !b) return 0; return 1 - levenshtein(a, b) / Math.max(a.length, b.length); }
var FREE_MAIL = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'ymail.com', 'aol.com', 'mail.com', 'proton.me', 'protonmail.com'];

// ── finding duplicates ───────────────────────────────────────────────
// What each customer has on it, so an empty profile can be told apart.
var USAGE_SQL =
  "SELECT c.id, (SELECT count(*) FROM invoices WHERE customer_id = c.id) + (SELECT count(*) FROM quotations WHERE customer_id = c.id) + " +
  "(SELECT count(*) FROM sales_orders WHERE customer_id = c.id) + (SELECT count(*) FROM estimates WHERE customer_id = c.id) + " +
  "(SELECT count(*) FROM payments WHERE customer_id = c.id) + (SELECT count(*) FROM receipts WHERE customer_id = c.id) + " +
  "(SELECT count(*) FROM credit_notes WHERE customer_id = c.id) + (SELECT count(*) FROM crm_leads WHERE customer_id = c.id) + " +
  "(SELECT count(*) FROM crm_conversations WHERE customer_id = c.id) + (SELECT count(*) FROM poki_tenants WHERE customer_id = c.id) AS used " +
  'FROM customers c WHERE c.id = ANY($1)';

async function scanDuplicates() {
  var rows = (await pool.query(
    "SELECT c.id, c.name, c.contact_person, c.phone, c.email, c.location, c.created_at FROM customers c WHERE c.status = 'active' AND " + SCOPE)).rows;
  var idents = (await pool.query("SELECT customer_id, kind, value FROM customer_identities WHERE customer_id = ANY($1)", [rows.map(function (r) { return r.id; })])).rows;
  var phones = {}, emails = {};
  function addTo(map, key, id) { if (!key) return; (map[key] = map[key] || new Set()).add(id); }
  rows.forEach(function (r) {
    String(r.phone || '').split(/[\/,;]| or /).forEach(function (p) { addTo(phones, internationalNumber(p), r.id); });
    if (inbox.isEmail(r.email)) addTo(emails, r.email.trim().toLowerCase(), r.id);
  });
  idents.forEach(function (i) { if (i.kind === 'phone') addTo(phones, i.value, i.customer_id); if (i.kind === 'email') addTo(emails, i.value, i.customer_id); });

  var pairs = {};
  function pair(a, b, score, reason) {
    if (a === b) return;
    var k = a < b ? a + '|' + b : b + '|' + a;
    var p = pairs[k] || (pairs[k] = { a: a < b ? a : b, b: a < b ? b : a, score: 0, reasons: [] });
    if (p.reasons.indexOf(reason) < 0) p.reasons.push(reason);
    p.score = Math.max(p.score, score) + (p.score && p.score !== score ? 5 : 0);
  }
  function allPairs(map, score, label) {
    Object.keys(map).forEach(function (k) {
      var ids = Array.from(map[k]);
      for (var i = 0; i < ids.length; i++) for (var j = i + 1; j < ids.length; j++) pair(ids[i], ids[j], score, label + ' ' + k);
    });
  }
  allPairs(phones, 95, 'same phone');
  allPairs(emails, 95, 'same email');

  var byId = {}, keys = {}, blocks = {};
  rows.forEach(function (r) {
    byId[r.id] = r;
    var k = nameKey(r.name);
    if (k.replace(/ /g, '').length < 4) return;
    keys[r.id] = k;
    (blocks[k.slice(0, 2)] = blocks[k.slice(0, 2)] || []).push(r.id);
  });
  Object.keys(blocks).forEach(function (b) {
    var ids = blocks[b];
    for (var i = 0; i < ids.length; i++) {
      for (var j = i + 1; j < ids.length; j++) {
        var x = byId[ids[i]], y = byId[ids[j]], kx = keys[x.id], ky = keys[y.id];
        if (kx === ky) {
          // One-word names ("Kofi") are too common to say much on their own.
          if (kx.indexOf(' ') > 0 || kx.length >= 8) pair(x.id, y.id, 75, 'same name');
          continue;
        }
        var s = similarity(kx, ky);
        if (s < 0.86) continue;
        var also = [];
        if (x.location && y.location && x.location.trim().toLowerCase() === y.location.trim().toLowerCase()) also.push('same location');
        var dx = (x.email.split('@')[1] || '').toLowerCase(), dy = (y.email.split('@')[1] || '').toLowerCase();
        if (dx && dx === dy && FREE_MAIL.indexOf(dx) < 0) also.push('same email domain ' + dx);
        if (x.contact_person && y.contact_person && nameKey(x.contact_person) === nameKey(y.contact_person)) also.push('same contact person');
        if (s >= 0.92 || also.length) pair(x.id, y.id, also.length ? 65 : 55, 'similar names (' + x.name + ' / ' + y.name + ')' + (also.length ? ', ' + also.join(', ') : ''));
      }
    }
  });

  var list = Object.keys(pairs).map(function (k) { return pairs[k]; });
  if (!list.length) return { found: 0 };
  var involved = Array.from(new Set([].concat.apply([], list.map(function (p) { return [p.a, p.b]; }))));
  var used = {};
  (await pool.query(USAGE_SQL, [involved])).rows.forEach(function (u) { used[u.id] = Number(u.used); });
  var phoneOf = {};
  rows.forEach(function (r) { phoneOf[r.id] = new Set(String(r.phone || '').split(/[\/,;]| or /).map(internationalNumber).filter(Boolean)); });
  idents.forEach(function (i) { if (i.kind === 'phone' && phoneOf[i.customer_id]) phoneOf[i.customer_id].add(i.value); });

  for (var p of list) {
    var strong = p.reasons.some(function (r) { return /^same (phone|email)/.test(r); });
    var diffPhones = phoneOf[p.a].size && phoneOf[p.b].size && !Array.from(phoneOf[p.a]).some(function (x) { return phoneOf[p.b].has(x); });
    var suggestion = (!used[p.a] || !used[p.b]) ? 'delete' : strong || (p.score >= 75 && !diffPhones) ? 'merge' : 'edit';
    if (diffPhones && !strong && suggestion === 'delete' && used[p.a] + used[p.b] > 0 && p.score < 75) suggestion = 'edit';
    await pool.query(
      'INSERT INTO crm_duplicate_suggestions (a_id, b_id, score, reasons, suggestion) VALUES ($1,$2,$3,$4,$5) ' +
      "ON CONFLICT (a_id, b_id) DO UPDATE SET score = EXCLUDED.score, reasons = EXCLUDED.reasons, suggestion = EXCLUDED.suggestion, updated_at = now() " +
      "WHERE crm_duplicate_suggestions.status = 'open'",
      [p.a, p.b, Math.min(100, p.score), JSON.stringify(p.reasons), suggestion]);
  }
  // A pair no longer alike (one was edited) is no longer suggested.
  var keep = list.map(function (p) { return p.a + '|' + p.b; });
  await pool.query("DELETE FROM crm_duplicate_suggestions WHERE status = 'open' AND NOT (a_id::text || '|' || b_id::text = ANY($1))", [keep]);
  return { found: list.length };
}

function sideOut(c, used) {
  return { id: c.id, name: c.name, contactPerson: c.contact_person, phone: c.phone, email: c.email, location: c.location, category: c.category,
    source: c.source, origin: c.origin_channel, createdAt: c.created_at, lastContactAt: c.last_contact_at,
    rep: c.account_manager_id ? { id: c.account_manager_id, name: c.rep_name } : null, used: used };
}

async function listDuplicates(ctx, q) {
  need(ctx, 'crm.read');
  var status = q && q.status === 'done' ? "d.status <> 'open'" : "d.status = 'open'";
  var rows = (await pool.query(
    'SELECT d.* FROM crm_duplicate_suggestions d WHERE ' + status + ' ORDER BY d.score DESC, d.created_at LIMIT 300')).rows;
  if (!rows.length) return [];
  var ids = Array.from(new Set([].concat.apply([], rows.map(function (r) { return [r.a_id, r.b_id]; }))));
  var cust = {};
  (await pool.query("SELECT c.*, e.first_name || ' ' || e.last_name AS rep_name FROM customers c LEFT JOIN employees e ON e.id = c.account_manager_id WHERE c.id = ANY($1)", [ids])).rows
    .forEach(function (c) { cust[c.id] = c; });
  var detail = {};
  (await pool.query(
    "SELECT c.id, (SELECT count(*)::int FROM invoices WHERE customer_id = c.id AND status <> 'void') AS invoices, (SELECT count(*)::int FROM quotations WHERE customer_id = c.id) AS quotations, " +
    "(SELECT count(*)::int FROM sales_orders WHERE customer_id = c.id) AS orders, (SELECT count(*)::int FROM crm_conversations WHERE customer_id = c.id) AS conversations, " +
    "(SELECT count(*)::int FROM crm_leads WHERE customer_id = c.id) AS leads, (SELECT array_agg(label) FROM customer_identities WHERE customer_id = c.id) AS identities " +
    'FROM customers c WHERE c.id = ANY($1)', [ids])).rows.forEach(function (d) { detail[d.id] = d; });
  return rows.filter(function (r) { return cust[r.a_id] && cust[r.b_id]; }).map(function (r) {
    function side(id) { var d = detail[id]; return sideOut(cust[id], { invoices: d.invoices, quotations: d.quotations, orders: d.orders, conversations: d.conversations, leads: d.leads, identities: d.identities || [] }); }
    var a = side(r.a_id), b = side(r.b_id);
    // Which to keep: the one with more on it (then the older one).
    function weight(s) { var u = s.used; return u.invoices * 5 + u.orders * 4 + u.quotations * 3 + u.leads * 2 + u.conversations; }
    var keepA = weight(a) > weight(b) || (weight(a) === weight(b) && new Date(a.createdAt) <= new Date(b.createdAt));
    return { id: r.id, score: r.score, reasons: r.reasons, suggestion: r.suggestion, status: r.status, decidedAt: r.decided_at,
      a: a, b: b, keepId: keepA ? a.id : b.id, dropId: keepA ? b.id : a.id };
  });
}

// ── settling them ────────────────────────────────────────────────────
// Every column, in every table, that points at a customer.
async function customerReferences(db) {
  return (await db.query(
    "SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c " +
    "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) " +
    "WHERE c.contype = 'f' AND c.confrelid = 'customers'::regclass")).rows;
}

async function merge(ctx, p) {
  need(ctx, 'crm.assign');
  var keepId = p && p.keepId, dropId = p && p.dropId;
  if (!keepId || !dropId || keepId === dropId) fail('invalid', 'Choose the profile to keep and the one to fold into it.');
  var result = await withTransaction(async function (db) {
    var both = (await db.query('SELECT c.* FROM customers c WHERE c.id = ANY($1) AND ' + SCOPE + ' FOR UPDATE', [[keepId, dropId]])).rows;
    var keep = both.find(function (c) { return c.id === keepId; }), drop = both.find(function (c) { return c.id === dropId; });
    if (!keep || !drop) fail('notfound', 'One of the two profiles is gone (perhaps already merged).');
    var tenants = (await db.query('SELECT customer_id FROM poki_tenants WHERE customer_id = ANY($1)', [[keepId, dropId]])).rows;
    if (tenants.length > 1) fail('conflict', 'Both are Poki tenants; they can\'t be merged here.');
    var moved = {};
    for (var ref of await customerReferences(db)) {
      if (ref.tbl === 'crm_duplicate_suggestions') continue;
      var r = await db.query('UPDATE ' + ref.tbl + ' SET ' + ref.col + ' = $1 WHERE ' + ref.col + ' = $2', [keepId, dropId]);
      if (r.rowCount) moved[ref.tbl] = (moved[ref.tbl] || 0) + r.rowCount;
    }
    function pick(a, b) { return a && String(a).trim() ? a : b; }
    var notes = [keep.notes, drop.notes ? 'From ' + drop.name + ': ' + drop.notes : ''].filter(function (x) { return x && x.trim(); }).join('\n');
    var follow = [keep.follow_up_on, drop.follow_up_on].filter(Boolean).sort()[0] || null;
    await db.query(
      'UPDATE customers SET contact_person = $2, phone = $3, email = $4, address = $5, location = $6, tax_id = $7, billing_address = $8, notes = $9, ' +
      'category = $10, account_manager_id = $11, follow_up_on = $12, follow_up_note = $13, marketing_opt_out = $14, origin_channel = $15, created_at = LEAST(created_at, $16) WHERE id = $1',
      [keepId, pick(keep.contact_person, drop.contact_person), pick(keep.phone, drop.phone), pick(keep.email, drop.email), pick(keep.address, drop.address),
        pick(keep.location, drop.location), pick(keep.tax_id, drop.tax_id), pick(keep.billing_address, drop.billing_address), notes,
        CATEGORY_RANK[drop.category] > CATEGORY_RANK[keep.category] ? drop.category : keep.category,
        keep.account_manager_id || drop.account_manager_id, follow, follow === keep.follow_up_on ? keep.follow_up_note : drop.follow_up_note || keep.follow_up_note,
        keep.marketing_opt_out || drop.marketing_opt_out, pick(keep.origin_channel, drop.origin_channel), drop.created_at]);
    await db.query('INSERT INTO customer_merges (kept_id, merged_name, merged_snapshot, moved, merged_by) VALUES ($1,$2,$3,$4,$5)',
      [keepId, drop.name, JSON.stringify(drop), JSON.stringify(moved), me(ctx)]);
    if (p.suggestionId) {
      await db.query("UPDATE crm_duplicate_suggestions SET status = 'merged', decided_by = $2, decided_at = now() WHERE id = $1", [p.suggestionId, me(ctx)]);
    }
    // Anything still pointing at it stops this, and nothing is changed.
    await db.query('DELETE FROM customers WHERE id = $1', [dropId]);
    await inbox.stampCustomer(db, keepId);
    var summary = Object.keys(moved).map(function (t) { return moved[t] + ' ' + t.replace(/_/g, ' '); }).join(', ');
    await audit(db, ctx, 'crm.merge', 'customer', keepId, 'Merged ' + drop.name + ' into ' + keep.name + (summary ? ' (moved ' + summary + ')' : '') + '.');
    return { keptId: keepId, moved: moved };
  });
  return result;
}

async function deleteEmpty(ctx, id, suggestionId) {
  need(ctx, 'crm.assign');
  var c = (await pool.query('SELECT c.* FROM customers c WHERE c.id = $1 AND ' + SCOPE, [id])).rows[0];
  if (!c) fail('notfound', 'Customer not found.');
  var used = Number((await pool.query(USAGE_SQL, [[id]])).rows[0].used);
  if (used) fail('conflict', c.name + ' has records on it (invoices, quotations, conversations…). Merge it into the other profile instead.');
  await withTransaction(async function (db) {
    if (suggestionId) await db.query("UPDATE crm_duplicate_suggestions SET status = 'deleted', decided_by = $2, decided_at = now() WHERE id = $1", [suggestionId, me(ctx)]);
    await db.query('DELETE FROM customers WHERE id = $1', [id]);
    await audit(db, ctx, 'crm.profile.delete', 'customer', id, 'Deleted the empty duplicate profile ' + c.name + '.');
  });
  return { deleted: true };
}

async function decide(ctx, suggestionId, status) {
  need(ctx, 'crm.manage');
  if (['dismissed', 'edited'].indexOf(status) < 0) fail('invalid', 'Unknown answer.');
  var r = (await pool.query("UPDATE crm_duplicate_suggestions SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'open' RETURNING id", [suggestionId, status, me(ctx)])).rows[0];
  if (!r) fail('notfound', 'That suggestion was already settled.');
  await audit(pool, ctx, 'crm.duplicate.' + status, 'crm_duplicate_suggestion', suggestionId, status === 'dismissed' ? 'Marked two profiles as different customers.' : 'Edited two look-alike profiles.');
  return { ok: true };
}

// ── coverage: customers with no rep ──────────────────────────────────
// Customers who should have a rep: they wrote, have an open lead, or were
// quoted, ordered or invoiced in the last year, or were added in the last 90 days.
var NEEDS_REP =
  "c.status = 'active' AND c.account_manager_id IS NULL AND " + SCOPE + " AND (" +
  "EXISTS (SELECT 1 FROM crm_conversations w WHERE w.customer_id = c.id) OR " +
  "EXISTS (SELECT 1 FROM crm_leads l WHERE l.customer_id = c.id AND l.stage NOT IN ('won', 'lost')) OR " +
  "EXISTS (SELECT 1 FROM quotations x WHERE x.customer_id = c.id AND x.created_at > now() - interval '365 days') OR " +
  "EXISTS (SELECT 1 FROM sales_orders x WHERE x.customer_id = c.id AND x.created_at > now() - interval '365 days') OR " +
  "EXISTS (SELECT 1 FROM invoices x WHERE x.customer_id = c.id AND x.issued_at > now() - interval '365 days') OR " +
  "c.created_at > now() - interval '90 days')";

async function repPool() {
  return (await pool.query(
    "SELECT e.id, e.first_name || ' ' || e.last_name AS name, bool_or(r.key = 'sales_rep') AS is_rep, " +
    "(SELECT count(*)::int FROM customers c WHERE c.account_manager_id = e.id AND c.status = 'active') AS load " +
    "FROM employees e JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id " +
    "LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_key = 'crm.manage' " +
    "WHERE e.status = 'active' AND u.status = 'active' AND (r.key = 'sales_rep' OR rp.permission_key IS NOT NULL) GROUP BY e.id")).rows;
}

async function unassigned(ctx) {
  need(ctx, 'crm.read');
  var rows = (await pool.query(
    "SELECT c.id, c.name, c.phone, c.email, c.category, c.origin_channel, c.created_at, c.last_contact_at, c.last_inbound_at, " +
    "(SELECT l.rep_id FROM crm_leads l WHERE l.customer_id = c.id AND l.rep_id IS NOT NULL ORDER BY l.received_on DESC LIMIT 1) AS lead_rep, " +
    "(SELECT x.created_by FROM (SELECT created_by, created_at FROM quotations WHERE customer_id = c.id UNION ALL SELECT created_by, created_at FROM sales_orders WHERE customer_id = c.id) x ORDER BY x.created_at DESC LIMIT 1) AS doc_rep, " +
    "(SELECT m.sent_by FROM crm_messages m JOIN crm_conversations w ON w.id = m.conversation_id WHERE w.customer_id = c.id AND m.sent_by IS NOT NULL GROUP BY m.sent_by ORDER BY count(*) DESC LIMIT 1) AS reply_rep, " +
    "(SELECT count(*)::int FROM crm_conversations w WHERE w.customer_id = c.id AND w.status = 'open' AND w.last_direction = 'in') AS waiting " +
    'FROM customers c WHERE ' + NEEDS_REP + ' ORDER BY c.last_inbound_at DESC NULLS LAST, c.created_at DESC LIMIT 500')).rows;
  var reps = await repPool();
  var byId = {};
  reps.forEach(function (r) { byId[r.id] = r; });
  var load = {};
  reps.forEach(function (r) { load[r.id] = r.load; });
  var plain = reps.filter(function (r) { return r.is_rep; });
  if (!plain.length) plain = reps;
  return rows.map(function (c) {
    var s = null;
    if (c.lead_rep && byId[c.lead_rep]) s = { rep: byId[c.lead_rep], key: 'lead', why: 'works their lead' };
    else if (c.doc_rep && byId[c.doc_rep]) s = { rep: byId[c.doc_rep], key: 'documents', why: 'made their last quotation or order' };
    else if (c.reply_rep && byId[c.reply_rep]) s = { rep: byId[c.reply_rep], key: 'replies', why: 'has been answering them' };
    else if (plain.length) {
      var least = plain.slice().sort(function (a, b) { return load[a.id] - load[b.id] || a.name.localeCompare(b.name); })[0];
      s = { rep: least, key: 'least', load: load[least.id], why: 'has the fewest customers (' + load[least.id] + ')' };
      load[least.id]++; // spread a batch across reps
    }
    return {
      id: c.id, name: c.name, phone: c.phone, email: c.email, category: c.category, origin: c.origin_channel, createdAt: c.created_at,
      lastContactAt: c.last_contact_at, lastInboundAt: c.last_inbound_at, waiting: c.waiting,
      suggested: s ? { id: s.rep.id, name: s.rep.name, why: s.why, whyKey: s.key, load: s.load != null ? s.load : null } : null
    };
  });
}

// Gives each customer to their suggested rep.
async function assignSuggested(ctx, p) {
  need(ctx, 'crm.assign');
  var want = new Set((p && p.customerIds) || []);
  var list = (await unassigned(ctx)).filter(function (c) { return c.suggested && (!want.size || want.has(c.id)); });
  var byRep = {};
  list.forEach(function (c) { (byRep[c.suggested.id] = byRep[c.suggested.id] || []).push(c.id); });
  var profiles = require('./crmProfiles.service');
  var changed = 0;
  for (var repId of Object.keys(byRep)) changed += (await profiles.assignRep(ctx, { customerIds: byRep[repId], repId: repId })).changed;
  return { changed: changed };
}

// Once a day while customers wait for a rep: the sales managers are told.
async function raiseCoverageConcern(asOf) {
  var today = (asOf || new Date()).toISOString().slice(0, 10);
  var state = (await pool.query("SELECT cursor FROM crm_channel_state WHERE key = 'coverage_alert'")).rows[0];
  if (state && state.cursor === today) return { sent: 0 };
  var n = (await pool.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE c.last_inbound_at > now() - interval \'7 days\')::int AS recent FROM customers c WHERE ' + NEEDS_REP)).rows[0];
  await pool.query("INSERT INTO crm_channel_state (key, cursor, last_run_at) VALUES ('coverage_alert', $1, now()) ON CONFLICT (key) DO UPDATE SET cursor = $1, last_run_at = now()", [today]);
  if (!n.n) return { sent: 0 };
  var managers = (await pool.query(
    "SELECT DISTINCT e.id FROM employees e JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id " +
    "JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_key = 'crm.assign' WHERE e.status = 'active' AND u.status = 'active'")).rows;
  for (var m of managers) {
    await notify(pool, m.id, n.n === 1 ? '1 customer has no sales rep' : n.n + ' customers have no sales rep',
      (n.recent ? n.recent + ' of them wrote in the last 7 days. ' : '') + 'Each has a suggested rep: give them out in one go.', '/crmhealth#reps');
  }
  return { sent: managers.length, customers: n.n };
}

module.exports = {
  nameKey: nameKey, similarity: similarity, scanDuplicates: scanDuplicates, listDuplicates: listDuplicates,
  merge: merge, deleteEmpty: deleteEmpty, decide: decide,
  unassigned: unassigned, assignSuggested: assignSuggested, raiseCoverageConcern: raiseCoverageConcern
};
