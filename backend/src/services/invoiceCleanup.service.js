var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { todayISO, bplScopeClause } = require('../utils/documents');
var invoices = require('./invoices.service');
var creditNotes = require('./creditNotes.service');
var poki = require('./poki.service');
var pokiInvoices = require('./pokiInvoices.service');

// Clearing out old invoices in one go: debts that will never come in, or
// money that did come in but was never recorded (Square imports, mostly).
// Several invoices, one action, one reason:
//   paid      — the money came in: a payment of what is left, with its
//               receipt (not emailed: the customer would get receipts for
//               money paid long ago);
//   write_off — the money will not come: a credit note for what is left,
//               so the invoice stays (and stays delivered) but owes nothing;
//   void      — the sale never happened: only an invoice with no payments,
//               and what it took from stock goes back.
// Each invoice goes through the same rules as doing it by hand, on its own,
// so one that cannot be done (already paid, part-paid and voided…) is
// reported and the rest still go through. The audit log keeps an entry for
// each invoice (with the reason) and one for the whole clean-up.
//
// Two sides: Bamboo Products' invoices (apply, invoice.manage, the Invoices
// page) and Poki Properties' rent and utility bills (applyPoki, poki.manage,
// Rent & utilities), each only ever touching its own company's invoices and
// going through its own rules — a Poki bill through pokiInvoices.service.js,
// so a rent bill paid off still marks the booking's deposit as held, and a
// voided bill puts its meter readings and recurring charges back to not
// billed.

var ACTIONS = ['paid', 'write_off', 'void'];
var METHODS = ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other'];
var MAX = 200;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Bamboo Products' invoices (the Invoices page).
async function apply(ctx, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  return run(ctx, p, {
    label: 'Clean-up',
    scope: function () { return bplScopeClause('i'); },
    pay: function (id, o) { return invoices.recordPayment(ctx, id, o); },
    credit: function (id, o) { return creditNotes.create(ctx, id, o); },
    voidIt: function (id, reason) { return invoices.voidInvoice(ctx, id, reason); }
  });
}

// Poki Properties' rent and utility bills (Rent & utilities).
async function applyPoki(ctx, p) {
  poki.canManage(ctx);
  var pokiId = await poki.pokiCompanyId();
  return run(ctx, p, {
    label: 'Poki clean-up',
    scope: function (arg) { return 'i.company_id = ' + arg(pokiId); },
    pay: function (id, o) { return pokiInvoices.recordPayment(ctx, id, o); },
    credit: function (id, o) { return pokiInvoices.createCreditNote(ctx, id, o); },
    voidIt: function (id, reason) { return pokiInvoices.voidInvoice(ctx, id, reason); }
  });
}

async function run(ctx, p, side) {
  p = p || {};
  var action = V.oneOf(p.action, ACTIONS, 'What to do');
  var reason = V.text(p.reason, 'Reason', 300);
  var ids = Array.isArray(p.invoiceIds) ? p.invoiceIds.filter(function (x, i, all) { return all.indexOf(x) === i; }) : [];
  if (!ids.length) fail('invalid', 'Tick at least one invoice.');
  if (ids.length > MAX) fail('invalid', 'At most ' + MAX + ' invoices at a time.');
  if (ids.some(function (x) { return !UUID.test(String(x)); })) fail('invalid', 'One of the invoices is not valid.');
  var method = null, date = null;
  if (action === 'paid') {
    method = V.oneOf(p.method || 'bank_transfer', METHODS, 'Payment method');
    date = V.date(p.date || todayISO(), 'Payment date');
    if (date > todayISO()) fail('invalid', 'The payment date cannot be in the future.');
  }

  // Only this side's invoices (not another company's).
  var args = [ids];
  var rows = (await pool.query(
    'SELECT i.id, i.invoice_no, i.currency, i.balance_due, c.name AS customer_name FROM invoices i JOIN customers c ON c.id = i.customer_id ' +
    'WHERE i.id = ANY($1::uuid[]) AND ' + side.scope(function (v) { args.push(v); return '$' + args.length; }), args)).rows;
  var byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });

  var results = [];
  for (var k = 0; k < ids.length; k++) {
    var r = byId[ids[k]];
    if (!r) { results.push({ id: ids[k], ok: false, error: 'Invoice not found.' }); continue; }
    var out = { id: r.id, invoiceNo: r.invoice_no, customerName: r.customer_name, currency: r.currency, amount: money(r.balance_due) };
    try {
      if (action === 'paid') {
        // The balance as it is now, not as the page last saw it.
        var due = money((await pool.query('SELECT balance_due FROM invoices WHERE id = $1', [r.id])).rows[0].balance_due);
        if (due <= 0) fail('conflict', 'Nothing is owed on this invoice.');
        var paid = await side.pay(r.id, {
          amount: due, method: method, date: date, reference: 'Clean-up', notes: reason, noReceiptEmail: true
        });
        out.amount = due;
        out.made = paid.receipt.receiptNo;
      } else if (action === 'write_off') {
        var left = money((await pool.query('SELECT balance_due FROM invoices WHERE id = $1', [r.id])).rows[0].balance_due);
        if (left <= 0) fail('conflict', 'Nothing is owed on this invoice.');
        var cn = await side.credit(r.id, { amount: left, reason: reason });
        out.amount = left;
        out.made = cn.creditNote.creditNo;
      } else {
        var cur = (await pool.query('SELECT status, amount_paid FROM invoices WHERE id = $1', [r.id])).rows[0];
        if (cur.status === 'paid') fail('conflict', 'This invoice is paid; it cannot be voided.');
        if (Number(cur.amount_paid) > 0) fail('conflict', 'Part of this invoice has been paid, so it cannot be voided. Write off what is left instead.');
        await side.voidIt(r.id, reason);
      }
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    results.push(out);
  }

  var done = results.filter(function (x) { return x.ok; });
  var totals = {};
  done.forEach(function (x) { totals[x.currency] = money((totals[x.currency] || 0) + x.amount); });
  if (done.length) {
    var word = { paid: 'recorded as paid', write_off: 'written off', void: 'voided' }[action];
    await audit(pool, ctx, 'invoice.cleanup', 'invoice', null,
      side.label + ': ' + done.length + ' invoice(s) ' + word + ' (' +
      Object.keys(totals).map(function (c) { return c + ' ' + totals[c].toFixed(2); }).join(', ') + '): ' +
      done.map(function (x) { return x.invoiceNo; }).join(', ') + ' \u2014 ' + reason + '.',
      { action: action, invoiceIds: done.map(function (x) { return x.id; }) });
  }
  return {
    action: action,
    done: done.length,
    failed: results.length - done.length,
    totals: Object.keys(totals).map(function (c) { return { currency: c, amount: totals[c] }; }),
    results: results
  };
}

module.exports = { apply: apply, applyPoki: applyPoki, ACTIONS: ACTIONS };
