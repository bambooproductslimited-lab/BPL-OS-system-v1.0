var { fail } = require('./errors');
var { V } = require('./validate');

// Ported verbatim from kernel.js's buildLineItems(rawItems). Shared line-item
// shape across quotations/estimates/sales orders/invoices — snapshot pricing
// at document-creation time, never recomputed from live catalog prices later.
// No real quotation, estimate or invoice has hundreds of lines, and an
// unbounded array is a cheap way for an authenticated user to make the
// server build and insert an arbitrary number of rows in one request.
var MAX_LINE_ITEMS = 200;

function buildLineItems(rawItems) {
  var arr = Array.isArray(rawItems) ? rawItems : [];
  if (!arr.length) fail('invalid', 'Add at least one line item.');
  if (arr.length > MAX_LINE_ITEMS) fail('invalid', 'A document cannot have more than ' + MAX_LINE_ITEMS + ' line items.');
  return arr.map(function (it) {
    var qty = Math.max(0.01, Number(it.qty) || 0), price = Math.max(0, Number(it.unitPrice) || 0);
    return {
      description: V.text(it.description, 'Item description', 160), qty: qty, unit: it.unit || 'each', unitPrice: price,
      discount: Math.max(0, Number(it.discount) || 0), discountType: it.discountType === 'percent' ? 'percent' : 'fixed',
      taxRate: Math.max(0, Number(it.taxRate) || 0), notes: (it.notes || '').trim(),
      packageLabel: (it.packageLabel || '').trim().slice(0, 80)
    };
  });
}

function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Commercial documents (customers/quotations/estimates/invoices) gained a
// company_id in migration 0056 so Poki's tenants, rent and utility invoices
// could reuse these tables — and the payments/receipts/share-link machinery
// built on them — without turning up in Bamboo Products' own lists.
//
// NULL means Bamboo Products Limited: every row that predates that
// migration is NULL and stays that way, which is why adding the column
// needed no backfill and changed no existing behaviour. The group's own
// screens therefore select "NULL or BPL" and nothing else; Poki's screens
// select its company_id explicitly. Returns a SQL fragment for the given
// table alias.
function bplScopeClause(alias) {
  var a = alias ? alias + '.' : '';
  return "(" + a + "company_id IS NULL OR " + a + "company_id = (SELECT id FROM companies WHERE code = 'BPL'))";
}

// Payment schedule: an ordered list of installments against a document's
// grand total, each either a percentage of it or a fixed amount, with its
// own due date — Square's "Payment schedule" step. `amount` is snapshotted
// here (against the grandTotal at save time) rather than recomputed live,
// same reasoning as line-item pricing: what was agreed shouldn't drift if
// the document is edited later. Entries with no value are dropped rather
// than rejected, so an empty/half-filled row in the editor doesn't block
// saving the rest of the document.
function buildPaymentSchedule(raw, grandTotal) {
  var arr = Array.isArray(raw) ? raw : [];
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    var value = Math.max(0, Number(it && it.value) || 0);
    if (!it || !value) continue;
    var type = it.type === 'fixed' ? 'fixed' : 'percent';
    var amount = type === 'percent' ? roundMoney((grandTotal * value) / 100) : roundMoney(value);
    var dueDate = V.date(it.dueDate, 'Payment schedule due date');
    out.push({ label: V.text(it.label || 'Installment', 'Payment schedule label', 80), type: type, value: value, amount: amount, dueDate: dueDate });
  }
  return out;
}

// Ported verbatim from kernel.js's computeDocTotals(items, docDiscount, docTaxRate).
function computeDocTotals(items, docDiscount, docTaxRate) {
  var subtotal = 0, discountTotal = 0, taxTotal = 0;
  items.forEach(function (it) {
    var line = it.qty * it.unitPrice;
    var lineDiscount = it.discountType === 'percent' ? line * (it.discount || 0) / 100 : (it.discount || 0);
    var afterDiscount = Math.max(0, line - lineDiscount);
    var lineTax = afterDiscount * (it.taxRate || 0) / 100;
    subtotal += line; discountTotal += lineDiscount; taxTotal += lineTax;
  });
  var docDiscountAmt = 0;
  if (docDiscount && docDiscount.value) docDiscountAmt = docDiscount.type === 'percent' ? (subtotal - discountTotal) * docDiscount.value / 100 : docDiscount.value;
  discountTotal += docDiscountAmt;
  var docTaxAmt = docTaxRate ? Math.max(0, subtotal - discountTotal) * docTaxRate / 100 : 0;
  taxTotal += docTaxAmt;
  var grandTotal = Math.max(0, subtotal - discountTotal) + taxTotal;
  return {
    subtotal: Math.round(subtotal * 100) / 100, discountTotal: Math.round(discountTotal * 100) / 100,
    taxTotal: Math.round(taxTotal * 100) / 100, grandTotal: Math.round(grandTotal * 100) / 100
  };
}

// Ported from kernel.js's nextDocNumber(kind), adapted to be transaction-safe:
// locks the settings row, reads+increments commercial.numbering[kind] in one
// statement. `client` must be inside an open transaction (kernel's in-memory
// version had no concurrency to guard against; this does).
async function nextDocNumber(client, kind) {
  var res = await client.query('SELECT commercial FROM settings WHERE id = 1 FOR UPDATE');
  var commercial = res.rows[0].commercial;
  var cfg = commercial.numbering[kind];
  var year = new Date().getFullYear();
  var seq = String(cfg.nextNumber).padStart(cfg.padding, '0');
  var number = cfg.prefix + '-' + (cfg.includeYear ? year + '-' : '') + seq;
  cfg.nextNumber++;
  await client.query('UPDATE settings SET commercial = $1 WHERE id = 1', [JSON.stringify(commercial)]);
  return number;
}

function addDays(iso, n) { return new Date(new Date(iso + 'T00:00').getTime() + n * 86400000).toISOString().slice(0, 10); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Multi-currency: a document's currency is freely chosen per document
// (quotations/estimates/invoices), defaulting to the customer's own
// preferred_currency when nothing is specified. Always validated against
// commercial.currencies (Company settings' enabled-currency list) so a typo
// or a disabled currency can't get stored on a real document.
function resolveCurrency(commercial, requested, customerPreferred) {
  var allowed = (commercial && commercial.currencies) || ['GHS'];
  var code = (requested || customerPreferred || allowed[0] || 'GHS').toUpperCase();
  if (allowed.indexOf(code) < 0) fail('invalid', '"' + code + '" isn\'t an enabled currency — add it in Company settings first.');
  return code;
}

// Line items are stored in the shared document_line_items table; these two
// helpers write/read them for any of quotation/estimate/sales_order/invoice.
async function insertLineItems(client, documentType, documentId, items) {
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    await client.query(
      'INSERT INTO document_line_items (document_type, document_id, sort_order, item_no, description, qty, unit, unit_price, discount, discount_type, tax_rate, notes, package_label) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [documentType, documentId, i, it.itemNo || '', it.description, it.qty, it.unit, it.unitPrice, it.discount, it.discountType, it.taxRate, it.notes || '', it.packageLabel || '']
    );
  }
}

async function loadLineItems(db, documentType, documentId) {
  var res = await db.query(
    'SELECT * FROM document_line_items WHERE document_type = $1 AND document_id = $2 ORDER BY sort_order',
    [documentType, documentId]
  );
  return res.rows.map(function (r) {
    return { itemNo: r.item_no, description: r.description, qty: Number(r.qty), unit: r.unit, unitPrice: Number(r.unit_price), discount: Number(r.discount), discountType: r.discount_type, taxRate: Number(r.tax_rate), notes: r.notes, packageLabel: r.package_label || '' };
  });
}

module.exports = {
  buildLineItems: buildLineItems, computeDocTotals: computeDocTotals, nextDocNumber: nextDocNumber, addDays: addDays,
  todayISO: todayISO, insertLineItems: insertLineItems, loadLineItems: loadLineItems, resolveCurrency: resolveCurrency,
  buildPaymentSchedule: buildPaymentSchedule, roundMoney: roundMoney, bplScopeClause: bplScopeClause,
  MAX_LINE_ITEMS: MAX_LINE_ITEMS
};
