var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var {
  buildLineItems, computeDocTotals, nextDocNumber, todayISO, addDays,
  insertLineItems, loadLineItems, roundMoney, buildPaymentSchedule
} = require('../utils/documents');
var poki = require('./poki.service');
var sharesService = require('./shares.service');

// Poki's estimates: what it costs a prospect to take a unit, quoted before
// any booking exists.
//
// Like rent invoices, these are ordinary rows in the shared `estimates`
// table tagged with company_id = Poki (migration 0056) plus doc_kind and
// poki_unit_id (0057). The estimate machinery already in production —
// totals, validity, payment schedules, share links, the printable preview,
// convert-to-quotation — applies unchanged; a letting offer is not a
// different kind of document, it is an estimate whose lines happen to
// describe a tenancy.
//
// What is genuinely different is where the numbers come from. A sales
// estimate is typed; a letting offer is derived from the unit's own terms
// (base rent, cycle, utility arrangement), so the operator picks a unit and
// gets a costed offer to adjust rather than a blank form. And an accepted
// offer converts to a draft booking instead of a quotation.


// Utilities never become a rent line unless they are a flat charge, but the
// prospect still has to be told the arrangement — it is the question every
// tenant asks and the one that causes disputes later.
function utilityNote(unit) {
  var amount = Number(unit.fixed_utility_amount || 0);
  var share = Number(unit.apportion_share || 0);
  if (unit.utility_mode === 'fixed') {
    return 'Utilities are charged at a flat ' + unit.currency + ' ' + amount.toLocaleString() +
      ' per month, included above.';
  }
  if (unit.utility_mode === 'metered') {
    return 'Electricity and water are sub-metered for this unit and billed on actual usage each period, separately from rent.';
  }
  if (unit.utility_mode === 'apportioned') {
    return 'A ' + share + '% share of the building utility bill is charged each period, separately from rent.';
  }
  return 'Utilities are paid by the tenant directly to the provider.';
}

// The costed offer for a unit: rent for however many periods are wanted up
// front, the deposit, and the fixed utility charge where the unit has one.
// Returned as plain line items so the caller can edit them before saving —
// nothing here is binding, it is a starting point.
function lettingLines(unit, opts) {
  // Mirrors what the booking itself will cost: whole months at the unit's
  // monthly rate, plus any leftover days at its daily rate, plus the
  // deposit. Priced the same way as poki.service.js's priceBooking so the
  // offer a prospect accepts and the booking they get are the same number.
  var months = Math.max(0, parseInt(opts.durationMonths, 10) || 0);
  var days = Math.max(0, parseInt(opts.durationDays, 10) || 0);
  if (months === 0 && days === 0) months = 1;
  var depositMonths = Math.max(0, Number(opts.depositMonths) || 0);
  var label = unit.property_name + ' \u00b7 ' + unit.code;
  var monthlyRate = roundMoney(unit.base_rent);
  var dailyRate = Number(unit.daily_rate) > 0 ? roundMoney(unit.daily_rate) : roundMoney(monthlyRate / 30);

  var lines = [];
  if (months > 0) {
    lines.push({
      description: 'Rent \u2014 ' + label,
      qty: months,
      unit: 'month',
      unitPrice: monthlyRate,
      notes: (unit.name || unit.unit_type) + ', payable in full before occupation.'
    });
  }
  if (days > 0) {
    lines.push({
      description: 'Rent (days) \u2014 ' + label,
      qty: days,
      unit: 'day',
      unitPrice: dailyRate,
      notes: Number(unit.daily_rate) > 0 ? 'At this unit\'s daily rate.' : 'Charged at one thirtieth of the monthly rate.'
    });
  }

  if (depositMonths > 0) {
    lines.push({
      description: 'Security deposit \u2014 ' + label,
      qty: 1,
      unit: 'each',
      unitPrice: roundMoney(monthlyRate * depositMonths),
      notes: depositMonths + ' month(s) rent, refundable at the end of the tenancy less any arrears or damage.'
    });
  }

  if (unit.utility_mode === 'fixed' && Number(unit.fixed_utility_amount) > 0 && months > 0) {
    lines.push({
      description: 'Utilities (flat charge) \u2014 ' + label,
      qty: months,
      unit: 'month',
      unitPrice: roundMoney(unit.fixed_utility_amount),
      notes: 'Flat utility charge for this unit.'
    });
  }

  return lines;
}

async function loadUnit(unitId) {
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query(
    'SELECT u.*, p.name AS property_name, p.company_id ' +
    'FROM poki_units u JOIN poki_properties p ON p.id = u.property_id ' +
    'WHERE u.id = $1 AND p.company_id = $2',
    [unitId, companyId]
  );
  if (!res.rows[0]) fail('invalid', 'Choose a Poki unit.');
  return res.rows[0];
}

// Preview only — writes nothing. The screen calls this when a unit is
// picked so the operator sees the costed offer before committing to it.
async function lettingDraft(ctx, p) {
  poki.canRead(ctx);
  var unit = await loadUnit(p.unitId);
  var items = lettingLines(unit, p);
  var totals = computeDocTotals(buildLineItems(items), null, 0);
  // The validity date the offer would get if the operator doesn't choose
  // one. Returned so the screen can show it rather than leaving the field
  // blank and stamping a date they never saw.
  var settings = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var validUntil = addDays(todayISO(), settings.rows[0].commercial.templates.validityDays);
  return {
    validUntil: validUntil,
    unitId: unit.id,
    unitCode: unit.code,
    propertyName: unit.property_name,
    unitStatus: unit.status,
    currency: unit.currency,
    baseRent: Number(unit.base_rent),
    dailyRate: Number(unit.daily_rate) > 0 ? Number(unit.daily_rate) : roundMoney(Number(unit.base_rent) / 30),
    depositAmount: roundMoney(Number(unit.base_rent) * (Number(p.depositMonths) || 0)),
    items: items,
    clientNotes: utilityNote(unit),
    grandTotal: totals.grandTotal
  };
}

var ESTIMATE_SELECT =
  'SELECT e.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, ' +
  '       u.code AS unit_code, u.status AS unit_status, pr.name AS property_name, ' +
  '       l.id AS booking_id, l.booking_no ' +
  'FROM estimates e ' +
  'JOIN customers c ON c.id = e.customer_id ' +
  'LEFT JOIN poki_units u ON u.id = e.poki_unit_id ' +
  'LEFT JOIN poki_properties pr ON pr.id = u.property_id ' +
  'LEFT JOIN poki_bookings l ON l.from_estimate_id = e.id ';

async function rowToEstimate(r) {
  var items = await loadLineItems(pool, 'estimate', r.id);
  return {
    id: r.id,
    estimateNo: r.estimate_no,
    docKind: r.doc_kind,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    customerPhone: r.customer_phone,
    unitId: r.poki_unit_id,
    unitCode: r.unit_code,
    unitStatus: r.unit_status,
    propertyName: r.property_name,
    bookingId: r.booking_id,
    bookingNo: r.booking_no,
    items: items,
    currency: r.currency,
    subtotal: Number(r.subtotal),
    discountTotal: Number(r.discount_total),
    taxTotal: Number(r.tax_total),
    grandTotal: Number(r.grand_total),
    status: r.status,
    validUntil: r.valid_until,
    internalNotes: r.internal_notes,
    clientNotes: r.client_notes,
    terms: r.terms,
    discount: { value: Number(r.discount_value), type: r.discount_type },
    taxRate: Number(r.tax_rate),
    paymentSchedule: r.payment_schedule || [],
    createdAt: r.created_at
  };
}

async function list(ctx, filters) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var params = [companyId];
  var sql = ESTIMATE_SELECT + 'WHERE e.company_id = $1 ';
  if (filters && filters.status) { params.push(filters.status); sql += 'AND e.status = $' + params.length + ' '; }
  if (filters && filters.unitId) { params.push(filters.unitId); sql += 'AND e.poki_unit_id = $' + params.length + ' '; }
  sql += 'ORDER BY e.created_at DESC';
  var res = await pool.query(sql, params);
  var out = [];
  for (var i = 0; i < res.rows.length; i++) out.push(await rowToEstimate(res.rows[i]));
  return out;
}

async function get(ctx, id) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query(ESTIMATE_SELECT + 'WHERE e.id = $1 AND e.company_id = $2', [id, companyId]);
  if (!res.rows[0]) fail('notfound', 'Estimate not found.');
  var out = await rowToEstimate(res.rows[0]);
  // Required to print the offer under Poki's own name rather than the
  // group's. Shared with the invoice side so the two documents can't drift.
  out.company = await require('./pokiInvoices.service').letterhead(companyId);
  return out;
}

// Same elevation reasoning as the invoice side: Poki's managers hold
// poki.manage, not quotation.manage, and the offer has already been proved
// to belong to Poki by get() before the delegate runs.
function elevate(ctx) {
  var e = Object.create(ctx);
  e.can = function (perm) {
    if (perm === 'quotation.manage' || perm === 'quotation.read') return true;
    return ctx.can(perm);
  };
  return e;
}

// Same fusing as the invoice side: elevation is unobtainable without first
// proving the caller may manage Poki and that the offer is Poki's.
async function actingOnPokiEstimate(ctx, id, fn) {
  poki.canManage(ctx);
  var est = await get(ctx, id);
  return fn(elevate(ctx), est);
}

async function createShareLink(ctx, id, expiresInDays) {
  return actingOnPokiEstimate(ctx, id, function (e) {
    return sharesService.createShareLink(e, 'estimate', id, expiresInDays);
  });
}

async function shareViaWhatsApp(ctx, id, url) {
  return actingOnPokiEstimate(ctx, id, function (e) {
    return sharesService.shareViaWhatsApp(e, 'estimate', id, url);
  });
}

// The customer on a Poki estimate is always someone in the tenant register
// — a prospect who has not signed is still a tenant record, which is what
// the 'prospect' status on poki_tenants is for. Quoting a name that exists
// nowhere would leave a document that cannot become a booking.
async function resolveTenant(tenantId) {
  var res = await pool.query(
    'SELECT t.id, t.customer_id, c.name, c.preferred_currency ' +
    'FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1',
    [tenantId]
  );
  if (!res.rows[0]) fail('invalid', 'Choose a tenant or prospect from the Poki register.');
  return res.rows[0];
}

async function create(ctx, p) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var tenant = await resolveTenant(p.tenantId);
  var docKind = V.oneOf(p.docKind || 'letting', ['letting', 'maintenance', 'other'], 'Estimate kind');

  var unit = null;
  if (p.unitId) unit = await loadUnit(p.unitId);
  if (docKind === 'letting' && !unit) fail('invalid', 'A letting offer needs the unit it is offering.');

  var items = buildLineItems(p.items);
  var totals = computeDocTotals(items, p.discount, p.taxRate);

  var settings = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var commercial = settings.rows[0].commercial;
  var validUntil = V.date(p.validUntil || addDays(todayISO(), commercial.templates.validityDays), 'Valid until');
  // Only the validity window is taken from the group's commercial settings.
  // The terms come from Poki's own record, because the group's template
  // names Bamboo Products and describes a sale of goods, neither of which
  // is true of a tenancy. Blank until Poki sets its own — an empty Terms
  // block is better than a confidently wrong one on a document going to a
  // prospect.
  var company = await require('./pokiInvoices.service').letterhead(companyId);
  var currency = (p.currency || (unit && unit.currency) || tenant.preferred_currency || 'GHS').toUpperCase();

  var discountValue = Number((p.discount && p.discount.value) || 0);
  var discountType = (p.discount && p.discount.type === 'percent') ? 'percent' : 'fixed';
  var taxRate = Number(p.taxRate) || 0;
  var schedule = buildPaymentSchedule(p.paymentSchedule, totals.grandTotal);

  var newId = await withTransaction(async function (client) {
    var estimateNo = await nextDocNumber(client, 'estimate');
    var res = await client.query(
      'INSERT INTO estimates (estimate_no, customer_id, company_id, doc_kind, poki_unit_id, subtotal, discount_total, ' +
      'tax_total, grand_total, status, created_by, valid_until, internal_notes, client_notes, terms, currency, ' +
      'discount_value, discount_type, tax_rate, payment_schedule) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *",
      [
        estimateNo, tenant.customer_id, companyId, docKind, unit ? unit.id : null,
        totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal,
        ctx.employee ? ctx.employee.id : null, validUntil,
        (p.internalNotes || '').trim(), (p.clientNotes || '').trim(),
        p.terms || company.invoiceFooter || '', currency,
        discountValue, discountType, taxRate, JSON.stringify(schedule)
      ]
    );
    await insertLineItems(client, 'estimate', res.rows[0].id, items);
    await audit(client, ctx, 'poki.estimate.create', 'estimate', res.rows[0].id,
      'Created ' + res.rows[0].estimate_no + ' (' + docKind + ') for ' + tenant.name +
      (unit ? ' on unit ' + unit.code : '') + ' — ' + currency + ' ' + totals.grandTotal.toLocaleString() + '.');
    return res.rows[0].id;
  });

  return get(ctx, newId);
}

async function update(ctx, id, p) {
  poki.canManage(ctx);
  var existing = await get(ctx, id);
  if (existing.status !== 'draft') fail('conflict', 'Only a draft estimate can be edited.');

  var tenant = await resolveTenant(p.tenantId);
  var unit = p.unitId ? await loadUnit(p.unitId) : null;
  if (existing.docKind === 'letting' && !unit) fail('invalid', 'A letting offer needs the unit it is offering.');

  var items = buildLineItems(p.items);
  var totals = computeDocTotals(items, p.discount, p.taxRate);
  var validUntil = p.validUntil ? V.date(p.validUntil, 'Valid until') : existing.validUntil;
  var discountValue = Number((p.discount && p.discount.value) || 0);
  var discountType = (p.discount && p.discount.type === 'percent') ? 'percent' : 'fixed';
  var taxRate = Number(p.taxRate) || 0;
  var schedule = buildPaymentSchedule(p.paymentSchedule, totals.grandTotal);

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE estimates SET customer_id = $1, poki_unit_id = $2, subtotal = $3, discount_total = $4, tax_total = $5, ' +
      'grand_total = $6, valid_until = $7, internal_notes = $8, client_notes = $9, currency = $10, ' +
      'discount_value = $11, discount_type = $12, tax_rate = $13, payment_schedule = $14 WHERE id = $15',
      [
        tenant.customer_id, unit ? unit.id : null, totals.subtotal, totals.discountTotal, totals.taxTotal,
        totals.grandTotal, validUntil, (p.internalNotes || '').trim(), (p.clientNotes || '').trim(),
        (p.currency || existing.currency).toUpperCase(), discountValue, discountType, taxRate,
        JSON.stringify(schedule), id
      ]
    );
    await client.query('DELETE FROM document_line_items WHERE document_type = $1 AND document_id = $2', ['estimate', id]);
    await insertLineItems(client, 'estimate', id, items);
    await audit(client, ctx, 'poki.estimate.update', 'estimate', id, 'Updated ' + existing.estimateNo + '.');
  });

  return get(ctx, id);
}

async function setStatus(ctx, id, status) {
  poki.canManage(ctx);
  var existing = await get(ctx, id);
  // 'converted' is set by convertToBooking alone — it means a booking exists,
  // and letting anyone set it by hand would strand an offer that claims a
  // tenancy it never created.
  status = V.oneOf(status, ['draft', 'finalized', 'archived'], 'Status');
  if (existing.status === 'converted') fail('conflict', 'This offer has already become booking ' + existing.bookingNo + '.');
  await pool.query('UPDATE estimates SET status = $1 WHERE id = $2', [status, id]);
  await audit(pool, ctx, 'poki.estimate.status', 'estimate', id, 'Set ' + existing.estimateNo + ' to ' + status + '.');
  return get(ctx, id);
}

async function remove(ctx, id) {
  poki.canManage(ctx);
  var existing = await get(ctx, id);
  if (existing.status === 'converted') fail('conflict', 'Cannot delete an offer that has become booking ' + existing.bookingNo + '.');
  await pool.query('DELETE FROM estimates WHERE id = $1', [id]);
  await audit(pool, ctx, 'poki.estimate.delete', 'estimate', id, 'Deleted estimate ' + existing.estimateNo + '.');
  return true;
}

// The prospect accepted: turn the offer into a draft booking on the unit it
// quoted.
//
// The booking terms come from the caller rather than being parsed back out of
// the line items. Descriptions are free text the operator may well have
// edited, and re-deriving a rent or deposit figure from them would be a
// guess dressed up as a calculation. The screen pre-fills the dialog from
// the estimate and the unit; what is confirmed there is what is written.
//
// A draft, not an active booking: activating is a separate, deliberate step
// that checks the unit is free and flips it to occupied.
async function convertToBooking(ctx, id, p) {
  poki.canManage(ctx);
  var est = await get(ctx, id);
  if (est.docKind !== 'letting') fail('conflict', 'Only a letting offer can become a booking.');
  if (est.status === 'converted') fail('conflict', 'This offer has already become booking ' + est.bookingNo + '.');
  if (!est.unitId) fail('conflict', 'This offer has no unit attached.');

  var tenantRes = await pool.query('SELECT id FROM poki_tenants WHERE customer_id = $1', [est.customerId]);
  if (!tenantRes.rows[0]) fail('conflict', 'The customer on this offer is not in the Poki tenant register.');

  var booking = await poki.createBooking(ctx, {
    unitId: est.unitId,
    tenantId: tenantRes.rows[0].id,
    startDate: p.startDate,
    endDate: p.endDate,
    rentTotal: p.rentTotal,
    depositAmount: p.depositAmount,
    rentCycle: p.rentCycle,
    paymentDay: p.paymentDay,
    escalationPercent: p.escalationPercent,
    currency: est.currency,
    status: 'draft',
    notes: p.notes || ('From letting offer ' + est.estimateNo + '.')
  });

  await withTransaction(async function (client) {
    await client.query('UPDATE poki_bookings SET from_estimate_id = $1 WHERE id = $2', [est.id, booking.id]);
    await client.query("UPDATE estimates SET status = 'converted' WHERE id = $1", [est.id]);
    await audit(client, ctx, 'poki.estimate.convert', 'estimate', est.id,
      'Converted ' + est.estimateNo + ' to booking ' + booking.bookingNo + '.');
  });

  return { estimate: await get(ctx, id), booking: await poki.getBooking(ctx, booking.id) };
}

module.exports = {
  lettingDraft: lettingDraft, list: list, get: get, create: create, update: update,
  setStatus: setStatus, remove: remove, convertToBooking: convertToBooking,
  createShareLink: createShareLink, shareViaWhatsApp: shareViaWhatsApp,
  lettingLines: lettingLines
};
