var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { nextDocNumber, todayISO } = require('../utils/documents');

// Poki — the group's property-rental business (migration 0056). Properties
// hold units; units are let to tenants under leases; leases drive rent and
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
// 2. Unit occupancy is DERIVED from leases, never set by hand. Activating a
//    lease marks its unit occupied; ending one frees it. A partial unique
//    index (migration 0056) makes "two active leases on one unit"
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
  // Units cascade, but a unit that was ever let carries lease history worth
  // keeping — so refuse rather than silently destroying the record of who
  // occupied what. Archiving is the intended route for a sold property.
  var leases = await pool.query(
    'SELECT COUNT(*)::int AS n FROM poki_leases l JOIN poki_units u ON u.id = l.unit_id WHERE u.property_id = $1',
    [id]
  );
  if (leases.rows[0].n > 0) {
    fail('conflict', 'This property has ' + leases.rows[0].n + ' lease record(s) against its units. Archive it instead of deleting.');
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
    baseRent: Number(r.base_rent), currency: r.currency, rentCycle: r.rent_cycle,
    utilityMode: r.utility_mode, fixedUtilityAmount: Number(r.fixed_utility_amount), apportionShare: Number(r.apportion_share),
    status: r.status, amenities: r.amenities, notes: r.notes, active: r.active,
    tenantName: r.tenant_name || null, leaseId: r.lease_id || null, leaseEnd: r.lease_end || null,
    leaseRent: r.lease_rent != null ? Number(r.lease_rent) : null
  };
}

// Joins the unit's ACTIVE lease (if any) so every unit list doubles as a
// rent roll — which unit, who's in it, what they pay, when it ends.
var UNIT_SELECT =
  'SELECT u.*, p.name AS property_name, l.id AS lease_id, l.end_date AS lease_end, l.rent_amount AS lease_rent, ' +
  '       c.name AS tenant_name ' +
  'FROM poki_units u ' +
  'JOIN poki_properties p ON p.id = u.property_id ' +
  "LEFT JOIN poki_leases l ON l.unit_id = u.id AND l.status = 'active' " +
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
      'rent_cycle, utility_mode, fixed_utility_amount, apportion_share, amenities, notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [
        p.propertyId, code, (p.name || '').trim(),
        V.oneOf(p.unitType || 'room', ['apartment', 'room', 'office', 'shop', 'warehouse', 'land', 'other'], 'Unit type'),
        (p.floor || '').trim(), num(p.sizeSqm), Math.max(0, parseInt(p.bedrooms, 10) || 0), Math.max(0, parseInt(p.bathrooms, 10) || 0),
        num(p.baseRent), (p.currency || 'GHS').toUpperCase(),
        V.oneOf(p.rentCycle || 'monthly', ['monthly', 'quarterly', 'semiannual', 'annual', 'one_off'], 'Rent cycle'),
        V.oneOf(p.utilityMode || 'none', ['none', 'metered', 'fixed', 'apportioned'], 'Utility mode'),
        num(p.fixedUtilityAmount), num(p.apportionShare), (p.amenities || '').trim(), (p.notes || '').trim()
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
  // derived from leases (see module comment). Only the manual states
  // (maintenance/unavailable/reserved) can be set by hand, and only on a
  // unit with no active lease.
  var status = cur.status;
  if (p.status !== undefined && p.status !== cur.status) {
    var requested = V.oneOf(p.status, ['vacant', 'occupied', 'reserved', 'maintenance', 'unavailable'], 'Status');
    var activeLease = await pool.query("SELECT id FROM poki_leases WHERE unit_id = $1 AND status = 'active'", [id]);
    if (activeLease.rows[0]) {
      fail('conflict', "This unit has an active lease — its status follows the lease. End the lease to change it.");
    }
    if (requested === 'occupied') fail('invalid', 'A unit becomes occupied by activating a lease on it, not by setting the status.');
    status = requested;
  }
  var res = await pool.query(
    'UPDATE poki_units SET code = $1, name = $2, unit_type = $3, floor = $4, size_sqm = $5, bedrooms = $6, bathrooms = $7, ' +
    'base_rent = $8, currency = $9, rent_cycle = $10, utility_mode = $11, fixed_utility_amount = $12, apportion_share = $13, ' +
    'status = $14, amenities = $15, notes = $16, active = $17, updated_at = now() WHERE id = $18 RETURNING *',
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
      p.rentCycle !== undefined ? V.oneOf(p.rentCycle, ['monthly', 'quarterly', 'semiannual', 'annual', 'one_off'], 'Rent cycle') : cur.rent_cycle,
      p.utilityMode !== undefined ? V.oneOf(p.utilityMode, ['none', 'metered', 'fixed', 'apportioned'], 'Utility mode') : cur.utility_mode,
      p.fixedUtilityAmount !== undefined ? num(p.fixedUtilityAmount) : cur.fixed_utility_amount,
      p.apportionShare !== undefined ? num(p.apportionShare) : cur.apportion_share,
      status,
      p.amenities !== undefined ? (p.amenities || '').trim() : cur.amenities,
      p.notes !== undefined ? (p.notes || '').trim() : cur.notes,
      p.active !== undefined ? !!p.active : cur.active,
      id
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
  var leases = await pool.query('SELECT COUNT(*)::int AS n FROM poki_leases WHERE unit_id = $1', [id]);
  if (leases.rows[0].n > 0) {
    fail('conflict', 'This unit has ' + leases.rows[0].n + ' lease record(s). Mark it inactive instead of deleting.');
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
    activeLeases: r.active_leases != null ? Number(r.active_leases) : undefined,
    unitLabels: r.unit_labels || null
  };
}

var TENANT_SELECT =
  'SELECT t.*, c.name, c.contact_person, c.email, c.phone, c.address, ' +
  "  COUNT(l.id) FILTER (WHERE l.status = 'active') AS active_leases, " +
  "  string_agg(p.name || ' · ' || u.code, ', ') FILTER (WHERE l.status = 'active') AS unit_labels " +
  'FROM poki_tenants t ' +
  'JOIN customers c ON c.id = t.customer_id ' +
  'LEFT JOIN poki_leases l ON l.tenant_id = t.id ' +
  'LEFT JOIN poki_units u ON u.id = l.unit_id ' +
  'LEFT JOIN poki_properties p ON p.id = u.property_id ';

async function listTenants(ctx) {
  canRead(ctx);
  var res = await pool.query(TENANT_SELECT + 'GROUP BY t.id, c.id ORDER BY c.name');
  return res.rows.map(rowToTenant);
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
  var leases = await pool.query('SELECT COUNT(*)::int AS n FROM poki_leases WHERE tenant_id = $1', [id]);
  if (leases.rows[0].n > 0) {
    fail('conflict', 'This tenant has ' + leases.rows[0].n + ' lease record(s). Set their status to "former" instead of deleting.');
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

// ── leases ──────────────────────────────────────────────────────────────

var CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12, one_off: 0 };

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

function rowToLease(r) {
  return {
    id: r.id, leaseNo: r.lease_no, unitId: r.unit_id, tenantId: r.tenant_id,
    unitCode: r.unit_code, unitType: r.unit_type, propertyId: r.property_id, propertyName: r.property_name,
    tenantName: r.tenant_name, tenantEmail: r.tenant_email, tenantPhone: r.tenant_phone,
    startDate: r.start_date, endDate: r.end_date,
    rentAmount: Number(r.rent_amount), currency: r.currency, rentCycle: r.rent_cycle, paymentDay: r.payment_day,
    nextInvoiceOn: r.next_invoice_on,
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

// Arrears come from the invoices raised against the lease, so "what this
// tenant owes" is always the same number the invoice list would give —
// there's no second running balance to drift out of step.
var LEASE_SELECT =
  'SELECT l.*, u.code AS unit_code, u.unit_type, p.id AS property_id, p.name AS property_name, ' +
  '       c.name AS tenant_name, c.email AS tenant_email, c.phone AS tenant_phone, ' +
  "       COALESCE(SUM(i.grand_total) FILTER (WHERE i.status <> 'void'), 0) AS invoiced_total, " +
  "       COALESCE(SUM(i.amount_paid) FILTER (WHERE i.status <> 'void'), 0) AS paid_total, " +
  "       COALESCE(SUM(i.balance_due) FILTER (WHERE i.status <> 'void'), 0) AS balance_total " +
  'FROM poki_leases l ' +
  'JOIN poki_units u ON u.id = l.unit_id ' +
  'JOIN poki_properties p ON p.id = u.property_id ' +
  'JOIN poki_tenants t ON t.id = l.tenant_id ' +
  'JOIN customers c ON c.id = t.customer_id ' +
  'LEFT JOIN invoices i ON i.poki_lease_id = l.id ';

async function listLeases(ctx, filters) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  var params = [companyId];
  var sql = LEASE_SELECT + 'WHERE p.company_id = $1';
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
  return res.rows.map(rowToLease);
}

async function getLease(ctx, id) {
  canRead(ctx);
  var res = await pool.query(LEASE_SELECT + 'WHERE l.id = $1 GROUP BY l.id, u.id, p.id, c.id', [id]);
  if (!res.rows[0]) fail('notfound', 'Lease not found.');
  return rowToLease(res.rows[0]);
}

async function createLease(ctx, p) {
  canManage(ctx);
  var unit = await pool.query(
    'SELECT u.*, p.company_id FROM poki_units u JOIN poki_properties p ON p.id = u.property_id WHERE u.id = $1',
    [p.unitId]
  );
  if (!unit.rows[0]) fail('invalid', 'Choose a unit.');
  var tenant = await pool.query('SELECT id FROM poki_tenants WHERE id = $1', [p.tenantId]);
  if (!tenant.rows[0]) fail('invalid', 'Choose a tenant.');

  var startDate = V.date(p.startDate, 'Start date');
  var endDate = V.date(p.endDate, 'End date');
  if (endDate < startDate) fail('invalid', 'The end date cannot be before the start date.');

  var rentCycle = V.oneOf(p.rentCycle || unit.rows[0].rent_cycle, ['monthly', 'quarterly', 'semiannual', 'annual', 'one_off'], 'Rent cycle');
  var status = V.oneOf(p.status || 'draft', ['draft', 'active'], 'Status');
  var rentAmount = num(p.rentAmount, Number(unit.rows[0].base_rent));
  var depositAmount = num(p.depositAmount);

  var leaseId = await withTransaction(async function (client) {
    if (status === 'active') {
      var clash = await client.query("SELECT id FROM poki_leases WHERE unit_id = $1 AND status = 'active'", [p.unitId]);
      if (clash.rows[0]) fail('conflict', 'That unit already has an active lease. End it before starting a new one.');
    }
    var leaseNo = await nextDocNumber(client, 'lease');
    var res = await client.query(
      'INSERT INTO poki_leases (lease_no, unit_id, tenant_id, start_date, end_date, rent_amount, currency, rent_cycle, ' +
      'payment_day, next_invoice_on, deposit_amount, deposit_held, escalation_percent, status, signed_on, notes, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id',
      [
        leaseNo, p.unitId, p.tenantId, startDate, endDate, rentAmount,
        (p.currency || unit.rows[0].currency || 'GHS').toUpperCase(), rentCycle,
        Math.min(28, Math.max(1, parseInt(p.paymentDay, 10) || 1)),
        // First rent period starts on the lease start date; the rent run
        // advances this each time it raises an invoice.
        startDate,
        depositAmount,
        // Deposit is only "held" once it's actually been collected, which
        // the deposit endpoint records — creating a lease just states what
        // is due.
        num(p.depositHeld),
        num(p.escalationPercent), status, p.signedOn || null, (p.notes || '').trim(),
        ctx.employee ? ctx.employee.id : null
      ]
    );
    if (status === 'active') {
      await client.query("UPDATE poki_units SET status = 'occupied', updated_at = now() WHERE id = $1", [p.unitId]);
    }
    await audit(client, ctx, 'poki.lease.create', 'poki_lease', res.rows[0].id, 'Created lease ' + leaseNo + ' on unit ' + unit.rows[0].code + '.');
    return res.rows[0].id;
  });

  return getLease(ctx, leaseId);
}

async function updateLease(ctx, id, p) {
  canManage(ctx);
  var existing = await pool.query('SELECT * FROM poki_leases WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Lease not found.');
  var cur = existing.rows[0];
  if (cur.status === 'terminated' || cur.status === 'expired') {
    fail('conflict', 'This lease has ended and can no longer be edited. Create a renewal instead.');
  }
  var startDate = p.startDate !== undefined ? V.date(p.startDate, 'Start date') : cur.start_date;
  var endDate = p.endDate !== undefined ? V.date(p.endDate, 'End date') : cur.end_date;
  if (String(endDate) < String(startDate)) fail('invalid', 'The end date cannot be before the start date.');

  var res = await pool.query(
    'UPDATE poki_leases SET start_date = $1, end_date = $2, rent_amount = $3, currency = $4, rent_cycle = $5, ' +
    'payment_day = $6, deposit_amount = $7, escalation_percent = $8, signed_on = $9, notes = $10, updated_at = now() ' +
    'WHERE id = $11 RETURNING *',
    [
      startDate, endDate,
      p.rentAmount !== undefined ? num(p.rentAmount) : cur.rent_amount,
      p.currency !== undefined ? (p.currency || 'GHS').toUpperCase() : cur.currency,
      p.rentCycle !== undefined ? V.oneOf(p.rentCycle, ['monthly', 'quarterly', 'semiannual', 'annual', 'one_off'], 'Rent cycle') : cur.rent_cycle,
      p.paymentDay !== undefined ? Math.min(28, Math.max(1, parseInt(p.paymentDay, 10) || 1)) : cur.payment_day,
      p.depositAmount !== undefined ? num(p.depositAmount) : cur.deposit_amount,
      p.escalationPercent !== undefined ? num(p.escalationPercent) : cur.escalation_percent,
      p.signedOn !== undefined ? (p.signedOn || null) : cur.signed_on,
      p.notes !== undefined ? (p.notes || '').trim() : cur.notes,
      id
    ]
  );
  await audit(pool, ctx, 'poki.lease.update', 'poki_lease', id, 'Updated lease ' + res.rows[0].lease_no + '.');
  return getLease(ctx, id);
}

// Activating is separate from editing because it's the moment the unit
// changes hands — it takes the unit, and the one-active-lease-per-unit
// index is what guarantees no double-let.
async function activateLease(ctx, id) {
  canManage(ctx);
  var lease = await pool.query('SELECT * FROM poki_leases WHERE id = $1', [id]);
  if (!lease.rows[0]) fail('notfound', 'Lease not found.');
  if (lease.rows[0].status === 'active') fail('conflict', 'This lease is already active.');
  if (lease.rows[0].status !== 'draft') fail('conflict', 'Only a draft lease can be activated.');

  await withTransaction(async function (client) {
    var clash = await client.query("SELECT lease_no FROM poki_leases WHERE unit_id = $1 AND status = 'active'", [lease.rows[0].unit_id]);
    if (clash.rows[0]) fail('conflict', 'Unit already let under lease ' + clash.rows[0].lease_no + '. End that lease first.');
    await client.query("UPDATE poki_leases SET status = 'active', updated_at = now() WHERE id = $1", [id]);
    await client.query("UPDATE poki_units SET status = 'occupied', updated_at = now() WHERE id = $1", [lease.rows[0].unit_id]);
    await audit(client, ctx, 'poki.lease.activate', 'poki_lease', id, 'Activated lease ' + lease.rows[0].lease_no + '.');
  });
  return getLease(ctx, id);
}

// Ending a lease frees the unit. Outstanding invoices are deliberately left
// standing — money owed doesn't stop being owed because someone moved out,
// and the arrears view should keep showing it.
async function endLease(ctx, id, p) {
  canManage(ctx);
  var lease = await pool.query('SELECT * FROM poki_leases WHERE id = $1', [id]);
  if (!lease.rows[0]) fail('notfound', 'Lease not found.');
  if (lease.rows[0].status === 'terminated' || lease.rows[0].status === 'expired') {
    fail('conflict', 'This lease has already ended.');
  }
  var newStatus = V.oneOf((p && p.status) || 'terminated', ['terminated', 'expired'], 'Status');
  var endedOn = (p && p.endedOn) ? V.date(p.endedOn, 'End date') : todayISO();

  await withTransaction(async function (client) {
    await client.query(
      'UPDATE poki_leases SET status = $1, terminated_on = $2, termination_reason = $3, next_invoice_on = NULL, updated_at = now() WHERE id = $4',
      [newStatus, endedOn, ((p && p.reason) || '').trim(), id]
    );
    await client.query("UPDATE poki_units SET status = 'vacant', updated_at = now() WHERE id = $1", [lease.rows[0].unit_id]);
    await audit(client, ctx, 'poki.lease.end', 'poki_lease', id, 'Ended lease ' + lease.rows[0].lease_no + ' (' + newStatus + ').');
  });
  return getLease(ctx, id);
}

// Renewal creates a NEW lease continuing from the old one's end date rather
// than extending it in place, so each term keeps its own rent, dates and
// signed agreement — which is what you need when a dispute is about what
// was agreed in a particular year.
async function renewLease(ctx, id, p) {
  canManage(ctx);
  var old = await pool.query('SELECT * FROM poki_leases WHERE id = $1', [id]);
  if (!old.rows[0]) fail('notfound', 'Lease not found.');
  var prev = old.rows[0];

  var months = CYCLE_MONTHS[prev.rent_cycle] || 12;
  var defaultTermMonths = months === 0 ? 12 : Math.max(months, 12);
  var startDate = (p && p.startDate) ? V.date(p.startDate, 'Start date') : addMonths(String(prev.end_date).slice(0, 10), 0);
  var endDate = (p && p.endDate) ? V.date(p.endDate, 'End date') : addMonths(startDate, defaultTermMonths);

  // Escalation is applied unless the caller states a rent explicitly.
  var escalation = (p && p.escalationPercent !== undefined) ? num(p.escalationPercent) : Number(prev.escalation_percent);
  var rentAmount = (p && p.rentAmount !== undefined)
    ? num(p.rentAmount)
    : Math.round(Number(prev.rent_amount) * (1 + escalation / 100) * 100) / 100;

  var newId = await withTransaction(async function (client) {
    if (prev.status === 'active') {
      await client.query(
        "UPDATE poki_leases SET status = 'renewed', terminated_on = $1, updated_at = now() WHERE id = $2",
        [startDate, id]
      );
    }
    var leaseNo = await nextDocNumber(client, 'lease');
    var res = await client.query(
      'INSERT INTO poki_leases (lease_no, unit_id, tenant_id, start_date, end_date, rent_amount, currency, rent_cycle, ' +
      'payment_day, next_invoice_on, deposit_amount, deposit_held, escalation_percent, status, notes, renewed_from_id, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'active',$14,$15,$16) RETURNING id",
      [
        leaseNo, prev.unit_id, prev.tenant_id, startDate, endDate, rentAmount, prev.currency, prev.rent_cycle,
        prev.payment_day, startDate, prev.deposit_amount,
        // The deposit carries over to the new term rather than being
        // refunded and re-collected.
        prev.deposit_held,
        escalation, (p && p.notes ? String(p.notes).trim() : ''), id, ctx.employee ? ctx.employee.id : null
      ]
    );
    await client.query("UPDATE poki_units SET status = 'occupied', updated_at = now() WHERE id = $1", [prev.unit_id]);
    await audit(client, ctx, 'poki.lease.renew', 'poki_lease', res.rows[0].id,
      'Renewed ' + prev.lease_no + ' as ' + leaseNo + ' at ' + prev.currency + ' ' + rentAmount.toLocaleString() + '.');
    return res.rows[0].id;
  });
  return getLease(ctx, newId);
}

// ── deposits ────────────────────────────────────────────────────────────

async function recordDeposit(ctx, id, p) {
  canManage(ctx);
  var lease = await pool.query('SELECT * FROM poki_leases WHERE id = $1', [id]);
  if (!lease.rows[0]) fail('notfound', 'Lease not found.');
  var amount = num(p && p.amount);
  if (amount <= 0) fail('invalid', 'Enter a deposit amount greater than zero.');
  var held = Math.round((Number(lease.rows[0].deposit_held) + amount) * 100) / 100;
  await pool.query('UPDATE poki_leases SET deposit_held = $1, deposit_notes = $2, updated_at = now() WHERE id = $3',
    [held, ((p && p.notes) || lease.rows[0].deposit_notes || '').trim(), id]);
  await audit(pool, ctx, 'poki.lease.deposit', 'poki_lease', id,
    'Recorded deposit of ' + lease.rows[0].currency + ' ' + amount.toLocaleString() + ' on ' + lease.rows[0].lease_no + '.');
  return getLease(ctx, id);
}

async function refundDeposit(ctx, id, p) {
  canManage(ctx);
  var lease = await pool.query('SELECT * FROM poki_leases WHERE id = $1', [id]);
  if (!lease.rows[0]) fail('notfound', 'Lease not found.');
  var cur = lease.rows[0];
  var refund = num(p && p.amount);
  var deductions = num(p && p.deductions);
  var available = Math.round((Number(cur.deposit_held) - Number(cur.deposit_refunded)) * 100) / 100;
  if (refund <= 0) fail('invalid', 'Enter a refund amount greater than zero.');
  if (refund + deductions > available + 0.01) {
    fail('invalid', 'Refund plus deductions (' + (refund + deductions).toLocaleString() + ') exceeds the ' +
      available.toLocaleString() + ' held on this lease.');
  }
  var refunded = Math.round((Number(cur.deposit_refunded) + refund) * 100) / 100;
  var note = ((p && p.notes) || '').trim();
  if (deductions > 0) {
    note = (note ? note + ' ' : '') + '[Deductions withheld: ' + cur.currency + ' ' + deductions.toLocaleString() + ']';
  }
  await pool.query(
    'UPDATE poki_leases SET deposit_refunded = $1, deposit_refunded_on = $2, deposit_notes = $3, updated_at = now() WHERE id = $4',
    [refunded, (p && p.refundedOn) || todayISO(), note, id]
  );
  await audit(pool, ctx, 'poki.lease.depositRefund', 'poki_lease', id,
    'Refunded deposit of ' + cur.currency + ' ' + refund.toLocaleString() + ' on ' + cur.lease_no +
    (deductions > 0 ? ' (withheld ' + deductions.toLocaleString() + ')' : '') + '.');
  return getLease(ctx, id);
}

// ── dashboard ───────────────────────────────────────────────────────────

// Everything the overview screen needs in one round trip: occupancy, what
// the portfolio bills per month, what's outstanding, and what needs
// attention soon (expiring leases, open maintenance).
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

  // Monthly recurring revenue: each active lease's rent normalised to a
  // month, so a quarterly and an annual lease are comparable.
  var mrr = await pool.query(
    "SELECT COALESCE(SUM(l.rent_amount / CASE l.rent_cycle " +
    "  WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'semiannual' THEN 6 WHEN 'annual' THEN 12 ELSE 1 END), 0) AS mrr " +
    'FROM poki_leases l JOIN poki_units u ON u.id = l.unit_id JOIN poki_properties p ON p.id = u.property_id ' +
    "WHERE p.company_id = $1 AND l.status = 'active' AND l.rent_cycle <> 'one_off'",
    [companyId]
  );

  var arrears = await pool.query(
    'SELECT COALESCE(SUM(i.balance_due), 0) AS outstanding, ' +
    '       COUNT(*) FILTER (WHERE i.due_date < $2 AND i.balance_due > 0)::int AS overdue_count, ' +
    '       COALESCE(SUM(i.balance_due) FILTER (WHERE i.due_date < $2), 0) AS overdue_amount ' +
    "FROM invoices i WHERE i.company_id = $1 AND i.status NOT IN ('paid', 'void')",
    [companyId, today]
  );

  var expiring = await pool.query(
    LEASE_SELECT +
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

  var u = units.rows[0];
  var occupancyRate = u.total > 0 ? Math.round((u.occupied / u.total) * 1000) / 10 : 0;

  return {
    units: { total: u.total, occupied: u.occupied, vacant: u.vacant, other: u.other, occupancyRate: occupancyRate },
    monthlyRecurringRevenue: Math.round(Number(mrr.rows[0].mrr) * 100) / 100,
    outstanding: Number(arrears.rows[0].outstanding),
    overdueCount: arrears.rows[0].overdue_count,
    overdueAmount: Number(arrears.rows[0].overdue_amount),
    openMaintenance: maintenance.rows[0].open_count,
    expiringLeases: expiring.rows.map(rowToLease)
  };
}

// Rent roll — one row per active lease, the report a landlord actually
// lives in: unit, tenant, rent, term, and what they owe right now.
async function rentRoll(ctx) {
  canRead(ctx);
  var companyId = await pokiCompanyId();
  var res = await pool.query(
    LEASE_SELECT + "WHERE p.company_id = $1 AND l.status = 'active' " +
    'GROUP BY l.id, u.id, p.id, c.id ORDER BY p.name, u.code',
    [companyId]
  );
  return res.rows.map(rowToLease);
}

// Marks leases whose end date has passed as expired and frees their units.
// Called by the lease list (same pattern as quotations' autoExpire) so the
// board is accurate without needing a scheduler.
async function autoExpireLeases() {
  var today = todayISO();
  var expired = await pool.query(
    "UPDATE poki_leases SET status = 'expired', updated_at = now() " +
    "WHERE status = 'active' AND end_date < $1 RETURNING unit_id",
    [today]
  );
  for (var i = 0; i < expired.rows.length; i++) {
    await pool.query("UPDATE poki_units SET status = 'vacant', updated_at = now() WHERE id = $1", [expired.rows[i].unit_id]);
  }
  return expired.rows.length;
}

module.exports = {
  pokiCompanyId: pokiCompanyId, canRead: canRead, canManage: canManage, addMonths: addMonths, CYCLE_MONTHS: CYCLE_MONTHS,
  listProperties: listProperties, createProperty: createProperty, updateProperty: updateProperty, removeProperty: removeProperty,
  listUnits: listUnits, createUnit: createUnit, updateUnit: updateUnit, removeUnit: removeUnit,
  listTenants: listTenants, createTenant: createTenant, updateTenant: updateTenant, removeTenant: removeTenant,
  listLeases: listLeases, getLease: getLease, createLease: createLease, updateLease: updateLease,
  activateLease: activateLease, endLease: endLease, renewLease: renewLease,
  recordDeposit: recordDeposit, refundDeposit: refundDeposit,
  overview: overview, rentRoll: rentRoll, autoExpireLeases: autoExpireLeases
};
