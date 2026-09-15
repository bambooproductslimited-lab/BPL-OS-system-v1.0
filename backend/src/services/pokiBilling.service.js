var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { buildLineItems, computeDocTotals, nextDocNumber, todayISO, insertLineItems } = require('../utils/documents');
var poki = require('./poki.service');

// Poki's billing: rent runs, utility bills, maintenance recharges and lease
// agreements.
//
// Every document this produces is an ordinary row in `invoices`, tagged with
// company_id = Poki and doc_kind = rent|utility|deposit|maintenance
// (migration 0056). That's deliberate: payments, receipts, share links, the
// printable preview and the arrears maths all already exist there and are in
// production use. A rent invoice is not a different KIND of thing from a
// sales invoice — it's the same thing with a period and a lease attached.

var CYCLE_MONTHS = poki.CYCLE_MONTHS;
var addMonths = poki.addMonths;

function num(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : (fallback || 0);
}
function money(n) { return Math.round(Number(n) * 100) / 100; }
function addDays(iso, n) {
  var d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// A rent period runs from its start up to the day before the next one
// begins, so consecutive periods tile without overlapping by a day (which
// would double-bill the boundary on a monthly lease).
function periodEndFor(startDate, cycle) {
  var months = CYCLE_MONTHS[cycle];
  if (!months) return startDate;
  return addDays(addMonths(startDate, months), -1);
}

function daysInclusive(fromISO, toISO) {
  return Math.round(
    (new Date(toISO + 'T00:00:00Z').getTime() - new Date(fromISO + 'T00:00:00Z').getTime()) / 86400000
  ) + 1;
}

// A lease's term is rarely a whole number of billing cycles, so the last
// period usually runs past the end date — a tenancy ending 21 Oct whose
// period opens 14 Oct would otherwise be charged a full month for eight
// days, and the invoice would claim to cover time the tenant has no right
// to occupy.
//
// So the final period is clamped to the lease end and charged for the days
// actually covered, as a fraction of the days the full period would have
// run. Pro-rating against the real period length (31 days in that example)
// rather than an averaged month keeps the arithmetic something a tenant can
// check against their own calendar.
//
// Every other period returns factor 1 and is untouched.
function billingPeriod(periodStart, cycle, leaseEndISO) {
  var fullEnd = periodEndFor(periodStart, cycle);
  var partial = !!leaseEndISO && fullEnd > leaseEndISO;
  var periodEnd = partial ? leaseEndISO : fullEnd;
  var fullDays = daysInclusive(periodStart, fullEnd);
  var billedDays = daysInclusive(periodStart, periodEnd);
  return {
    periodEnd: periodEnd,
    partial: partial,
    fullDays: fullDays,
    billedDays: billedDays,
    factor: partial && fullDays > 0 ? billedDays / fullDays : 1
  };
}

// Rent is due on the lease's payment day in the month the period opens —
// but never before the period itself starts.
function dueDateFor(periodStart, paymentDay) {
  var ym = String(periodStart).slice(0, 7);
  var candidate = ym + '-' + String(Math.min(28, Math.max(1, paymentDay || 1))).padStart(2, '0');
  return candidate < String(periodStart).slice(0, 10) ? String(periodStart).slice(0, 10) : candidate;
}

async function commercialSettings() {
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  return res.rows[0].commercial;
}

// Poki bills under its own letterhead and bank details; falls back to the
// group's commercial settings where the company row hasn't been filled in.
async function pokiPaymentInstructions() {
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query('SELECT payment_details, invoice_footer FROM companies WHERE id = $1', [companyId]);
  var row = res.rows[0] || {};
  if (row.payment_details && row.payment_details.instructions) return row.payment_details.instructions;
  var commercial = await commercialSettings();
  return commercial.paymentDetails.instructions;
}

// Shared invoice writer for every Poki document kind. Mirrors
// invoices.service.js's createManual, with the rent-specific columns set.
async function insertPokiInvoice(client, opts) {
  var totals = computeDocTotals(opts.items, null, 0);
  var invoiceNo = await nextDocNumber(client, 'invoice');
  var res = await client.query(
    'INSERT INTO invoices (invoice_no, customer_id, company_id, doc_kind, poki_lease_id, period_start, period_end, ' +
    'subtotal, discount_total, tax_total, grand_total, amount_paid, balance_due, status, issued_at, due_date, ' +
    'bank_instructions, currency, notes, terms) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$11,'unpaid',$12,$13,$14,$15,$16,$17) RETURNING *",
    [
      invoiceNo, opts.customerId, opts.companyId, opts.docKind, opts.leaseId || null,
      opts.periodStart || null, opts.periodEnd || null,
      totals.subtotal, totals.discountTotal, totals.taxTotal, totals.grandTotal,
      opts.issuedAt || todayISO(), opts.dueDate, opts.instructions || '', opts.currency || 'GHS',
      opts.notes || '', opts.terms || ''
    ]
  );
  await insertLineItems(client, 'invoice', res.rows[0].id, opts.items);
  return res.rows[0];
}

// ── rent ────────────────────────────────────────────────────────────────

// Which active leases are due to be billed as at a given date. A lease is
// due when its next_invoice_on has arrived (or passed) and that period
// still starts within the lease term — so a lease doesn't keep generating
// invoices past its own end date.
async function rentRunPreview(ctx, asOf) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var cutoff = asOf ? V.date(asOf, 'As-at date') : todayISO();

  var res = await pool.query(
    'SELECT l.*, u.code AS unit_code, u.utility_mode, u.fixed_utility_amount, p.name AS property_name, ' +
    '       c.id AS customer_id, c.name AS tenant_name ' +
    'FROM poki_leases l ' +
    'JOIN poki_units u ON u.id = l.unit_id ' +
    'JOIN poki_properties p ON p.id = u.property_id ' +
    'JOIN poki_tenants t ON t.id = l.tenant_id ' +
    'JOIN customers c ON c.id = t.customer_id ' +
    "WHERE p.company_id = $1 AND l.status = 'active' AND l.rent_cycle <> 'one_off' " +
    '  AND l.next_invoice_on IS NOT NULL AND l.next_invoice_on <= $2 AND l.next_invoice_on <= l.end_date ' +
    'ORDER BY p.name, u.code',
    [companyId, cutoff]
  );

  return res.rows.map(function (r) {
    var periodStart = String(r.next_invoice_on).slice(0, 10);
    var period = billingPeriod(periodStart, r.rent_cycle, String(r.end_date).slice(0, 10));
    var fullRent = Number(r.rent_amount);
    var fullUtility = r.utility_mode === 'fixed' ? Number(r.fixed_utility_amount) : 0;
    var rentAmount = money(fullRent * period.factor);
    var fixedUtility = money(fullUtility * period.factor);
    return {
      leaseId: r.id, leaseNo: r.lease_no, tenantName: r.tenant_name,
      propertyName: r.property_name, unitCode: r.unit_code,
      periodStart: periodStart, periodEnd: period.periodEnd,
      rentAmount: rentAmount, fixedUtility: fixedUtility,
      total: money(rentAmount + fixedUtility),
      // Surfaced so the rent-run screen can show that a short final period
      // is intentional, not a mispriced lease.
      partial: period.partial, billedDays: period.billedDays, fullDays: period.fullDays,
      fullRentAmount: fullRent, fullUtility: fullUtility,
      currency: r.currency, rentCycle: r.rent_cycle,
      dueDate: dueDateFor(periodStart, r.payment_day)
    };
  });
}

// Raises one rent invoice per lease and advances each lease's
// next_invoice_on by a cycle. Runs in a single transaction: a partial rent
// run that billed half the tenants and lost track of the other half would
// be considerably worse than one that failed cleanly.
async function runRent(ctx, p) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var due = await rentRunPreview(ctx, p && p.asOf);
  if (p && Array.isArray(p.leaseIds) && p.leaseIds.length) {
    var wanted = {};
    p.leaseIds.forEach(function (id) { wanted[id] = true; });
    due = due.filter(function (d) { return wanted[d.leaseId]; });
  }
  if (!due.length) fail('invalid', 'No leases are due for rent invoicing as at that date.');

  var instructions = await pokiPaymentInstructions();

  var created = await withTransaction(async function (client) {
    var out = [];
    for (var i = 0; i < due.length; i++) {
      var d = due[i];
      var lease = await client.query('SELECT * FROM poki_leases WHERE id = $1 FOR UPDATE', [d.leaseId]);
      var l = lease.rows[0];
      // Re-check inside the transaction: two people hitting "run rent" at
      // once must not both bill the same period.
      if (!l || l.status !== 'active' || !l.next_invoice_on || String(l.next_invoice_on).slice(0, 10) !== d.periodStart) continue;

      var cust = await client.query(
        'SELECT c.id FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1',
        [l.tenant_id]
      );

      // Recomputed from the locked row rather than trusted from the
      // preview: if someone edited the rent or shortened the lease between
      // previewing and running, the invoice must follow the lease as it is
      // now, not as it was on screen.
      var period = billingPeriod(d.periodStart, l.rent_cycle, String(l.end_date).slice(0, 10));
      var rentDue = money(Number(l.rent_amount) * period.factor);
      var utilityDue = money(d.fullUtility * period.factor);
      var periodNote = 'Period ' + d.periodStart + ' to ' + period.periodEnd;
      if (period.partial) {
        // Spelled out on the invoice itself. A tenant who sees a smaller
        // final charge should be able to check it without asking.
        periodNote += ' — part period, ' + period.billedDays + ' of ' + period.fullDays +
          ' days (lease ends ' + String(l.end_date).slice(0, 10) + ')';
      }

      var items = [{
        description: 'Rent — ' + d.propertyName + ' · ' + d.unitCode,
        notes: periodNote,
        qty: 1, unit: period.partial ? 'part ' + d.rentCycle : d.rentCycle, unitPrice: rentDue
      }];
      if (utilityDue > 0) {
        items.push({
          description: 'Utilities (fixed charge) — ' + d.unitCode,
          notes: periodNote,
          qty: 1, unit: 'each', unitPrice: utilityDue
        });
      }

      var inv = await insertPokiInvoice(client, {
        customerId: cust.rows[0].id, companyId: companyId, docKind: 'rent', leaseId: l.id,
        periodStart: d.periodStart, periodEnd: period.periodEnd,
        items: buildLineItems(items), dueDate: d.dueDate, currency: l.currency,
        instructions: instructions,
        notes: 'Rent for ' + d.propertyName + ' · ' + d.unitCode + ' (' + d.periodStart + ' – ' + period.periodEnd + ')' +
          (period.partial ? ', pro-rated for ' + period.billedDays + ' of ' + period.fullDays + ' days.' : '.')
      });

      var nextOn = addMonths(d.periodStart, CYCLE_MONTHS[l.rent_cycle] || 1);
      await client.query('UPDATE poki_leases SET next_invoice_on = $1, updated_at = now() WHERE id = $2', [nextOn, l.id]);

      out.push({ leaseNo: l.lease_no, invoiceNo: inv.invoice_no, invoiceId: inv.id, amount: Number(inv.grand_total), tenantName: d.tenantName });
    }
    if (!out.length) fail('conflict', 'Those leases were already billed for this period.');
    await audit(client, ctx, 'poki.rent.run', 'poki_lease', out[0].invoiceId,
      'Rent run: raised ' + out.length + ' invoice(s) totalling ' +
      out.reduce(function (s, r) { return s + r.amount; }, 0).toLocaleString() + '.');
    return out;
  });

  return { created: created.length, invoices: created };
}

// ── utilities: meters ───────────────────────────────────────────────────

function rowToMeter(r) {
  return {
    id: r.id, unitId: r.unit_id, unitCode: r.unit_code, propertyName: r.property_name,
    utilityType: r.utility_type, meterNumber: r.meter_number, measureUnit: r.measure_unit,
    rate: Number(r.rate), active: r.active, notes: r.notes,
    lastReading: r.last_reading != null ? Number(r.last_reading) : 0,
    lastReadOn: r.last_read_on || null
  };
}

var METER_SELECT =
  'SELECT m.*, u.code AS unit_code, p.name AS property_name, ' +
  '  (SELECT current_reading FROM poki_meter_readings r WHERE r.meter_id = m.id ORDER BY r.period_end DESC LIMIT 1) AS last_reading, ' +
  '  (SELECT period_end FROM poki_meter_readings r WHERE r.meter_id = m.id ORDER BY r.period_end DESC LIMIT 1) AS last_read_on ' +
  'FROM poki_meters m JOIN poki_units u ON u.id = m.unit_id JOIN poki_properties p ON p.id = u.property_id ';

async function listMeters(ctx, filters) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var params = [companyId];
  var sql = METER_SELECT + 'WHERE p.company_id = $1';
  if (filters && filters.unitId) {
    params.push(filters.unitId);
    sql += ' AND m.unit_id = $' + params.length;
  }
  sql += ' ORDER BY p.name, u.code, m.utility_type';
  var res = await pool.query(sql, params);
  return res.rows.map(rowToMeter);
}

async function createMeter(ctx, p) {
  poki.canManage(ctx);
  var unit = await pool.query('SELECT id FROM poki_units WHERE id = $1', [p.unitId]);
  if (!unit.rows[0]) fail('invalid', 'Choose a unit.');
  var res = await pool.query(
    'INSERT INTO poki_meters (unit_id, utility_type, meter_number, measure_unit, rate, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [
      p.unitId,
      V.oneOf(p.utilityType || 'electricity', ['electricity', 'water', 'gas', 'other'], 'Utility type'),
      (p.meterNumber || '').trim(), (p.measureUnit || 'kWh').trim(), num(p.rate), (p.notes || '').trim()
    ]
  );
  await audit(pool, ctx, 'poki.meter.create', 'poki_meter', res.rows[0].id, 'Added a utility meter.');
  var full = await pool.query(METER_SELECT + 'WHERE m.id = $1', [res.rows[0].id]);
  return rowToMeter(full.rows[0]);
}

async function updateMeter(ctx, id, p) {
  poki.canManage(ctx);
  var cur = await pool.query('SELECT * FROM poki_meters WHERE id = $1', [id]);
  if (!cur.rows[0]) fail('notfound', 'Meter not found.');
  var m = cur.rows[0];
  await pool.query(
    'UPDATE poki_meters SET utility_type = $1, meter_number = $2, measure_unit = $3, rate = $4, active = $5, notes = $6, updated_at = now() WHERE id = $7',
    [
      p.utilityType !== undefined ? V.oneOf(p.utilityType, ['electricity', 'water', 'gas', 'other'], 'Utility type') : m.utility_type,
      p.meterNumber !== undefined ? (p.meterNumber || '').trim() : m.meter_number,
      p.measureUnit !== undefined ? (p.measureUnit || '').trim() : m.measure_unit,
      p.rate !== undefined ? num(p.rate) : m.rate,
      p.active !== undefined ? !!p.active : m.active,
      p.notes !== undefined ? (p.notes || '').trim() : m.notes,
      id
    ]
  );
  var full = await pool.query(METER_SELECT + 'WHERE m.id = $1', [id]);
  return rowToMeter(full.rows[0]);
}

function rowToReading(r) {
  return {
    id: r.id, meterId: r.meter_id, unitCode: r.unit_code, propertyName: r.property_name,
    utilityType: r.utility_type, measureUnit: r.measure_unit,
    periodStart: r.period_start, periodEnd: r.period_end,
    previousReading: Number(r.previous_reading), currentReading: Number(r.current_reading),
    consumption: Number(r.consumption), rate: Number(r.rate), amount: Number(r.amount),
    invoiceId: r.invoice_id, invoiceNo: r.invoice_no || null, readOn: r.read_on, notes: r.notes
  };
}

async function listReadings(ctx, filters) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var params = [companyId];
  var sql =
    'SELECT r.*, m.utility_type, m.measure_unit, u.code AS unit_code, p.name AS property_name, i.invoice_no ' +
    'FROM poki_meter_readings r JOIN poki_meters m ON m.id = r.meter_id ' +
    'JOIN poki_units u ON u.id = m.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    'LEFT JOIN invoices i ON i.id = r.invoice_id WHERE p.company_id = $1';
  if (filters && filters.unbilledOnly) sql += ' AND r.invoice_id IS NULL';
  if (filters && filters.meterId) {
    params.push(filters.meterId);
    sql += ' AND r.meter_id = $' + params.length;
  }
  sql += ' ORDER BY r.period_end DESC, p.name, u.code';
  var res = await pool.query(sql, params);
  return res.rows.map(rowToReading);
}

// Consumption and amount are computed and stored, not derived on read: the
// tariff can change, and a reading already taken must keep the cost it was
// taken at (same snapshot principle as line-item pricing).
async function recordReading(ctx, p) {
  poki.canManage(ctx);
  var meter = await pool.query(METER_SELECT + 'WHERE m.id = $1', [p.meterId]);
  if (!meter.rows[0]) fail('invalid', 'Choose a meter.');
  var m = meter.rows[0];

  var periodStart = V.date(p.periodStart, 'Period start');
  var periodEnd = V.date(p.periodEnd, 'Period end');
  if (periodEnd < periodStart) fail('invalid', 'The period end cannot be before the period start.');

  var previous = p.previousReading !== undefined ? num(p.previousReading) : Number(m.last_reading || 0);
  var current = num(p.currentReading);
  if (current < previous) {
    fail('invalid', 'The current reading (' + current + ') is lower than the previous one (' + previous +
      '). Check the reading, or record a meter replacement first.');
  }
  var consumption = money(current - previous);
  var rate = p.rate !== undefined ? num(p.rate) : Number(m.rate);
  var amount = money(consumption * rate);

  var res = await pool.query(
    'INSERT INTO poki_meter_readings (meter_id, period_start, period_end, previous_reading, current_reading, consumption, rate, amount, read_on, read_by, notes) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [p.meterId, periodStart, periodEnd, previous, current, consumption, rate, amount,
      p.readOn || todayISO(), ctx.employee ? ctx.employee.id : null, (p.notes || '').trim()]
  );
  await audit(pool, ctx, 'poki.reading.record', 'poki_meter_reading', res.rows[0].id,
    'Recorded ' + m.utility_type + ' reading for ' + m.unit_code + ': ' + consumption + ' ' + m.measure_unit + '.');

  var full = await pool.query(
    'SELECT r.*, m.utility_type, m.measure_unit, u.code AS unit_code, p.name AS property_name, NULL AS invoice_no ' +
    'FROM poki_meter_readings r JOIN poki_meters m ON m.id = r.meter_id ' +
    'JOIN poki_units u ON u.id = m.unit_id JOIN poki_properties p ON p.id = u.property_id WHERE r.id = $1',
    [res.rows[0].id]
  );
  return rowToReading(full.rows[0]);
}

// Bills every unbilled reading belonging to a unit that currently has an
// active lease, one invoice per lease. Readings on vacant units are left
// alone — there's nobody to bill, and silently writing them off would hide
// consumption the landlord is absorbing.
async function billReadings(ctx, p) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var ids = (p && Array.isArray(p.readingIds)) ? p.readingIds : [];
  if (!ids.length) fail('invalid', 'Select at least one reading to bill.');

  var instructions = await pokiPaymentInstructions();

  var result = await withTransaction(async function (client) {
    var res = await client.query(
      'SELECT r.*, m.utility_type, m.measure_unit, u.code AS unit_code, u.id AS unit_id, pr.name AS property_name, ' +
      '       l.id AS lease_id, l.currency, l.payment_day, c.id AS customer_id, c.name AS tenant_name ' +
      'FROM poki_meter_readings r ' +
      'JOIN poki_meters m ON m.id = r.meter_id ' +
      'JOIN poki_units u ON u.id = m.unit_id ' +
      'JOIN poki_properties pr ON pr.id = u.property_id ' +
      "LEFT JOIN poki_leases l ON l.unit_id = u.id AND l.status = 'active' " +
      'LEFT JOIN poki_tenants t ON t.id = l.tenant_id ' +
      'LEFT JOIN customers c ON c.id = t.customer_id ' +
      'WHERE r.id = ANY($1::uuid[]) AND r.invoice_id IS NULL AND pr.company_id = $2 FOR UPDATE OF r',
      [ids, companyId]
    );
    if (!res.rows.length) fail('conflict', 'Those readings have already been billed, or no longer exist.');

    var byLease = {};
    var skipped = [];
    res.rows.forEach(function (r) {
      if (!r.lease_id) { skipped.push(r.unit_code); return; }
      if (!byLease[r.lease_id]) byLease[r.lease_id] = [];
      byLease[r.lease_id].push(r);
    });

    var out = [];
    var leaseIds = Object.keys(byLease);
    for (var i = 0; i < leaseIds.length; i++) {
      var rows = byLease[leaseIds[i]];
      var first = rows[0];
      var items = rows.map(function (r) {
        return {
          description: r.utility_type.charAt(0).toUpperCase() + r.utility_type.slice(1) + ' — ' + r.unit_code,
          notes: r.period_start + ' to ' + r.period_end + ': ' + Number(r.consumption) + ' ' + r.measure_unit +
                 ' @ ' + Number(r.rate) + '/' + r.measure_unit,
          qty: Number(r.consumption), unit: r.measure_unit, unitPrice: Number(r.rate)
        };
      });
      var periodStart = rows.map(function (r) { return String(r.period_start).slice(0, 10); }).sort()[0];
      var periodEnd = rows.map(function (r) { return String(r.period_end).slice(0, 10); }).sort().reverse()[0];

      var inv = await insertPokiInvoice(client, {
        customerId: first.customer_id, companyId: companyId, docKind: 'utility', leaseId: first.lease_id,
        periodStart: periodStart, periodEnd: periodEnd,
        items: buildLineItems(items), dueDate: dueDateFor(todayISO(), first.payment_day),
        currency: first.currency || 'GHS', instructions: instructions,
        notes: 'Utility charges for ' + first.property_name + ' · ' + first.unit_code + '.'
      });
      for (var j = 0; j < rows.length; j++) {
        await client.query('UPDATE poki_meter_readings SET invoice_id = $1 WHERE id = $2', [inv.id, rows[j].id]);
      }
      out.push({ invoiceId: inv.id, invoiceNo: inv.invoice_no, tenantName: first.tenant_name, amount: Number(inv.grand_total) });
    }
    if (!out.length) fail('conflict', 'None of those readings belong to a unit with an active lease, so there is nobody to bill.');
    await audit(client, ctx, 'poki.utility.bill', 'invoice', out[0].invoiceId, 'Billed utilities: ' + out.length + ' invoice(s).');
    return { invoices: out, skippedUnits: skipped };
  });

  return { created: result.invoices.length, invoices: result.invoices, skippedUnits: result.skippedUnits };
}

// ── utilities: master bills (apportioned mode) ──────────────────────────

async function listMasterBills(ctx) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query(
    'SELECT b.*, p.name AS property_name FROM poki_master_bills b JOIN poki_properties p ON p.id = b.property_id ' +
    'WHERE p.company_id = $1 ORDER BY b.period_end DESC',
    [companyId]
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, propertyId: r.property_id, propertyName: r.property_name, utilityType: r.utility_type,
      periodStart: r.period_start, periodEnd: r.period_end, totalAmount: Number(r.total_amount),
      splitMethod: r.split_method, reference: r.reference, billedAt: r.billed_at, notes: r.notes
    };
  });
}

async function createMasterBill(ctx, p) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var prop = await pool.query('SELECT id FROM poki_properties WHERE id = $1 AND company_id = $2', [p.propertyId, companyId]);
  if (!prop.rows[0]) fail('invalid', 'Choose a property.');
  var periodStart = V.date(p.periodStart, 'Period start');
  var periodEnd = V.date(p.periodEnd, 'Period end');
  if (periodEnd < periodStart) fail('invalid', 'The period end cannot be before the period start.');
  var res = await pool.query(
    'INSERT INTO poki_master_bills (property_id, utility_type, period_start, period_end, total_amount, split_method, reference, notes) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    [
      p.propertyId,
      V.oneOf(p.utilityType || 'electricity', ['electricity', 'water', 'gas', 'other'], 'Utility type'),
      periodStart, periodEnd, num(p.totalAmount),
      V.oneOf(p.splitMethod || 'share', ['share', 'equal', 'sqm'], 'Split method'),
      (p.reference || '').trim(), (p.notes || '').trim()
    ]
  );
  await audit(pool, ctx, 'poki.masterBill.create', 'poki_master_bill', res.rows[0].id, 'Recorded a master utility bill.');
  var all = await listMasterBills(ctx);
  return all.find(function (b) { return b.id === res.rows[0].id; });
}

// Works out each apportioned unit's share of a master bill. Exposed
// separately from billing it so the split can be reviewed before anything
// is charged to a tenant — apportioned utilities are the most commonly
// disputed line on a Ghanaian tenancy bill.
async function masterBillSplit(ctx, id) {
  poki.canRead(ctx);
  var bill = await pool.query(
    'SELECT b.*, p.name AS property_name FROM poki_master_bills b JOIN poki_properties p ON p.id = b.property_id WHERE b.id = $1',
    [id]
  );
  if (!bill.rows[0]) fail('notfound', 'Master bill not found.');
  var b = bill.rows[0];

  var units = await pool.query(
    'SELECT u.id, u.code, u.apportion_share, u.size_sqm, l.id AS lease_id, l.currency, l.payment_day, ' +
    '       c.id AS customer_id, c.name AS tenant_name ' +
    'FROM poki_units u ' +
    "LEFT JOIN poki_leases l ON l.unit_id = u.id AND l.status = 'active' " +
    'LEFT JOIN poki_tenants t ON t.id = l.tenant_id ' +
    'LEFT JOIN customers c ON c.id = t.customer_id ' +
    "WHERE u.property_id = $1 AND u.active AND u.utility_mode = 'apportioned' ORDER BY u.code",
    [b.property_id]
  );
  if (!units.rows.length) {
    return { billId: id, propertyName: b.property_name, totalAmount: Number(b.total_amount), splitMethod: b.split_method, lines: [], note: 'No units in this property are set to apportioned utilities.' };
  }

  var total = Number(b.total_amount);
  var weights = units.rows.map(function (u) {
    if (b.split_method === 'equal') return 1;
    if (b.split_method === 'sqm') return Number(u.size_sqm) || 0;
    return Number(u.apportion_share) || 0;
  });
  var weightSum = weights.reduce(function (s, w) { return s + w; }, 0);

  var lines = units.rows.map(function (u, i) {
    // With no usable weights (shares all zero, or no floor areas recorded)
    // fall back to an equal split rather than billing everyone nothing.
    var share = weightSum > 0 ? weights[i] / weightSum : 1 / units.rows.length;
    return {
      unitId: u.id, unitCode: u.code, leaseId: u.lease_id, customerId: u.customer_id,
      tenantName: u.tenant_name, currency: u.currency || 'GHS', paymentDay: u.payment_day,
      weight: weights[i], sharePercent: Math.round(share * 1000) / 10, amount: money(total * share),
      billable: !!u.lease_id
    };
  });

  return {
    billId: id, propertyName: b.property_name, utilityType: b.utility_type,
    periodStart: b.period_start, periodEnd: b.period_end,
    totalAmount: total, splitMethod: b.split_method, billedAt: b.billed_at,
    weightBasisMissing: weightSum <= 0,
    lines: lines
  };
}

async function billMasterBill(ctx, id) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var split = await masterBillSplit(ctx, id);
  if (split.billedAt) fail('conflict', 'This master bill has already been apportioned to tenants.');
  var billable = split.lines.filter(function (l) { return l.billable && l.amount > 0; });
  if (!billable.length) fail('conflict', 'None of the apportioned units in this property currently have an active lease.');

  var instructions = await pokiPaymentInstructions();

  var created = await withTransaction(async function (client) {
    var out = [];
    for (var i = 0; i < billable.length; i++) {
      var line = billable[i];
      var items = buildLineItems([{
        description: split.utilityType.charAt(0).toUpperCase() + split.utilityType.slice(1) +
          ' (shared) — ' + line.unitCode,
        notes: split.periodStart + ' to ' + split.periodEnd + ': ' + line.sharePercent + '% share of ' +
               split.propertyName + ' master bill',
        qty: 1, unit: 'each', unitPrice: line.amount
      }]);
      var inv = await insertPokiInvoice(client, {
        customerId: line.customerId, companyId: companyId, docKind: 'utility', leaseId: line.leaseId,
        periodStart: String(split.periodStart).slice(0, 10), periodEnd: String(split.periodEnd).slice(0, 10),
        items: items, dueDate: dueDateFor(todayISO(), line.paymentDay), currency: line.currency,
        instructions: instructions,
        notes: 'Shared utility charge for ' + split.propertyName + ' · ' + line.unitCode + '.'
      });
      out.push({ invoiceId: inv.id, invoiceNo: inv.invoice_no, tenantName: line.tenantName, amount: Number(inv.grand_total) });
    }
    await client.query('UPDATE poki_master_bills SET billed_at = now() WHERE id = $1', [id]);
    await audit(client, ctx, 'poki.masterBill.bill', 'poki_master_bill', id,
      'Apportioned master bill across ' + out.length + ' tenant(s).');
    return out;
  });

  return { created: created.length, invoices: created };
}

// ── arrears ─────────────────────────────────────────────────────────────

// Who owes what, worst first. Reads straight off the invoices raised
// against leases, so it can never disagree with the invoice list.
async function arrears(ctx) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var today = todayISO();
  var res = await pool.query(
    'SELECT i.id, i.invoice_no, i.doc_kind, i.issued_at, i.due_date, i.currency, ' +
    '       i.grand_total, i.amount_paid, i.balance_due, i.status, ' +
    '       c.name AS tenant_name, l.lease_no, u.code AS unit_code, p.name AS property_name, ' +
    '       GREATEST(0, ($2::date - i.due_date))::int AS days_overdue ' +
    'FROM invoices i ' +
    'JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN poki_leases l ON l.id = i.poki_lease_id ' +
    'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
    'LEFT JOIN poki_properties p ON p.id = u.property_id ' +
    "WHERE i.company_id = $1 AND i.status NOT IN ('paid', 'void') AND i.balance_due > 0 " +
    'ORDER BY days_overdue DESC, i.balance_due DESC',
    [companyId, today]
  );
  var rows = res.rows.map(function (r) {
    return {
      invoiceId: r.id, invoiceNo: r.invoice_no, docKind: r.doc_kind, tenantName: r.tenant_name,
      leaseNo: r.lease_no, unitCode: r.unit_code, propertyName: r.property_name,
      issuedAt: r.issued_at, dueDate: r.due_date, currency: r.currency,
      grandTotal: Number(r.grand_total), amountPaid: Number(r.amount_paid), balanceDue: Number(r.balance_due),
      daysOverdue: r.days_overdue, status: r.status
    };
  });
  return {
    totalOutstanding: money(rows.reduce(function (s, r) { return s + r.balanceDue; }, 0)),
    totalOverdue: money(rows.filter(function (r) { return r.daysOverdue > 0; }).reduce(function (s, r) { return s + r.balanceDue; }, 0)),
    rows: rows
  };
}

// Poki's own invoice list. The group's /invoices endpoint deliberately
// excludes these (see bplScopeClause), so Poki needs its own view — same
// rows, same table, opposite side of the same filter.
async function listInvoices(ctx, filters) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var params = [companyId];
  var sql =
    'SELECT i.*, c.name AS customer_name, l.lease_no, u.code AS unit_code, p.name AS property_name ' +
    'FROM invoices i ' +
    'JOIN customers c ON c.id = i.customer_id ' +
    'LEFT JOIN poki_leases l ON l.id = i.poki_lease_id ' +
    'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
    'LEFT JOIN poki_properties p ON p.id = u.property_id ' +
    'WHERE i.company_id = $1';
  if (filters && filters.docKind) {
    params.push(filters.docKind);
    sql += ' AND i.doc_kind = $' + params.length;
  }
  if (filters && filters.leaseId) {
    params.push(filters.leaseId);
    sql += ' AND i.poki_lease_id = $' + params.length;
  }
  sql += ' ORDER BY i.issued_at DESC, i.invoice_no DESC';
  var res = await pool.query(sql, params);
  var today = todayISO();
  var invoicesService = require('./invoices.service');
  var out = [];
  for (var i = 0; i < res.rows.length; i++) {
    var r = res.rows[i];
    out.push(await invoicesService.rowToInvoice(pool, r, {
      customerName: r.customer_name, leaseNo: r.lease_no, unitCode: r.unit_code, propertyName: r.property_name,
      docKind: r.doc_kind, periodStart: r.period_start, periodEnd: r.period_end,
      overdue: r.status !== 'paid' && r.status !== 'void' && r.due_date && String(r.due_date).slice(0, 10) < today
    }));
  }
  return out;
}

// ── maintenance ─────────────────────────────────────────────────────────

function rowToRequest(r) {
  return {
    id: r.id, unitId: r.unit_id, unitCode: r.unit_code, propertyName: r.property_name,
    leaseId: r.lease_id, tenantName: r.tenant_name || null,
    title: r.title, description: r.description, category: r.category, priority: r.priority, status: r.status,
    reportedOn: r.reported_on, reportedBy: r.reported_by, assignedTo: r.assigned_to,
    assignedToName: r.assigned_to_name || null,
    cost: Number(r.cost), chargeToTenant: r.charge_to_tenant,
    resolvedOn: r.resolved_on, resolutionNotes: r.resolution_notes
  };
}

var REQUEST_SELECT =
  'SELECT m.*, u.code AS unit_code, p.name AS property_name, c.name AS tenant_name, ' +
  "       (e.first_name || ' ' || e.last_name) AS assigned_to_name " +
  'FROM poki_maintenance_requests m ' +
  'JOIN poki_units u ON u.id = m.unit_id ' +
  'JOIN poki_properties p ON p.id = u.property_id ' +
  'LEFT JOIN poki_leases l ON l.id = m.lease_id ' +
  'LEFT JOIN poki_tenants t ON t.id = l.tenant_id ' +
  'LEFT JOIN customers c ON c.id = t.customer_id ' +
  'LEFT JOIN employees e ON e.id = m.assigned_to ';

async function listRequests(ctx, filters) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var params = [companyId];
  var sql = REQUEST_SELECT + 'WHERE p.company_id = $1';
  if (filters && filters.status) {
    params.push(filters.status);
    sql += ' AND m.status = $' + params.length;
  }
  if (filters && filters.unitId) {
    params.push(filters.unitId);
    sql += ' AND m.unit_id = $' + params.length;
  }
  sql += " ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, m.reported_on DESC";
  var res = await pool.query(sql, params);
  return res.rows.map(rowToRequest);
}

async function createRequest(ctx, p) {
  poki.canManage(ctx);
  var unit = await pool.query('SELECT id FROM poki_units WHERE id = $1', [p.unitId]);
  if (!unit.rows[0]) fail('invalid', 'Choose a unit.');
  // Attach the unit's current lease automatically so the request is tied to
  // whoever actually occupies it, without the reporter having to know.
  var lease = await pool.query("SELECT id FROM poki_leases WHERE unit_id = $1 AND status = 'active'", [p.unitId]);
  var res = await pool.query(
    'INSERT INTO poki_maintenance_requests (unit_id, lease_id, title, description, category, priority, reported_on, reported_by, assigned_to, charge_to_tenant) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id',
    [
      p.unitId, lease.rows[0] ? lease.rows[0].id : null,
      V.text(p.title, 'Title', 160), (p.description || '').trim(), (p.category || 'general').trim(),
      V.oneOf(p.priority || 'normal', ['low', 'normal', 'high', 'urgent'], 'Priority'),
      p.reportedOn || todayISO(), (p.reportedBy || '').trim(), p.assignedTo || null, !!p.chargeToTenant
    ]
  );
  await audit(pool, ctx, 'poki.maintenance.create', 'poki_maintenance_request', res.rows[0].id, 'Logged a maintenance request.');
  var full = await pool.query(REQUEST_SELECT + 'WHERE m.id = $1', [res.rows[0].id]);
  return rowToRequest(full.rows[0]);
}

async function updateRequest(ctx, id, p) {
  poki.canManage(ctx);
  var cur = await pool.query('SELECT * FROM poki_maintenance_requests WHERE id = $1', [id]);
  if (!cur.rows[0]) fail('notfound', 'Maintenance request not found.');
  var m = cur.rows[0];
  var status = p.status !== undefined
    ? V.oneOf(p.status, ['open', 'in_progress', 'resolved', 'closed', 'cancelled'], 'Status')
    : m.status;
  var resolvedOn = m.resolved_on;
  if ((status === 'resolved' || status === 'closed') && !resolvedOn) resolvedOn = p.resolvedOn || todayISO();
  if (status !== 'resolved' && status !== 'closed') resolvedOn = null;

  await pool.query(
    'UPDATE poki_maintenance_requests SET title = $1, description = $2, category = $3, priority = $4, status = $5, ' +
    'assigned_to = $6, cost = $7, charge_to_tenant = $8, resolved_on = $9, resolution_notes = $10, updated_at = now() WHERE id = $11',
    [
      p.title !== undefined ? V.text(p.title, 'Title', 160) : m.title,
      p.description !== undefined ? (p.description || '').trim() : m.description,
      p.category !== undefined ? (p.category || '').trim() : m.category,
      p.priority !== undefined ? V.oneOf(p.priority, ['low', 'normal', 'high', 'urgent'], 'Priority') : m.priority,
      status,
      p.assignedTo !== undefined ? (p.assignedTo || null) : m.assigned_to,
      p.cost !== undefined ? num(p.cost) : m.cost,
      p.chargeToTenant !== undefined ? !!p.chargeToTenant : m.charge_to_tenant,
      resolvedOn,
      p.resolutionNotes !== undefined ? (p.resolutionNotes || '').trim() : m.resolution_notes,
      id
    ]
  );
  var full = await pool.query(REQUEST_SELECT + 'WHERE m.id = $1', [id]);
  return rowToRequest(full.rows[0]);
}

// Recharges a repair the tenant is liable for (a broken window, say) as its
// own invoice, rather than folding it into rent where it would be invisible
// on the next statement.
async function chargeRequestToTenant(ctx, id) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query(REQUEST_SELECT + 'WHERE m.id = $1', [id]);
  if (!res.rows[0]) fail('notfound', 'Maintenance request not found.');
  var m = res.rows[0];
  if (!m.lease_id) fail('conflict', 'This request is not attached to a lease, so there is no tenant to charge.');
  if (Number(m.cost) <= 0) fail('invalid', 'Record the repair cost before charging it to the tenant.');

  var lease = await pool.query(
    'SELECT l.*, c.id AS customer_id FROM poki_leases l JOIN poki_tenants t ON t.id = l.tenant_id ' +
    'JOIN customers c ON c.id = t.customer_id WHERE l.id = $1',
    [m.lease_id]
  );
  var l = lease.rows[0];
  var instructions = await pokiPaymentInstructions();

  var inv = await withTransaction(async function (client) {
    var created = await insertPokiInvoice(client, {
      customerId: l.customer_id, companyId: companyId, docKind: 'maintenance', leaseId: l.id,
      items: buildLineItems([{
        description: 'Repair recharge — ' + m.unit_code + ': ' + m.title,
        notes: m.resolution_notes || m.description || '',
        qty: 1, unit: 'each', unitPrice: Number(m.cost)
      }]),
      dueDate: dueDateFor(todayISO(), l.payment_day), currency: l.currency, instructions: instructions,
      notes: 'Maintenance recharge for ' + m.property_name + ' · ' + m.unit_code + '.'
    });
    await client.query('UPDATE poki_maintenance_requests SET charge_to_tenant = true, updated_at = now() WHERE id = $1', [id]);
    await audit(client, ctx, 'poki.maintenance.charge', 'invoice', created.id,
      'Charged repair "' + m.title + '" to tenant as ' + created.invoice_no + '.');
    return created;
  });

  return { invoiceId: inv.id, invoiceNo: inv.invoice_no, amount: Number(inv.grand_total) };
}

// ── lease agreements ────────────────────────────────────────────────────

var DEFAULT_TEMPLATE_BODY = [
  'TENANCY AGREEMENT',
  '',
  'This Agreement is made on {{today}} between:',
  '',
  'LANDLORD: {{landlord_name}}, of {{landlord_address}} ("the Landlord");',
  '',
  'and',
  '',
  'TENANT: {{tenant_name}}{{tenant_id_clause}}, of {{tenant_address}} ("the Tenant").',
  '',
  '1. PREMISES',
  'The Landlord lets to the Tenant the premises known as {{unit_description}} at {{property_name}}, {{property_address}} ("the Premises").',
  '',
  '2. TERM',
  'The tenancy runs from {{start_date}} to {{end_date}}.',
  '',
  '3. RENT',
  'The Tenant shall pay rent of {{currency}} {{rent_amount}} per {{rent_cycle_label}}, due on day {{payment_day}} of each rental period.',
  '',
  '4. SECURITY DEPOSIT',
  'The Tenant has paid a security deposit of {{currency}} {{deposit_amount}}, refundable at the end of the tenancy less any deductions for damage beyond fair wear and tear, unpaid rent, or unpaid utility charges.',
  '',
  '5. UTILITIES',
  '{{utility_clause}}',
  '',
  '6. USE OF PREMISES',
  'The Tenant shall use the Premises for {{permitted_use}} only, and shall not sublet or assign without the Landlord\'s prior written consent.',
  '',
  '7. REPAIRS AND MAINTENANCE',
  'The Landlord shall keep the structure and exterior in good repair. The Tenant shall keep the interior in good and tenantable condition and shall be responsible for the cost of repairing damage caused by the Tenant, their household or visitors.',
  '',
  '8. TERMINATION',
  'Either party may terminate this Agreement by giving one (1) month\'s written notice. The Landlord may terminate immediately where rent remains unpaid for thirty (30) days or where the Tenant is in material breach of this Agreement.',
  '',
  '9. GOVERNING LAW',
  'This Agreement is governed by the laws of the Republic of Ghana.',
  '',
  'SIGNED by the parties:',
  '',
  'Landlord: ______________________    Date: ____________',
  '',
  'Tenant: ________________________    Date: ____________',
  '',
  'Witness: _______________________    Date: ____________'
].join('\n');

var CYCLE_LABELS = { monthly: 'month', quarterly: 'quarter', semiannual: 'half-year', annual: 'year', one_off: 'term' };

async function listTemplates(ctx) {
  poki.canRead(ctx);
  var companyId = await poki.pokiCompanyId();
  var res = await pool.query('SELECT * FROM poki_agreement_templates WHERE company_id = $1 ORDER BY is_default DESC, name', [companyId]);
  return res.rows.map(function (r) {
    return { id: r.id, name: r.name, unitType: r.unit_type, body: r.body, isDefault: r.is_default, active: r.active };
  });
}

// Seeds the built-in Ghana tenancy template on first use so there is always
// something to generate from, rather than an empty screen.
async function ensureDefaultTemplate(ctx) {
  var companyId = await poki.pokiCompanyId();
  var existing = await pool.query('SELECT id FROM poki_agreement_templates WHERE company_id = $1 LIMIT 1', [companyId]);
  if (existing.rows[0]) return;
  await pool.query(
    'INSERT INTO poki_agreement_templates (company_id, name, unit_type, body, is_default) VALUES ($1,$2,$3,$4,true)',
    [companyId, 'Standard tenancy agreement', 'any', DEFAULT_TEMPLATE_BODY]
  );
}

async function saveTemplate(ctx, id, p) {
  poki.canManage(ctx);
  var companyId = await poki.pokiCompanyId();
  if (id) {
    var cur = await pool.query('SELECT * FROM poki_agreement_templates WHERE id = $1', [id]);
    if (!cur.rows[0]) fail('notfound', 'Template not found.');
    await pool.query(
      'UPDATE poki_agreement_templates SET name = $1, unit_type = $2, body = $3, is_default = $4, active = $5, updated_at = now() WHERE id = $6',
      [
        p.name !== undefined ? V.text(p.name, 'Template name', 120) : cur.rows[0].name,
        p.unitType !== undefined ? (p.unitType || 'any') : cur.rows[0].unit_type,
        p.body !== undefined ? String(p.body) : cur.rows[0].body,
        p.isDefault !== undefined ? !!p.isDefault : cur.rows[0].is_default,
        p.active !== undefined ? !!p.active : cur.rows[0].active,
        id
      ]
    );
    if (p.isDefault) {
      await pool.query('UPDATE poki_agreement_templates SET is_default = false WHERE company_id = $1 AND id <> $2', [companyId, id]);
    }
    return { ok: true, id: id };
  }
  var res = await pool.query(
    'INSERT INTO poki_agreement_templates (company_id, name, unit_type, body, is_default) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [companyId, V.text(p.name, 'Template name', 120), (p.unitType || 'any'), String(p.body || DEFAULT_TEMPLATE_BODY), !!p.isDefault]
  );
  if (p.isDefault) {
    await pool.query('UPDATE poki_agreement_templates SET is_default = false WHERE company_id = $1 AND id <> $2', [companyId, res.rows[0].id]);
  }
  return { ok: true, id: res.rows[0].id };
}

function fillPlaceholders(body, values) {
  return String(body).replace(/\{\{(\w+)\}\}/g, function (match, key) {
    return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
  });
}

// Generates the agreement text for a lease and stores it ON the lease, so
// editing the template afterwards never rewrites an agreement already
// generated (and possibly signed) under the old wording.
async function generateAgreement(ctx, leaseId, p) {
  poki.canManage(ctx);
  await ensureDefaultTemplate(ctx);
  var companyId = await poki.pokiCompanyId();

  var res = await pool.query(
    'SELECT l.*, u.code AS unit_code, u.name AS unit_name, u.unit_type, u.utility_mode, u.fixed_utility_amount, ' +
    '       pr.name AS property_name, pr.address AS property_address, ' +
    '       c.name AS tenant_name, c.address AS tenant_address, t.id_type, t.id_number ' +
    'FROM poki_leases l ' +
    'JOIN poki_units u ON u.id = l.unit_id ' +
    'JOIN poki_properties pr ON pr.id = u.property_id ' +
    'JOIN poki_tenants t ON t.id = l.tenant_id ' +
    'JOIN customers c ON c.id = t.customer_id WHERE l.id = $1',
    [leaseId]
  );
  if (!res.rows[0]) fail('notfound', 'Lease not found.');
  var l = res.rows[0];

  var company = await pool.query('SELECT name, legal_name, address FROM companies WHERE id = $1', [companyId]);
  var landlord = company.rows[0] || {};

  var tpl;
  if (p && p.templateId) {
    tpl = await pool.query('SELECT * FROM poki_agreement_templates WHERE id = $1', [p.templateId]);
  } else {
    // Prefer a template written for this unit type, else the default.
    tpl = await pool.query(
      'SELECT * FROM poki_agreement_templates WHERE company_id = $1 AND active AND (unit_type = $2 OR unit_type = $3) ' +
      'ORDER BY (unit_type = $2) DESC, is_default DESC LIMIT 1',
      [companyId, l.unit_type, 'any']
    );
  }
  if (!tpl.rows[0]) fail('notfound', 'No agreement template is available.');

  var utilityClause;
  if (l.utility_mode === 'metered') {
    utilityClause = 'Electricity and water consumed at the Premises are separately metered and shall be billed to the Tenant on consumption, payable with the rent.';
  } else if (l.utility_mode === 'fixed') {
    utilityClause = 'The Tenant shall pay a fixed utility charge of ' + l.currency + ' ' +
      Number(l.fixed_utility_amount).toLocaleString() + ' per rental period in addition to the rent.';
  } else if (l.utility_mode === 'apportioned') {
    utilityClause = 'Utilities are supplied through the building\'s master accounts, and the Tenant shall pay their apportioned share of each bill as invoiced by the Landlord.';
  } else {
    utilityClause = 'The Tenant shall register and pay for their own electricity and water accounts directly with the relevant utility providers.';
  }

  var values = {
    today: todayISO(),
    landlord_name: landlord.legal_name || landlord.name || 'Poki',
    landlord_address: landlord.address || '',
    tenant_name: l.tenant_name,
    tenant_id_clause: l.id_number ? ' (' + (l.id_type || 'ID') + ' No. ' + l.id_number + ')' : '',
    tenant_address: l.tenant_address || '',
    unit_description: (l.unit_name ? l.unit_name + ' (' + l.unit_code + ')' : l.unit_code) + ', a ' + l.unit_type,
    property_name: l.property_name,
    property_address: l.property_address || '',
    start_date: String(l.start_date).slice(0, 10),
    end_date: String(l.end_date).slice(0, 10),
    currency: l.currency,
    rent_amount: Number(l.rent_amount).toLocaleString(),
    rent_cycle_label: CYCLE_LABELS[l.rent_cycle] || l.rent_cycle,
    payment_day: l.payment_day,
    deposit_amount: Number(l.deposit_amount).toLocaleString(),
    utility_clause: utilityClause,
    permitted_use: (p && p.permittedUse) || (l.unit_type === 'apartment' || l.unit_type === 'room' ? 'residential purposes' : 'lawful business purposes')
  };

  var body = fillPlaceholders(tpl.rows[0].body, values);

  await pool.query(
    'UPDATE poki_leases SET agreement_body = $1, agreement_generated_at = now(), updated_at = now() WHERE id = $2',
    [body, leaseId]
  );
  await audit(pool, ctx, 'poki.lease.agreement', 'poki_lease', leaseId, 'Generated the tenancy agreement for ' + l.lease_no + '.');
  return { leaseId: leaseId, leaseNo: l.lease_no, body: body, generatedAt: new Date().toISOString() };
}

// Lets an agreement be hand-edited after generation (a negotiated clause,
// a correction) without regenerating and losing the change.
async function saveAgreement(ctx, leaseId, body) {
  poki.canManage(ctx);
  var lease = await pool.query('SELECT lease_no FROM poki_leases WHERE id = $1', [leaseId]);
  if (!lease.rows[0]) fail('notfound', 'Lease not found.');
  await pool.query(
    'UPDATE poki_leases SET agreement_body = $1, agreement_generated_at = now(), updated_at = now() WHERE id = $2',
    [String(body || ''), leaseId]
  );
  await audit(pool, ctx, 'poki.lease.agreementEdit', 'poki_lease', leaseId, 'Edited the tenancy agreement for ' + lease.rows[0].lease_no + '.');
  return { ok: true };
}

module.exports = {
  rentRunPreview: rentRunPreview, runRent: runRent,
  listMeters: listMeters, createMeter: createMeter, updateMeter: updateMeter,
  listReadings: listReadings, recordReading: recordReading, billReadings: billReadings,
  listMasterBills: listMasterBills, createMasterBill: createMasterBill, masterBillSplit: masterBillSplit, billMasterBill: billMasterBill,
  arrears: arrears, listInvoices: listInvoices,
  listRequests: listRequests, createRequest: createRequest, updateRequest: updateRequest, chargeRequestToTenant: chargeRequestToTenant,
  listTemplates: listTemplates, saveTemplate: saveTemplate, ensureDefaultTemplate: ensureDefaultTemplate,
  generateAgreement: generateAgreement, saveAgreement: saveAgreement,
  periodEndFor: periodEndFor, dueDateFor: dueDateFor, billingPeriod: billingPeriod,
  // Pure date helpers, exported so pokiTermTotal.test.js can walk a lease
  // period by period the way runRent does and check the browser's total
  // against it.
  addDays: addDays, daysInclusive: daysInclusive, CYCLE_MONTHS: CYCLE_MONTHS,
  // Shared with pokiInvoices.service.js so a manually raised charge is
  // built exactly like an automatic one.
  insertPokiInvoice: insertPokiInvoice, pokiPaymentInstructions: pokiPaymentInstructions
};
