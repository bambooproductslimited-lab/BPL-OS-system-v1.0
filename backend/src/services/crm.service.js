var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// The CRM (migration 0102): the sales team's leads from the first message to
// a won or lost deal, with follow-ups, site visits, prospects, referrals and
// the rep's commission on every sale.
//
// A sale is always an OS invoice. Linking an invoice to a lead makes it a
// deal; its value, discount, what's been paid and the balance are read from
// the invoice every time, so the CRM and Finance can't disagree.
//
// Commission (the rule the company used in its Kick-back CRM sheet): the
// base rate (20% unless changed in the CRM settings) minus the discount
// given, as a percentage of the price before discount, never below zero,
// paid on the value after discount. 5% off -> 15%; 12.4% off -> 7.6%. A
// kick-back is the same share going to someone who isn't the sales rep. A
// referral pays the referral rate (20%) of the deal's value.
//
// Who sees what: crm.read to look, crm.manage to add and work leads,
// prospects and visits; commission figures are shown to the rep they belong
// to, and everyone's (and marking them paid) needs crm.commission.

var STAGES = ['new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation', 'won', 'lost'];
var OPEN_STAGES = STAGES.slice(0, 6);
var NOTE_KINDS = ['note', 'call'];
var PAY_STATUSES = ['pending', 'paid', 'not_eligible'];
var VISIT_STATUSES = ['scheduled', 'visited', 'cancelled'];
var STALE_DAYS = 14;

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function dateOnly(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function str(v, max) { v = v == null ? '' : String(v).trim(); return max ? v.slice(0, max) : v; }
function optDate(v, label) { return v === undefined || v === null || v === '' ? null : V.date(v, label); }
function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function personName(first, last) { return [first, last].filter(Boolean).join(' '); }

// ── settings ─────────────────────────────────────────────────────────

async function settingsRow(db) {
  await (db || pool).query('INSERT INTO crm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  return (await (db || pool).query(
    'SELECT s.*, c.name AS company_name, c.code AS company_code FROM crm_settings s LEFT JOIN companies c ON c.id = s.company_id WHERE s.id = 1')).rows[0];
}
// The company whose sale invoices are CRM sales: the one chosen in the
// settings, else Bamboo Products Limited (code BPL), else every company.
async function salesCompany(s) {
  if (s.company_id) return { id: s.company_id, name: s.company_name, code: s.company_code };
  var bpl = (await pool.query("SELECT id, name, code FROM companies WHERE code = 'BPL' LIMIT 1")).rows[0];
  return bpl || { id: null, name: null, code: null };
}
// Which invoices are the CRM company's (i. is invoices, c. its customer).
// Bamboo Products' invoices from before the OS had companies have none set,
// and the rest of the OS counts those as BPL's (reports.service.js,
// salesOrders.service.js) — unless the customer belongs to another company.
// arg(value) adds a query parameter and returns its $n.
function invoiceScope(co, arg) {
  if (!co.id) return 'true';
  var p = arg(co.id);
  if (co.code === 'BPL') return '(i.company_id = ' + p + ' OR (i.company_id IS NULL AND (c.company_id IS NULL OR c.company_id = ' + p + ')))';
  return 'i.company_id = ' + p;
}
function settingsOut(s, co) {
  return {
    commissionRate: Number(s.commission_rate), referralRate: Number(s.referral_rate),
    companyId: co.id, companyName: co.name, sources: s.sources || []
  };
}
async function getSettings(ctx) {
  need(ctx, 'crm.read');
  var s = await settingsRow();
  return settingsOut(s, await salesCompany(s));
}
async function saveSettings(ctx, p) {
  if (!ctx.can('crm.commission') && !ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (crm.commission).');
  var s = await settingsRow();
  var rate = p.commissionRate === undefined ? Number(s.commission_rate) : Number(p.commissionRate);
  var ref = p.referralRate === undefined ? Number(s.referral_rate) : Number(p.referralRate);
  if (!(rate >= 0 && rate <= 100) || !(ref >= 0 && ref <= 100)) fail('invalid', 'A rate must be between 0 and 100%.');
  var sources = p.sources === undefined ? s.sources : p.sources;
  if (!Array.isArray(sources)) fail('invalid', 'Sources must be a list.');
  sources = sources.map(function (x) { return str(x, 40); }).filter(Boolean).filter(function (x, i, a) { return a.indexOf(x) === i; });
  var companyId = p.companyId === undefined ? s.company_id : (p.companyId || null);
  await pool.query('UPDATE crm_settings SET commission_rate = $1, referral_rate = $2, sources = $3, company_id = $4, updated_at = now(), updated_by = $5 WHERE id = 1',
    [rate, ref, JSON.stringify(sources), companyId, me(ctx)]);
  await audit(pool, ctx, 'crm.settings', 'crm_settings', null, 'CRM settings: commission ' + rate + '%, referral ' + ref + '%.');
  return getSettings(ctx);
}

// ── commission maths ─────────────────────────────────────────────────

// What a deal's invoice says, and the commission on it.
function money(inv, baseRate) {
  var subtotal = Number(inv.subtotal || 0);
  var discount = Number(inv.discount_total || 0);
  var value = round2(subtotal - discount);
  var discountPct = subtotal > 0 ? round2(discount / subtotal * 100) : 0;
  var rate = Math.max(0, round2(Number(baseRate) - discountPct));
  return {
    price: round2(subtotal), discount: round2(discount), discountPct: discountPct, value: value,
    total: round2(inv.grand_total), paid: round2(inv.amount_paid), balance: round2(inv.balance_due),
    rate: rate, commission: round2(value * rate / 100), ready: Number(inv.balance_due) <= 0.005
  };
}

// ── leads ────────────────────────────────────────────────────────────

var LEAD_SELECT =
  'SELECT l.*, e.first_name AS rep_first, e.last_name AS rep_last, c.name AS customer_name, ' +
  '(SELECT count(*)::int FROM crm_deals d WHERE d.lead_id = l.id) AS deal_count, ' +
  '(SELECT coalesce(sum(i.grand_total), 0) FROM crm_deals d JOIN invoices i ON i.id = d.invoice_id WHERE d.lead_id = l.id) AS deal_value, ' +
  '(SELECT json_build_object(\'body\', n.body, \'kind\', n.kind, \'at\', n.at) FROM crm_lead_notes n WHERE n.lead_id = l.id AND n.kind IN (\'note\', \'call\') ORDER BY n.at DESC LIMIT 1) AS last_note ' +
  'FROM crm_leads l LEFT JOIN employees e ON e.id = l.rep_id LEFT JOIN customers c ON c.id = l.customer_id ';

function rowToLead(r) {
  return {
    id: r.id, ref: r.ref, sheetRef: r.sheet_ref || null, receivedOn: dateOnly(r.received_on),
    name: r.name, company: r.company, phone: r.phone, email: r.email, location: r.location,
    source: r.source, item: r.item, stage: r.stage, nextFollowUp: dateOnly(r.next_follow_up),
    repId: r.rep_id, repName: r.rep_id ? personName(r.rep_first, r.rep_last) : (r.rep_name || null),
    comments: r.comments, lostReason: r.lost_reason || null,
    customerId: r.customer_id, customerName: r.customer_name || null, prospectId: r.prospect_id,
    stageChangedAt: r.stage_changed_at, createdAt: r.created_at, updatedAt: r.updated_at,
    dealCount: r.deal_count || 0, dealValue: round2(r.deal_value), lastNote: r.last_note || null
  };
}

async function listLeads(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var where = [], args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  if (q.stage === 'open' || !q.stage) where.push('l.stage = ANY(' + arg(OPEN_STAGES) + ')');
  else if (q.stage !== 'all') where.push('l.stage = ' + arg(V.oneOf(q.stage, STAGES, 'Stage')));
  if (q.rep === 'me') where.push('l.rep_id = ' + arg(me(ctx)));
  else if (q.rep === 'none') where.push("l.rep_id IS NULL AND l.rep_name = ''");
  else if (q.rep) where.push('l.rep_id = ' + arg(q.rep));
  if (q.source) where.push('l.source = ' + arg(q.source));
  var today = todayISO();
  if (q.followUp === 'overdue') where.push('l.next_follow_up < ' + arg(today));
  else if (q.followUp === 'today') where.push('l.next_follow_up = ' + arg(today));
  else if (q.followUp === 'week') where.push('l.next_follow_up BETWEEN ' + arg(today) + ' AND ' + arg(addDays(today, 7)));
  else if (q.followUp === 'none') where.push('l.next_follow_up IS NULL');
  if (q.from) where.push('l.received_on >= ' + arg(V.date(q.from, 'From')));
  if (q.to) where.push('l.received_on <= ' + arg(V.date(q.to, 'To')));
  if (q.q) {
    var like = arg('%' + String(q.q).trim().toLowerCase() + '%');
    where.push('(lower(l.name) LIKE ' + like + ' OR lower(l.company) LIKE ' + like + ' OR lower(l.phone) LIKE ' + like +
      ' OR lower(l.item) LIKE ' + like + ' OR lower(l.location) LIKE ' + like + ' OR lower(l.ref) LIKE ' + like + ' OR lower(l.sheet_ref) LIKE ' + like + ')');
  }
  var limit = Math.min(Math.max(Number(q.limit) || 300, 1), 1000);
  var res = await pool.query(LEAD_SELECT + (where.length ? 'WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY l.received_on DESC, l.created_at DESC LIMIT ' + limit, args);
  return res.rows.map(rowToLead);
}

async function leadRow(id, db) {
  var r = (await (db || pool).query(LEAD_SELECT + 'WHERE l.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Lead not found.');
  return r;
}

async function getLead(ctx, id) {
  need(ctx, 'crm.read');
  var lead = rowToLead(await leadRow(id));
  var notes = (await pool.query(
    'SELECT n.*, e.first_name, e.last_name FROM crm_lead_notes n LEFT JOIN employees e ON e.id = n.by_employee WHERE n.lead_id = $1 ORDER BY n.at DESC LIMIT 200', [id])).rows;
  lead.notes = notes.map(function (n) {
    return { id: n.id, kind: n.kind, body: n.body, fromStage: n.from_stage, toStage: n.to_stage, at: n.at, by: n.by_employee ? personName(n.first_name, n.last_name) : null };
  });
  lead.deals = await dealsWhere(ctx, 'd.lead_id = $1', [id]);
  lead.visits = (await listVisitsWhere('v.lead_id = $1', [id]));
  lead.referrals = await referralsWhere('r.lead_id = $1', [id]);
  if (lead.phone || lead.email) {
    // Other leads with the same phone or email: probably the same person.
    lead.sameContact = (await pool.query(
      "SELECT id, ref, name, stage, received_on FROM crm_leads WHERE id <> $1 AND ((phone <> '' AND regexp_replace(phone, '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g')) OR (email <> '' AND lower(email) = lower($3))) ORDER BY received_on DESC LIMIT 5",
      [id, lead.phone || '-', lead.email || '-'])).rows.map(function (r) { return { id: r.id, ref: r.ref, name: r.name, stage: r.stage, receivedOn: dateOnly(r.received_on) }; });
  } else lead.sameContact = [];
  return lead;
}

async function repFields(p, fallbackId) {
  if (p.repId === undefined) return { id: fallbackId, name: '' };
  if (!p.repId) return { id: null, name: str(p.repName, 80) };
  var e = (await pool.query("SELECT id FROM employees WHERE id = $1", [p.repId])).rows[0];
  if (!e) fail('invalid', 'That sales rep was not found.');
  return { id: e.id, name: '' };
}

async function note(db, ctx, leadId, kind, body, fromStage, toStage) {
  await db.query('INSERT INTO crm_lead_notes (lead_id, kind, body, from_stage, to_stage, by_employee) VALUES ($1,$2,$3,$4,$5,$6)',
    [leadId, kind, body || '', fromStage || null, toStage || null, me(ctx)]);
}

async function createLead(ctx, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var name = V.text(p.name, 'Name', 120);
  var stage = V.oneOf(p.stage || 'new', STAGES, 'Stage');
  var rep = await repFields(p, me(ctx));
  var receivedOn = optDate(p.receivedOn, 'Date received') || todayISO();
  var lead = await withTransaction(async function (db) {
    var r = (await db.query(
      'INSERT INTO crm_leads (received_on, name, company, phone, email, location, source, item, stage, next_follow_up, rep_id, rep_name, comments, lost_reason, prospect_id, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id, ref',
      [receivedOn, name, str(p.company, 120), str(p.phone, 40), str(p.email, 120), str(p.location, 120), str(p.source, 40), str(p.item, 200),
        stage, optDate(p.nextFollowUp, 'Next follow-up'), rep.id, rep.name, str(p.comments, 4000), stage === 'lost' ? str(p.lostReason, 300) : '', p.prospectId || null, me(ctx)])).rows[0];
    await note(db, ctx, r.id, 'stage', 'Lead added.', null, stage);
    await audit(db, ctx, 'crm.lead.create', 'crm_lead', r.id, 'Added lead ' + r.ref + ' (' + name + ').');
    return r;
  });
  return getLead(ctx, lead.id);
}

async function updateLead(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var cur = await leadRow(id);
  var rep = await repFields(p, cur.rep_id);
  if (p.repId === undefined) rep.name = cur.rep_name;
  var stage = p.stage === undefined ? cur.stage : V.oneOf(p.stage, STAGES, 'Stage');
  function pick(key, col, max) { return p[key] === undefined ? cur[col] : str(p[key], max); }
  var name = p.name === undefined ? cur.name : V.text(p.name, 'Name', 120);
  await withTransaction(async function (db) {
    await db.query(
      'UPDATE crm_leads SET name = $2, company = $3, phone = $4, email = $5, location = $6, source = $7, item = $8, comments = $9, ' +
      'next_follow_up = $10, rep_id = $11, rep_name = $12, received_on = $13, stage = $14, lost_reason = $15, ' +
      'stage_changed_at = CASE WHEN stage <> $14 THEN now() ELSE stage_changed_at END, updated_at = now() WHERE id = $1',
      [id, name, pick('company', 'company', 120), pick('phone', 'phone', 40), pick('email', 'email', 120), pick('location', 'location', 120),
        pick('source', 'source', 40), pick('item', 'item', 200), pick('comments', 'comments', 4000),
        p.nextFollowUp === undefined ? cur.next_follow_up : optDate(p.nextFollowUp, 'Next follow-up'),
        rep.id, rep.name, p.receivedOn === undefined ? cur.received_on : V.date(p.receivedOn, 'Date received'),
        stage, stage === 'lost' ? (p.lostReason === undefined ? cur.lost_reason : str(p.lostReason, 300)) : '']);
    if (stage !== cur.stage) await note(db, ctx, id, 'stage', str(p.stageNote, 2000), cur.stage, stage);
    await audit(db, ctx, 'crm.lead.update', 'crm_lead', id, 'Updated lead ' + cur.ref + (stage !== cur.stage ? ' (' + cur.stage + ' → ' + stage + ')' : '') + '.');
  });
  return getLead(ctx, id);
}

// Moves a lead on (or back) with an optional note: the pipeline's one-tap
// action. A lost lead keeps its reason.
async function setStage(ctx, id, p) {
  p = p || {};
  return updateLead(ctx, id, { stage: p.stage, stageNote: p.note, lostReason: p.lostReason, nextFollowUp: p.nextFollowUp });
}

async function addNote(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var kind = V.oneOf(p.kind || 'note', NOTE_KINDS, 'Kind');
  var body = V.text(p.body, 'Note', 4000);
  var cur = await leadRow(id);
  await withTransaction(async function (db) {
    await note(db, ctx, id, kind, body);
    var next = p.nextFollowUp === undefined ? cur.next_follow_up : optDate(p.nextFollowUp, 'Next follow-up');
    // A call or note on a brand-new lead means it has been contacted.
    var stage = cur.stage === 'new' ? 'contacted' : cur.stage;
    await db.query('UPDATE crm_leads SET next_follow_up = $2, stage = $3, stage_changed_at = CASE WHEN stage <> $3 THEN now() ELSE stage_changed_at END, updated_at = now() WHERE id = $1', [id, next, stage]);
    if (stage !== cur.stage) await note(db, ctx, id, 'stage', '', cur.stage, stage);
  });
  return getLead(ctx, id);
}

async function removeLead(ctx, id) {
  need(ctx, 'crm.manage');
  var cur = await leadRow(id);
  if (cur.deal_count > 0) fail('conflict', 'This lead has a sale linked to it. Unlink the sale first — a lead with money attached is kept.');
  await pool.query('DELETE FROM crm_leads WHERE id = $1', [id]);
  await audit(pool, ctx, 'crm.lead.delete', 'crm_lead', id, 'Deleted lead ' + cur.ref + ' (' + cur.name + ').');
  return { ok: true };
}

// Makes the lead a customer in the OS (or links the customer who already
// has its phone or email), so a quotation and invoice can be raised.
async function toCustomer(ctx, id) {
  need(ctx, 'crm.manage');
  need(ctx, 'customer.manage');
  var cur = await leadRow(id);
  if (cur.customer_id) return getLead(ctx, id);
  var existing = null;
  if (cur.phone && cur.phone.replace(/\D/g, '').length >= 7) {
    existing = (await pool.query("SELECT id FROM customers WHERE regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1", [cur.phone.replace(/\D/g, '')])).rows[0];
  }
  if (!existing && cur.email) existing = (await pool.query('SELECT id FROM customers WHERE lower(email) = lower($1) LIMIT 1', [cur.email])).rows[0];
  await withTransaction(async function (db) {
    var customerId;
    if (existing) customerId = existing.id;
    else {
      var s = await settingsRow(db);
      var co = await salesCompany(s);
      customerId = (await db.query(
        "INSERT INTO customers (name, contact_person, email, phone, address, category, account_manager_id, status, notes, company_id) " +
        "VALUES ($1,$2,$3,$4,$5,'lead',$6,'active',$7,$8) RETURNING id",
        [cur.company || cur.name, cur.company ? cur.name : '', cur.email, cur.phone, cur.location, cur.rep_id || me(ctx),
          'From CRM lead ' + cur.ref + (cur.item ? ' — ' + cur.item : '') + '.', co.id])).rows[0].id;
      await audit(db, ctx, 'customer.create', 'customer', customerId, 'Added customer ' + (cur.company || cur.name) + ' from CRM lead ' + cur.ref + '.');
    }
    await db.query('UPDATE crm_leads SET customer_id = $2, updated_at = now() WHERE id = $1', [id, customerId]);
    await note(db, ctx, id, 'note', existing ? 'Linked to the existing customer with the same contact details.' : 'Added as a customer.');
  });
  return getLead(ctx, id);
}

// ── deals (a lead's sale = an OS invoice) ────────────────────────────

var DEAL_SELECT =
  'SELECT d.*, l.ref AS lead_ref, l.name AS lead_name, l.source AS lead_source, l.item AS lead_item, ' +
  'e.first_name AS rep_first, e.last_name AS rep_last, i.invoice_no, i.issued_at, i.subtotal, i.discount_total, i.grand_total, i.amount_paid, i.balance_due, i.status AS invoice_status, ' +
  'c.name AS customer_name FROM crm_deals d JOIN crm_leads l ON l.id = d.lead_id JOIN invoices i ON i.id = d.invoice_id ' +
  'LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN employees e ON e.id = d.rep_id ';

function rowToDeal(ctx, r) {
  var m = money(r, r.base_rate);
  var mine = r.rep_id && r.rep_id === me(ctx);
  var showPay = ctx.can('crm.commission') || mine;
  return {
    id: r.id, leadId: r.lead_id, leadRef: r.lead_ref, leadName: r.lead_name, source: r.lead_source, item: r.lead_item,
    invoiceId: r.invoice_id, invoiceNo: r.invoice_no, issuedAt: dateOnly(r.issued_at), invoiceStatus: r.invoice_status, customerName: r.customer_name,
    kind: r.kind, repId: r.rep_id, repName: r.rep_id ? personName(r.rep_first, r.rep_last) : (r.rep_name || null), coreTeam: r.core_team,
    price: m.price, discount: m.discount, discountPct: m.discountPct, value: m.value, total: m.total, paid: m.paid, balance: m.balance,
    baseRate: Number(r.base_rate), rate: showPay ? m.rate : null, commission: showPay ? m.commission : null, ready: m.ready,
    status: r.status, paidOn: dateOnly(r.paid_on), notes: r.notes, mine: !!mine
  };
}
async function dealsWhere(ctx, where, args) {
  var res = await pool.query(DEAL_SELECT + 'WHERE ' + where + ' ORDER BY i.issued_at DESC', args);
  return res.rows.map(function (r) { return rowToDeal(ctx, r); });
}

// Sales (invoices) of the CRM's company that aren't a deal yet — to pick
// from when linking a sale to a lead. The lead's own customer comes first.
async function invoicesToLink(ctx, q) {
  need(ctx, 'crm.manage');
  q = q || {};
  var s = await settingsRow();
  var co = await salesCompany(s);
  var args = [], where = ["i.doc_kind = 'sale'", "i.status <> 'void'", 'NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.invoice_id = i.id)'];
  function arg(v) { args.push(v); return '$' + args.length; }
  where.push(invoiceScope(co, arg));
  var search = String(q.q || '').trim();
  if (search) { var like = arg('%' + search.toLowerCase() + '%'); where.push('(lower(i.invoice_no) LIKE ' + like + ' OR lower(c.name) LIKE ' + like + ')'); }
  var customerId = null;
  if (q.leadId) customerId = (await leadRow(q.leadId)).customer_id;
  var res = await pool.query(
    'SELECT i.id, i.invoice_no, i.issued_at, i.grand_total, i.balance_due, i.customer_id, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id ' +
    'WHERE ' + where.join(' AND ') + ' ORDER BY (i.customer_id = ' + arg(customerId) + ') DESC NULLS LAST, i.issued_at DESC LIMIT 40', args);
  var invoices = res.rows.map(function (r) {
    return { id: r.id, invoiceNo: r.invoice_no, issuedAt: dateOnly(r.issued_at), total: round2(r.grand_total), balance: round2(r.balance_due), customerName: r.customer_name, sameCustomer: !!customerId && r.customer_id === customerId };
  });
  // Searched for an invoice number that can't be linked: say why, rather
  // than just "nothing to link".
  var why = null;
  if (search && !invoices.length) {
    var hit = (await pool.query(
      'SELECT i.invoice_no, i.status, i.doc_kind, i.company_id, i.customer_id, c.company_id AS customer_company, co.name AS company_name, co.code AS company_code, l.ref AS lead_ref, l.name AS lead_name ' +
      'FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN companies co ON co.id = coalesce(i.company_id, c.company_id) ' +
      'LEFT JOIN crm_deals d ON d.invoice_id = i.id LEFT JOIN crm_leads l ON l.id = d.lead_id ' +
      'WHERE lower(i.invoice_no) = lower($1) LIMIT 1', [search])).rows[0];
    if (hit) {
      var reason = hit.lead_ref ? 'linked' : hit.status === 'void' ? 'void' : hit.doc_kind !== 'sale' ? 'notSale' : 'otherCompany';
      why = { invoiceNo: hit.invoice_no, reason: reason, leadRef: hit.lead_ref || null, leadName: hit.lead_name || null, docKind: hit.doc_kind, companyName: hit.company_name || null };
    } else why = { invoiceNo: search, reason: 'notFound' };
  }
  return { invoices: invoices, why: why };
}

async function linkInvoice(ctx, leadId, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var cur = await leadRow(leadId);
  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [p.invoiceId])).rows[0];
  if (!inv) fail('notfound', 'Invoice not found.');
  if (inv.status === 'void') fail('invalid', 'That invoice is void.');
  if (inv.doc_kind !== 'sale') fail('invalid', 'Only a sales invoice can be a CRM deal.');
  if ((await pool.query('SELECT 1 FROM crm_deals WHERE invoice_id = $1', [inv.id])).rows[0]) fail('conflict', 'That invoice is already linked to a lead.');
  var kind = V.oneOf(p.kind || 'commission', ['commission', 'kickback'], 'Kind');
  var rep = await repFields(p, cur.rep_id);
  if (p.repId === undefined) rep.name = cur.rep_name;
  var s = await settingsRow();
  var deal = await withTransaction(async function (db) {
    var d = (await db.query(
      'INSERT INTO crm_deals (lead_id, invoice_id, kind, rep_id, rep_name, core_team, base_rate, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [leadId, inv.id, kind, rep.id, rep.name, str(p.coreTeam, 300), s.commission_rate, p.notEligible ? 'not_eligible' : 'pending', me(ctx)])).rows[0];
    var toStage = 'won';
    await db.query("UPDATE crm_leads SET stage = 'won', customer_id = coalesce(customer_id, $2), next_follow_up = NULL, " +
      "stage_changed_at = CASE WHEN stage <> 'won' THEN now() ELSE stage_changed_at END, updated_at = now() WHERE id = $1", [leadId, inv.customer_id]);
    await note(db, ctx, leadId, 'deal', 'Sale linked: invoice ' + inv.invoice_no + '.', cur.stage !== toStage ? cur.stage : null, cur.stage !== toStage ? toStage : null);
    await audit(db, ctx, 'crm.deal.link', 'crm_lead', leadId, 'Linked invoice ' + inv.invoice_no + ' to lead ' + cur.ref + '.');
    return d;
  });
  return (await dealsWhere(ctx, 'd.id = $1', [deal.id]))[0];
}

async function dealRow(id) {
  var r = (await pool.query('SELECT d.*, i.invoice_no, l.ref AS lead_ref FROM crm_deals d JOIN invoices i ON i.id = d.invoice_id JOIN crm_leads l ON l.id = d.lead_id WHERE d.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Deal not found.');
  return r;
}

async function updateDeal(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var cur = await dealRow(id);
  if (cur.status === 'paid' && (p.kind !== undefined || p.repId !== undefined)) fail('conflict', 'This commission is already paid. Mark it unpaid first to change who it goes to.');
  var rep = await repFields(p, cur.rep_id);
  if (p.repId === undefined) rep.name = cur.rep_name;
  await pool.query('UPDATE crm_deals SET kind = $2, rep_id = $3, rep_name = $4, core_team = $5, notes = $6 WHERE id = $1',
    [id, p.kind === undefined ? cur.kind : V.oneOf(p.kind, ['commission', 'kickback'], 'Kind'), rep.id, rep.name,
      p.coreTeam === undefined ? cur.core_team : str(p.coreTeam, 300), p.notes === undefined ? cur.notes : str(p.notes, 1000)]);
  await audit(pool, ctx, 'crm.deal.update', 'crm_deal', id, 'Updated the deal on invoice ' + cur.invoice_no + '.');
  return (await dealsWhere(ctx, 'd.id = $1', [id]))[0];
}

// Pending -> paid (or not eligible, or back to pending).
async function setDealStatus(ctx, id, status) {
  need(ctx, 'crm.commission');
  status = V.oneOf(status, PAY_STATUSES, 'Status');
  var cur = await dealRow(id);
  await pool.query('UPDATE crm_deals SET status = $2, paid_on = $3, paid_by = $4 WHERE id = $1',
    [id, status, status === 'paid' ? todayISO() : null, status === 'paid' ? me(ctx) : null]);
  await audit(pool, ctx, 'crm.deal.status', 'crm_deal', id, 'Commission on invoice ' + cur.invoice_no + ': ' + status.replace('_', ' ') + '.');
  return (await dealsWhere(ctx, 'd.id = $1', [id]))[0];
}

async function unlinkDeal(ctx, id) {
  need(ctx, 'crm.manage');
  var cur = await dealRow(id);
  if (cur.status === 'paid') fail('conflict', 'The commission on this sale is already paid, so it stays linked.');
  await withTransaction(async function (db) {
    await db.query('DELETE FROM crm_deals WHERE id = $1', [id]);
    await note(db, ctx, cur.lead_id, 'deal', 'Sale unlinked: invoice ' + cur.invoice_no + '.');
    await audit(db, ctx, 'crm.deal.unlink', 'crm_lead', cur.lead_id, 'Unlinked invoice ' + cur.invoice_no + ' from lead ' + cur.lead_ref + '.');
  });
  return { ok: true };
}

// Every deal, with its commission: all of them for crm.commission, else the
// rep's own.
async function listDeals(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var where = ['true'], args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  if (!ctx.can('crm.commission')) where.push('d.rep_id = ' + arg(me(ctx)));
  else if (q.rep) where.push('d.rep_id = ' + arg(q.rep));
  if (q.status) where.push('d.status = ' + arg(V.oneOf(q.status, PAY_STATUSES, 'Status')));
  if (q.from) where.push('i.issued_at >= ' + arg(V.date(q.from, 'From')));
  if (q.to) where.push('i.issued_at <= ' + arg(V.date(q.to, 'To')));
  return dealsWhere(ctx, where.join(' AND '), args);
}

// ── referrals ────────────────────────────────────────────────────────

async function referralsWhere(where, args) {
  var res = await pool.query(
    'SELECT r.*, l.ref AS lead_ref, l.name AS lead_name, i.invoice_no, i.subtotal, i.discount_total FROM crm_referrals r ' +
    'LEFT JOIN crm_leads l ON l.id = r.lead_id LEFT JOIN invoices i ON i.id = r.invoice_id WHERE ' + where + ' ORDER BY r.created_at DESC', args);
  return res.rows.map(function (r) {
    var value = r.invoice_id ? round2(Number(r.subtotal) - Number(r.discount_total)) : round2(r.deal_value);
    return {
      id: r.id, referrerName: r.referrer_name, referrerPhone: r.referrer_phone, location: r.location,
      leadId: r.lead_id, leadRef: r.lead_ref, customerReferred: r.customer_referred || r.lead_name || '',
      invoiceId: r.invoice_id, invoiceNo: r.invoice_no, dealValue: value, rate: Number(r.rate), amount: round2(value * Number(r.rate) / 100),
      status: r.status, paidOn: dateOnly(r.paid_on), notes: r.notes, createdAt: r.created_at
    };
  });
}
async function listReferrals(ctx) { need(ctx, 'crm.read'); return referralsWhere('true', []); }

async function saveReferral(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var s = await settingsRow();
  var cur = id ? (await pool.query('SELECT * FROM crm_referrals WHERE id = $1', [id])).rows[0] : null;
  if (id && !cur) fail('notfound', 'Referral not found.');
  var name = V.text(p.referrerName === undefined && cur ? cur.referrer_name : p.referrerName, 'Referrer', 120);
  var leadId = p.leadId === undefined ? (cur ? cur.lead_id : null) : (p.leadId || null);
  var invoiceId = p.invoiceId === undefined ? (cur ? cur.invoice_id : null) : (p.invoiceId || null);
  if (leadId && !(await pool.query('SELECT 1 FROM crm_leads WHERE id = $1', [leadId])).rows[0]) fail('invalid', 'That lead was not found.');
  if (invoiceId && !(await pool.query('SELECT 1 FROM invoices WHERE id = $1', [invoiceId])).rows[0]) fail('invalid', 'That invoice was not found.');
  var dealValue = p.dealValue === undefined ? (cur ? cur.deal_value : null) : (p.dealValue === '' || p.dealValue === null ? null : Number(p.dealValue));
  if (dealValue !== null && !(dealValue >= 0)) fail('invalid', 'The deal value must be a positive amount.');
  var rate = p.rate === undefined ? (cur ? Number(cur.rate) : Number(s.referral_rate)) : Number(p.rate);
  if (!(rate >= 0 && rate <= 100)) fail('invalid', 'The rate must be between 0 and 100%.');
  var vals = [name, str(p.referrerPhone === undefined && cur ? cur.referrer_phone : p.referrerPhone, 40), str(p.location === undefined && cur ? cur.location : p.location, 120),
    leadId, str(p.customerReferred === undefined && cur ? cur.customer_referred : p.customerReferred, 120), invoiceId, dealValue, rate,
    str(p.notes === undefined && cur ? cur.notes : p.notes, 1000)];
  var rid;
  if (cur) {
    await pool.query('UPDATE crm_referrals SET referrer_name = $2, referrer_phone = $3, location = $4, lead_id = $5, customer_referred = $6, invoice_id = $7, deal_value = $8, rate = $9, notes = $10 WHERE id = $1', [id].concat(vals));
    rid = id;
  } else {
    rid = (await pool.query('INSERT INTO crm_referrals (referrer_name, referrer_phone, location, lead_id, customer_referred, invoice_id, deal_value, rate, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
      vals.concat([me(ctx)]))).rows[0].id;
  }
  await audit(pool, ctx, cur ? 'crm.referral.update' : 'crm.referral.create', 'crm_referral', rid, (cur ? 'Updated' : 'Added') + ' referral by ' + name + '.');
  return (await referralsWhere('r.id = $1', [rid]))[0];
}
async function setReferralStatus(ctx, id, status) {
  need(ctx, 'crm.commission');
  status = V.oneOf(status, PAY_STATUSES, 'Status');
  var res = await pool.query('UPDATE crm_referrals SET status = $2, paid_on = $3 WHERE id = $1 RETURNING referrer_name', [id, status, status === 'paid' ? todayISO() : null]);
  if (!res.rows[0]) fail('notfound', 'Referral not found.');
  await audit(pool, ctx, 'crm.referral.status', 'crm_referral', id, 'Referral by ' + res.rows[0].referrer_name + ': ' + status.replace('_', ' ') + '.');
  return (await referralsWhere('r.id = $1', [id]))[0];
}
async function removeReferral(ctx, id) {
  need(ctx, 'crm.manage');
  var r = (await pool.query("DELETE FROM crm_referrals WHERE id = $1 AND status <> 'paid' RETURNING referrer_name", [id])).rows[0];
  if (!r) fail('conflict', 'A paid referral is kept; only an unpaid one can be deleted.');
  await audit(pool, ctx, 'crm.referral.delete', 'crm_referral', id, 'Deleted referral by ' + r.referrer_name + '.');
  return { ok: true };
}

// ── prospects ────────────────────────────────────────────────────────

function rowToProspect(r) {
  return {
    id: r.id, listName: r.list_name, market: r.market, company: r.company, name: r.name, phone: r.phone, email: r.email,
    website: r.website, interest: r.interest, notes: r.notes, createdAt: r.created_at,
    leadId: r.lead_id || null, leadRef: r.lead_ref || null, leadStage: r.lead_stage || null
  };
}
var PROSPECT_SELECT = 'SELECT p.*, l.id AS lead_id, l.ref AS lead_ref, l.stage AS lead_stage FROM crm_prospects p ' +
  'LEFT JOIN LATERAL (SELECT id, ref, stage FROM crm_leads WHERE prospect_id = p.id ORDER BY created_at DESC LIMIT 1) l ON true ';

async function listProspects(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var where = [], args = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  if (q.list) where.push('p.list_name = ' + arg(q.list));
  if (q.market) where.push('p.market = ' + arg(q.market));
  if (q.q) {
    var like = arg('%' + String(q.q).trim().toLowerCase() + '%');
    where.push('(lower(p.name) LIKE ' + like + ' OR lower(p.company) LIKE ' + like + ' OR lower(p.interest) LIKE ' + like + ' OR lower(p.email) LIKE ' + like + ' OR p.phone LIKE ' + like + ')');
  }
  var rows = (await pool.query(PROSPECT_SELECT + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY p.list_name, p.company, p.name LIMIT 2000', args)).rows;
  var lists = (await pool.query(
    'SELECT p.list_name, p.market, count(*)::int AS n, count(l.id)::int AS converted FROM crm_prospects p LEFT JOIN crm_leads l ON l.prospect_id = p.id GROUP BY 1, 2 ORDER BY 3 DESC')).rows;
  return {
    prospects: rows.map(rowToProspect),
    lists: lists.map(function (r) { return { listName: r.list_name, market: r.market, count: r.n, converted: r.converted }; })
  };
}

async function saveProspect(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var cur = id ? (await pool.query('SELECT * FROM crm_prospects WHERE id = $1', [id])).rows[0] : null;
  if (id && !cur) fail('notfound', 'Prospect not found.');
  function f(key, col, max) { return p[key] === undefined && cur ? cur[col] : str(p[key], max); }
  var vals = [f('listName', 'list_name', 80), V.oneOf(p.market === undefined && cur ? cur.market : (p.market || 'local'), ['local', 'export'], 'Market'),
    f('company', 'company', 120), f('name', 'name', 120), f('phone', 'phone', 40), f('email', 'email', 120), f('website', 'website', 200),
    f('interest', 'interest', 200), f('notes', 'notes', 2000)];
  if (!vals[2] && !vals[3]) fail('invalid', 'Give a name or a company.');
  var pid;
  if (cur) {
    await pool.query('UPDATE crm_prospects SET list_name = $2, market = $3, company = $4, name = $5, phone = $6, email = $7, website = $8, interest = $9, notes = $10 WHERE id = $1', [id].concat(vals));
    pid = id;
  } else {
    pid = (await pool.query('INSERT INTO crm_prospects (list_name, market, company, name, phone, email, website, interest, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', vals.concat([me(ctx)]))).rows[0].id;
  }
  await audit(pool, ctx, cur ? 'crm.prospect.update' : 'crm.prospect.create', 'crm_prospect', pid, (cur ? 'Updated' : 'Added') + ' prospect ' + (vals[3] || vals[2]) + '.');
  return rowToProspect((await pool.query(PROSPECT_SELECT + 'WHERE p.id = $1', [pid])).rows[0]);
}
async function removeProspect(ctx, id) {
  need(ctx, 'crm.manage');
  var r = (await pool.query('DELETE FROM crm_prospects WHERE id = $1 RETURNING name, company', [id])).rows[0];
  if (!r) fail('notfound', 'Prospect not found.');
  await audit(pool, ctx, 'crm.prospect.delete', 'crm_prospect', id, 'Deleted prospect ' + (r.name || r.company) + '.');
  return { ok: true };
}
// A prospect worth approaching becomes a lead, keeping where it came from.
async function prospectToLead(ctx, id, p) {
  need(ctx, 'crm.manage');
  var pr = (await pool.query(PROSPECT_SELECT + 'WHERE p.id = $1', [id])).rows[0];
  if (!pr) fail('notfound', 'Prospect not found.');
  if (pr.lead_id) fail('conflict', 'This prospect is already lead ' + pr.lead_ref + '.');
  p = p || {};
  return createLead(ctx, {
    name: pr.name || pr.company, company: pr.name ? pr.company : '', phone: pr.phone, email: pr.email,
    source: p.source || 'Prospect list', item: pr.interest, prospectId: pr.id, repId: p.repId,
    comments: [pr.list_name ? 'From the prospect list "' + pr.list_name + '".' : '', pr.notes].filter(Boolean).join(' ')
  });
}

// ── site visits ──────────────────────────────────────────────────────

async function listVisitsWhere(where, args) {
  var res = await pool.query(
    'SELECT v.*, l.ref AS lead_ref, l.name AS lead_name, ' +
    "(SELECT coalesce(json_agg(json_build_object('id', e.id, 'name', e.first_name || ' ' || e.last_name) ORDER BY e.first_name), '[]') FROM employees e WHERE e.id = ANY(v.assessor_ids)) AS assessors " +
    'FROM crm_site_visits v LEFT JOIN crm_leads l ON l.id = v.lead_id WHERE ' + where + ' ORDER BY v.scheduled_on DESC, v.created_at DESC', args);
  return res.rows.map(function (r) {
    return {
      id: r.id, leadId: r.lead_id, leadRef: r.lead_ref, client: r.client, location: r.location, scheduledOn: dateOnly(r.scheduled_on),
      status: r.status, assessors: r.assessors, assessorsText: r.assessors_text, findings: r.findings
    };
  });
}
async function listVisits(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var where = ['true'], args = [];
  if (q.from) { args.push(V.date(q.from, 'From')); where.push('v.scheduled_on >= $' + args.length); }
  if (q.to) { args.push(V.date(q.to, 'To')); where.push('v.scheduled_on <= $' + args.length); }
  return listVisitsWhere(where.join(' AND '), args);
}
async function saveVisit(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var cur = id ? (await pool.query('SELECT * FROM crm_site_visits WHERE id = $1', [id])).rows[0] : null;
  if (id && !cur) fail('notfound', 'Site visit not found.');
  var leadId = p.leadId === undefined ? (cur ? cur.lead_id : null) : (p.leadId || null);
  var lead = leadId ? (await pool.query('SELECT id, name, location FROM crm_leads WHERE id = $1', [leadId])).rows[0] : null;
  if (leadId && !lead) fail('invalid', 'That lead was not found.');
  var client = p.client === undefined && cur ? cur.client : (str(p.client, 120) || (lead ? lead.name : ''));
  if (!client) fail('invalid', 'Client is required.');
  var assessors = p.assessorIds === undefined ? (cur ? cur.assessor_ids : []) : (Array.isArray(p.assessorIds) ? p.assessorIds : []);
  if (assessors.length) {
    var found = (await pool.query('SELECT count(*)::int AS n FROM employees WHERE id = ANY($1::uuid[])', [assessors])).rows[0].n;
    if (found !== assessors.length) fail('invalid', 'One of the people going was not found.');
  }
  var status = V.oneOf(p.status === undefined ? (cur ? cur.status : 'scheduled') : p.status, VISIT_STATUSES, 'Status');
  var vals = [leadId, client, p.location === undefined && cur ? cur.location : (str(p.location, 120) || (lead ? lead.location : '')),
    p.scheduledOn === undefined && cur ? cur.scheduled_on : V.date(p.scheduledOn, 'Visit date'), status, assessors,
    p.assessorsText === undefined && cur ? cur.assessors_text : str(p.assessorsText, 200), p.findings === undefined && cur ? cur.findings : str(p.findings, 4000)];
  var vid = await withTransaction(async function (db) {
    var v;
    if (cur) {
      await db.query('UPDATE crm_site_visits SET lead_id = $2, client = $3, location = $4, scheduled_on = $5, status = $6, assessor_ids = $7, assessors_text = $8, findings = $9, updated_at = now() WHERE id = $1', [id].concat(vals));
      v = id;
    } else {
      v = (await db.query('INSERT INTO crm_site_visits (lead_id, client, location, scheduled_on, status, assessor_ids, assessors_text, findings, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', vals.concat([me(ctx)]))).rows[0].id;
    }
    if (leadId && (!cur || cur.status !== status)) {
      await note(db, ctx, leadId, 'visit', status === 'visited' ? 'Site visited.' + (vals[7] ? ' ' + vals[7] : '') : status === 'cancelled' ? 'Site visit cancelled.' : 'Site visit booked for ' + dateOnly(vals[3]) + '.');
    }
    await audit(db, ctx, cur ? 'crm.visit.update' : 'crm.visit.create', 'crm_site_visit', v, (cur ? 'Updated' : 'Booked') + ' site visit for ' + client + '.');
    return v;
  });
  return (await listVisitsWhere('v.id = $1', [vid]))[0];
}
async function removeVisit(ctx, id) {
  need(ctx, 'crm.manage');
  var r = (await pool.query('DELETE FROM crm_site_visits WHERE id = $1 RETURNING client', [id])).rows[0];
  if (!r) fail('notfound', 'Site visit not found.');
  await audit(pool, ctx, 'crm.visit.delete', 'crm_site_visit', id, 'Deleted site visit for ' + r.client + '.');
  return { ok: true };
}

// ── the overview (the sheet's Dash-Board and Summary tabs) ───────────

function quarterOf(iso) {
  var y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
  var q0 = Math.floor((m - 1) / 3) * 3 + 1;
  var from = y + '-' + String(q0).padStart(2, '0') + '-01';
  var end = new Date(Date.UTC(y, q0 + 2, 0)).toISOString().slice(0, 10);
  return { from: from, to: end };
}
function monthsBetween(from, to) {
  var out = [], y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  while (out.length < 36) {
    var key = y + '-' + String(m).padStart(2, '0');
    if (key > to.slice(0, 7)) break;
    out.push(key);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function overview(ctx, q) {
  need(ctx, 'crm.read');
  q = q || {};
  var today = todayISO();
  var period = q.from && q.to ? { from: V.date(q.from, 'From'), to: V.date(q.to, 'To') } : quarterOf(today);
  if (period.to < period.from) fail('invalid', 'The period ends before it starts.');
  var days = Math.round((new Date(period.to) - new Date(period.from)) / 86400000) + 1;
  var prev = { from: addDays(period.from, -days), to: addDays(period.from, -1) };
  var s = await settingsRow();
  var co = await salesCompany(s);
  var seeAll = ctx.can('crm.commission');
  var myId = me(ctx);

  var dealRows = (await pool.query(DEAL_SELECT + 'WHERE i.issued_at BETWEEN $1 AND $2', [prev.from, period.to])).rows;
  var inPeriod = dealRows.filter(function (r) { return dateOnly(r.issued_at) >= period.from; });
  var inPrev = dealRows.filter(function (r) { return dateOnly(r.issued_at) < period.from; });
  function sum(rows, f) { return round2(rows.reduce(function (a, r) { return a + Number(r[f] || 0); }, 0)); }

  var leadsAll = (await pool.query(
    'SELECT l.id, l.stage, l.source, l.rep_id, l.rep_name, l.received_on, l.next_follow_up, l.stage_changed_at, l.name, l.ref, l.item, e.first_name, e.last_name ' +
    'FROM crm_leads l LEFT JOIN employees e ON e.id = l.rep_id')).rows;
  var leadsIn = leadsAll.filter(function (l) { var d = dateOnly(l.received_on); return d >= period.from && d <= period.to; });
  var leadsPrev = leadsAll.filter(function (l) { var d = dateOnly(l.received_on); return d >= prev.from && d <= prev.to; });

  // the pipeline: every lead, by stage (the sheet's "Status of all leads")
  var stages = STAGES.map(function (st) { return { stage: st, count: leadsAll.filter(function (l) { return l.stage === st; }).length }; });

  // month by month: leads received, deals closed, revenue, cash, arrears
  var months = monthsBetween(period.from, period.to).map(function (m) {
    var d = inPeriod.filter(function (r) { return dateOnly(r.issued_at).slice(0, 7) === m; });
    return {
      month: m, leads: leadsIn.filter(function (l) { return dateOnly(l.received_on).slice(0, 7) === m; }).length,
      deals: d.length, revenue: sum(d, 'grand_total'), cash: sum(d, 'amount_paid'), arrears: sum(d, 'balance_due')
    };
  });

  // where leads come from, and how many of them were won
  var bySource = {};
  leadsIn.forEach(function (l) {
    var k = l.source || '';
    bySource[k] = bySource[k] || { source: k, leads: 0, won: 0 };
    bySource[k].leads++;
    if (l.stage === 'won') bySource[k].won++;
  });

  // the team: leads handled, won, revenue and commission, per rep
  var reps = {};
  function repKey(id, name) { return id || ('name:' + (name || '')); }
  function repOf(id, name, first, last) {
    var k = repKey(id, name);
    reps[k] = reps[k] || { repId: id || null, name: id ? personName(first, last) : (name || null), leads: 0, open: 0, won: 0, lost: 0, deals: 0, revenue: 0, commissionDue: 0, commissionPaid: 0, overdue: 0 };
    return reps[k];
  }
  leadsIn.forEach(function (l) {
    var r = repOf(l.rep_id, l.rep_name, l.first_name, l.last_name);
    r.leads++;
    if (l.stage === 'won') r.won++; else if (l.stage === 'lost') r.lost++; else r.open++;
  });
  leadsAll.forEach(function (l) {
    if (OPEN_STAGES.indexOf(l.stage) >= 0 && l.next_follow_up && dateOnly(l.next_follow_up) < today) repOf(l.rep_id, l.rep_name, l.first_name, l.last_name).overdue++;
  });
  inPeriod.forEach(function (d) {
    var r = repOf(d.rep_id, d.rep_name, d.rep_first, d.rep_last);
    var m = money(d, d.base_rate);
    r.deals++;
    r.revenue = round2(r.revenue + Number(d.grand_total));
    if (d.status === 'pending') r.commissionDue = round2(r.commissionDue + m.commission);
    if (d.status === 'paid') r.commissionPaid = round2(r.commissionPaid + m.commission);
  });
  var team = Object.keys(reps).map(function (k) { return reps[k]; });
  team.forEach(function (r) { if (!seeAll && r.repId !== myId) { r.commissionDue = null; r.commissionPaid = null; } });
  team.sort(function (a, b) { return b.revenue - a.revenue || b.leads - a.leads; });

  // follow-ups due
  var open = leadsAll.filter(function (l) { return OPEN_STAGES.indexOf(l.stage) >= 0; });
  var overdue = open.filter(function (l) { return l.next_follow_up && dateOnly(l.next_follow_up) < today; });
  var dueToday = open.filter(function (l) { return l.next_follow_up && dateOnly(l.next_follow_up) === today; });
  var dueWeek = open.filter(function (l) { var d = l.next_follow_up && dateOnly(l.next_follow_up); return d && d > today && d <= addDays(today, 7); });
  var staleCutoff = Date.now() - STALE_DAYS * 86400000;
  var stale = open.filter(function (l) { return !l.next_follow_up && new Date(l.stage_changed_at).getTime() < staleCutoff; });
  var followList = overdue.concat(dueToday).sort(function (a, b) { return dateOnly(a.next_follow_up) < dateOnly(b.next_follow_up) ? -1 : 1; }).slice(0, 8).map(function (l) {
    return { id: l.id, ref: l.ref, name: l.name, item: l.item, stage: l.stage, nextFollowUp: dateOnly(l.next_follow_up), repName: l.rep_id ? personName(l.first_name, l.last_name) : (l.rep_name || null) };
  });

  // commission owed: pending deals (all, whatever their date)
  var pendingDeals = (await pool.query(DEAL_SELECT + "WHERE d.status = 'pending'" + (seeAll ? '' : ' AND d.rep_id = $1'), seeAll ? [] : [myId])).rows;
  var commission = { ready: 0, waiting: 0, readyCount: 0, waitingCount: 0 };
  pendingDeals.forEach(function (d) {
    var m = money(d, d.base_rate);
    if (m.ready) { commission.ready = round2(commission.ready + m.commission); commission.readyCount++; }
    else { commission.waiting = round2(commission.waiting + m.commission); commission.waitingCount++; }
  });
  var referralRows = await referralsWhere("r.status = 'pending'", []);
  commission.referrals = round2(referralRows.reduce(function (a, r) { return a + r.amount; }, 0));
  commission.referralCount = referralRows.length;

  // sales of the company in the period that aren't linked to any lead
  var unlinkedArgs = [period.from, period.to];
  var unlinked = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(i.grand_total), 0) AS total FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id " +
    "WHERE i.doc_kind = 'sale' AND i.status <> 'void' AND i.issued_at BETWEEN $1 AND $2 " +
    'AND NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.invoice_id = i.id) AND ' +
    invoiceScope(co, function (v) { unlinkedArgs.push(v); return '$' + unlinkedArgs.length; }), unlinkedArgs)).rows[0];

  // site visits in the period
  var visits = (await pool.query('SELECT status, scheduled_on FROM crm_site_visits WHERE scheduled_on BETWEEN $1 AND $2', [period.from, addDays(today, 14) > period.to ? addDays(today, 14) : period.to])).rows;
  var vIn = visits.filter(function (v) { var d = dateOnly(v.scheduled_on); return d >= period.from && d <= period.to; });
  var upcoming = (await listVisitsWhere("v.status = 'scheduled' AND v.scheduled_on >= $1 AND v.scheduled_on <= $2", [today, addDays(today, 14)])).reverse();

  var prospects = (await pool.query('SELECT count(*)::int AS n, count(DISTINCT l.prospect_id)::int AS converted FROM crm_prospects p LEFT JOIN crm_leads l ON l.prospect_id = p.id')).rows[0];

  var mine = {
    open: open.filter(function (l) { return l.rep_id === myId; }).length,
    overdue: overdue.filter(function (l) { return l.rep_id === myId; }).length,
    dueToday: dueToday.filter(function (l) { return l.rep_id === myId; }).length
  };

  var wonIn = leadsIn.filter(function (l) { return l.stage === 'won'; }).length;
  var lostIn = leadsIn.filter(function (l) { return l.stage === 'lost'; }).length;

  return {
    period: period, previous: prev, company: co.name, settings: settingsOut(s, co),
    totals: {
      revenue: sum(inPeriod, 'grand_total'), deals: inPeriod.length, cash: sum(inPeriod, 'amount_paid'), arrears: sum(inPeriod, 'balance_due'),
      leads: leadsIn.length, won: wonIn, lost: lostIn, conversion: leadsIn.length ? Math.round(wonIn / leadsIn.length * 100) : null,
      averageDeal: inPeriod.length ? round2(sum(inPeriod, 'grand_total') / inPeriod.length) : null
    },
    previousTotals: { revenue: sum(inPrev, 'grand_total'), deals: inPrev.length, leads: leadsPrev.length },
    months: months, stages: stages, totalLeads: leadsAll.length, openLeads: open.length,
    sources: Object.keys(bySource).map(function (k) { return bySource[k]; }).sort(function (a, b) { return b.leads - a.leads; }),
    team: team,
    followUps: { overdue: overdue.length, today: dueToday.length, week: dueWeek.length, stale: stale.length, list: followList, staleDays: STALE_DAYS },
    commission: commission, seeAllCommission: seeAll,
    unlinkedSales: { count: unlinked.n, total: round2(unlinked.total) },
    visits: {
      scheduled: vIn.length, visited: vIn.filter(function (v) { return v.status === 'visited'; }).length,
      cancelled: vIn.filter(function (v) { return v.status === 'cancelled'; }).length,
      upcoming: upcoming.slice(0, 6)
    },
    prospects: { total: prospects.n, converted: prospects.converted },
    mine: mine
  };
}

// People who can be picked as a rep or a site assessor.
async function people(ctx) {
  need(ctx, 'crm.read');
  var res = await pool.query("SELECT id, first_name, last_name, position_title FROM employees WHERE status = 'active' ORDER BY first_name, last_name");
  return res.rows.map(function (r) { return { id: r.id, name: personName(r.first_name, r.last_name), position: r.position_title || '' }; });
}

module.exports = {
  STAGES: STAGES, OPEN_STAGES: OPEN_STAGES, commission: money,
  getSettings: getSettings, saveSettings: saveSettings, overview: overview, people: people,
  listLeads: listLeads, getLead: getLead, createLead: createLead, updateLead: updateLead, setStage: setStage, addNote: addNote,
  removeLead: removeLead, toCustomer: toCustomer,
  invoicesToLink: invoicesToLink, linkInvoice: linkInvoice, updateDeal: updateDeal, setDealStatus: setDealStatus, unlinkDeal: unlinkDeal, listDeals: listDeals,
  listReferrals: listReferrals, saveReferral: saveReferral, setReferralStatus: setReferralStatus, removeReferral: removeReferral,
  listProspects: listProspects, saveProspect: saveProspect, removeProspect: removeProspect, prospectToLead: prospectToLead,
  listVisits: listVisits, saveVisit: saveVisit, removeVisit: removeVisit,
  _settingsRow: settingsRow, _salesCompany: salesCompany, _invoiceScope: invoiceScope
};
