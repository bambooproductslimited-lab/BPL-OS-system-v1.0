var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var fileStore = require('../lib/fileStore');
var activity = require('./restaurantActivity.service');

// Bills to pay (migration 0196): what each company owes its suppliers —
// Bamboo Products, the restaurants. Each bill has the supplier's own
// reference, a photo or PDF of it, the day it is due, who approved it
// (above a set amount, someone with bill.approve; below it, it needs no
// one), and what was paid — when, how, from which account — until it is
// paid in full. Entered in the OS (Finance → Bills to pay), on a
// restaurant's till (back office → Bills), or made by itself when a
// restaurant receives a purchase order it did not pay at the door. The
// daily round (jobs/dailyAlerts.js) reminds who pays them three days
// before, on the day, and once it is late.

var CATEGORIES = ['stock', 'utilities', 'rent', 'services', 'equipment', 'transport', 'staff', 'other'];
var METHODS = ['bank', 'mobile_money', 'cash', 'cheque'];
var DEFAULTS = { approveOver: 2000, accounts: [], dueDays: 7 };
var MAX_FILES = 4, MAX_FILE_BYTES = 8 * 1024 * 1024;
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var OPEN = ['to_approve', 'approved'];

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dayText(d) { return d instanceof Date ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : String(d).slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function ref(n) { return 'B-' + String(n).padStart(4, '0'); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : ''; }
function money(n) { return 'GHS ' + round2(n).toFixed(2); }
function canRead(ctx) { return ctx.can('bill.read'); }
function canManage(ctx) { return ctx.can('bill.manage'); }
function canApprove(ctx) { return ctx.can('bill.approve'); }
function need(ctx, can, perm) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }

async function settingsOf(db) {
  var r = (await (db || pool).query('SELECT bills FROM settings WHERE id = 1')).rows[0];
  return cleanSettings((r && r.bills) || {});
}
function cleanSettings(v) {
  var over = Number(v.approveOver);
  var due = Math.round(Number(v.dueDays));
  return {
    approveOver: v.approveOver === undefined || v.approveOver === null || v.approveOver === '' || !(over >= 0) ? DEFAULTS.approveOver : Math.min(1e9, round2(over)),
    accounts: (Array.isArray(v.accounts) ? v.accounts : []).map(function (a) { return text(a, 60); }).filter(Boolean).slice(0, 10),
    dueDays: v.dueDays === undefined || v.dueDays === null || v.dueDays === '' || !(due >= 0) ? DEFAULTS.dueDays : Math.min(120, due)
  };
}

// Where a bill stands, on a given day.
function stateOf(r, day) {
  if (r.status === 'paid' || r.status === 'cancelled') return r.status;
  var left = daysBetween(day, dayText(r.due_date));
  return left < 0 ? 'overdue' : left === 0 ? 'today' : left <= 7 ? 'soon' : 'later';
}

var SELECT = 'SELECT b.*, c.code AS company_code, c.name AS company_name, po.number AS po_number, ' +
  'ce.first_name AS cb_first, ce.last_name AS cb_last, ae.first_name AS ab_first, ae.last_name AS ab_last FROM supplier_bills b ' +
  'JOIN companies c ON c.id = b.company_id LEFT JOIN restaurant_purchase_orders po ON po.id = b.purchase_order_id ' +
  'LEFT JOIN employees ce ON ce.id = b.created_by LEFT JOIN employees ae ON ae.id = b.approved_by ';

async function paymentsOf(ids) {
  var out = new Map();
  if (!ids.length) return out;
  (await pool.query(
    'SELECT p.*, e.first_name, e.last_name FROM supplier_bill_payments p LEFT JOIN employees e ON e.id = p.by_id WHERE p.bill_id = ANY($1::uuid[]) ORDER BY p.paid_on, p.created_at', [ids])).rows
    .forEach(function (p) {
      var list = out.get(p.bill_id) || [];
      list.push({ id: p.id, amount: round2(p.amount), paidOn: dayText(p.paid_on), method: p.method, account: p.account, reference: p.reference, hasPhoto: !!p.photo, by: nameOf(p.first_name, p.last_name) });
      out.set(p.bill_id, list);
    });
  return out;
}
function billOut(r, payments, day) {
  var balance = r.status === 'cancelled' ? 0 : round2(Number(r.amount) - Number(r.paid));
  return {
    id: r.id, ref: ref(r.number), company: { id: r.company_id, code: r.company_code, name: r.company_name },
    supplierId: r.supplier_id || r.restaurant_supplier_id || null, supplierName: r.supplier_name, reference: r.reference, category: r.category,
    billDate: dayText(r.bill_date), dueDate: dayText(r.due_date), daysLeft: daysBetween(day || today(), dayText(r.due_date)),
    amount: round2(r.amount), paid: round2(r.paid), balance: balance, status: r.status, state: stateOf(r, day || today()),
    note: r.note, files: (r.files || []).map(function (f, i) { return { n: i, name: f.name || 'bill-' + (i + 1), type: f.type }; }),
    source: r.source, purchaseOrder: r.purchase_order_id ? { id: r.purchase_order_id, ref: 'PO-' + String(r.po_number).padStart(4, '0') } : null,
    createdBy: nameOf(r.cb_first, r.cb_last), approvedBy: nameOf(r.ab_first, r.ab_last), approvedAt: r.approved_at,
    cancelledReason: r.cancelled_reason, createdAt: r.created_at, payments: payments || []
  };
}
async function billsOut(rows, day) {
  var pays = await paymentsOf(rows.map(function (r) { return r.id; }));
  return rows.map(function (r) { return billOut(r, pays.get(r.id), day); });
}
async function one(id) {
  var r = (await pool.query(SELECT + 'WHERE b.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That bill is gone.');
  return (await billsOut([r]))[0];
}

// What is open, by when: overdue, due this week (today included), later,
// waiting to be approved; and paid this month.
async function summaryOf(where, args) {
  var day = today();
  var r = (await pool.query(
    "SELECT count(*) FILTER (WHERE status IN ('to_approve', 'approved') AND due_date < $" + (args.length + 1) + ")::int AS overdue_n, " +
    "coalesce(sum(amount - paid) FILTER (WHERE status IN ('to_approve', 'approved') AND due_date < $" + (args.length + 1) + "), 0) AS overdue, " +
    "count(*) FILTER (WHERE status IN ('to_approve', 'approved') AND due_date >= $" + (args.length + 1) + " AND due_date <= $" + (args.length + 1) + "::date + 7)::int AS week_n, " +
    "coalesce(sum(amount - paid) FILTER (WHERE status IN ('to_approve', 'approved') AND due_date >= $" + (args.length + 1) + " AND due_date <= $" + (args.length + 1) + "::date + 7), 0) AS week, " +
    "count(*) FILTER (WHERE status IN ('to_approve', 'approved') AND due_date > $" + (args.length + 1) + "::date + 7)::int AS later_n, " +
    "coalesce(sum(amount - paid) FILTER (WHERE status IN ('to_approve', 'approved') AND due_date > $" + (args.length + 1) + "::date + 7), 0) AS later, " +
    "count(*) FILTER (WHERE status = 'to_approve')::int AS approve_n, coalesce(sum(amount) FILTER (WHERE status = 'to_approve'), 0) AS approve " +
    'FROM supplier_bills b WHERE ' + where, args.concat([day]))).rows[0];
  var paid = (await pool.query(
    "SELECT coalesce(sum(p.amount), 0) AS paid FROM supplier_bill_payments p JOIN supplier_bills b ON b.id = p.bill_id WHERE " + where + " AND p.paid_on >= date_trunc('month', $" + (args.length + 1) + "::date)",
    args.concat([day]))).rows[0];
  return {
    overdue: { n: r.overdue_n, amount: round2(r.overdue) }, week: { n: r.week_n, amount: round2(r.week) }, later: { n: r.later_n, amount: round2(r.later) },
    toApprove: { n: r.approve_n, amount: round2(r.approve) }, paidThisMonth: round2(paid.paid)
  };
}

// GET /api/bills?company=&status=open|paid|cancelled|all&q=
async function list(ctx, q) {
  need(ctx, canRead, 'bill.read');
  q = q || {};
  var where = [], args = [];
  if (q.company && /^[0-9a-f-]{36}$/i.test(String(q.company))) { args.push(q.company); where.push('b.company_id = $' + args.length); }
  var status = ['open', 'paid', 'cancelled', 'all'].indexOf(q.status) >= 0 ? q.status : 'open';
  if (status === 'open') where.push("b.status IN ('to_approve', 'approved')");
  else if (status !== 'all') { args.push(status); where.push('b.status = $' + args.length); }
  var search = text(q.q, 60);
  if (search) { args.push('%' + search.toLowerCase() + '%'); where.push('(lower(b.supplier_name) LIKE $' + args.length + ' OR lower(b.reference) LIKE $' + args.length + ' OR lower(b.note) LIKE $' + args.length + ')'); }
  var rows = (await pool.query(SELECT + (where.length ? 'WHERE ' + where.join(' AND ') : '') +
    (status === 'open' ? ' ORDER BY b.due_date, b.number' : ' ORDER BY b.updated_at DESC') + ' LIMIT 300', args)).rows;
  var companyWhere = q.company && /^[0-9a-f-]{36}$/i.test(String(q.company)) ? ['b.company_id = $1', [q.company]] : ['true', []];
  var byCompany = (await pool.query(
    "SELECT c.id, c.code, c.name, count(*)::int AS open, coalesce(sum(b.amount - b.paid), 0) AS balance, count(*) FILTER (WHERE b.due_date < current_date)::int AS overdue " +
    "FROM supplier_bills b JOIN companies c ON c.id = b.company_id WHERE b.status IN ('to_approve', 'approved') GROUP BY c.id ORDER BY balance DESC")).rows;
  var suppliers = (await pool.query(
    "SELECT name, NULL::uuid AS company_id FROM suppliers WHERE coalesce(status, 'active') <> 'inactive' UNION SELECT name, company_id FROM restaurant_suppliers WHERE active " +
    'UNION SELECT DISTINCT supplier_name, company_id FROM supplier_bills ORDER BY 1 LIMIT 600')).rows;
  return {
    bills: await billsOut(rows), status: status, summary: await summaryOf(companyWhere[0], companyWhere[1]),
    byCompany: byCompany.map(function (c) { return { id: c.id, code: c.code, name: c.name, open: c.open, balance: round2(c.balance), overdue: c.overdue }; }),
    companies: (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows,
    suppliers: suppliers.map(function (s) { return { name: s.name, companyId: s.company_id }; }),
    categories: CATEGORIES, methods: METHODS, settings: await settingsOf(), today: today(),
    canManage: canManage(ctx), canApprove: canApprove(ctx)
  };
}

async function get(ctx, id) {
  need(ctx, canRead, 'bill.read');
  return one(id);
}

function fieldsOf(p) {
  var f = {
    companyId: /^[0-9a-f-]{36}$/i.test(String(p.companyId || '')) ? p.companyId : fail('invalid', 'Which company owes it?'),
    supplierName: text(p.supplierName, 120),
    reference: text(p.reference, 60),
    category: CATEGORIES.indexOf(p.category) >= 0 ? p.category : 'other',
    billDate: DAY.test(String(p.billDate || '')) ? p.billDate : today(),
    dueDate: String(p.dueDate || ''),
    amount: round2(p.amount),
    note: text(p.note, 500)
  };
  if (f.supplierName.length < 2) fail('invalid', 'Who is the bill from? The supplier\'s name.');
  if (!(f.amount > 0 && f.amount <= 1e9)) fail('invalid', 'How much is the bill? More than 0.');
  if (f.billDate > addDays(today(), 1)) fail('invalid', 'The bill\'s date cannot be in the future.');
  if (!DAY.test(f.dueDate)) fail('invalid', 'When is it due?');
  if (f.dueDate < f.billDate) fail('invalid', 'It cannot be due before the bill\'s date.');
  return f;
}

// Bills over the limit wait for someone with bill.approve; the rest, and
// those entered by someone who could approve them, are approved at once.
async function insertBill(db, f, o) {
  var s = await settingsOf(db);
  await db.query("SELECT pg_advisory_xact_lock(hashtext('supplier_bills'))");
  var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM supplier_bills')).rows[0].n;
  var approvedNow = f.amount <= s.approveOver || !!o.approver;
  return (await db.query(
    'INSERT INTO supplier_bills (number, company_id, supplier_id, restaurant_supplier_id, supplier_name, reference, category, bill_date, due_date, amount, status, note, files, ' +
    'purchase_order_id, source, created_by, approved_by, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *',
    [n, f.companyId, o.supplierId || null, o.restaurantSupplierId || null, f.supplierName, f.reference, f.category, f.billDate, f.dueDate, f.amount,
      approvedNow ? 'approved' : 'to_approve', f.note, JSON.stringify(o.files || []), o.poId || null, o.source || 'office', o.by || null,
      o.approver || null, approvedNow ? new Date() : null])).rows[0];
}

// Who approves are told of a bill waiting for them.
async function tellApprovers(bill, exceptId) {
  if (bill.status !== 'to_approve') return;
  var holders = await require('./staffAlerts.service').holdersOf(['bill.approve']);
  var co = (await pool.query('SELECT name FROM companies WHERE id = $1', [bill.company_id])).rows[0];
  for (var i = 0; i < holders.length; i++) {
    if (holders[i].employee_id === exceptId) continue;
    await notify(pool, holders[i].employee_id, '🧾 ' + ref(bill.number) + ' to approve · ' + money(bill.amount),
      bill.supplier_name + (co ? ' · ' + co.name : '') + ' · due ' + dayText(bill.due_date), '/bills?open=' + bill.id);
  }
}

async function supplierIdOf(db, companyId, name, given) {
  if (given && /^[0-9a-f-]{36}$/i.test(String(given))) {
    var rs = (await db.query('SELECT id FROM restaurant_suppliers WHERE id = $1 AND company_id = $2', [given, companyId])).rows[0];
    if (rs) return { restaurantSupplierId: rs.id };
    var s = (await db.query('SELECT id FROM suppliers WHERE id = $1', [given])).rows[0];
    if (s) return { supplierId: s.id };
  }
  var byName = (await db.query('SELECT id FROM restaurant_suppliers WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1', [companyId, name])).rows[0];
  if (byName) return { restaurantSupplierId: byName.id };
  var os = (await db.query('SELECT id FROM suppliers WHERE lower(name) = lower($1) LIMIT 1', [name])).rows[0];
  return os ? { supplierId: os.id } : {};
}

// POST /api/bills { id?, companyId, supplierName, supplierId?, reference,
// category, billDate, dueDate, amount, note }
async function save(ctx, p) {
  need(ctx, canManage, 'bill.manage');
  p = p || {};
  var f = fieldsOf(p);
  if (!(await pool.query('SELECT 1 FROM companies WHERE id = $1', [f.companyId])).rows[0]) fail('invalid', 'Unknown company.');
  var me = ctx.employee ? ctx.employee.id : null;
  var saved = await withTransaction(async function (db) {
    var sup = await supplierIdOf(db, f.companyId, f.supplierName, p.supplierId);
    if (p.id) {
      var cur = (await db.query('SELECT * FROM supplier_bills WHERE id = $1 FOR UPDATE', [p.id])).rows[0];
      if (!cur) fail('notfound', 'That bill is gone.');
      if (OPEN.indexOf(cur.status) < 0) fail('conflict', 'That bill is ' + cur.status + ': it cannot change.');
      if (f.amount < Number(cur.paid)) fail('invalid', 'It cannot be less than what was paid already (' + money(cur.paid) + ').');
      var s = await settingsOf(db);
      // More than before and over the limit: approved again, unless by an approver.
      var reapprove = cur.status === 'approved' && f.amount > Number(cur.amount) && f.amount > s.approveOver && !canApprove(ctx);
      var row = (await db.query(
        'UPDATE supplier_bills SET company_id = $2, supplier_id = $3, restaurant_supplier_id = $4, supplier_name = $5, reference = $6, category = $7, bill_date = $8, due_date = $9, amount = $10, note = $11, ' +
        "status = CASE WHEN $12 THEN 'to_approve' ELSE status END, approved_by = CASE WHEN $12 THEN NULL ELSE approved_by END, approved_at = CASE WHEN $12 THEN NULL ELSE approved_at END, updated_at = now() WHERE id = $1 RETURNING *",
        [cur.id, f.companyId, sup.supplierId || null, sup.restaurantSupplierId || null, f.supplierName, f.reference, f.category, f.billDate, f.dueDate, f.amount, f.note, reapprove])).rows[0];
      await audit(db, ctx, 'bill.updated', 'supplier_bill', row.id, ref(row.number) + ' (' + row.supplier_name + ') changed: ' + money(row.amount) + ', due ' + f.dueDate + (reapprove ? '; to approve again' : '') + '.');
      return { row: row, isNew: false };
    }
    var made = await insertBill(db, f, { supplierId: sup.supplierId, restaurantSupplierId: sup.restaurantSupplierId, source: 'office', by: me, approver: canApprove(ctx) ? me : null });
    await audit(db, ctx, 'bill.created', 'supplier_bill', made.id, ref(made.number) + ' from ' + made.supplier_name + ': ' + money(made.amount) + ', due ' + f.dueDate + (made.status === 'to_approve' ? ', to approve.' : '.'));
    return { row: made, isNew: true };
  });
  await tellApprovers(saved.row, me);
  return one(saved.row.id);
}

// What a file is, by its first bytes: a photo, or a PDF.
function fileType(buf) {
  var t = require('./shopQuotes.service').photoType(buf);
  if (t) return t;
  if (buf.length > 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  return null;
}
async function keepFile(buf, name) {
  if (!buf || !buf.length) fail('invalid', 'That file is empty.');
  if (buf.length > MAX_FILE_BYTES) fail('invalid', 'That file is too big (8 MB at most).');
  var t = fileType(buf);
  if (!t) fail('invalid', 'Add a photo (JPG, PNG, WebP) or a PDF of the bill.');
  var base = text(name, 80).replace(/[^\w .()-]/g, '').replace(/\.[a-z0-9]+$/i, '') || 'bill';
  return { key: await fileStore.put(base + '.' + t.ext, buf, t.type), type: t.type, name: base + '.' + t.ext };
}

// POST /api/bills/:id/files (multipart: files) — the bill itself: photos or PDFs.
async function addFiles(ctx, id, files) {
  need(ctx, canManage, 'bill.manage');
  if (!files || !files.length) fail('invalid', 'Choose a photo or a PDF of the bill.');
  var cur = (await pool.query('SELECT * FROM supplier_bills WHERE id = $1', [id])).rows[0];
  if (!cur) fail('notfound', 'That bill is gone.');
  var have = cur.files || [];
  if (have.length + files.length > MAX_FILES) fail('invalid', 'Up to ' + MAX_FILES + ' files on a bill.');
  var kept = [];
  for (var i = 0; i < files.length; i++) kept.push(await keepFile(files[i].buffer, files[i].originalname));
  await pool.query('UPDATE supplier_bills SET files = files || $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(kept)]);
  await audit(pool, ctx, 'bill.files', 'supplier_bill', id, ref(cur.number) + ': ' + kept.length + ' file' + (kept.length === 1 ? '' : 's') + ' added.');
  return one(id);
}

// GET /api/bills/:id/files/:n
async function fileKey(ctx, id, n) {
  need(ctx, canRead, 'bill.read');
  var r = (await pool.query('SELECT files FROM supplier_bills WHERE id = $1', [id])).rows[0];
  var f = r && (r.files || [])[Number(n)];
  if (!f) fail('notfound', 'No such file.');
  return { key: f.key, name: f.name || 'bill' };
}
// GET /api/bills/payments/:id/photo
async function paymentPhotoKey(ctx, paymentId) {
  need(ctx, canRead, 'bill.read');
  var r = (await pool.query('SELECT photo FROM supplier_bill_payments WHERE id = $1', [paymentId])).rows[0];
  if (!r || !r.photo) fail('notfound', 'No such photo.');
  return { key: r.photo.key, name: 'payment' + (r.photo.type === 'image/png' ? '.png' : '.jpg') };
}

// POST /api/bills/:id/approve
async function approve(ctx, id) {
  need(ctx, canApprove, 'bill.approve');
  var row = (await pool.query("UPDATE supplier_bills SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1 AND status = 'to_approve' RETURNING *",
    [id, ctx.employee ? ctx.employee.id : null])).rows[0];
  if (!row) {
    var cur = (await pool.query('SELECT status FROM supplier_bills WHERE id = $1', [id])).rows[0];
    fail(cur ? 'conflict' : 'notfound', cur ? 'That bill is ' + cur.status.replace('_', ' ') + ' already.' : 'That bill is gone.');
  }
  await audit(pool, ctx, 'bill.approved', 'supplier_bill', id, ref(row.number) + ' (' + row.supplier_name + ', ' + money(row.amount) + ') approved.');
  if (row.created_by && (!ctx.employee || row.created_by !== ctx.employee.id)) {
    await notify(pool, row.created_by, '✅ ' + ref(row.number) + ' approved', row.supplier_name + ' · ' + money(row.amount) + ' · due ' + dayText(row.due_date), '/bills?open=' + row.id);
  }
  return one(id);
}

// POST /api/bills/:id/pay { amount, paidOn, method, account, reference, photo }
async function pay(ctx, id, p) {
  need(ctx, canManage, 'bill.manage');
  p = p || {};
  var amount = round2(p.amount);
  if (!(amount > 0)) fail('invalid', 'How much was paid? More than 0.');
  var paidOn = DAY.test(String(p.paidOn || '')) ? p.paidOn : today();
  if (paidOn > today()) fail('invalid', 'It cannot be paid in the future.');
  var method = METHODS.indexOf(p.method) >= 0 ? p.method : fail('invalid', 'How was it paid?');
  var photo = p.photo ? await require('./restaurantCashOffice.service').photoFrom(p.photo, 'bill-payment') : null;
  var row = await withTransaction(async function (db) {
    var cur = (await db.query('SELECT * FROM supplier_bills WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) fail('notfound', 'That bill is gone.');
    if (cur.status === 'to_approve') fail('conflict', 'That bill waits to be approved: approve it first.');
    if (cur.status !== 'approved') fail('conflict', 'That bill is ' + cur.status + ' already.');
    var balance = round2(Number(cur.amount) - Number(cur.paid));
    if (amount > balance + 0.001) fail('invalid', 'That is more than is left to pay (' + money(balance) + ').');
    await db.query('INSERT INTO supplier_bill_payments (bill_id, amount, paid_on, method, account, reference, photo, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [cur.id, amount, paidOn, method, text(p.account, 60), text(p.reference, 60), photo, ctx.employee ? ctx.employee.id : null]);
    var up = (await db.query("UPDATE supplier_bills SET paid = paid + $2, status = CASE WHEN amount - (paid + $2) <= 0.004 THEN 'paid' ELSE status END, updated_at = now() WHERE id = $1 RETURNING *",
      [cur.id, amount])).rows[0];
    await audit(db, ctx, 'bill.paid', 'supplier_bill', cur.id, ref(cur.number) + ' (' + cur.supplier_name + '): ' + money(amount) + ' paid on ' + paidOn + ' by ' + method.replace('_', ' ') +
      (p.account ? ' from ' + text(p.account, 60) : '') + (up.status === 'paid' ? '; paid in full.' : '; ' + money(Number(up.amount) - Number(up.paid)) + ' left.'));
    return up;
  });
  return one(row.id);
}

// POST /api/bills/:id/cancel { reason } — entered twice, or not owed after all.
async function cancel(ctx, id, p) {
  need(ctx, canManage, 'bill.manage');
  var reason = text(p && p.reason, 200);
  if (reason.length < 3) fail('invalid', 'Why is it cancelled?');
  var cur = (await pool.query('SELECT * FROM supplier_bills WHERE id = $1', [id])).rows[0];
  if (!cur) fail('notfound', 'That bill is gone.');
  if (OPEN.indexOf(cur.status) < 0) fail('conflict', 'That bill is ' + cur.status + ' already.');
  if (Number(cur.paid) > 0) fail('conflict', 'Part of it is paid: it cannot be cancelled.');
  await pool.query("UPDATE supplier_bills SET status = 'cancelled', cancelled_reason = $2, updated_at = now() WHERE id = $1", [id, reason]);
  await audit(pool, ctx, 'bill.cancelled', 'supplier_bill', id, ref(cur.number) + ' (' + cur.supplier_name + ', ' + money(cur.amount) + ') cancelled: ' + reason + '.');
  return one(id);
}

// PUT /api/bills/settings { approveOver, accounts, dueDays }
async function saveSettings(ctx, p) {
  need(ctx, canApprove, 'bill.approve');
  var s = cleanSettings(p || {});
  await pool.query('UPDATE settings SET bills = $1 WHERE id = 1', [s]);
  await audit(pool, ctx, 'bill.settings', 'settings', null, 'Bills to pay: approved by someone over ' + money(s.approveOver) + '; due ' + s.dueDays + ' days after; accounts ' + (s.accounts.join(', ') || 'none') + '.');
  return s;
}

// Every company's open bills, for the owner's view: overdue, due this week,
// waiting for approval.
async function dueOf(companyIds) {
  var out = {};
  if (!companyIds.length) return out;
  (await pool.query(
    "SELECT company_id, count(*) FILTER (WHERE due_date < current_date)::int AS overdue_n, coalesce(sum(amount - paid) FILTER (WHERE due_date < current_date), 0) AS overdue, " +
    "count(*) FILTER (WHERE due_date >= current_date AND due_date <= current_date + 7)::int AS week_n, coalesce(sum(amount - paid) FILTER (WHERE due_date >= current_date AND due_date <= current_date + 7), 0) AS week, " +
    "count(*) FILTER (WHERE status = 'to_approve')::int AS approve_n FROM supplier_bills WHERE status IN ('to_approve', 'approved') AND company_id = ANY($1::uuid[]) GROUP BY company_id",
    [companyIds])).rows.forEach(function (r) {
    out[r.company_id] = { overdue: { n: r.overdue_n, amount: round2(r.overdue) }, week: { n: r.week_n, amount: round2(r.week) }, toApprove: r.approve_n };
  });
  return out;
}

// ── On a restaurant's till ──

// A received purchase order the restaurant did not pay at the door: the
// bill to pay for it, due in the usual number of days (or the day given).
async function fromPurchaseOrder(db, companyId, po, total, by, p) {
  if (!(total > 0)) return null;
  var s = await settingsOf(db);
  var dueDate = DAY.test(String(p.dueDate || '')) && p.dueDate >= today() ? p.dueDate : addDays(today(), s.dueDays);
  var poRef = 'PO-' + String(po.number).padStart(4, '0');
  return insertBill(db, {
    companyId: companyId, supplierName: text(po.supplier_name, 120) || 'Supplier', reference: text(p.supplierRef, 60) || poRef, category: 'stock',
    billDate: today(), dueDate: dueDate, amount: round2(total), note: 'Received on the till: ' + poRef + '.'
  }, { restaurantSupplierId: po.supplier_id, source: 'purchase_order', by: by.id, poId: po.id });
}

// POST /api/pos/settings/bills { managerPin, action: 'list' | 'save', bill }
// — the restaurant's bills in the back office: what it owes and when; a
// bill entered with its photo (the office approves and pays it).
async function tillTab(token, p, ip) {
  p = p || {};
  var access = require('./restaurantTillAccess.service');
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var done = null;
  if (p.action === 'save') {
    var b = p.bill || {};
    var f = fieldsOf(Object.assign({}, b, { companyId: company }));
    var files = b.photo ? [await keepPhoto(b.photo)] : [];
    var made = await withTransaction(async function (db) {
      var sup = await supplierIdOf(db, company, f.supplierName, b.supplierId);
      var row = await insertBill(db, f, { restaurantSupplierId: sup.restaurantSupplierId, supplierId: sup.supplierId, source: 'till', by: m.manager.id, files: files });
      await activity.log(db, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'settings.bills',
        summary: 'Bill ' + ref(row.number) + ' from ' + row.supplier_name + ' entered: ' + money(row.amount) + ', due ' + f.dueDate + '.', amount: row.amount, refType: 'supplier_bill', refId: row.id });
      return row;
    });
    await tellApprovers(made, null);
    done = { ref: ref(made.number), status: made.status };
  }
  var rows = (await pool.query(SELECT + "WHERE b.company_id = $1 AND (b.status IN ('to_approve', 'approved') OR b.updated_at > now() - interval '60 days') ORDER BY (b.status IN ('to_approve', 'approved')) DESC, b.due_date, b.number LIMIT 200", [company])).rows;
  var suppliers = (await pool.query('SELECT id, name FROM restaurant_suppliers WHERE company_id = $1 AND active ORDER BY name', [company])).rows;
  var s = await settingsOf();
  return { bills: await billsOut(rows), summary: await summaryOf('b.company_id = $1', [company]), suppliers: suppliers, categories: CATEGORIES,
    dueDays: s.dueDays, approveOver: s.approveOver, today: today(), done: done };
}
async function keepPhoto(dataUrl) {
  var ph = await require('./restaurantCashOffice.service').photoFrom(dataUrl, 'bill');
  return { key: ph.key, type: ph.type, name: 'bill.' + (ph.type === 'image/png' ? 'png' : ph.type === 'image/webp' ? 'webp' : 'jpg') };
}
// GET /api/pos/bills/:id/files/:n
async function tillFileKey(token, id, n) {
  var session = await require('./restaurantTillAccess.service').need(token, ['till', 'stock']);
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) fail('notfound', 'No such file.');
  var r = (await pool.query('SELECT files FROM supplier_bills WHERE id = $1 AND company_id = $2', [id, session.posCompanyId])).rows[0];
  var f = r && (r.files || [])[Number(n)];
  if (!f) fail('notfound', 'No such file.');
  return { key: f.key, name: f.name || 'bill' };
}

module.exports = {
  CATEGORIES: CATEGORIES, METHODS: METHODS, settingsOf: settingsOf, list: list, get: get, save: save, addFiles: addFiles, fileKey: fileKey, paymentPhotoKey: paymentPhotoKey,
  approve: approve, pay: pay, cancel: cancel, saveSettings: saveSettings, dueOf: dueOf, fromPurchaseOrder: fromPurchaseOrder, tellApprovers: tellApprovers,
  tillTab: tillTab, tillFileKey: tillFileKey, stateOf: stateOf, dayText: dayText
};
