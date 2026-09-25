var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { nextDocNumber, todayISO, buildLineItems } = require('../utils/documents');

// Poki — the group's property-rental business (migration 0056). Properties
// hold units; units are let to tenants under bookings; bookings drive rent and
// utility billing (poki.billing.service.js).
//
// Two things here are worth knowing before reading the rest:
//
// 1. A tenant is a PROFILE EXTENSION of a customer, not a separate party.
//    poki_tenants.customer_id points at a customers row carrying the name,
//    email, phone and address; this service creates and updates both
//    together in one transaction. That's what lets a rent invoice be an
//    ordinary invoice with no special-casing, while keeping tenants out of
//    Bamboo Products' client list (their customer row is company-scoped to
//    Poki).
//
// 2. Unit occupancy is DERIVED from bookings, never set by hand. Activating a
//    booking marks its unit occupied; ending one frees it. A partial unique
//    index (migration 0056) makes "two active bookings on one unit"
//    impossible at the database level rather than by convention here.

var POKI_CODE = 'PKI';

async function pokiCompanyId(db) {
  var res = await (db || pool).query('SELECT id FROM companies WHERE code = $1', [POKI_CODE]);
  if (!res.rows[0]) fail('notfound', 'The Poki company record is missing — run database migrations.');
  return res.rows[0].id;
}

function canRead(ctx) {
  if (!ctx.can('poki.read') && !ctx.can('poki.manage')) {
    fail('forbidden', 'Your role does not allow this action (poki.read).');
  }
}
function canManage(ctx) {
  if (!ctx.can('poki.manage')) fail('forbidden', 'Your role does not allow this action (poki.manage).');
}

function dateOnly(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }

function num(v, fallback) {
  var n = Number(v);
  return isFinite(n) ? n : (fallback || 0);
}

// ── properties ──────────────────────────────────────────────────────────

function rowToProperty(r) {
  return {
    id: r.id, code: r.code, name: r.name, propertyType: r.property_type, address: r.address,
    city: r.city, region: r.region, ghanaPostGps: r.ghana_post_gps, description: r.description,
    acquiredOn: r.acquired_on, status: r.status, notes: r.notes,
    unitCount: r.unit_count != null ? Number(r.unit_count) : undefined,
    occupiedCount: r.occupied_count != null ? Number(r.occupied_count) : undefined,
    vacantCount: r.vacant_count != null ? Number(r.vacant_count) : undefined,
    monthlyRent: r.monthly_rent != null ? Number(r.monthly_rent) : undefined
  };
}

async function listProperties(ctx) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  // Unit counts come back with the property so the list can show occupancy
  // without the frontend fanning out a request per property.
  var res = await pool.query(
    'SELECT p.*, ' +
    '  COUNT(u.id) FILTER (WHERE u.active) AS unit_count, ' +
    "  COUNT(u.id) FILTER (WHERE u.active AND u.status = 'occupied') AS occupied_count, " +
    "  COUNT(u.id) FILTER (WHERE u.active AND u.status = 'vacant') AS vacant_count, " +
    '  COALESCE(SUM(u.base_rent) FILTER (WHERE u.active), 0) AS monthly_rent ' +
    'FROM poki_properties p LEFT JOIN poki_units u ON u.property_id = p.id ' +
    'WHERE p.company_id = $1 GROUP BY p.id ORDER BY p.name',
    [companyId]
  );
  return res.rows.map(rowToProperty);
}

async function createProperty(ctx, p) {
  canManage(ctx);
  var companyId = await pokiCompanyId();
  var name = V.text(p.name, 'Property name', 160);
  var code = V.text(p.code, 'Property code', 40).toUpperCase();
  var propertyType = V.oneOf(p.propertyType || 'mixed', ['residential', 'commercial', 'mixed', 'land'], 'Property type');
  var res;
  try {
    res = await pool.query(
      'INSERT INTO poki_properties (company_id, code, name, property_type, address, city, region, ghana_post_gps, description, acquired_on, notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [companyId, code, name, propertyType, (p.address || '').trim(), (p.city || '').trim(), (p.region || '').trim(),
        (p.ghanaPostGps || '').trim(), (p.description || '').trim(), p.acquiredOn || null, (p.notes || '').trim()]
    );
  } catch (err) {
    if (err.code === '23505') fail('conflict', 'A property with code "' + code + '" already exists.');
    throw err;
  }
  await audit(pool, ctx, 'poki.property.create', 'poki_property', res.rows[0].id, 'Added property ' + name + ' (' + code + ').');
  return rowToProperty(res.rows[0]);
}

async function updateProperty(ctx, id, p) {
  canManage(ctx);
  var existing = await pool.query('SELECT * FROM poki_properties WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Property not found.');
  var cur = existing.rows[0];
  var res = await pool.query(
    'UPDATE poki_properties SET name = $1, property_type = $2, address = $3, city = $4, region = $5, ghana_post_gps = $6, ' +
    'description = $7, acquired_on = $8, status = $9, notes = $10, updated_at = now() WHERE id = $11 RETURNING *',
    [
      p.name !== undefined ? V.text(p.name, 'Property name', 160) : cur.name,
      p.propertyType !== undefined ? V.oneOf(p.propertyType, ['residential', 'commercial', 'mixed', 'land'], 'Property type') : cur.property_type,
      p.address !== undefined ? (p.address || '').trim() : cur.address,
      p.city !== undefined ? (p.city || '').trim() : cur.city,
      p.region !== undefined ? (p.region || '').trim() : cur.region,
      p.ghanaPostGps !== undefined ? (p.ghanaPostGps || '').trim() : cur.ghana_post_gps,
      p.description !== undefined ? (p.description || '').trim() : cur.description,
      p.acquiredOn !== undefined ? (p.acquiredOn || null) : cur.acquired_on,
      p.status !== undefined ? V.oneOf(p.status, ['active', 'archived'], 'Status') : cur.status,
      p.notes !== undefined ? (p.notes || '').trim() : cur.notes,
      id
    ]
  );
  await audit(pool, ctx, 'poki.property.update', 'poki_property', id, 'Updated property ' + res.rows[0].name + '.');
  return rowToProperty(res.rows[0]);
}

async function removeProperty(ctx, id) {
  canManage(ctx);
  var existing = await pool.query('SELECT * FROM poki_properties WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Property not found.');
  // Units cascade, but a unit that was ever let carries booking history worth
  // keeping — so refuse rather than silently destroying the record of who
  // occupied what. Archiving is the intended route for a sold property.
  var bookings = await pool.query(
    'SELECT COUNT(*)::int AS n FROM poki_bookings l JOIN poki_units u ON u.id = l.unit_id WHERE u.property_id = $1',
    [id]
  );
  if (bookings.rows[0].n > 0) {
    fail('conflict', 'This property has ' + bookings.rows[0].n + ' booking record(s) against its units. Archive it instead of deleting.');
  }
  await pool.query('DELETE FROM poki_properties WHERE id = $1', [id]);
  await audit(pool, ctx, 'poki.property.delete', 'poki_property', id, 'Deleted property ' + existing.rows[0].name + '.');
  return { ok: true };
}

// ── units ───────────────────────────────────────────────────────────────

function rowToUnit(r) {
  return {
    id: r.id, propertyId: r.property_id, propertyName: r.property_name, code: r.code, name: r.name,
    unitType: r.unit_type, floor: r.floor, sizeSqm: Number(r.size_sqm), bedrooms: r.bedrooms, bathrooms: r.bathrooms,
    baseRent: Number(r.base_rent), currency: r.currency, fxRate: Number(r.fx_rate), dailyRate: Number(r.daily_rate),
    utilityMode: r.utility_mode, fixedUtilityAmount: Number(r.fixed_utility_amount), apportionShare: Number(r.apportion_share),
    status: r.status, amenities: r.amenities, notes: r.notes, active: r.active,
    tenantName: r.tenant_name || null, bookingId: r.booking_id || null, bookingEnd: r.booking_end || null,
    bookingRent: r.booking_rent != null ? Number(r.booking_rent) : null,
    bookingMonthly: r.booking_monthly != null ? Number(r.booking_monthly) : null, bookingNo: r.booking_no || null,
    tenantId: r.tenant_id || null, tenantPhone: r.tenant_phone || null, tenantEmail: r.tenant_email || null,
    lastLetEnd: dateOnly(r.last_let_end), nextBookingStart: dateOnly(r.next_start),
    openRequests: r.open_requests != null ? Number(r.open_requests) : 0, createdAt: r.created_at || null
  };
}

// Joins the unit's ACTIVE booking (if any) so every unit list doubles as a
// rent roll — which unit, who's in it, what they pay, when it ends.
// Also: when the unit was last let (the day its last booking ended), the
// next booking waiting to start on it, and how many repairs are open.
var UNIT_SELECT =
  'SELECT u.*, p.name AS property_name, l.id AS booking_id, l.end_date AS booking_end, l.rent_total AS booking_rent, ' +
  '       l.monthly_rate AS booking_monthly, l.booking_no, l.tenant_id AS tenant_id, ' +
  '       c.name AS tenant_name, c.phone AS tenant_phone, c.email AS tenant_email, ' +
  "       (SELECT MAX(COALESCE(b.terminated_on, b.end_date)) FROM poki_bookings b WHERE b.unit_id = u.id AND b.status IN ('terminated', 'expired', 'renewed')) AS last_let_end, " +
  "       (SELECT MIN(b.start_date) FROM poki_bookings b WHERE b.unit_id = u.id AND b.status IN ('draft', 'active') AND b.start_date > CURRENT_DATE) AS next_start, " +
  "       (SELECT COUNT(*) FROM poki_maintenance_requests m WHERE m.unit_id = u.id AND m.status IN ('open', 'in_progress')) AS open_requests " +
  'FROM poki_units u ' +
  'JOIN poki_properties p ON p.id = u.property_id ' +
  "LEFT JOIN poki_bookings l ON l.unit_id = u.id AND l.status = 'active' " +
  'LEFT JOIN poki_tenants t ON t.id = l.tenant_id ' +
  'LEFT JOIN customers c ON c.id = t.customer_id ';

async function listUnits(ctx, filters) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  var params = [companyId];
  var sql = UNIT_SELECT + 'WHERE p.company_id = $1';
  if (filters && filters.propertyId) {
    params.push(filters.propertyId);
    sql += ' AND u.property_id = $' + params.length;
  }
  if (filters && filters.status) {
    params.push(filters.status);
    sql += ' AND u.status = $' + params.length;
  }
  sql += ' ORDER BY p.name, u.code';
  var res = await pool.query(sql, params);
  return res.rows.map(rowToUnit);
}

// GHS per 1 unit of the unit's own currency. The company's books are in GHS,
// so a GHS unit is always 1 and nothing else may be. A missing or zero rate
// on a foreign-currency unit is refused rather than defaulted to 1, because
// defaulting would quietly show USD 500 as GHS 500.
var BASE_CURRENCY = 'GHS';
function fxRateFor(currency, raw) {
  var code = (currency || BASE_CURRENCY).toUpperCase();
  if (code === BASE_CURRENCY) return 1;
  var rate = Number(raw);
  if (!isFinite(rate) || rate <= 0) {
    fail('invalid', 'Enter the exchange rate for ' + code + ' — how many ' + BASE_CURRENCY + ' one ' + code + ' is worth.');
  }
  return Math.round(rate * 1000000) / 1000000;
}

async function createUnit(ctx, p) {
  canManage(ctx);
  var companyId = await pokiCompanyId();
  var prop = await pool.query('SELECT id FROM poki_properties WHERE id = $1 AND company_id = $2', [p.propertyId, companyId]);
  if (!prop.rows[0]) fail('invalid', 'Choose a property.');
  var code = V.text(p.code, 'Unit code', 40);
  var res;
  try {
    res = await pool.query(
      'INSERT INTO poki_units (property_id, code, name, unit_type, floor, size_sqm, bedrooms, bathrooms, base_rent, currency, ' +
      'daily_rate, utility_mode, fixed_utility_amount, apportion_share, amenities, notes, fx_rate) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',
      [
        p.propertyId, code, (p.name || '').trim(),
        V.oneOf(p.unitType || 'room', ['apartment', 'room', 'office', 'shop', 'warehouse', 'land', 'other'], 'Unit type'),
        (p.floor || '').trim(), num(p.sizeSqm), Math.max(0, parseInt(p.bedrooms, 10) || 0), Math.max(0, parseInt(p.bathrooms, 10) || 0),
        num(p.baseRent), (p.currency || 'GHS').toUpperCase(),
        num(p.dailyRate),
        V.oneOf(p.utilityMode || 'none', ['none', 'metered', 'fixed', 'apportioned'], 'Utility mode'),
        num(p.fixedUtilityAmount), num(p.apportionShare), (p.amenities || '').trim(), (p.notes || '').trim(),
        fxRateFor(p.currency, p.fxRate)
      ]
    );
  } catch (err) {
    if (err.code === '23505') fail('conflict', 'Unit "' + code + '" already exists in this property.');
    throw err;
  }
  await audit(pool, ctx, 'poki.unit.create', 'poki_unit', res.rows[0].id, 'Added unit ' + code + '.');
  var full = await pool.query(UNIT_SELECT + 'WHERE u.id = $1', [res.rows[0].id]);
  return rowToUnit(full.rows[0]);
}

async function updateUnit(ctx, id, p) {
  canManage(ctx);
  var existing = await pool.query('SELECT * FROM poki_units WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Unit not found.');
  var cur = existing.rows[0];
  // status is deliberately NOT settable here for occupied/vacant — that's
  // derived from bookings (see module comment). Only the manual states
  // (maintenance/unavailable/reserved) can be set by hand, and only on a
  // unit with no active booking.
  var status = cur.status;
  if (p.status !== undefined && p.status !== cur.status) {
    var requested = V.oneOf(p.status, ['vacant', 'occupied', 'reserved', 'maintenance', 'unavailable'], 'Status');
    var activeBooking = await pool.query("SELECT id FROM poki_bookings WHERE unit_id = $1 AND status = 'active'", [id]);
    if (activeBooking.rows[0]) {
      fail('conflict', "This unit has an active booking — its status follows the booking. End the booking to change it.");
    }
    if (requested === 'occupied') fail('invalid', 'A unit becomes occupied by activating a booking on it, not by setting the status.');
    status = requested;
  }
  var res = await pool.query(
    'UPDATE poki_units SET code = $1, name = $2, unit_type = $3, floor = $4, size_sqm = $5, bedrooms = $6, bathrooms = $7, ' +
    'base_rent = $8, currency = $9, daily_rate = $10, utility_mode = $11, fixed_utility_amount = $12, apportion_share = $13, ' +
    'status = $14, amenities = $15, notes = $16, active = $17, fx_rate = $19, updated_at = now() WHERE id = $18 RETURNING *',
    [
      p.code !== undefined ? V.text(p.code, 'Unit code', 40) : cur.code,
      p.name !== undefined ? (p.name || '').trim() : cur.name,
      p.unitType !== undefined ? V.oneOf(p.unitType, ['apartment', 'room', 'office', 'shop', 'warehouse', 'land', 'other'], 'Unit type') : cur.unit_type,
      p.floor !== undefined ? (p.floor || '').trim() : cur.floor,
      p.sizeSqm !== undefined ? num(p.sizeSqm) : cur.size_sqm,
      p.bedrooms !== undefined ? Math.max(0, parseInt(p.bedrooms, 10) || 0) : cur.bedrooms,
      p.bathrooms !== undefined ? Math.max(0, parseInt(p.bathrooms, 10) || 0) : cur.bathrooms,
      p.baseRent !== undefined ? num(p.baseRent) : cur.base_rent,
      p.currency !== undefined ? (p.currency || 'GHS').toUpperCase() : cur.currency,
      p.dailyRate !== undefined ? num(p.dailyRate) : cur.daily_rate,
      p.utilityMode !== undefined ? V.oneOf(p.utilityMode, ['none', 'metered', 'fixed', 'apportioned'], 'Utility mode') : cur.utility_mode,
      p.fixedUtilityAmount !== undefined ? num(p.fixedUtilityAmount) : cur.fixed_utility_amount,
      p.apportionShare !== undefined ? num(p.apportionShare) : cur.apportion_share,
      status,
      p.amenities !== undefined ? (p.amenities || '').trim() : cur.amenities,
      p.notes !== undefined ? (p.notes || '').trim() : cur.notes,
      p.active !== undefined ? !!p.active : cur.active,
      id,
      // Switching a unit to another currency without supplying a rate is
      // refused by fxRateFor; switching back to GHS resets it to 1.
      p.currency !== undefined || p.fxRate !== undefined
        ? fxRateFor(p.currency !== undefined ? p.currency : cur.currency,
                    p.fxRate !== undefined ? p.fxRate : cur.fx_rate)
        : cur.fx_rate
    ]
  );
  await audit(pool, ctx, 'poki.unit.update', 'poki_unit', id, 'Updated unit ' + res.rows[0].code + '.');
  var full = await pool.query(UNIT_SELECT + 'WHERE u.id = $1', [id]);
  return rowToUnit(full.rows[0]);
}

async function removeUnit(ctx, id) {
  canManage(ctx);
  var existing = await pool.query('SELECT * FROM poki_units WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Unit not found.');
  var bookings = await pool.query('SELECT COUNT(*)::int AS n FROM poki_bookings WHERE unit_id = $1', [id]);
  if (bookings.rows[0].n > 0) {
    fail('conflict', 'This unit has ' + bookings.rows[0].n + ' booking record(s). Mark it inactive instead of deleting.');
  }
  await pool.query('DELETE FROM poki_units WHERE id = $1', [id]);
  await audit(pool, ctx, 'poki.unit.delete', 'poki_unit', id, 'Deleted unit ' + existing.rows[0].code + '.');
  return { ok: true };
}

// ── tenants ─────────────────────────────────────────────────────────────

function rowToTenant(r) {
  return {
    id: r.id, customerId: r.customer_id,
    name: r.name, contactPerson: r.contact_person, email: r.email, phone: r.phone, address: r.address,
    tenantType: r.tenant_type, idType: r.id_type, idNumber: r.id_number,
    occupation: r.occupation, employer: r.employer,
    emergencyContactName: r.emergency_contact_name, emergencyContactPhone: r.emergency_contact_phone,
    nextOfKinName: r.next_of_kin_name, nextOfKinPhone: r.next_of_kin_phone,
    onboardedOn: r.onboarded_on, status: r.status, notes: r.notes,
    activeBookings: r.active_bookings != null ? Number(r.active_bookings) : undefined,
    unitLabels: r.unit_labels || null
  };
}

var TENANT_SELECT =
  'SELECT t.*, c.name, c.contact_person, c.email, c.phone, c.address, ' +
  "  COUNT(l.id) FILTER (WHERE l.status = 'active') AS active_bookings, " +
  "  string_agg(u.code, ', ' ORDER BY u.code) FILTER (WHERE l.status = 'active') AS unit_labels " +
  'FROM poki_tenants t ' +
  'JOIN customers c ON c.id = t.customer_id ' +
  'LEFT JOIN poki_bookings l ON l.tenant_id = t.id ' +
  'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
  'LEFT JOIN poki_properties p ON p.id = u.property_id ';

// Plus, per tenant, money (what they owe and how much of it is overdue, per
// currency — from their invoices, the same figures the invoice list gives),
// what they have paid in all, and their bookings (how many, since when,
// when the current one ends, deposit held).
async function listTenants(ctx) {
  canRead(ctx);
  var res = await pool.query(TENANT_SELECT + 'GROUP BY t.id, c.id ORDER BY c.name');
  var today = todayISO();
  var money_ = await pool.query(
    'SELECT i.customer_id, i.currency, ' +
    "  COALESCE(SUM(i.balance_due) FILTER (WHERE i.status NOT IN ('paid', 'void')), 0) AS owed, " +
    "  COALESCE(SUM(i.balance_due) FILTER (WHERE i.status NOT IN ('paid', 'void') AND i.due_date < $1), 0) AS overdue, " +
    "  MAX(($1::date - i.due_date)) FILTER (WHERE i.status NOT IN ('paid', 'void') AND i.balance_due > 0 AND i.due_date < $1) AS days_overdue, " +
    "  COALESCE(SUM(i.amount_paid) FILTER (WHERE i.status <> 'void'), 0) AS paid " +
    'FROM invoices i JOIN poki_tenants t ON t.customer_id = i.customer_id GROUP BY 1, 2', [today]);
  var stays = await pool.query(
    'SELECT l.tenant_id, COUNT(*) AS bookings, MIN(l.start_date) AS since, ' +
    "  MAX(l.end_date) FILTER (WHERE l.status = 'active') AS current_end, " +
    "  MIN(l.start_date) FILTER (WHERE l.status IN ('draft', 'active') AND l.start_date > $1) AS next_start, " +
    '  COALESCE(SUM(l.deposit_held - l.deposit_refunded), 0) AS deposit_held ' +
    "FROM poki_bookings l WHERE l.status <> 'draft' OR l.start_date > $1 GROUP BY 1", [today]);
  var byCustomer = {};
  money_.rows.forEach(function (r) { (byCustomer[r.customer_id] = byCustomer[r.customer_id] || []).push(r); });
  var byTenant = {};
  stays.rows.forEach(function (r) { byTenant[r.tenant_id] = r; });
  return res.rows.map(function (r) {
    var t = rowToTenant(r);
    var m = byCustomer[r.customer_id] || [];
    var st = byTenant[r.id];
    t.owed = m.filter(function (x) { return Number(x.owed) > 0; }).map(function (x) { return { currency: x.currency, amount: money(x.owed) }; });
    t.overdue = m.filter(function (x) { return Number(x.overdue) > 0; }).map(function (x) { return { currency: x.currency, amount: money(x.overdue) }; });
    t.daysOverdue = m.reduce(function (d, x) { return Math.max(d, Number(x.days_overdue) || 0); }, 0);
    t.paid = m.filter(function (x) { return Number(x.paid) > 0; }).map(function (x) { return { currency: x.currency, amount: money(x.paid) }; });
    t.bookings = st ? Number(st.bookings) : 0;
    t.since = st ? dateOnly(st.since) : null;
    t.currentEnd = st ? dateOnly(st.current_end) : null;
    t.nextStart = st ? dateOnly(st.next_start) : null;
    t.depositHeld = st ? money(st.deposit_held) : 0;
    t.createdAt = r.created_at || null;
    return t;
  });
}

// Creates the customer (billing identity) and the tenant profile together.
// Both or neither — a tenant row with no customer would break every
// invoice path, and an orphan Poki-scoped customer would be invisible
// clutter in a list nobody looks at.
async function createTenant(ctx, p) {
  canManage(ctx);
  var companyId = await pokiCompanyId();
  var name = V.text(p.name, 'Tenant name', 160);
  var tenantType = V.oneOf(p.tenantType || 'individual', ['individual', 'company'], 'Tenant type');

  var tenantId = await withTransaction(async function (client) {
    var cust = await client.query(
      'INSERT INTO customers (name, contact_person, email, phone, address, billing_address, category, status, notes, preferred_currency, company_id) ' +
      "VALUES ($1,$2,$3,$4,$5,$5,'active','active',$6,$7,$8) RETURNING id",
      [name, (p.contactPerson || '').trim(), (p.email || '').trim().toLowerCase(), (p.phone || '').trim(),
        (p.address || '').trim(), (p.notes || '').trim(), (p.currency || 'GHS').toUpperCase(), companyId]
    );
    var t = await client.query(
      'INSERT INTO poki_tenants (customer_id, tenant_type, id_type, id_number, occupation, employer, ' +
      'emergency_contact_name, emergency_contact_phone, next_of_kin_name, next_of_kin_phone, onboarded_on, status, notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id',
      [
        cust.rows[0].id, tenantType, (p.idType || '').trim(), (p.idNumber || '').trim(),
        (p.occupation || '').trim(), (p.employer || '').trim(),
        (p.emergencyContactName || '').trim(), (p.emergencyContactPhone || '').trim(),
        (p.nextOfKinName || '').trim(), (p.nextOfKinPhone || '').trim(),
        p.onboardedOn || todayISO(),
        V.oneOf(p.status || 'active', ['prospect', 'active', 'former', 'blacklisted'], 'Status'),
        (p.notes || '').trim()
      ]
    );
    await audit(client, ctx, 'poki.tenant.create', 'poki_tenant', t.rows[0].id, 'Added tenant ' + name + '.');
    return t.rows[0].id;
  });

  var res = await pool.query(TENANT_SELECT + 'WHERE t.id = $1 GROUP BY t.id, c.id', [tenantId]);
  return rowToTenant(res.rows[0]);
}

async function updateTenant(ctx, id, p) {
  canManage(ctx);
  var existing = await pool.query('SELECT t.*, c.id AS cust_id FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Tenant not found.');
  var cur = existing.rows[0];

  await withTransaction(async function (client) {
    // Contact details live on the customer row; only update the fields the
    // caller actually sent so a partial edit can't blank the rest.
    var custFields = [];
    var custParams = [];
    function setCust(col, value) { custParams.push(value); custFields.push(col + ' = $' + custParams.length); }
    if (p.name !== undefined) setCust('name', V.text(p.name, 'Tenant name', 160));
    if (p.contactPerson !== undefined) setCust('contact_person', (p.contactPerson || '').trim());
    if (p.email !== undefined) setCust('email', (p.email || '').trim().toLowerCase());
    if (p.phone !== undefined) setCust('phone', (p.phone || '').trim());
    if (p.address !== undefined) { setCust('address', (p.address || '').trim()); setCust('billing_address', (p.address || '').trim()); }
    if (custFields.length) {
      custParams.push(cur.cust_id);
      await client.query('UPDATE customers SET ' + custFields.join(', ') + ' WHERE id = $' + custParams.length, custParams);
    }

    await client.query(
      'UPDATE poki_tenants SET tenant_type = $1, id_type = $2, id_number = $3, occupation = $4, employer = $5, ' +
      'emergency_contact_name = $6, emergency_contact_phone = $7, next_of_kin_name = $8, next_of_kin_phone = $9, ' +
      'onboarded_on = $10, status = $11, notes = $12, updated_at = now() WHERE id = $13',
      [
        p.tenantType !== undefined ? V.oneOf(p.tenantType, ['individual', 'company'], 'Tenant type') : cur.tenant_type,
        p.idType !== undefined ? (p.idType || '').trim() : cur.id_type,
        p.idNumber !== undefined ? (p.idNumber || '').trim() : cur.id_number,
        p.occupation !== undefined ? (p.occupation || '').trim() : cur.occupation,
        p.employer !== undefined ? (p.employer || '').trim() : cur.employer,
        p.emergencyContactName !== undefined ? (p.emergencyContactName || '').trim() : cur.emergency_contact_name,
        p.emergencyContactPhone !== undefined ? (p.emergencyContactPhone || '').trim() : cur.emergency_contact_phone,
        p.nextOfKinName !== undefined ? (p.nextOfKinName || '').trim() : cur.next_of_kin_name,
        p.nextOfKinPhone !== undefined ? (p.nextOfKinPhone || '').trim() : cur.next_of_kin_phone,
        p.onboardedOn !== undefined ? (p.onboardedOn || null) : cur.onboarded_on,
        p.status !== undefined ? V.oneOf(p.status, ['prospect', 'active', 'former', 'blacklisted'], 'Status') : cur.status,
        p.notes !== undefined ? (p.notes || '').trim() : cur.notes,
        id
      ]
    );
    await audit(client, ctx, 'poki.tenant.update', 'poki_tenant', id, 'Updated tenant.');
  });

  var res = await pool.query(TENANT_SELECT + 'WHERE t.id = $1 GROUP BY t.id, c.id', [id]);
  return rowToTenant(res.rows[0]);
}

async function removeTenant(ctx, id) {
  canManage(ctx);
  var existing = await pool.query('SELECT t.*, c.name FROM poki_tenants t JOIN customers c ON c.id = t.customer_id WHERE t.id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Tenant not found.');
  var bookings = await pool.query('SELECT COUNT(*)::int AS n FROM poki_bookings WHERE tenant_id = $1', [id]);
  if (bookings.rows[0].n > 0) {
    fail('conflict', 'This tenant has ' + bookings.rows[0].n + ' booking record(s). Set their status to "former" instead of deleting.');
  }
  await withTransaction(async function (client) {
    await client.query('DELETE FROM poki_tenants WHERE id = $1', [id]);
    // The customer row exists only to give this tenant a billing identity,
    // so it goes too — unless something already invoiced it, in which case
    // the FK from invoices stops us and the tenant delete above is rolled
    // back with it.
    await client.query('DELETE FROM customers WHERE id = $1', [existing.rows[0].customer_id]);
    await audit(client, ctx, 'poki.tenant.delete', 'poki_tenant', id, 'Deleted tenant ' + existing.rows[0].name + '.');
  });
  return { ok: true };
}

// ── bookings ──────────────────────────────────────────────────────────────


// Adds whole months to a YYYY-MM-DD date, clamping the day so 31 Jan + 1
// month lands on 28/29 Feb rather than rolling into March (which is what
// JS's Date does natively, and would quietly shift a rent period).
function addMonths(iso, months) {
  var parts = String(iso).slice(0, 10).split('-');
  var y = Number(parts[0]);
  var m = Number(parts[1]) - 1;
  var d = Number(parts[2]);
  var target = new Date(Date.UTC(y, m + months, 1));
  var lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

// ── booking duration and price ─────────────────────────────────────────────
// A booking is a block of time bought up front: so many months, plus so many
// days, from a start date. The end date is derived, never typed — which is
// what stops "6 months" and the dates on the agreement disagreeing.
//
// Inclusive of both ends, so a booking of 1 month from the 14th runs to the
// 13th of the next month, and two consecutive bookings tile without
// overlapping on the boundary day.
function bookingEndDate(startDate, months, days) {
  return addDays(addMonths(startDate, months), days - 1);
}

function addDays(iso, n) {
  var t = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// Price is the monthly rate times whole months, plus the daily rate times
// leftover days. No pro-rating: the duration IS the period, so there is no
// part-period to apportion — which is the whole reason the previous
// cycle-based model had to.
//
// A unit with no daily_rate set falls back to monthly/30. That is the right
// default for a few days tacked onto a longer booking; a unit genuinely let
// by the day should carry its own daily rate, since a short let normally
// costs more per day than a long one and that cannot be derived.
function dailyRateFor(monthlyRate, unitDailyRate) {
  var explicit = Number(unitDailyRate) || 0;
  if (explicit > 0) return money(explicit);
  return money((Number(monthlyRate) || 0) / 30);
}

function priceBooking(monthlyRate, dailyRate, months, days) {
  var m = money((Number(monthlyRate) || 0) * months);
  var d = money((Number(dailyRate) || 0) * days);
  return { monthsAmount: m, daysAmount: d, rentTotal: money(m + d) };
}

function money(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function readDuration(p, cur) {
  var months = p.durationMonths !== undefined ? parseInt(p.durationMonths, 10) : (cur ? cur.duration_months : 0);
  var days = p.durationDays !== undefined ? parseInt(p.durationDays, 10) : (cur ? cur.duration_days : 0);
  months = Math.max(0, months || 0);
  days = Math.max(0, days || 0);
  if (months === 0 && days === 0) fail('invalid', 'Say how long the booking is for — a number of months, days, or both.');
  if (months > 600) fail('invalid', 'That is longer than fifty years. Check the number of months.');
  return { months: months, days: days };
}

// The database refuses overlapping bookings outright (see migration 0062's
// exclusion constraint), which is what actually prevents a double-let when
// two people book at the same moment. This turns that into a message naming
// the booking in the way, rather than a raw constraint error.
async function assertUnitFree(client, unitId, startDate, endDate, exceptId) {
  var params = [unitId, startDate, endDate];
  var sql =
    "SELECT booking_no, start_date, end_date FROM poki_bookings " +
    "WHERE unit_id = $1 AND status IN ('draft','active') " +
    "AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')";
  if (exceptId) { params.push(exceptId); sql += ' AND id <> $' + params.length; }
  var clash = await client.query(sql + ' LIMIT 1', params);
  if (clash.rows[0]) {
    fail('conflict', 'That unit is already booked ' + clash.rows[0].start_date + ' to ' +
      clash.rows[0].end_date + ' under ' + clash.rows[0].booking_no + '.');
  }
}

function rowToBooking(r) {
  return {
    id: r.id, bookingNo: r.booking_no, unitId: r.unit_id, tenantId: r.tenant_id,
    unitCode: r.unit_code, unitType: r.unit_type, propertyId: r.property_id, propertyName: r.property_name,
    tenantName: r.tenant_name, tenantEmail: r.tenant_email, tenantPhone: r.tenant_phone,
    startDate: r.start_date, endDate: r.end_date,
    durationMonths: r.duration_months, durationDays: r.duration_days,
    durationLabel: describeDuration(r.duration_months, r.duration_days),
    monthlyRate: Number(r.monthly_rate), dailyRate: Number(r.daily_rate),
    rentTotal: Number(r.rent_total), currency: r.currency,
    depositAmount: Number(r.deposit_amount), depositHeld: Number(r.deposit_held),
    depositRefunded: Number(r.deposit_refunded), depositRefundedOn: r.deposit_refunded_on, depositNotes: r.deposit_notes,
    escalationPercent: Number(r.escalation_percent),
    status: r.status, signedOn: r.signed_on, terminatedOn: r.terminated_on, terminationReason: r.termination_reason,
    agreementBody: r.agreement_body, agreementGeneratedAt: r.agreement_generated_at,
    renewedFromId: r.renewed_from_id, notes: r.notes, createdAt: r.created_at,
    invoicedTotal: r.invoiced_total != null ? Number(r.invoiced_total) : undefined,
    paidTotal: r.paid_total != null ? Number(r.paid_total) : undefined,
    balanceTotal: r.balance_total != null ? Number(r.balance_total) : undefined
  };
}

// Arrears come from the invoices raised against the booking, so "what this
// tenant owes" is always the same number the invoice list would give —
// there's no second running balance to drift out of step.
var BOOKING_SELECT =
  'SELECT l.*, u.code AS unit_code, u.unit_type, p.id AS property_id, p.name AS property_name, ' +
  '       c.name AS tenant_name, c.email AS tenant_email, c.phone AS tenant_phone, ' +
  "       COALESCE(SUM(i.grand_total) FILTER (WHERE i.status <> 'void'), 0) AS invoiced_total, " +
  "       COALESCE(SUM(i.amount_paid) FILTER (WHERE i.status <> 'void'), 0) AS paid_total, " +
  "       COALESCE(SUM(i.balance_due) FILTER (WHERE i.status <> 'void'), 0) AS balance_total " +
  'FROM poki_bookings l ' +
  'JOIN poki_units u ON u.id = l.unit_id ' +
  'JOIN poki_properties p ON p.id = u.property_id ' +
  'JOIN poki_tenants t ON t.id = l.tenant_id ' +
  'JOIN customers c ON c.id = t.customer_id ' +
  'LEFT JOIN invoices i ON i.poki_booking_id = l.id ';

async function listBookings(ctx, filters) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  var params = [companyId];
  var sql = BOOKING_SELECT + 'WHERE p.company_id = $1';
  if (filters && filters.status) {
    params.push(filters.status);
    sql += ' AND l.status = $' + params.length;
  }
  if (filters && filters.tenantId) {
    params.push(filters.tenantId);
    sql += ' AND l.tenant_id = $' + params.length;
  }
  if (filters && filters.unitId) {
    params.push(filters.unitId);
    sql += ' AND l.unit_id = $' + params.length;
  }
  sql += ' GROUP BY l.id, u.id, p.id, c.id ORDER BY l.start_date DESC';
  var res = await pool.query(sql, params);
  return res.rows.map(rowToBooking);
}

async function getBooking(ctx, id) {
  canRead(ctx);
  var res = await pool.query(BOOKING_SELECT + 'WHERE l.id = $1 GROUP BY l.id, u.id, p.id, c.id', [id]);
  if (!res.rows[0]) fail('notfound', 'Booking not found.');
  return rowToBooking(res.rows[0]);
}

async function createBooking(ctx, p) {
  canManage(ctx);
  var unit = await pool.query(
    'SELECT u.*, p.company_id, p.name AS property_name ' +
    'FROM poki_units u JOIN poki_properties p ON p.id = u.property_id WHERE u.id = $1',
    [p.unitId]
  );
  if (!unit.rows[0]) fail('invalid', 'Choose a unit.');
  var tenant = await pool.query('SELECT id FROM poki_tenants WHERE id = $1', [p.tenantId]);
  if (!tenant.rows[0]) fail('invalid', 'Choose a tenant.');

  var startDate = V.date(p.startDate, 'Start date');
  var duration = readDuration(p, null);
  var endDate = bookingEndDate(startDate, duration.months, duration.days);

  var monthlyRate = money(p.monthlyRate !== undefined ? num(p.monthlyRate) : Number(unit.rows[0].base_rent));
  var dailyRate = money(p.dailyRate !== undefined ? num(p.dailyRate) : dailyRateFor(monthlyRate, unit.rows[0].daily_rate));
  var priced = priceBooking(monthlyRate, dailyRate, duration.months, duration.days);
  var status = V.oneOf(p.status || 'draft', ['draft', 'active'], 'Status');
  var depositAmount = num(p.depositAmount);

  var bookingId = await withTransaction(async function (client) {
    await assertUnitFree(client, p.unitId, startDate, endDate, null);
    var bookingNo = await nextDocNumber(client, 'booking');
    var res = await client.query(
      'INSERT INTO poki_bookings (booking_no, unit_id, tenant_id, start_date, end_date, ' +
      'duration_months, duration_days, monthly_rate, daily_rate, rent_total, currency, ' +
      'deposit_amount, deposit_held, escalation_percent, status, signed_on, notes, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id',
      [
        bookingNo, p.unitId, p.tenantId, startDate, endDate,
        duration.months, duration.days, monthlyRate, dailyRate, priced.rentTotal,
        (p.currency || unit.rows[0].currency || 'GHS').toUpperCase(),
        depositAmount,
        // Deposit is only "held" once actually collected, which the deposit
        // endpoint records — creating a booking just states what is due.
        num(p.depositHeld),
        num(p.escalationPercent), status, p.signedOn || null, (p.notes || '').trim(),
        ctx.employee ? ctx.employee.id : null
      ]
    );
    if (status === 'active') {
      await client.query("UPDATE poki_units SET status = 'occupied', updated_at = now() WHERE id = $1", [p.unitId]);
    }
    var full = await client.query('SELECT * FROM poki_bookings WHERE id = $1', [res.rows[0].id]);
    var inv = await raiseBookingInvoice(client, ctx, full.rows[0], unit.rows[0]);
    await audit(client, ctx, 'poki.booking.create', 'poki_booking', res.rows[0].id,
      'Created booking ' + bookingNo + ' on unit ' + unit.rows[0].code + ' (' +
      describeDuration(duration.months, duration.days) + ')' +
      (inv ? ', invoiced as ' + inv.invoice_no : '') + '.');
    return res.rows[0].id;
  });

  return getBooking(ctx, bookingId);
}

// The one invoice a booking produces. Raised when the booking is created,
// because it is the document the tenant is sent in order to pay — and the
// terms say rent and deposit are payable in full before keys are handed
// over. Nothing else invoices rent: there is no run, no schedule, no second
// charge later.
//
// Rent and deposit go on the same invoice rather than two, because the
// tenant makes one payment for one figure — the same figure the booking
// screen quoted. Split across two documents they would be asked to pay a
// number neither document showed.
async function raiseBookingInvoice(client, ctx, booking, unit) {
  var items = [];
  var label = unit.property_name + ' \u00b7 ' + unit.code;

  if (booking.duration_months > 0) {
    items.push({
      description: 'Rent \u2014 ' + label,
      qty: booking.duration_months, unit: 'month', unitPrice: Number(booking.monthly_rate),
      notes: describeDuration(booking.duration_months, booking.duration_days) +
        ' from ' + String(booking.start_date).slice(0, 10) + '.'
    });
  }
  if (booking.duration_days > 0) {
    items.push({
      description: 'Rent (days) \u2014 ' + label,
      qty: booking.duration_days, unit: 'day', unitPrice: Number(booking.daily_rate), notes: ''
    });
  }
  // Only what is still outstanding on the deposit, not the whole figure.
  // One rule covers every case: a new booking holds nothing so the full
  // deposit is charged; a renewal carries the previous one over so nothing
  // is charged; and a renewal that raises the deposit charges only the
  // difference. Re-charging a deposit the tenant already paid is the kind
  // of error that gets noticed by the tenant rather than by us.
  var depositOwing = money(Number(booking.deposit_amount) - Number(booking.deposit_held));
  if (depositOwing > 0) {
    items.push({
      description: 'Security deposit \u2014 ' + label,
      qty: 1, unit: 'each', unitPrice: depositOwing,
      notes: Number(booking.deposit_held) > 0
        ? 'The balance of the deposit; the rest carried over from the previous booking.'
        : 'Refundable at the end of the tenancy, less any arrears or damage.'
    });
  }
  if (!items.length) return null;

  var billing = require('./pokiBilling.service');
  var tenant = await client.query(
    'SELECT t.customer_id FROM poki_tenants t WHERE t.id = $1', [booking.tenant_id]);

  // Due before occupation — but never dated in the past, which would show a
  // booking backdated into the system as instantly overdue.
  var start = String(booking.start_date).slice(0, 10);
  var today = new Date().toISOString().slice(0, 10);
  var dueDate = start < today ? today : start;

  return billing.insertPokiInvoice(client, {
    customerId: tenant.rows[0].customer_id,
    companyId: unit.company_id,
    docKind: 'rent',
    bookingId: booking.id,
    periodStart: start,
    periodEnd: String(booking.end_date).slice(0, 10),
    items: buildLineItems(items),
    dueDate: dueDate,
    currency: booking.currency,
    instructions: await billing.pokiPaymentInstructions(),
    notes: 'Booking ' + booking.booking_no + ' \u2014 ' +
      describeDuration(booking.duration_months, booking.duration_days) + '.'
  });
}

function describeDuration(months, days) {
  var parts = [];
  if (months) parts.push(months + (months === 1 ? ' month' : ' months'));
  if (days) parts.push(days + (days === 1 ? ' day' : ' days'));
  return parts.join(' and ');
}

async function updateBooking(ctx, id, p) {
  canManage(ctx);
  var existing = await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Booking not found.');
  var cur = existing.rows[0];
  if (cur.status === 'terminated' || cur.status === 'expired') {
    fail('conflict', 'This booking has ended and can no longer be edited. Create a new one instead.');
  }

  var startDate = p.startDate !== undefined ? V.date(p.startDate, 'Start date') : String(cur.start_date).slice(0, 10);
  var duration = readDuration(p, cur);
  var endDate = bookingEndDate(startDate, duration.months, duration.days);

  var monthlyRate = money(p.monthlyRate !== undefined ? num(p.monthlyRate) : Number(cur.monthly_rate));
  var dailyRate = money(p.dailyRate !== undefined ? num(p.dailyRate) : Number(cur.daily_rate));
  var priced = priceBooking(monthlyRate, dailyRate, duration.months, duration.days);

  var res = await withTransaction(async function (client) {
    await assertUnitFree(client, cur.unit_id, startDate, endDate, id);
    return client.query(
      'UPDATE poki_bookings SET start_date = $1, end_date = $2, duration_months = $3, duration_days = $4, ' +
      'monthly_rate = $5, daily_rate = $6, rent_total = $7, currency = $8, deposit_amount = $9, ' +
      'escalation_percent = $10, signed_on = $11, notes = $12, updated_at = now() ' +
      'WHERE id = $13 RETURNING *',
      [
        startDate, endDate, duration.months, duration.days,
        monthlyRate, dailyRate, priced.rentTotal,
        p.currency !== undefined ? (p.currency || 'GHS').toUpperCase() : cur.currency,
        p.depositAmount !== undefined ? num(p.depositAmount) : cur.deposit_amount,
        p.escalationPercent !== undefined ? num(p.escalationPercent) : cur.escalation_percent,
        p.signedOn !== undefined ? (p.signedOn || null) : cur.signed_on,
        p.notes !== undefined ? (p.notes || '').trim() : cur.notes,
        id
      ]
    );
  });
  await audit(pool, ctx, 'poki.booking.update', 'poki_booking', id, 'Updated booking ' + res.rows[0].booking_no + '.');
  return getBooking(ctx, id);
}

// Quotes a booking without saving it, so the screen can show the price and
// whether the unit is free before anyone commits. Same arithmetic the real
// create uses — deliberately not a second implementation.
async function quoteBooking(ctx, p) {
  canRead(ctx);
  var unit = await pool.query('SELECT * FROM poki_units WHERE id = $1', [p.unitId]);
  if (!unit.rows[0]) fail('invalid', 'Choose a unit.');

  var startDate = V.date(p.startDate, 'Start date');
  var duration = readDuration(p, null);
  var endDate = bookingEndDate(startDate, duration.months, duration.days);
  var monthlyRate = money(p.monthlyRate !== undefined ? num(p.monthlyRate) : Number(unit.rows[0].base_rent));
  var dailyRate = money(p.dailyRate !== undefined ? num(p.dailyRate) : dailyRateFor(monthlyRate, unit.rows[0].daily_rate));
  var priced = priceBooking(monthlyRate, dailyRate, duration.months, duration.days);
  var deposit = num(p.depositAmount);

  var clash = await pool.query(
    "SELECT booking_no, start_date, end_date FROM poki_bookings " +
    "WHERE unit_id = $1 AND status IN ('draft','active') " +
    "AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]') " +
    (p.exceptId ? 'AND id <> $4 ' : '') + 'LIMIT 1',
    p.exceptId ? [p.unitId, startDate, endDate, p.exceptId] : [p.unitId, startDate, endDate]
  );

  return {
    startDate: startDate, endDate: endDate,
    durationMonths: duration.months, durationDays: duration.days,
    durationLabel: describeDuration(duration.months, duration.days),
    monthlyRate: monthlyRate, dailyRate: dailyRate,
    monthsAmount: priced.monthsAmount, daysAmount: priced.daysAmount,
    rentTotal: priced.rentTotal, depositAmount: deposit,
    total: money(priced.rentTotal + deposit),
    currency: (p.currency || unit.rows[0].currency || 'GHS').toUpperCase(),
    available: !clash.rows[0],
    clashesWith: clash.rows[0] ? {
      bookingNo: clash.rows[0].booking_no,
      startDate: clash.rows[0].start_date,
      endDate: clash.rows[0].end_date
    } : null
  };
}

// Activating is separate from editing because it's the moment the unit
// changes hands — it takes the unit, and the one-active-booking-per-unit
// index is what guarantees no double-let.
async function activateBooking(ctx, id) {
  canManage(ctx);
  var booking = await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [id]);
  if (!booking.rows[0]) fail('notfound', 'Booking not found.');
  if (booking.rows[0].status === 'active') fail('conflict', 'This booking is already active.');
  if (booking.rows[0].status !== 'draft') fail('conflict', 'Only a draft booking can be activated.');

  await withTransaction(async function (client) {
    var clash = await client.query("SELECT booking_no FROM poki_bookings WHERE unit_id = $1 AND status = 'active'", [booking.rows[0].unit_id]);
    if (clash.rows[0]) fail('conflict', 'Unit already let under booking ' + clash.rows[0].booking_no + '. End that booking first.');
    await client.query("UPDATE poki_bookings SET status = 'active', updated_at = now() WHERE id = $1", [id]);
    await client.query("UPDATE poki_units SET status = 'occupied', updated_at = now() WHERE id = $1", [booking.rows[0].unit_id]);
    await audit(client, ctx, 'poki.booking.activate', 'poki_booking', id, 'Activated booking ' + booking.rows[0].booking_no + '.');
  });
  return getBooking(ctx, id);
}

// Ending a booking frees the unit. Outstanding invoices are deliberately left
// standing — money owed doesn't stop being owed because someone moved out,
// and the arrears view should keep showing it.
async function endBooking(ctx, id, p) {
  canManage(ctx);
  var booking = await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [id]);
  if (!booking.rows[0]) fail('notfound', 'Booking not found.');
  if (booking.rows[0].status === 'terminated' || booking.rows[0].status === 'expired') {
    fail('conflict', 'This booking has already ended.');
  }
  var newStatus = V.oneOf((p && p.status) || 'terminated', ['terminated', 'expired'], 'Status');
  var endedOn = (p && p.endedOn) ? V.date(p.endedOn, 'End date') : todayISO();

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE poki_bookings SET status = $1, terminated_on = $2, termination_reason = $3, updated_at = now() WHERE id = $4',
      [newStatus, endedOn, ((p && p.reason) || '').trim(), id]
    );
    await client.query("UPDATE poki_units SET status = 'vacant', updated_at = now() WHERE id = $1", [booking.rows[0].unit_id]);
    await audit(client, ctx, 'poki.booking.end', 'poki_booking', id, 'Ended booking ' + booking.rows[0].booking_no + ' (' + newStatus + ').');
  });
  return getBooking(ctx, id);
}

// Renewal creates a NEW booking continuing from the old one's end date rather
// than extending it in place, so each term keeps its own rent, dates and
// signed agreement — which is what you need when a dispute is about what
// was agreed in a particular year.
async function renewBooking(ctx, id, p) {
  canManage(ctx);
  var old = await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [id]);
  if (!old.rows[0]) fail('notfound', 'Booking not found.');
  var prev = old.rows[0];
  var prevEnd = String(prev.end_date).slice(0, 10);

  // The new block starts the day AFTER the old one ends. Both dates are
  // inclusive, so starting on the old end date would be a one-day overlap —
  // which the no-overlap constraint now refuses outright, and which would
  // have double-charged that day before it existed.
  var startDate = (p && p.startDate) ? V.date(p.startDate, 'Start date') : addDays(prevEnd, 1);

  // Same length as the block being renewed unless the caller says otherwise:
  // a tenant on six months usually takes another six.
  var duration = readDuration(
    { durationMonths: p && p.durationMonths, durationDays: p && p.durationDays },
    prev
  );
  var endDate = bookingEndDate(startDate, duration.months, duration.days);

  // Escalation applies to the rates unless a rate is given explicitly.
  var escalation = (p && p.escalationPercent !== undefined) ? num(p.escalationPercent) : Number(prev.escalation_percent);
  var factor = 1 + escalation / 100;
  var monthlyRate = (p && p.monthlyRate !== undefined) ? money(num(p.monthlyRate)) : money(Number(prev.monthly_rate) * factor);
  var dailyRate = (p && p.dailyRate !== undefined) ? money(num(p.dailyRate)) : money(Number(prev.daily_rate) * factor);
  var priced = priceBooking(monthlyRate, dailyRate, duration.months, duration.days);

  var newId = await withTransaction(async function (client) {
    if (prev.status === 'active') {
      await client.query(
        "UPDATE poki_bookings SET status = 'renewed', terminated_on = $1, updated_at = now() WHERE id = $2",
        [prevEnd, id]
      );
    }
    await assertUnitFree(client, prev.unit_id, startDate, endDate, id);
    var bookingNo = await nextDocNumber(client, 'booking');
    var res = await client.query(
      'INSERT INTO poki_bookings (booking_no, unit_id, tenant_id, start_date, end_date, ' +
      'duration_months, duration_days, monthly_rate, daily_rate, rent_total, currency, ' +
      'deposit_amount, deposit_held, escalation_percent, status, notes, renewed_from_id, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$15,$16,$17) RETURNING id",
      [
        bookingNo, prev.unit_id, prev.tenant_id, startDate, endDate,
        duration.months, duration.days, monthlyRate, dailyRate, priced.rentTotal,
        prev.currency, prev.deposit_amount,
        // The deposit carries over to the new block rather than being
        // refunded and re-collected.
        prev.deposit_held,
        escalation, (p && p.notes ? String(p.notes).trim() : ''), id,
        ctx.employee ? ctx.employee.id : null
      ]
    );
    await client.query("UPDATE poki_units SET status = 'occupied', updated_at = now() WHERE id = $1", [prev.unit_id]);

    // A renewal is another block of time and needs paying like any other.
    // The deposit carried over above, so raiseBookingInvoice charges only
    // rent unless the renewal raised the deposit.
    var unit = await client.query(
      'SELECT u.*, p.company_id, p.name AS property_name ' +
      'FROM poki_units u JOIN poki_properties p ON p.id = u.property_id WHERE u.id = $1',
      [prev.unit_id]);
    var full = await client.query('SELECT * FROM poki_bookings WHERE id = $1', [res.rows[0].id]);
    var inv = await raiseBookingInvoice(client, ctx, full.rows[0], unit.rows[0]);

    await audit(client, ctx, 'poki.booking.renew', 'poki_booking', res.rows[0].id,
      'Renewed ' + prev.booking_no + ' as ' + bookingNo + ' (' + describeDuration(duration.months, duration.days) + ')' +
      (inv ? ', invoiced as ' + inv.invoice_no : '') + '.');
    return res.rows[0].id;
  });

  return getBooking(ctx, newId);
}

// ── deposits ────────────────────────────────────────────────────────────

async function recordDeposit(ctx, id, p) {
  canManage(ctx);
  var booking = await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [id]);
  if (!booking.rows[0]) fail('notfound', 'Booking not found.');
  var amount = num(p && p.amount);
  if (amount <= 0) fail('invalid', 'Enter a deposit amount greater than zero.');
  var held = Math.round((Number(booking.rows[0].deposit_held) + amount) * 100) / 100;
  await pool.query('UPDATE poki_bookings SET deposit_held = $1, deposit_notes = $2, updated_at = now() WHERE id = $3',
    [held, ((p && p.notes) || booking.rows[0].deposit_notes || '').trim(), id]);
  await audit(pool, ctx, 'poki.booking.deposit', 'poki_booking', id,
    'Recorded deposit of ' + booking.rows[0].currency + ' ' + amount.toLocaleString() + ' on ' + booking.rows[0].booking_no + '.');
  return getBooking(ctx, id);
}

async function refundDeposit(ctx, id, p) {
  canManage(ctx);
  var booking = await pool.query('SELECT * FROM poki_bookings WHERE id = $1', [id]);
  if (!booking.rows[0]) fail('notfound', 'Booking not found.');
  var cur = booking.rows[0];
  var refund = num(p && p.amount);
  var deductions = num(p && p.deductions);
  var available = Math.round((Number(cur.deposit_held) - Number(cur.deposit_refunded)) * 100) / 100;
  if (refund <= 0) fail('invalid', 'Enter a refund amount greater than zero.');
  if (refund + deductions > available + 0.01) {
    fail('invalid', 'Refund plus deductions (' + (refund + deductions).toLocaleString() + ') exceeds the ' +
      available.toLocaleString() + ' held on this booking.');
  }
  var refunded = Math.round((Number(cur.deposit_refunded) + refund) * 100) / 100;
  var note = ((p && p.notes) || '').trim();
  if (deductions > 0) {
    note = (note ? note + ' ' : '') + '[Deductions withheld: ' + cur.currency + ' ' + deductions.toLocaleString() + ']';
  }
  await pool.query(
    'UPDATE poki_bookings SET deposit_refunded = $1, deposit_refunded_on = $2, deposit_notes = $3, updated_at = now() WHERE id = $4',
    [refunded, (p && p.refundedOn) || todayISO(), note, id]
  );
  await audit(pool, ctx, 'poki.booking.depositRefund', 'poki_booking', id,
    'Refunded deposit of ' + cur.currency + ' ' + refund.toLocaleString() + ' on ' + cur.booking_no +
    (deductions > 0 ? ' (withheld ' + deductions.toLocaleString() + ')' : '') + '.');
  return getBooking(ctx, id);
}

// ── dashboard ───────────────────────────────────────────────────────────

// Everything the overview screen needs in one round trip: occupancy, what
// the portfolio bills per month, what's outstanding, and what needs
// attention soon (expiring bookings, open maintenance).
async function overview(ctx) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  var today = todayISO();

  var units = await pool.query(
    'SELECT COUNT(*)::int AS total, ' +
    "  COUNT(*) FILTER (WHERE u.status = 'occupied')::int AS occupied, " +
    "  COUNT(*) FILTER (WHERE u.status = 'vacant')::int AS vacant, " +
    "  COUNT(*) FILTER (WHERE u.status NOT IN ('occupied','vacant'))::int AS other " +
    'FROM poki_units u JOIN poki_properties p ON p.id = u.property_id WHERE p.company_id = $1 AND u.active',
    [companyId]
  );

  // Monthly rent roll: every unit carries one monthly rate now, so this is a
  // plain sum — no normalising a quarterly figure against an annual one, and
  // no cycle to exclude. Day-only bookings contribute nothing here on
  // purpose: a five-day let is not monthly recurring revenue, and counting
  // it as such would overstate the roll.
  // Grouped by currency, not summed across them. A unit let in USD and one
  // let in GHS cannot be added together, and the old query did exactly that
  // and labelled the result GHS. Same shape the commercial dashboards already
  // use for this (see moneyBreakdown in frontend lib/currency.js).
  var mrr = await pool.query(
    'SELECT l.currency, COALESCE(SUM(l.monthly_rate), 0) AS amount ' +
    'FROM poki_bookings l JOIN poki_units u ON u.id = l.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    "WHERE p.company_id = $1 AND l.status = 'active' AND l.duration_months > 0 " +
    'GROUP BY l.currency ORDER BY l.currency',
    [companyId]
  );

  var arrears = await pool.query(
    'SELECT i.currency, COALESCE(SUM(i.balance_due), 0) AS outstanding, ' +
    '       COUNT(*) FILTER (WHERE i.due_date < $2 AND i.balance_due > 0)::int AS overdue_count, ' +
    '       COALESCE(SUM(i.balance_due) FILTER (WHERE i.due_date < $2), 0) AS overdue_amount ' +
    "FROM invoices i WHERE i.company_id = $1 AND i.status NOT IN ('paid', 'void') " +
    'GROUP BY i.currency ORDER BY i.currency',
    [companyId, today]
  );

  var expiring = await pool.query(
    BOOKING_SELECT +
    "WHERE p.company_id = $1 AND l.status = 'active' AND l.end_date <= ($2::date + INTERVAL '90 days') " +
    'GROUP BY l.id, u.id, p.id, c.id ORDER BY l.end_date LIMIT 20',
    [companyId, today]
  );

  var maintenance = await pool.query(
    'SELECT COUNT(*)::int AS open_count FROM poki_maintenance_requests m ' +
    'JOIN poki_units u ON u.id = m.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    "WHERE p.company_id = $1 AND m.status IN ('open', 'in_progress')",
    [companyId]
  );

  // What was billed and what came in, month by month for the last twelve
  // months, per currency (see the rent-roll note above on why not summed).
  var twelveAgo = today.slice(0, 8) + '01';
  twelveAgo = addMonths(twelveAgo, -11);
  var billed = await pool.query(
    "SELECT to_char(i.issued_at, 'YYYY-MM') AS month, i.currency, COALESCE(SUM(i.grand_total), 0) AS amount " +
    "FROM invoices i WHERE i.company_id = $1 AND i.status <> 'void' AND i.issued_at >= $2 GROUP BY 1, 2",
    [companyId, twelveAgo]
  );
  var collected = await pool.query(
    "SELECT to_char(pm.date, 'YYYY-MM') AS month, pm.currency, COALESCE(SUM(pm.amount), 0) AS amount " +
    'FROM payments pm JOIN invoices i ON i.id = pm.invoice_id ' +
    "WHERE i.company_id = $1 AND i.status <> 'void' AND pm.date >= $2 GROUP BY 1, 2",
    [companyId, twelveAgo]
  );

  // Vacant units and since when: the day the last booking on them ended (or
  // was ended early), or when the unit was added if it has never been let.
  var vacant = await pool.query(
    'SELECT u.id, u.code, u.name, u.base_rent, u.currency, u.unit_type, p.name AS property_name, ' +
    '       COALESCE(MAX(COALESCE(l.terminated_on, l.end_date)) FILTER (WHERE l.status IN (\'terminated\', \'expired\', \'renewed\', \'active\')), u.created_at::date) AS vacant_since, ' +
    '       COUNT(l.id) FILTER (WHERE l.status IN (\'terminated\', \'expired\', \'renewed\', \'active\')) AS times_let ' +
    'FROM poki_units u JOIN poki_properties p ON p.id = u.property_id ' +
    'LEFT JOIN poki_bookings l ON l.unit_id = u.id ' +
    "WHERE p.company_id = $1 AND u.active AND u.status = 'vacant' GROUP BY u.id, p.id ORDER BY vacant_since",
    [companyId]
  );

  // Move-ins in the next 30 days: bookings drawn up but not started yet.
  var upcoming = await pool.query(
    BOOKING_SELECT +
    "WHERE p.company_id = $1 AND l.status IN ('draft', 'active') AND l.start_date > $2 AND l.start_date <= ($2::date + INTERVAL '30 days') " +
    'GROUP BY l.id, u.id, p.id, c.id ORDER BY l.start_date LIMIT 20',
    [companyId, today]
  );

  var deposits = await pool.query(
    'SELECT l.currency, COALESCE(SUM(l.deposit_held - l.deposit_refunded), 0) AS held ' +
    'FROM poki_bookings l JOIN poki_units u ON u.id = l.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    'WHERE p.company_id = $1 AND l.deposit_held > l.deposit_refunded GROUP BY 1 ORDER BY 1',
    [companyId]
  );

  var urgent = await pool.query(
    'SELECT COUNT(*) FILTER (WHERE m.priority IN (\'urgent\', \'high\'))::int AS urgent, MIN(m.reported_on) AS oldest ' +
    'FROM poki_maintenance_requests m JOIN poki_units u ON u.id = m.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    "WHERE p.company_id = $1 AND m.status IN ('open', 'in_progress')",
    [companyId]
  );

  var u = units.rows[0];
  var occupancyRate = u.total > 0 ? Math.round((u.occupied / u.total) * 1000) / 10 : 0;
  var months = [];
  for (var mi = 0; mi < 12; mi++) months.push(addMonths(twelveAgo, mi).slice(0, 7));
  function byMonth(rows) {
    return rows.map(function (r) { return { month: r.month, currency: r.currency, amount: money(r.amount) }; });
  }

  return {
    units: { total: u.total, occupied: u.occupied, vacant: u.vacant, other: u.other, occupancyRate: occupancyRate },
    // [{ currency, amount }] — one entry per currency in play. A portfolio
    // let entirely in GHS gets a single entry and reads exactly as before.
    monthlyRecurringRevenue: mrr.rows.map(function (r) {
      return { currency: r.currency, amount: Math.round(Number(r.amount) * 100) / 100 };
    }),
    outstanding: arrears.rows
      .filter(function (r) { return Number(r.outstanding) !== 0; })
      .map(function (r) { return { currency: r.currency, amount: Number(r.outstanding) }; }),
    overdueCount: arrears.rows.reduce(function (n, r) { return n + r.overdue_count; }, 0),
    overdueAmount: arrears.rows
      .filter(function (r) { return Number(r.overdue_amount) !== 0; })
      .map(function (r) { return { currency: r.currency, amount: Number(r.overdue_amount) }; }),
    openMaintenance: maintenance.rows[0].open_count,
    urgentMaintenance: urgent.rows[0].urgent,
    oldestOpenMaintenance: urgent.rows[0].oldest,
    expiringBookings: expiring.rows.map(rowToBooking),
    upcomingBookings: upcoming.rows.map(rowToBooking),
    months: months, billedByMonth: byMonth(billed.rows), collectedByMonth: byMonth(collected.rows),
    depositsHeld: deposits.rows.map(function (r) { return { currency: r.currency, amount: money(r.held) }; }),
    vacantUnits: vacant.rows.map(function (r) {
      var since = r.vacant_since instanceof Date ? r.vacant_since.toISOString().slice(0, 10) : String(r.vacant_since).slice(0, 10);
      return {
        id: r.id, code: r.code, name: r.name, unitType: r.unit_type, propertyName: r.property_name,
        baseRent: Number(r.base_rent), currency: r.currency, vacantSince: since, timesLet: Number(r.times_let),
        daysVacant: Math.max(0, Math.round((new Date(today + 'T00:00:00Z') - new Date(since + 'T00:00:00Z')) / 86400000))
      };
    })
  };
}

// Rent roll — one row per active booking, the report a landlord actually
// lives in: unit, tenant, rent, term, and what they owe right now.
async function rentRoll(ctx) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  var res = await pool.query(
    BOOKING_SELECT + "WHERE p.company_id = $1 AND l.status = 'active' " +
    'GROUP BY l.id, u.id, p.id, c.id ORDER BY p.name, u.code',
    [companyId]
  );
  return res.rows.map(rowToBooking);
}

// Marks bookings whose end date has passed as expired and frees their units.
// Called by the booking list (same pattern as quotations' autoExpire) so the
// board is accurate without needing a scheduler.
async function autoExpireBookings() {
  var today = todayISO();
  var expired = await pool.query(
    "UPDATE poki_bookings SET status = 'expired', updated_at = now() " +
    "WHERE status = 'active' AND end_date < $1 RETURNING unit_id",
    [today]
  );
  for (var i = 0; i < expired.rows.length; i++) {
    await pool.query("UPDATE poki_units SET status = 'vacant', updated_at = now() WHERE id = $1", [expired.rows[i].unit_id]);
  }
  return expired.rows.length;
}

module.exports = {
  pokiCompanyId: pokiCompanyId, canRead: canRead, canManage: canManage, addMonths: addMonths, addDays: addDays,
  bookingEndDate: bookingEndDate, priceBooking: priceBooking, dailyRateFor: dailyRateFor, describeDuration: describeDuration,
  listProperties: listProperties, createProperty: createProperty, updateProperty: updateProperty, removeProperty: removeProperty,
  listUnits: listUnits, createUnit: createUnit, updateUnit: updateUnit, removeUnit: removeUnit,
  listTenants: listTenants, createTenant: createTenant, updateTenant: updateTenant, removeTenant: removeTenant,
  listBookings: listBookings, getBooking: getBooking, createBooking: createBooking, updateBooking: updateBooking,
  quoteBooking: quoteBooking,
  activateBooking: activateBooking, endBooking: endBooking, renewBooking: renewBooking,
  recordDeposit: recordDeposit, refundDeposit: refundDeposit,
  overview: overview, rentRoll: rentRoll, autoExpireBookings: autoExpireBookings
};
