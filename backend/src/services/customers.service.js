var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

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
// grouped per currency rather than blended into one meaningless number
// (summing GHS and USD amounts as if they were the same unit).
async function list(ctx) {
  if (!ctx.can('customer.read')) fail('forbidden', 'Your role does not allow this action (customer.read).');
  var res = await pool.query('SELECT c.*, m.first_name, m.last_name FROM customers c LEFT JOIN employees m ON m.id = c.account_manager_id ORDER BY c.name');
  var quotedRes = await pool.query('SELECT customer_id, currency, sum(grand_total) AS s FROM quotations GROUP BY customer_id, currency');
  var invoicedRes = await pool.query('SELECT customer_id, currency, sum(grand_total) AS invoiced, sum(amount_paid) AS paid FROM invoices GROUP BY customer_id, currency');

  var quotedByCustomer = {}, invoicedByCustomer = {};
  quotedRes.rows.forEach(function (r) {
    (quotedByCustomer[r.customer_id] = quotedByCustomer[r.customer_id] || []).push({ currency: r.currency, amount: Number(r.s) });
  });
  invoicedRes.rows.forEach(function (r) {
    (invoicedByCustomer[r.customer_id] = invoicedByCustomer[r.customer_id] || []).push({
      currency: r.currency, invoiced: Number(r.invoiced), paid: Number(r.paid), outstanding: Number(r.invoiced) - Number(r.paid)
    });
  });

  return res.rows.map(function (r) {
    return rowToCustomer(r, {
      managerName: r.first_name ? r.first_name + ' ' + r.last_name : '—',
      quotedTotals: quotedByCustomer[r.id] || [], invoicedTotals: invoicedByCustomer[r.id] || []
    });
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
    'UPDATE customers SET name = $1, contact_person = $2, email = $3, phone = $4, address = $5, billing_address = $6, category = $7, account_manager_id = $8, notes = $9, preferred_currency = $10 WHERE id = $11 RETURNING *',
    [name, (p.contactPerson || '').trim(), (p.email || '').trim(), (p.phone || '').trim(), address,
      (p.billingAddress || address || '').trim(), category, p.accountManagerId !== undefined ? (p.accountManagerId || null) : existing.rows[0].account_manager_id,
      (p.notes || '').trim(), preferredCurrency, id]
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

module.exports = { list: list, create: create, setCategory: setCategory, update: update, remove: remove };
