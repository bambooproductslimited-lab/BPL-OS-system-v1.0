var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, todayISO } = require('../utils/documents');
var poki = require('./poki.service');
var billing = require('./pokiBilling.service');

// Recurring charges for Poki tenants: the service charge (CAM — common area
// maintenance) and flat utility fees, billed every month, quarter or year
// for as long as the booking runs (migration 0097).
//
// Each charge is billed in advance: on its next date an invoice is raised
// for the period starting that day, due net_days later, and the date moves
// on by one period. The last period is cut at the charge's own end date or
// the booking's, whichever comes first, and charged pro rata by days. When
// several charges of one booking fall due together they go on one invoice.
// A period can only ever be billed once (poki_recurring_charge_runs' key),
// so the daily run, a repeated run and a manual "bill now" can't double up.
//
// The daily job (jobs/dailyAlerts.js) calls run() with no person; a person
// can also bill one charge's next period early from the Rent & utilities
// page.

var KINDS = ['cam', 'utility', 'other'];
var FREQUENCIES = { monthly: 1, quarterly: 3, yearly: 12 };
var DEFAULT_TEXT = { cam: 'Service charge (CAM)', utility: 'Utilities (flat fee)', other: 'Recurring charge' };
var MAX_PERIODS_PER_RUN = 12;

function dateOnly(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function days(fromISO, toISO) { return Math.round((new Date(toISO + 'T00:00:00Z') - new Date(fromISO + 'T00:00:00Z')) / 86400000) + 1; }
function round2(n) { return Math.round(n * 100) / 100; }
function minDate(a, b) { return !a ? b : !b ? a : (a < b ? a : b); }

// The period a charge bills from `start`, cut at `limit`, with its amount.
function periodFor(charge, start, limit) {
  var fullEnd = addDays(poki.addMonths(start, FREQUENCIES[charge.frequency]), -1);
  var end = minDate(fullEnd, limit);
  var amount = Number(charge.amount);
  var part = end < fullEnd;
  if (part) amount = round2(amount * days(start, end) / days(start, fullEnd));
  return { start: start, end: end, amount: amount, part: part, daysUsed: days(start, end), daysFull: days(start, fullEnd), nextStart: addDays(fullEnd, 1) };
}

var LIST_SQL =
  'SELECT c.*, b.booking_no, b.status AS booking_status, b.start_date AS booking_start, b.end_date AS booking_end, b.currency, ' +
  '  u.code AS unit_code, pr.name AS property_name, cu.id AS customer_id, cu.name AS tenant_name, cu.phone AS tenant_phone, ' +
  '  (SELECT count(*) FROM poki_recurring_charge_runs r WHERE r.charge_id = c.id)::int AS periods_billed, ' +
  '  (SELECT COALESCE(sum(r.amount), 0) FROM poki_recurring_charge_runs r WHERE r.charge_id = c.id)::float AS billed_total, ' +
  '  lr.period_start AS last_period_start, lr.period_end AS last_period_end, li.id AS last_invoice_id, li.invoice_no AS last_invoice_no, li.status AS last_invoice_status, li.balance_due AS last_balance ' +
  'FROM poki_recurring_charges c JOIN poki_bookings b ON b.id = c.booking_id JOIN poki_units u ON u.id = b.unit_id ' +
  'JOIN poki_properties pr ON pr.id = u.property_id JOIN poki_tenants t ON t.id = b.tenant_id JOIN customers cu ON cu.id = t.customer_id ' +
  'LEFT JOIN LATERAL (SELECT * FROM poki_recurring_charge_runs r WHERE r.charge_id = c.id ORDER BY r.period_start DESC LIMIT 1) lr ON true ' +
  'LEFT JOIN invoices li ON li.id = lr.invoice_id ';

function rowToCharge(r) {
  return {
    id: r.id, bookingId: r.booking_id, bookingNo: r.booking_no, bookingStatus: r.booking_status, bookingEnd: dateOnly(r.booking_end),
    kind: r.kind, description: r.description, amount: Number(r.amount), currency: r.currency || 'GHS', frequency: r.frequency,
    startDate: dateOnly(r.start_date), endDate: dateOnly(r.end_date), nextDate: dateOnly(r.next_date), netDays: r.net_days, status: r.status,
    unitCode: r.unit_code, propertyName: r.property_name, customerId: r.customer_id, tenantName: r.tenant_name, tenantPhone: r.tenant_phone || '',
    periodsBilled: r.periods_billed, billedTotal: Number(r.billed_total),
    lastPeriod: r.last_period_start ? { start: dateOnly(r.last_period_start), end: dateOnly(r.last_period_end) } : null,
    lastInvoice: r.last_invoice_id ? { id: r.last_invoice_id, invoiceNo: r.last_invoice_no, status: r.last_invoice_status, balanceDue: Number(r.last_balance) } : null,
    createdAt: r.created_at
  };
}

async function list(ctx) {
  poki.canRead(ctx);
  var res = await pool.query(LIST_SQL + 'ORDER BY (c.status = \'active\') DESC, c.next_date, cu.name');
  return res.rows.map(rowToCharge);
}
async function getOne(id) {
  var r = (await pool.query(LIST_SQL + 'WHERE c.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Recurring charge not found.');
  return rowToCharge(r);
}

async function create(ctx, p) {
  poki.canManage(ctx);
  var booking = (await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [p.bookingId])).rows[0];
  if (!booking) fail('invalid', 'Choose a booking.');
  if (['draft', 'active'].indexOf(booking.status) < 0) fail('conflict', 'That booking has ended, so there is nothing left to charge.');
  var kind = V.oneOf(p.kind || 'cam', KINDS, 'Kind');
  var frequency = V.oneOf(p.frequency || 'monthly', Object.keys(FREQUENCIES), 'How often');
  var description = p.description && String(p.description).trim() ? V.text(p.description, 'Description', 120) : DEFAULT_TEXT[kind];
  var amount = Number(p.amount);
  if (!isFinite(amount) || amount <= 0) fail('invalid', 'The amount must be more than zero.');
  var bookingStart = dateOnly(booking.start_date), bookingEnd = dateOnly(booking.end_date);
  var start = p.startDate ? V.date(p.startDate, 'First invoice date') : (todayISO() > bookingStart ? todayISO() : bookingStart);
  if (start > bookingEnd) fail('invalid', 'The first invoice date is after the booking ends (' + bookingEnd + ').');
  var end = p.endDate ? V.date(p.endDate, 'Last date') : null;
  if (end && end < start) fail('invalid', 'The last date must be after the first invoice date.');
  var netDays = p.netDays === undefined || p.netDays === '' ? 14 : Number(p.netDays);
  if (!Number.isInteger(netDays) || netDays < 0 || netDays > 90) fail('invalid', 'Days to pay must be a whole number from 0 to 90.');

  var row = (await pool.query(
    'INSERT INTO poki_recurring_charges (booking_id, kind, description, amount, frequency, start_date, end_date, next_date, net_days, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9) RETURNING id',
    [booking.id, kind, description, amount, frequency, start, end, netDays, ctx.employee ? ctx.employee.id : null])).rows[0];
  await audit(pool, ctx, 'poki.recurring.create', 'poki_recurring_charge', row.id,
    'Set up ' + description + ' of ' + amount + ' ' + frequency + ' on booking ' + booking.booking_no + ', first invoice ' + start + '.');
  return getOne(row.id);
}

// Amount, wording, days to pay, how often, the last date and the next
// invoice date can change; periods already billed stay as they were.
async function update(ctx, id, p) {
  poki.canManage(ctx);
  var c = (await pool.query('SELECT * FROM poki_recurring_charges WHERE id = $1', [id])).rows[0];
  if (!c) fail('notfound', 'Recurring charge not found.');
  if (c.status === 'ended') fail('conflict', 'This charge has ended. Set up a new one instead.');
  var amount = p.amount === undefined ? Number(c.amount) : Number(p.amount);
  if (!isFinite(amount) || amount <= 0) fail('invalid', 'The amount must be more than zero.');
  var description = p.description === undefined ? c.description : V.text(p.description, 'Description', 120);
  var frequency = p.frequency === undefined ? c.frequency : V.oneOf(p.frequency, Object.keys(FREQUENCIES), 'How often');
  var netDays = p.netDays === undefined ? c.net_days : Number(p.netDays);
  if (!Number.isInteger(netDays) || netDays < 0 || netDays > 90) fail('invalid', 'Days to pay must be a whole number from 0 to 90.');
  var next = p.nextDate === undefined ? dateOnly(c.next_date) : V.date(p.nextDate, 'Next invoice date');
  var lastRun = (await pool.query('SELECT max(period_end) AS e FROM poki_recurring_charge_runs WHERE charge_id = $1', [id])).rows[0].e;
  if (lastRun && next <= dateOnly(lastRun)) fail('invalid', 'The next invoice date must be after the period already billed (to ' + dateOnly(lastRun) + ').');
  var end = p.endDate === undefined ? dateOnly(c.end_date) : (p.endDate ? V.date(p.endDate, 'Last date') : null);
  if (end && end < dateOnly(c.start_date)) fail('invalid', 'The last date must be after the first invoice date.');
  await pool.query('UPDATE poki_recurring_charges SET amount = $2, description = $3, frequency = $4, net_days = $5, next_date = $6, end_date = $7, updated_at = now() WHERE id = $1',
    [id, amount, description, frequency, netDays, next, end]);
  await audit(pool, ctx, 'poki.recurring.update', 'poki_recurring_charge', id, 'Changed ' + description + ': ' + amount + ' ' + frequency + ', next invoice ' + next + '.');
  return getOne(id);
}

// Pause stops billing; resuming skips the periods that passed while paused
// (they were not meant to be charged) and carries on from the next one.
// Ending is for good.
async function setStatus(ctx, id, status) {
  poki.canManage(ctx);
  status = V.oneOf(status, ['active', 'paused', 'ended'], 'Status');
  var c = (await pool.query('SELECT * FROM poki_recurring_charges WHERE id = $1', [id])).rows[0];
  if (!c) fail('notfound', 'Recurring charge not found.');
  if (c.status === 'ended' && status !== 'ended') fail('conflict', 'This charge has ended. Set up a new one instead.');
  var next = dateOnly(c.next_date);
  if (status === 'active' && c.status === 'paused') {
    var today = todayISO();
    var guard = 0;
    while (next < today && guard++ < 600) next = poki.addMonths(next, FREQUENCIES[c.frequency]);
  }
  await pool.query('UPDATE poki_recurring_charges SET status = $2, next_date = $3, updated_at = now() WHERE id = $1', [id, status, next]);
  await audit(pool, ctx, 'poki.recurring.' + status, 'poki_recurring_charge', id,
    (status === 'active' ? 'Resumed ' : status === 'paused' ? 'Paused ' : 'Ended ') + c.description + (status === 'active' ? ', next invoice ' + next : '') + '.');
  return getOne(id);
}

// Only a charge never billed can be deleted; one that has been is ended.
async function remove(ctx, id) {
  poki.canManage(ctx);
  var c = (await pool.query('SELECT * FROM poki_recurring_charges WHERE id = $1', [id])).rows[0];
  if (!c) fail('notfound', 'Recurring charge not found.');
  var billed = (await pool.query('SELECT 1 FROM poki_recurring_charge_runs WHERE charge_id = $1 LIMIT 1', [id])).rows[0];
  if (billed) fail('conflict', 'This charge has already been invoiced. End it instead, so its history stays.');
  await pool.query('DELETE FROM poki_recurring_charges WHERE id = $1', [id]);
  await audit(pool, ctx, 'poki.recurring.delete', 'poki_recurring_charge', id, 'Deleted ' + c.description + ' before it was ever billed.');
  return { ok: true };
}

// Raises the invoices that have come due. opts.asOf (default today) is the
// billing date; opts.chargeId bills that one charge's next period now, even
// if its date hasn't come yet. ctx may be null (the daily job).
async function run(ctx, opts) {
  opts = opts || {};
  if (ctx) poki.canManage(ctx);
  var asOf = opts.asOf ? V.date(opts.asOf, 'Date') : todayISO();
  var companyId = await poki.pokiCompanyId();
  var instructions = await billing.pokiPaymentInstructions();

  return withTransaction(async function (client) {
    var args = [asOf];
    var where = "c.status = 'active' AND c.next_date <= $1";
    if (opts.chargeId) { args = [opts.chargeId]; where = "c.id = $1 AND c.status = 'active'"; }
    var due = (await client.query(
      'SELECT c.*, b.booking_no, b.status AS booking_status, b.end_date AS booking_end, b.currency, u.code AS unit_code, pr.name AS property_name, ' +
      '  t.customer_id, cu.name AS tenant_name ' +
      'FROM poki_recurring_charges c JOIN poki_bookings b ON b.id = c.booking_id JOIN poki_units u ON u.id = b.unit_id ' +
      'JOIN poki_properties pr ON pr.id = u.property_id JOIN poki_tenants t ON t.id = b.tenant_id JOIN customers cu ON cu.id = t.customer_id ' +
      'WHERE ' + where + ' ORDER BY b.id, c.next_date FOR UPDATE OF c', args)).rows;
    if (opts.chargeId && !due.length) fail('conflict', 'That charge is paused or has ended, so there is nothing to bill.');

    var byBooking = {};
    var ended = 0;
    for (var i = 0; i < due.length; i++) {
      var c = due[i];
      if (c.booking_status !== 'active') {
        // A booking that ended stops its charges; a draft one waits.
        if (['expired', 'terminated', 'renewed'].indexOf(c.booking_status) >= 0) {
          await client.query("UPDATE poki_recurring_charges SET status = 'ended', updated_at = now() WHERE id = $1", [c.id]);
          ended++;
        }
        continue;
      }
      var limit = minDate(dateOnly(c.end_date), dateOnly(c.booking_end));
      var next = dateOnly(c.next_date);
      var until = opts.chargeId ? next : asOf;
      var periods = [];
      while (next <= until && next <= limit && periods.length < MAX_PERIODS_PER_RUN) {
        var per = periodFor(c, next, limit);
        periods.push(per);
        next = per.nextStart;
      }
      if (periods.length) (byBooking[c.booking_id] = byBooking[c.booking_id] || []).push({ charge: c, periods: periods, next: next });
      if (next > limit) {
        await client.query("UPDATE poki_recurring_charges SET status = 'ended', next_date = $2, updated_at = now() WHERE id = $1", [c.id, next]);
        ended++;
      } else if (periods.length) {
        await client.query('UPDATE poki_recurring_charges SET next_date = $2, updated_at = now() WHERE id = $1', [c.id, next]);
      }
    }

    var out = [];
    var bookingIds = Object.keys(byBooking);
    for (var bi = 0; bi < bookingIds.length; bi++) {
      var group = byBooking[bookingIds[bi]];
      var first = group[0].charge;
      var lines = [];
      var claimed = [];
      for (var gi = 0; gi < group.length; gi++) {
        var ch = group[gi].charge;
        for (var pi = 0; pi < group[gi].periods.length; pi++) {
          var pd = group[gi].periods[pi];
          // Claim the period first: if it was billed already, skip it.
          var got = (await client.query(
            'INSERT INTO poki_recurring_charge_runs (charge_id, period_start, period_end, amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING charge_id',
            [ch.id, pd.start, pd.end, pd.amount])).rows[0];
          if (!got) continue;
          claimed.push({ chargeId: ch.id, start: pd.start });
          lines.push({
            description: ch.description + ' — ' + ch.unit_code,
            notes: pd.start + ' to ' + pd.end + (pd.part ? ' (part period: ' + pd.daysUsed + ' of ' + pd.daysFull + ' days)' : ''),
            qty: 1, unitPrice: pd.amount, kind: ch.kind, netDays: ch.net_days
          });
        }
      }
      if (!lines.length) continue;
      var kinds = lines.map(function (l) { return l.kind; }).filter(function (k, i2, a) { return a.indexOf(k) === i2; });
      var docKind = kinds.length === 1 ? kinds[0] : 'other';
      var netDays = Math.min.apply(null, lines.map(function (l) { return l.netDays; }));
      var starts = group.map(function (g) { return g.periods.map(function (p2) { return p2.start; }); }).flat().sort();
      var ends = group.map(function (g) { return g.periods.map(function (p2) { return p2.end; }); }).flat().sort();
      var inv = await billing.insertPokiInvoice(client, {
        customerId: first.customer_id, companyId: companyId, docKind: docKind, bookingId: first.booking_id,
        periodStart: starts[0], periodEnd: ends[ends.length - 1],
        items: buildLineItems(lines.map(function (l) { return { description: l.description, notes: l.notes, qty: l.qty, unitPrice: l.unitPrice }; })),
        issuedAt: todayISO(), dueDate: addDays(todayISO(), netDays), currency: first.currency || 'GHS', instructions: instructions,
        notes: 'Recurring charges for ' + first.property_name + ' · ' + first.unit_code + ' (booking ' + first.booking_no + ').'
      });
      for (var k = 0; k < claimed.length; k++) {
        await client.query('UPDATE poki_recurring_charge_runs SET invoice_id = $1 WHERE charge_id = $2 AND period_start = $3', [inv.id, claimed[k].chargeId, claimed[k].start]);
      }
      out.push({ invoiceId: inv.id, invoiceNo: inv.invoice_no, tenantName: first.tenant_name, bookingNo: first.booking_no, amount: Number(inv.grand_total), currency: inv.currency, lines: lines.length });
    }
    if (out.length || ended) {
      await audit(client, ctx, 'poki.recurring.bill', 'poki_recurring_charge', opts.chargeId || 'run',
        'Recurring charges billed: ' + out.length + ' invoice(s)' + (out.length ? ' (' + out.map(function (o) { return o.invoiceNo; }).join(', ') + ')' : '') + (ended ? '; ' + ended + ' charge(s) ended' : '') + '.');
    }
    return { invoices: out, ended: ended };
  });
}

module.exports = { list: list, create: create, update: update, setStatus: setStatus, remove: remove, run: run, periodFor: periodFor };
