var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { buildLineItems, todayISO, addDays } = require('../utils/documents');
var poki = require('./poki.service');
var billing = require('./pokiBilling.service');
var invoicesService = require('./invoices.service');
var sharesService = require('./shares.service');

// Acting on a Poki invoice: preview, payment, void, share, and the one-off
// charges the automatic paths (rent run, meters, maintenance) don't cover.
//
// Rent and utility invoices are rows in the shared `invoices` table, so the
// payment, receipt and share-link machinery already built for Bamboo
// Products applies to them unchanged — recording a payment has to write a
// payment row, a receipt, and recompute the balance and status, and there
// should be exactly one implementation of that.
//
// The catch is permissions. Those services gate on invoice.manage, which is
// Bamboo Products' permission and which Poki's managers deliberately do not
// hold — granting it would hand them BPL's invoices too, defeating the
// company separation the whole module rests on. So each function here
// proves two things first (the caller holds poki.manage, AND the invoice
// actually belongs to Poki) and only then delegates through a context with
// that one permission added. See elevate() below.

// Every caller must pass through this. Checking company_id is what stops a
// Poki manager reaching a Bamboo Products invoice by passing its id to a
// /poki/ endpoint.
async function assertPokiInvoice(id) {
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query('SELECT * FROM invoices WHERE id = $1', [id]);
  var inv = res.rows[0];
  if (!inv) fail('notfound', 'Invoice not found.');
  if (inv.company_id !== companyId) fail('notfound', 'Invoice not found.');
  return inv;
}

// A context that can do exactly one extra thing, used only after
// assertPokiInvoice has confirmed the target. Object.create keeps the real
// employee on the prototype chain, so audit entries still name the person
// who acted rather than an anonymous elevated principal.
function elevate(ctx) {
  var e = Object.create(ctx);
  e.can = function (perm) {
    if (perm === 'invoice.manage' || perm === 'invoice.read') return true;
    return ctx.can(perm);
  };
  return e;
}

// The only way to obtain an elevated context. Fusing the two checks with
// the elevation means a future endpoint physically cannot delegate without
// first proving both that the caller may manage Poki and that the invoice
// is Poki's — the previous shape left that to each call site remembering,
// which is the kind of discipline that holds until the day it doesn't.
async function actingOnPokiInvoice(ctx, id, fn) {
  poki.canManage(ctx);
  var inv = await assertPokiInvoice(id);
  return fn(elevate(ctx), inv);
}

// The letterhead of the company that issued the document. Poki heads its
// paperwork with its own wordmark and the office behind it, not the group's
// logo — a tenant's invoice has to say who is charging them.
async function letterhead(companyId) {
  var res = await pool.query(
    'SELECT name, legal_name, letterhead_subtitle, address, ghana_post_gps, phone, email, tax_id, invoice_footer ' +
    'FROM companies WHERE id = $1',
    [companyId]
  );
  var c = res.rows[0] || {};
  return {
    name: c.legal_name || c.name || '',
    subtitle: c.letterhead_subtitle || '',
    address: c.address || '',
    ghanaPostGps: c.ghana_post_gps || '',
    phone: c.phone || '',
    email: c.email || '',
    taxId: c.tax_id || '',
    invoiceFooter: c.invoice_footer || ''
  };
}

async function get(ctx, id) {
  poki.canRead(ctx);
  var inv = await assertPokiInvoice(id);
  var extra = await pool.query(
    'SELECT c.name AS customer_name, c.email, c.phone, c.address, l.lease_no, ' +
    '       u.code AS unit_code, p.name AS property_name ' +
    'FROM invoices i ' +
    'JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN poki_leases l ON l.id = i.poki_lease_id ' +
    'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
    'LEFT JOIN poki_properties p ON p.id = u.property_id ' +
    'WHERE i.id = $1',
    [id]
  );
  var x = extra.rows[0] || {};

  // The printable invoice has to be headed by the company that issued it.
  // Poki bills its own tenants under its own name and address, and an
  // invoice going out under "Bamboo Products Limited" would undo the whole
  // point of keeping the two businesses' books apart.
  return invoicesService.rowToInvoice(pool, inv, {
    company: await letterhead(inv.company_id),
    customerName: x.customer_name, customerEmail: x.email, customerPhone: x.phone, customerAddress: x.address,
    leaseNo: x.lease_no, unitCode: x.unit_code, propertyName: x.property_name,
    docKind: inv.doc_kind, periodStart: inv.period_start, periodEnd: inv.period_end
  });
}

async function recordPayment(ctx, id, p) {
  return actingOnPokiInvoice(ctx, id, function (e) {
    return invoicesService.recordPayment(e, id, p);
  });
}

async function voidInvoice(ctx, id) {
  return actingOnPokiInvoice(ctx, id, function (e) {
    return invoicesService.voidInvoice(e, id);
  });
}

async function createShareLink(ctx, id, expiresInDays) {
  return actingOnPokiInvoice(ctx, id, function (e) {
    return sharesService.createShareLink(e, 'invoice', id, expiresInDays);
  });
}

async function shareViaWhatsApp(ctx, id, url) {
  return actingOnPokiInvoice(ctx, id, function (e) {
    return sharesService.shareViaWhatsApp(e, 'invoice', id, url);
  });
}

// One-off charges: service charge, late fee, cleaning, damages — anything
// outside rent, metered utilities and maintenance recharges.
//
// Deliberately cannot raise doc_kind 'rent' or 'utility'. Those kinds carry
// bookkeeping the automatic paths own — a rent invoice advances its lease's
// next_invoice_on, a utility invoice marks meter readings billed — and an
// invoice created here would carry the label without the bookkeeping,
// leaving the rent run to bill the same period again.
var MANUAL_KINDS = ['other', 'deposit', 'maintenance'];

async function create(ctx, p) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var docKind = V.oneOf(p.docKind || 'other', MANUAL_KINDS, 'Charge kind');

  var tenant = await pool.query(
    'SELECT t.id, c.id AS customer_id, c.name, c.preferred_currency ' +
    'FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1',
    [p.tenantId]
  );
  if (!tenant.rows[0]) fail('invalid', 'Choose a tenant from the Poki register.');

  // Attaching the lease is what makes the charge show up in that tenancy's
  // arrears rather than floating free of the unit it relates to.
  var leaseId = null;
  if (p.leaseId) {
    var lease = await pool.query(
      'SELECT l.id FROM poki_leases l JOIN poki_units u ON u.id = l.unit_id ' +
      'JOIN poki_properties pr ON pr.id = u.property_id ' +
      'WHERE l.id = $1 AND l.tenant_id = $2 AND pr.company_id = $3',
      [p.leaseId, p.tenantId, companyId]
    );
    if (!lease.rows[0]) fail('invalid', 'That lease does not belong to this tenant.');
    leaseId = lease.rows[0].id;
  }

  var items = buildLineItems(p.items);
  var issuedAt = V.date(p.issuedAt || todayISO(), 'Issue date');
  var dueDate = V.date(p.dueDate || addDays(issuedAt, 14), 'Due date');
  if (dueDate < issuedAt) fail('invalid', 'The due date cannot be before the issue date.');

  var instructions = await billing.pokiPaymentInstructions();
  var { withTransaction } = require('../db/pool');
  var { audit } = require('../utils/audit');

  var inv = await withTransaction(async function (client) {
    var created = await billing.insertPokiInvoice(client, {
      customerId: tenant.rows[0].customer_id, companyId: companyId, docKind: docKind,
      leaseId: leaseId, items: items, issuedAt: issuedAt, dueDate: dueDate,
      currency: (p.currency || tenant.rows[0].preferred_currency || 'GHS').toUpperCase(),
      instructions: instructions, notes: (p.notes || '').trim(), terms: (p.terms || '').trim()
    });
    await audit(client, ctx, 'poki.invoice.create', 'invoice', created.id,
      'Raised ' + created.invoice_no + ' (' + docKind + ') for ' + tenant.rows[0].name +
      ' — ' + created.currency + ' ' + Number(created.grand_total).toLocaleString() + '.');
    return created;
  });

  return get(ctx, inv.id);
}

module.exports = {
  get: get, recordPayment: recordPayment, voidInvoice: voidInvoice,
  createShareLink: createShareLink, shareViaWhatsApp: shareViaWhatsApp,
  create: create, MANUAL_KINDS: MANUAL_KINDS, letterhead: letterhead
};
