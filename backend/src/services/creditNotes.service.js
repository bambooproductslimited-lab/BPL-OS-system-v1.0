var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { nextDocNumber, todayISO } = require('../utils/documents');

// Credit notes: taking some or all of an invoice back — a booking
// shortened, goods returned, a price agreed down — and refunding what the
// customer then has paid over what they owe.
//
// The invoice keeps its original total; the credit is kept beside it
// (invoices.credit_total), and the database works out what is still owed
// from total − credits − payments (migration 0119). A refund is money
// going back, so it is a negative payment (source 'refund'): collections
// and reports net it off without knowing about credit notes at all.
//
// Only what the customer has overpaid can be refunded — money they still
// owe is cleared by the credit itself. An overpayment left unrefunded is
// allowed (they may want it kept for a next order) and shown as such.

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }
var METHODS = ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque'];

function rowToCreditNote(r) {
  return {
    id: r.id, creditNo: r.credit_no, invoiceId: r.invoice_id, currency: r.currency,
    amount: Number(r.amount), refundAmount: Number(r.refund_amount), reason: r.reason,
    refundMethod: r.refund_method || null, refundReference: r.refund_reference || '',
    createdAt: r.created_at, createdByName: r.first_name ? r.first_name + ' ' + r.last_name : ''
  };
}

async function listRaw(invoiceId) {
  var rows = (await pool.query(
    'SELECT n.*, p.method AS refund_method, p.reference AS refund_reference, e.first_name, e.last_name FROM credit_notes n ' +
    'LEFT JOIN payments p ON p.id = n.refund_payment_id LEFT JOIN employees e ON e.id = n.created_by ' +
    'WHERE n.invoice_id = $1 ORDER BY n.created_at', [invoiceId])).rows;
  return rows.map(rowToCreditNote);
}

// What a credit note could do on this invoice right now.
function roomOn(i) {
  var creditable = money(Number(i.grand_total) - Number(i.credit_total));
  var paid = money(i.amount_paid);
  return { creditable: Math.max(0, creditable), paid: paid, overpaid: Math.max(0, money(paid - creditable)) };
}

async function list(ctx, invoiceId) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  return listRaw(invoiceId);
}

async function create(ctx, invoiceId, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var made = await withTransaction(function (client) {
    return applyCredit(client, ctx, invoiceId, {
      amount: p.amount, refundAmount: p.refundAmount, reason: p.reason,
      refundMethod: p.refundMethod, refundReference: p.refundReference
    });
  });

  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  var notes = await listRaw(invoiceId);
  return {
    creditNote: notes.find(function (n) { return n.id === made.id; }),
    creditNotes: notes,
    overpaidLeft: made.overpaidLeft,
    invoice: {
      id: inv.id, invoiceNo: inv.invoice_no, currency: inv.currency, status: inv.status,
      grandTotal: Number(inv.grand_total), creditTotal: Number(inv.credit_total),
      amountPaid: Number(inv.amount_paid), balanceDue: Number(inv.balance_due)
    }
  };
}

// The credit note itself, inside the caller's transaction — also used when
// a Poki booking is cut below what the tenant already paid (poki.service.js).
async function applyCredit(client, ctx, invoiceId, p) {
  var amount = money(p.amount), refund = money(p.refundAmount);
  if (amount < 0 || refund < 0) fail('invalid', 'Amounts cannot be negative.');
  if (!amount && !refund) fail('invalid', 'Enter how much to credit, or how much to refund.');
  var reason = V.text(p.reason, 'Reason', 300);
  var method = refund ? V.oneOf(p.refundMethod || 'bank_transfer', METHODS, 'Refund method') : null;

  var i = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId])).rows[0];
  if (!i) fail('notfound', 'Invoice not found.');
  if (i.status === 'void') fail('conflict', 'This invoice has been voided.');
  var room = roomOn(i);
  if (amount > room.creditable + 0.005) {
    fail('invalid', 'That is more than is left on the invoice to credit (' + i.currency + ' ' + room.creditable.toFixed(2) + ').');
  }
  // After this credit: what they owe, and what they have paid over it.
  var overpaid = Math.max(0, money(room.paid - (room.creditable - amount)));
  if (refund > overpaid + 0.005) {
    fail('invalid', overpaid > 0
      ? 'You can refund at most ' + i.currency + ' ' + overpaid.toFixed(2) + ': what they have paid over what they would then owe.'
      : 'There is nothing to refund: they have not paid more than they would then owe.');
  }

  var creditNo = await nextDocNumber(client, 'creditNote');
  var refundPaymentId = null;
  if (refund > 0) {
    refundPaymentId = (await client.query(
      "INSERT INTO payments (invoice_id, customer_id, date, amount, currency, method, reference, received_by, notes, source) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'refund') RETURNING id",
      [i.id, i.customer_id, todayISO(), -refund, i.currency, method, String(p.refundReference || '').trim().slice(0, 120),
        ctx.employee.id, 'Refund \u2014 ' + creditNo + ': ' + reason])).rows[0].id;
  }
  await client.query('UPDATE invoices SET credit_total = credit_total + $1, amount_paid = amount_paid - $2 WHERE id = $3', [amount, refund, i.id]);
  var note = (await client.query(
    'INSERT INTO credit_notes (credit_no, invoice_id, customer_id, currency, amount, refund_amount, refund_payment_id, reason, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [creditNo, i.id, i.customer_id, i.currency, amount, refund, refundPaymentId, reason, ctx.employee.id])).rows[0];
  await audit(client, ctx, 'invoice.credit', 'invoice', i.id,
    creditNo + ' on ' + i.invoice_no + ': credited ' + i.currency + ' ' + amount.toFixed(2) +
    (refund ? ', refunded ' + i.currency + ' ' + refund.toFixed(2) + ' by ' + method.replace('_', ' ') : '') + ' \u2014 ' + reason + '.');
  return { id: note.id, creditNo: creditNo, overpaidLeft: money(overpaid - refund) };
}

module.exports = { list: list, listRaw: listRaw, create: create, applyCredit: applyCredit, roomOn: roomOn };
