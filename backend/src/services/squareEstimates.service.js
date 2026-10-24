var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var estimates = require('./estimates.service');
var customers = require('./customers.service');

// Estimates made in Square, brought into Estimates (migration 0185). Square
// has no way for another app to read its estimates (its API has invoices,
// not estimates), so the Estimates page reads the PDFs Square makes of them
// (frontend lib/squareEstimates.js, in the browser), shows what it found to
// be checked, and sends it here. Each keeps Square's number: the same
// estimate brought twice is found, not copied. Its customer is the one
// picked, or found by email, phone or name, or else added.

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function digits(v) { return String(v || '').replace(/\D/g, '').slice(-9); }
function isoDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null; }
var STATUS = ['draft', 'finalized', 'accepted', 'declined'];

async function customerFor(ctx, e) {
  if (e.customerId) {
    var picked = (await pool.query('SELECT id FROM customers WHERE id = $1', [e.customerId])).rows[0];
    if (!picked) fail('invalid', 'That customer no longer exists.');
    return { id: picked.id, added: false };
  }
  var c = e.customer || {};
  var name = text(c.name, 100), email = text(c.email, 200).toLowerCase(), phone = digits(c.phone);
  if (email) {
    var byEmail = (await pool.query('SELECT id FROM customers WHERE lower(email) = $1 ORDER BY created_at LIMIT 1', [email])).rows[0];
    if (byEmail) return { id: byEmail.id, added: false };
  }
  if (phone.length === 9) {
    var byPhone = (await pool.query("SELECT id FROM customers WHERE right(regexp_replace(phone, '\\D', '', 'g'), 9) = $1 ORDER BY created_at LIMIT 1", [phone])).rows[0];
    if (byPhone) return { id: byPhone.id, added: false };
  }
  if (name) {
    var byName = (await pool.query('SELECT id FROM customers WHERE lower(name) = lower($1) ORDER BY created_at LIMIT 1', [name])).rows[0];
    if (byName) return { id: byName.id, added: false };
  }
  if (!name) fail('invalid', 'Pick the customer for Square estimate ' + (e.squareNo || '') + '.');
  if (!ctx.can('customer.manage')) fail('forbidden', name + ' is not a customer yet, and your role cannot add customers: pick one.');
  var made = await customers.create(ctx, { name: name, email: c.email, phone: c.phone, address: c.address, category: 'prospect', notes: 'Added from a Square estimate.' });
  await pool.query("UPDATE customers SET source = 'square' WHERE id = $1", [made.id]);
  return { id: made.id, added: true };
}

// POST /api/estimates/import-square { estimates: [...] } — what was read from
// Square's PDFs and checked on the page.
async function importParsed(ctx, list) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  if (!Array.isArray(list) || !list.length) fail('invalid', 'No estimates to bring over.');
  if (list.length > 100) fail('invalid', 'Bring at most 100 estimates at a time.');
  var done = { created: [], skipped: [], customersAdded: 0 };
  for (var i = 0; i < list.length; i++) {
    var e = list[i] || {};
    var squareNo = text(e.squareNo, 40).replace(/^#/, '');
    if (!squareNo) fail('invalid', 'Each estimate needs its Square number.');
    var externalId = 'square-estimate:' + squareNo.toLowerCase();
    var had = (await pool.query('SELECT id, estimate_no FROM estimates WHERE external_id = $1', [externalId])).rows[0];
    if (had) { done.skipped.push({ squareNo: squareNo, id: had.id, estimateNo: had.estimate_no }); continue; }
    var items = (Array.isArray(e.items) ? e.items : []).map(function (it) {
      var qty = Number(it.qty), unitPrice = Number(it.unitPrice), discount = Math.max(0, Number(it.discount) || 0);
      return { description: text(it.description, 300), notes: text(it.notes, 500), qty: qty, unitPrice: unitPrice, discount: discount, discountType: 'fixed', unit: text(it.unit, 20) || 'each' };
    }).filter(function (it) { return it.description && it.qty > 0 && it.unitPrice >= 0; });
    if (!items.length) fail('invalid', 'Square estimate ' + squareNo + ' has no items: add them before bringing it over.');
    var who = await customerFor(ctx, e);
    if (who.added) done.customersAdded++;
    var discount = Math.max(0, Number(e.discount) || 0);
    var made = await estimates.create(ctx, {
      customerId: who.id, items: items, currency: e.currency || 'GHS',
      validUntil: isoDay(e.validUntil) || undefined,
      discount: discount ? { type: 'fixed', value: discount } : undefined, taxRate: Math.max(0, Number(e.taxRate) || 0),
      clientNotes: text(e.notes, 2000), internalNotes: 'Brought over from Square estimate #' + squareNo + '.'
    });
    var status = STATUS.indexOf(e.status) >= 0 ? e.status : 'finalized';
    await pool.query(
      "UPDATE estimates SET external_id = $2, source = 'square', terms = $3, status = $4, created_at = coalesce($5::date::timestamptz, created_at), " +
      'client_answer = $6, client_answered_at = CASE WHEN $6::text IS NULL THEN NULL ELSE coalesce($5::date::timestamptz, now()) END WHERE id = $1',
      [made.id, externalId, text(e.terms, 4000), status === 'draft' ? 'draft' : 'finalized', isoDay(e.date),
        status === 'accepted' ? 'approved' : status === 'declined' ? 'declined' : null]);
    done.created.push({ squareNo: squareNo, id: made.id, estimateNo: made.estimateNo });
  }
  await audit(pool, ctx, 'estimate.import_square', 'estimate', done.created.length ? done.created[0].id : '-',
    'Brought ' + done.created.length + ' estimate(s) over from Square' + (done.skipped.length ? '; ' + done.skipped.length + ' already here' : '') + '.');
  return done;
}

module.exports = { importParsed: importParsed };
