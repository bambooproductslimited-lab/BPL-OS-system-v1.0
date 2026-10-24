var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var { loadLineItems, todayISO, addDays } = require('../utils/documents');
var { V } = require('../utils/validate');

// Repeating invoices (migration 0184) — Square's recurring invoices: an
// invoice repeated every week, month, quarter or year (or every few of
// them) from a first day, until a last day or a number of times. On each
// day a new invoice is raised from the first one, its lines, prices and
// terms (jobs/invoiceSeries.js), due so many days later, and emailed to the
// customer when asked. Each day's is raised once, whatever happens: the
// invoice carries its series and its day (ux_invoices_series_period). A
// series can be paused, started again, or stopped.

var EVERY = ['week', 'month', 'quarter', 'year'];
var CATCH_UP = 12; // at most this many missed days raised in one go

function dayOf(d) { return d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null; }
// The next day, n weeks, months, quarters or years on; the 31st of a month
// becomes the last day of a shorter one.
function advance(day, every, n) {
  var d = new Date(day + 'T00:00:00Z');
  if (every === 'week') { d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); }
  var months = every === 'month' ? n : every === 'quarter' ? 3 * n : 12 * n;
  var want = d.getUTCDate();
  var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(want, last));
  return t.toISOString().slice(0, 10);
}

function out(r) {
  return {
    id: r.id, templateInvoiceId: r.template_invoice_id, templateNo: r.template_no || null, customerId: r.customer_id, customerName: r.customer_name || '',
    name: r.name, every: r.every, everyN: r.every_n, nextOn: dayOf(r.next_on), endsOn: dayOf(r.ends_on), maxCount: r.max_count, raised: r.raised,
    dueDays: r.due_days, autoEmail: r.auto_email, status: r.status, lastError: r.last_error || '', createdAt: r.created_at,
    amount: r.amount != null ? Number(r.amount) : null, currency: r.currency || null, lastInvoice: r.last_no ? { id: r.last_id, invoiceNo: r.last_no, status: r.last_status } : null
  };
}
var SELECT =
  'SELECT s.*, c.name AS customer_name, t.invoice_no AS template_no, t.grand_total AS amount, t.currency, l.id AS last_id, l.invoice_no AS last_no, l.status AS last_status ' +
  'FROM invoice_series s JOIN customers c ON c.id = s.customer_id LEFT JOIN invoices t ON t.id = s.template_invoice_id ' +
  'LEFT JOIN LATERAL (SELECT id, invoice_no, status FROM invoices WHERE series_id = s.id AND series_period IS NOT NULL ORDER BY series_period DESC LIMIT 1) l ON true ';

function check(p, cur) {
  var every = V.oneOf(p.every || (cur && cur.every) || 'month', EVERY, 'Repeat every');
  var everyN = Math.round(Number(p.everyN != null ? p.everyN : cur ? cur.every_n : 1));
  if (!(everyN >= 1 && everyN <= 12)) fail('invalid', 'Repeat every 1 to 12 ' + every + 's.');
  var endsOn = p.endsOn ? V.date(p.endsOn, 'Last day') : null;
  var maxCount = p.maxCount ? Math.round(Number(p.maxCount)) : null;
  if (maxCount != null && !(maxCount >= 1 && maxCount <= 520)) fail('invalid', 'Repeat 1 to 520 times.');
  var dueDays = Math.round(Number(p.dueDays != null ? p.dueDays : cur ? cur.due_days : 14));
  if (!(dueDays >= 0 && dueDays <= 365)) fail('invalid', 'Due 0 to 365 days after it is raised.');
  return { every: every, everyN: everyN, endsOn: endsOn, maxCount: maxCount, dueDays: dueDays, autoEmail: !!(p.autoEmail != null ? p.autoEmail : cur && cur.auto_email), name: String(p.name != null ? p.name : cur ? cur.name : '').trim().slice(0, 80) };
}

// POST /api/invoices/:id/repeat { every, everyN, startOn, endsOn, maxCount, dueDays, autoEmail, name }
async function create(ctx, invoiceId, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) fail('notfound', 'Invoice not found.');
  if (inv.status === 'void') fail('conflict', 'A voided invoice cannot be repeated.');
  if (inv.series_id) {
    var on = (await pool.query("SELECT id FROM invoice_series WHERE id = $1 AND status <> 'ended'", [inv.series_id])).rows[0];
    if (on) fail('conflict', 'This invoice already repeats.');
  }
  var c = check(p);
  var startOn = p.startOn ? V.date(p.startOn, 'First repeat') : advance(dayOf(inv.issued_at) || todayISO(), c.every, c.everyN);
  if (startOn < todayISO()) fail('invalid', 'The first repeat cannot be in the past.');
  if (c.endsOn && c.endsOn < startOn) fail('invalid', 'The last day is before the first repeat.');
  var row = (await pool.query(
    'INSERT INTO invoice_series (template_invoice_id, customer_id, name, every, every_n, next_on, ends_on, max_count, due_days, auto_email, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [inv.id, inv.customer_id, c.name, c.every, c.everyN, startOn, c.endsOn, c.maxCount, c.dueDays, c.autoEmail, ctx.employee.id])).rows[0];
  await pool.query('UPDATE invoices SET series_id = $2 WHERE id = $1 AND series_id IS NULL', [inv.id, row.id]);
  await audit(pool, ctx, 'invoice.repeat', 'invoice', inv.id, inv.invoice_no + ' repeats every ' + (c.everyN > 1 ? c.everyN + ' ' + c.every + 's' : c.every) + ' from ' + startOn + '.');
  return get(ctx, row.id);
}

async function get(ctx, id) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  var r = (await pool.query(SELECT + 'WHERE s.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Repeating invoice not found.');
  return out(r);
}

// GET /api/invoice-series
async function list(ctx) {
  if (!ctx.can('invoice.read')) fail('forbidden', 'Your role does not allow this action (invoice.read).');
  return (await pool.query(SELECT + "ORDER BY (s.status = 'ended'), s.next_on")).rows.map(out);
}

// PATCH /api/invoice-series/:id { status: active|paused|ended, every, everyN, nextOn, endsOn, maxCount, dueDays, autoEmail, name }
async function update(ctx, id, p) {
  if (!ctx.can('invoice.manage')) fail('forbidden', 'Your role does not allow this action (invoice.manage).');
  p = p || {};
  var cur = (await pool.query('SELECT * FROM invoice_series WHERE id = $1', [id])).rows[0];
  if (!cur) fail('notfound', 'Repeating invoice not found.');
  if (cur.status === 'ended') fail('conflict', 'This repeating invoice was stopped. Repeat the invoice again to start a new one.');
  var status = p.status ? V.oneOf(p.status, ['active', 'paused', 'ended'], 'Status') : cur.status;
  var c = check(Object.assign({ endsOn: dayOf(cur.ends_on), maxCount: cur.max_count }, p), cur);
  var nextOn = p.nextOn ? V.date(p.nextOn, 'Next repeat') : dayOf(cur.next_on);
  // Started again after a pause: from the next day still to come, not the missed ones.
  if (status === 'active' && cur.status === 'paused') { while (nextOn < todayISO()) nextOn = advance(nextOn, c.every, c.everyN); }
  if (p.nextOn && nextOn < todayISO()) fail('invalid', 'The next repeat cannot be in the past.');
  await pool.query(
    'UPDATE invoice_series SET status = $2, every = $3, every_n = $4, next_on = $5, ends_on = $6, max_count = $7, due_days = $8, auto_email = $9, name = $10, last_error = CASE WHEN $2 = \'active\' THEN \'\' ELSE last_error END WHERE id = $1',
    [id, status, c.every, c.everyN, nextOn, c.endsOn, c.maxCount, c.dueDays, c.autoEmail, c.name]);
  await audit(pool, ctx, 'invoice.repeat_' + status, 'invoice_series', id, status === 'ended' ? 'Stopped a repeating invoice.' : status === 'paused' ? 'Paused a repeating invoice.' : 'Changed a repeating invoice.');
  return get(ctx, id);
}

// One series' days that have come: each raised once, emailed when asked.
async function raiseDue(s, today) {
  var raised = [];
  var template = (await pool.query('SELECT * FROM invoices WHERE id = $1', [s.template_invoice_id])).rows[0];
  if (!template) {
    await pool.query("UPDATE invoice_series SET status = 'ended', last_error = 'The invoice it repeats was deleted.' WHERE id = $1", [s.id]);
    return raised;
  }
  var items = await loadLineItems(pool, 'invoice', template.id);
  var ctx = { can: function () { return true; }, user: { id: null }, employee: { id: s.created_by, first_name: 'Repeating invoice', last_name: '' } };
  var next = dayOf(s.next_on), count = s.raised, status = 'active';
  for (var k = 0; k < CATCH_UP && next <= today; k++) {
    if ((s.ends_on && next > dayOf(s.ends_on)) || (s.max_count && count >= s.max_count)) { status = 'ended'; break; }
    try {
      var inv = await require('./invoices.service').createManual(ctx, {
        customerId: template.customer_id, items: items, currency: template.currency, dueDate: addDays(next, s.due_days),
        discount: { value: Number(template.discount_value), type: template.discount_type }, taxRate: Number(template.tax_rate),
        notes: template.notes, terms: template.terms, poReference: template.po_reference
      }, { seriesId: s.id, seriesPeriod: next });
      raised.push(inv);
      count++;
    } catch (e) {
      if (e.code !== '23505') throw e; // that day's was raised already
    }
    next = advance(next, s.every, s.every_n);
  }
  if ((s.ends_on && next > dayOf(s.ends_on)) || (s.max_count && count >= s.max_count)) status = 'ended';
  await pool.query("UPDATE invoice_series SET next_on = $2, raised = $3, status = $4, last_error = '' WHERE id = $1", [s.id, next, count, status]);
  for (var i = 0; i < raised.length; i++) {
    var sent = s.auto_email ? await require('./documentEmails.service').autoInvoice(raised[i].id) : false;
    if (s.created_by) {
      await notify(pool, s.created_by, '🔁 ' + raised[i].invoiceNo + ' raised for ' + (s.customer_name || 'a customer'),
        (sent ? 'Emailed to the customer. ' : '') + 'Repeats every ' + (s.every_n > 1 ? s.every_n + ' ' + s.every + 's' : s.every) + (status === 'ended' ? ', and that was the last.' : '.'), '/invoices?open=' + raised[i].id);
    }
  }
  return raised;
}

// jobs/invoiceSeries.js: every series whose day has come. Returns how many invoices were raised.
async function runDue(now) {
  var today = dayOf(now || new Date());
  var due = (await pool.query(
    "SELECT s.*, c.name AS customer_name FROM invoice_series s JOIN customers c ON c.id = s.customer_id WHERE s.status = 'active' AND s.next_on <= $1 ORDER BY s.next_on LIMIT 200", [today])).rows;
  var n = 0;
  // Two servers at once raise each day's invoice once all the same: the
  // second one's is refused (ux_invoices_series_period) and skipped.
  for (var i = 0; i < due.length; i++) {
    try { n += (await raiseDue(due[i], today)).length; }
    catch (e) { await pool.query('UPDATE invoice_series SET last_error = $2 WHERE id = $1', [due[i].id, String(e.message || e).slice(0, 300)]); }
  }
  return n;
}

module.exports = { create: create, list: list, get: get, update: update, runDue: runDue, advance: advance };
