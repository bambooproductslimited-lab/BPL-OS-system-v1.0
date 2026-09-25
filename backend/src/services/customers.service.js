var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { bplScopeClause } = require('../utils/documents');

async function validateCurrency(code) {
  if (!code) return 'GHS';
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var allowed = (res.rows[0].commercial && res.rows[0].commercial.currencies) || ['GHS'];
  var upper = String(code).toUpperCase();
  if (allowed.indexOf(upper) < 0) fail('invalid', '"' + upper + '" isn\'t an enabled currency — add it in Company settings first.');
  return upper;
}

function rowToCustomer(r, extra) {
  return Object.assign({
    id: r.id, name: r.name, contactPerson: r.contact_person, email: r.email, phone: r.phone, address: r.address,
    category: r.category, accountManagerId: r.account_manager_id, status: r.status, notes: r.notes,
    taxId: r.tax_id, preferredCurrency: r.preferred_currency, paymentTerms: r.payment_terms, billingAddress: r.billing_address
  }, extra || {});
}

// kernel.js: handlers['customers.list']
// A customer can have documents in more than one currency (freely chosen
// per document — see documents.js's resolveCurrency()), so these totals are
// grouped per currency rather than blended into one meaningless number.
// Voided invoices and cancelled quotations don't count as business done.
// Alongside: what they owe and how late (outstanding, overdue, the oldest
// days overdue), open quotations and the quotations won and lost, what they
// paid in the last twelve months, when they last paid, and the last day
// anything happened with them — which is what the Clients screen reads.
async function list(ctx) {
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  var today = new Date().toISOString().slice(0, 10);
  var res = await pool.query('SELECT c.*, m.first_name, m.last_name, m.photo_key AS m_photo_key, m.photo_updated_at AS m_photo_at FROM customers c LEFT JOIN employees m ON m.id = c.account_manager_id ' +
    'WHERE ' + bplScopeClause('c') + ' ORDER BY c.name');
  var q = await Promise.all([
    pool.query("SELECT customer_id, currency, sum(grand_total) AS s FROM quotations WHERE status <> 'cancelled' GROUP BY customer_id, currency"),
    pool.query("SELECT customer_id, currency, sum(grand_total) AS invoiced, sum(amount_paid) AS paid, sum(balance_due) AS balance, " +
      "  sum(balance_due) FILTER (WHERE due_date < $1) AS overdue FROM invoices WHERE status <> 'void' GROUP BY customer_id, currency", [today]),
    pool.query("SELECT customer_id, count(*) FILTER (WHERE status IN ('sent', 'viewed') AND (valid_until IS NULL OR valid_until >= $1)) AS open_quotes, " +
      "  count(*) FILTER (WHERE status = 'accepted') AS won, count(*) FILTER (WHERE status IN ('rejected', 'expired')) AS lost, max(created_at) AS last_quote FROM quotations GROUP BY customer_id", [today]),
    pool.query("SELECT customer_id, count(*) AS invoices, max(issued_at) AS last_invoice, " +
      "  max(($1::date - due_date)) FILTER (WHERE balance_due > 0 AND due_date < $1 AND status NOT IN ('paid', 'void')) AS days_overdue FROM invoices WHERE status <> 'void' GROUP BY customer_id", [today]),
    pool.query("SELECT customer_id, currency, max(date) AS last_paid, sum(amount) FILTER (WHERE date > $1::date - 365) AS paid12 FROM payments GROUP BY customer_id, currency", [today]),
    pool.query('SELECT customer_id, max(created_at) AS last_estimate FROM estimates GROUP BY customer_id')
  ]);
  function group(rows, map) {
    var out = {};
    rows.forEach(function (r) { (out[r.customer_id] = out[r.customer_id] || []).push(map(r)); });
    return out;
  }
  var quoted = group(q[0].rows, function (r) { return { currency: r.currency, amount: Number(r.s) }; });
  var invoiced = group(q[1].rows, function (r) {
    return { currency: r.currency, invoiced: Number(r.invoiced), paid: Number(r.paid), outstanding: Number(r.balance), overdue: Number(r.overdue || 0) };
  });
  var quotes = {}; q[2].rows.forEach(function (r) { quotes[r.customer_id] = r; });
  var invs = {}; q[3].rows.forEach(function (r) { invs[r.customer_id] = r; });
  var pays = group(q[4].rows, function (r) { return r; });
  var ests = {}; q[5].rows.forEach(function (r) { ests[r.customer_id] = r; });
  function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }

  return res.rows.map(function (r) {
    var qu = quotes[r.id] || {}, iv = invs[r.id] || {}, pa = pays[r.id] || [], es = ests[r.id] || {};
    var lastPaid = pa.reduce(function (m, x) { var d = day(x.last_paid); return d && (!m || d > m) ? d : m; }, null);
    var dates = [day(qu.last_quote), day(iv.last_invoice), lastPaid, day(es.last_estimate)].filter(Boolean).sort();
    var inv = invoiced[r.id] || [];
    return rowToCustomer(r, {
      managerName: r.first_name ? r.first_name + ' ' + r.last_name : '—',
      managerPhoto: r.m_photo_key && r.m_photo_at ? new Date(r.m_photo_at).getTime() : null,
      quotedTotals: quoted[r.id] || [], invoicedTotals: inv,
      outstanding: inv.filter(function (x) { return x.outstanding > 0; }).map(function (x) { return { currency: x.currency, amount: x.outstanding }; }),
      overdue: inv.filter(function (x) { return x.overdue > 0; }).map(function (x) { return { currency: x.currency, amount: x.overdue }; }),
      daysOverdue: Number(iv.days_overdue || 0),
      paid12: pa.filter(function (x) { return Number(x.paid12) > 0; }).map(function (x) { return { currency: x.currency, amount: Number(x.paid12) }; }),
      openQuotes: Number(qu.open_quotes || 0), quotesWon: Number(qu.won || 0), quotesLost: Number(qu.lost || 0),
      invoiceCount: Number(iv.invoices || 0), lastPaidOn: lastPaid,
      lastActivity: dates.length ? dates[dates.length - 1] : null, createdAt: r.created_at || null, source: r.source
    });
  });
}

// Everything done with one customer, newest first: estimates, quotations,
// invoices and payments on one timeline, for the client's window.
async function activity(ctx, id) {
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  var c = (await pool.query('SELECT id FROM customers WHERE id = $1 AND ' + bplScopeClause(), [id])).rows[0];
  if (!c) fail('notfound', 'Customer not found.');
  var res = await pool.query(
    "SELECT 'estimate' AS kind, id, estimate_no AS no, created_at::date AS day, created_at AS at, grand_total AS amount, currency, status, NULL::numeric AS balance FROM estimates WHERE customer_id = $1 " +
    "UNION ALL SELECT 'quotation', id, quote_no, created_at::date, created_at, grand_total, currency, status, NULL FROM quotations WHERE customer_id = $1 " +
    "UNION ALL SELECT 'invoice', id, invoice_no, issued_at, issued_at::timestamptz, grand_total, currency, status, balance_due FROM invoices WHERE customer_id = $1 " +
    "UNION ALL SELECT 'payment', p.id, i.invoice_no, p.date, p.date::timestamptz, p.amount, p.currency, p.method, NULL FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = $1 " +
    'ORDER BY at DESC, no DESC LIMIT 60', [id]);
  return res.rows.map(function (r) {
    return {
      kind: r.kind, id: r.id, no: r.no, day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10),
      amount: Number(r.amount), currency: r.currency, status: r.status, balance: r.balance === null ? null : Number(r.balance)
    };
  });
}

// kernel.js: handlers['customers.create']
async function create(ctx, p) {
  if (!ctx.can('customer.manage')) fail('forbidden', 'Your role does not allow this action (customer.manage).');
  var name = V.text(p.name, 'Customer name', 100);
  var category = V.oneOf(p.category || 'lead', ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category');
  var preferredCurrency = await validateCurrency(p.preferredCurrency);
  var res = await pool.query(
    "INSERT INTO customers (name, contact_person, email, phone, address, category, account_manager_id, status, notes, preferred_currency) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9) RETURNING *",
    [name, (p.contactPerson || '').trim(), (p.email || '').trim(), (p.phone || '').trim(), (p.address || '').trim(), category, p.accountManagerId || ctx.employee.id, (p.notes || '').trim(), preferredCurrency]
  );
  var c = res.rows[0];
  await audit(pool, ctx, 'customer.create', 'customer', c.id, 'Added customer ' + c.name + '.');
  return rowToCustomer(c);
}

// kernel.js: handlers['customers.setCategory']
async function setCategory(ctx, id, category) {
  if (!ctx.can('customer.manage')) fail('forbidden', 'Your role does not allow this action (customer.manage).');
  category = V.oneOf(category, ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category');
  var res = await pool.query('UPDATE customers SET category = $1 WHERE id = $2 RETURNING *', [category, id]);
  if (!res.rows[0]) fail('notfound', 'Customer not found.');
  var c = res.rows[0];
  await audit(pool, ctx, 'customer.update', 'customer', c.id, 'Set ' + c.name + ' to ' + c.category + '.');
  return rowToCustomer(c);
}

// kernel.js: handlers['customers.update']
async function update(ctx, id, p) {
  if (!ctx.can('customer.manage')) fail('forbidden', 'Your role does not allow this action (customer.manage).');
  var existing = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Customer not found.');

  var name = V.text(p.name, 'Customer name', 100);
  var address = (p.address || '').trim();
  var category = V.oneOf(p.category || existing.rows[0].category, ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category');
  var preferredCurrency = p.preferredCurrency !== undefined ? await validateCurrency(p.preferredCurrency) : existing.rows[0].preferred_currency;
  var res = await pool.query(
    'UPDATE customers SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, billing_address = $6, category = $7, account_manager_id = $8, notes = $9, preferred_currency = $10, ' +
    'tax_id = $12, payment_terms = $13 WHERE id = $11 RETURNING *',
    [name, (p.contactPerson || '').trim(), (p.email || '').trim(), (p.phone || '').trim(), address,
      (p.billingAddress || address || '').trim(), category, p.accountManagerId !== undefined ? (p.accountManagerId || null) : existing.rows[0].account_manager_id,
      (p.notes || '').trim(), preferredCurrency, id,
      p.taxId !== undefined ? String(p.taxId || '').trim().slice(0, 60) : existing.rows[0].tax_id,
      p.paymentTerms !== undefined ? (String(p.paymentTerms || '').trim().slice(0, 60) || 'Net 30') : existing.rows[0].payment_terms]
  );
  var c = res.rows[0];
  await audit(pool, ctx, 'customer.update', 'customer', c.id, 'Updated ' + c.name + '.');
  return rowToCustomer(c);
}

// kernel.js: handlers['customers.delete']
async function remove(ctx, id) {
  if (!ctx.can('customer.manage')) fail('forbidden', 'Your role does not allow this action (customer.manage).');
  var res = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  var c = res.rows[0];
  if (!c) fail('notfound', 'Customer not found.');
  var linked = await pool.query(
    'SELECT 1 WHERE EXISTS (SELECT 1 FROM quotations WHERE customer_id = $1) OR EXISTS (SELECT 1 FROM estimates WHERE customer_id = $1) OR EXISTS (SELECT 1 FROM invoices WHERE customer_id = $1)',
    [id]
  );
  if (linked.rows.length) fail('conflict', 'Cannot delete ' + c.name + ' — they have quotations, estimates or invoices on record.');
  await pool.query('DELETE FROM customers WHERE id = $1', [id]);
  await audit(pool, ctx, 'customer.delete', 'customer', id, 'Deleted customer ' + c.name + '.');
  return true;
}

module.exports = { list: list, activity: activity, create: create, setCategory: setCategory, update: update, remove: remove };
