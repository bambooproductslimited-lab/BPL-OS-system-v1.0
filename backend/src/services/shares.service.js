var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// A shareable, unauthenticated read-only link for a quotation/estimate/
// invoice — Square's "Share link" option in its Finish & Share step. The
// token is the only thing standing between anyone with the link and the
// document, so it's a long random value (never a sequential id), and
// getSharedDocument() below returns only what a customer should see:
// no employee names, no internal audit trail, no permission-gated fields.
var TABLE_BY_TYPE = { quotation: 'quotations', estimate: 'estimates', invoice: 'invoices' };
var MANAGE_PERM_BY_TYPE = { quotation: 'quotation.manage', estimate: 'quotation.manage', invoice: 'invoice.manage' };
var VALID_TYPES = Object.keys(TABLE_BY_TYPE);

// See migration 0060. 30 days is both the default and the ceiling.
var SHARE_DEFAULT_DAYS = 30;
var SHARE_MAX_DAYS = 30;

async function createShareLink(ctx, documentType, documentId, expiresInDays) {
  if (VALID_TYPES.indexOf(documentType) < 0) fail('invalid', 'Unknown document type.');
  if (!ctx.can(MANAGE_PERM_BY_TYPE[documentType])) fail('forbidden', 'Your role does not allow this action.');
  var exists = await pool.query('SELECT id FROM ' + TABLE_BY_TYPE[documentType] + ' WHERE id = $1', [documentId]);
  if (!exists.rows[0]) fail('notfound', 'Document not found.');

  // Always expires. A share link is a bearer URL to the customer's contact
  // details and the document's figures, so a perpetual one is a standing
  // grant to anyone it is ever forwarded to. Absent or unparseable means
  // the default, not "forever"; anything above the ceiling is clamped
  // rather than rejected, so an old client asking for no expiry gets 30
  // days instead of an error.
  var requested = Number(expiresInDays);
  var days = Number.isFinite(requested) && requested > 0
    ? Math.min(SHARE_MAX_DAYS, Math.max(1, Math.floor(requested)))
    : SHARE_DEFAULT_DAYS;
  var expiresAt = new Date(Date.now() + days * 86400000);
  var token = crypto.randomBytes(24).toString('base64url');

  var res = await pool.query(
    'INSERT INTO document_shares (token, document_type, document_id, expires_at, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [token, documentType, documentId, expiresAt, ctx.employee.id]
  );
  return { token: res.rows[0].token, expiresAt: res.rows[0].expires_at };
}

// Normalizes the three slightly different row shapes into one view model —
// exactly what the public preview page (and nothing more) needs.
async function getSharedDocument(token) {
  var shareRes = await pool.query('SELECT * FROM document_shares WHERE token = $1', [token]);
  var share = shareRes.rows[0];
  if (!share) fail('notfound', 'This link is invalid or has been removed.');
  if (share.expires_at && new Date(share.expires_at) < new Date()) fail('notfound', 'This link has expired — ask for a new one.');

  var docRes = await pool.query('SELECT * FROM ' + TABLE_BY_TYPE[share.document_type] + ' WHERE id = $1', [share.document_id]);
  var d = docRes.rows[0];
  if (!d) fail('notfound', 'This document no longer exists.');

  var itemsRes = await pool.query(
    'SELECT * FROM document_line_items WHERE document_type = $1 AND document_id = $2 ORDER BY sort_order',
    [share.document_type, share.document_id]
  );
  var items = itemsRes.rows.map(function (r) {
    return { description: r.description, notes: r.notes, qty: Number(r.qty), unit: r.unit, unitPrice: Number(r.unit_price), discount: Number(r.discount), discountType: r.discount_type, taxRate: Number(r.tax_rate), packageLabel: r.package_label || '' };
  });

  var custRes = await pool.query('SELECT name, email, phone, address FROM customers WHERE id = $1', [d.customer_id]);
  var cust = custRes.rows[0] || { name: '', email: '', phone: '', address: '' };

  var docNo = share.document_type === 'quotation' ? d.quote_no : share.document_type === 'estimate' ? d.estimate_no : d.invoice_no;
  var dateValue = share.document_type === 'invoice' ? d.issued_at : d.created_at;
  var notes = share.document_type === 'estimate' ? d.client_notes : d.notes;

  return {
    documentType: share.document_type, docNo: docNo, title: d.title || '', status: d.status, currency: d.currency,
    dateValue: dateValue, validUntil: d.valid_until || null, dueDate: d.due_date || null,
    items: items, subtotal: Number(d.subtotal), discountTotal: Number(d.discount_total), taxTotal: Number(d.tax_total), grandTotal: Number(d.grand_total),
    amountPaid: d.amount_paid != null ? Number(d.amount_paid) : null, balanceDue: d.balance_due != null ? Number(d.balance_due) : null,
    notes: notes || '', terms: d.terms || '', customer: cust, paymentSchedule: d.payment_schedule || []
  };
}

// WhatsApp's Cloud API only allows a free-form message within the 24-hour
// window after the customer last messaged this business's number — cold-
// sending a share link to someone who's never messaged in works for some
// customers and fails for others, and that's a WhatsApp platform rule, not
// something this can paper over. sendMessage's own fail() surfaces that
// clearly rather than pretending it always works.
async function shareViaWhatsApp(ctx, documentType, documentId, url) {
  if (VALID_TYPES.indexOf(documentType) < 0) fail('invalid', 'Unknown document type.');
  if (!ctx.can(MANAGE_PERM_BY_TYPE[documentType])) fail('forbidden', 'Your role does not allow this action.');
  var docRes = await pool.query('SELECT customer_id FROM ' + TABLE_BY_TYPE[documentType] + ' WHERE id = $1', [documentId]);
  if (!docRes.rows[0]) fail('notfound', 'Document not found.');
  var custRes = await pool.query('SELECT name, phone FROM customers WHERE id = $1', [docRes.rows[0].customer_id]);
  var cust = custRes.rows[0];
  if (!cust || !cust.phone) fail('invalid', 'This customer has no phone number on file.');

  // Best-effort local -> E.164 normalization for this business's home
  // market (Ghana): a 10-digit number starting with the trunk prefix "0"
  // becomes 233 + the remaining 9 digits. Anything already carrying a
  // country code (or from elsewhere) is left as-is and simply passed to
  // the Graph API, which will reject it clearly if it's not deliverable.
  var digits = String(cust.phone).replace(/\D/g, '');
  if (digits.length === 10 && digits.charAt(0) === '0') digits = '233' + digits.slice(1);

  var whatsapp = require('./whatsapp.service');
  await whatsapp.sendMessage(digits, 'Hi ' + cust.name + ', here is your document from Bamboo Products Limited: ' + url);
  return { sent: true };
}

module.exports = { createShareLink: createShareLink, getSharedDocument: getSharedDocument, shareViaWhatsApp: shareViaWhatsApp,
  SHARE_DEFAULT_DAYS: SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS: SHARE_MAX_DAYS };
