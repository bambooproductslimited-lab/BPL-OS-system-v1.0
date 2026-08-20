#!/usr/bin/env node
/*
 * Production-safe alternative to seed.js. seed.js TRUNCATEs every table and
 * fills it with fake demo people/customers/quotations — exactly what you
 * want for local dev, and exactly what you must never point at a real
 * company's database. This script never deletes anything: it only inserts
 * the reference data every deployment needs to function at all (the
 * permission catalogue, the 12 role definitions, one default company
 * settings row — see referenceData.js) if that data isn't there yet, then
 * creates exactly one real administrator account from the ADMIN_* env vars
 * below. Safe to run on every deploy: each step checks first and skips
 * anything already present, so re-running it after the first real deploy
 * is a no-op.
 *
 * Required env vars: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME, ADMIN_LAST_NAME.
 * Run with: npm run bootstrap
 */
var bcrypt = require('bcrypt');
var crypto = require('crypto');
var config = require('../config');
var { pool, withTransaction } = require('./pool');
var { PERMISSIONS, ROLE_DEFS, defaultSettingsRow } = require('./referenceData');

function uuid() { return crypto.randomUUID(); }

async function ensurePermissionsAndRoles(client) {
  // Per-row idempotent (not just "skip if the table isn't empty"), so that
  // adding a new entry to PERMISSIONS/ROLE_DEFS later and redeploying picks
  // it up on an already-bootstrapped database instead of being silently
  // ignored forever.
  var existingPerms = await client.query('SELECT key FROM permissions');
  var knownPermKeys = {};
  existingPerms.rows.forEach(function (r) { knownPermKeys[r.key] = true; });
  for (var i = 0; i < PERMISSIONS.length; i++) {
    var p = PERMISSIONS[i];
    if (knownPermKeys[p.key]) continue;
    console.log('Adding new permission to catalogue: ' + p.key);
    await client.query('INSERT INTO permissions (key, "group", label) VALUES ($1, $2, $3)', [p.key, p.group, p.label]);
  }

  var roleRes = await client.query('SELECT key, id FROM roles');
  var roleIds = {};
  roleRes.rows.forEach(function (r) { roleIds[r.key] = r.id; });
  for (var j = 0; j < ROLE_DEFS.length; j++) {
    var def = ROLE_DEFS[j];
    if (roleIds[def.key]) continue;
    console.log('Creating new role: ' + def.key);
    var id = uuid();
    roleIds[def.key] = id;
    await client.query('INSERT INTO roles (id, key, name, is_system, description) VALUES ($1, $2, $3, true, $4)', [id, def.key, def.name, def.description]);
    for (var k = 0; k < def.permissions.length; k++) {
      await client.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)', [id, def.permissions[k]]);
    }
  }

  // The administrator role must always carry every permission in the
  // catalogue — roles.service.js's setPermission refuses to touch it for
  // exactly this reason — so unlike other roles (which an admin may have
  // deliberately customized via Roles & Permissions), it's always safe to
  // top it up with anything new in PERMISSIONS without clobbering a
  // deliberate customization.
  var adminId = roleIds.administrator;
  var adminPerms = await client.query('SELECT permission_key FROM role_permissions WHERE role_id = $1', [adminId]);
  var adminHas = {};
  adminPerms.rows.forEach(function (r) { adminHas[r.permission_key] = true; });
  for (var m = 0; m < PERMISSIONS.length; m++) {
    var key = PERMISSIONS[m].key;
    if (adminHas[key]) continue;
    console.log('Granting new permission to administrator role: ' + key);
    await client.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)', [adminId, key]);
  }

  return roleIds;
}

async function ensureSettings(client) {
  var existing = await client.query('SELECT id, commercial, payroll FROM settings WHERE id = 1');
  if (existing.rows[0]) {
    // Additive sync only, same reasoning as ensurePermissionsAndRoles: a
    // later referenceData.js adding a new document type (e.g. 'waybill')
    // shouldn't require deleting the live settings row to pick it up, but
    // an operator's edits to existing keys (tax rates, templates, etc. via
    // Company Settings) must never be overwritten.
    var commercial = existing.rows[0].commercial;
    var payroll = existing.rows[0].payroll || {};
    var defaults = defaultSettingsRow();
    var changed = false;
    Object.keys(defaults.commercial.numbering).forEach(function (kind) {
      if (!commercial.numbering[kind]) {
        console.log('Adding missing document numbering config: ' + kind);
        commercial.numbering[kind] = defaults.commercial.numbering[kind];
        changed = true;
      }
    });
    var payrollChanged = false;
    if (!payroll.payeBands) {
      console.log('Adding default payroll rates (SSNIT/PAYE) — verify these against current GRA/SSNIT circulars.');
      payroll = defaults.payroll;
      payrollChanged = true;
    }
    if (changed) await client.query('UPDATE settings SET commercial = $1 WHERE id = 1', [JSON.stringify(commercial)]);
    if (payrollChanged) await client.query('UPDATE settings SET payroll = $1 WHERE id = 1', [JSON.stringify(payroll)]);
    if (!changed && !payrollChanged) console.log('Company settings row already present — skipping.');
    return;
  }
  console.log('Inserting default company settings...');
  var s = defaultSettingsRow();
  await client.query(
    'INSERT INTO settings (id, company_name, short_name, country, currency, timezone, fiscal_year_start, work_week, standard_hours, late_after, plants, leave_approval_chain, integrations, commercial, payroll) ' +
    'VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
    [s.companyName, s.shortName, s.country, s.currency, s.timezone, s.fiscalYearStart, s.workWeek, s.standardHours, s.lateAfter, s.plants, s.leaveApprovalChain, JSON.stringify(s.integrations), JSON.stringify(s.commercial), JSON.stringify(s.payroll)]
  );
}

var LEAVE_TYPE_DEFS = [
  { name: 'Annual staff leave', daysPerYear: 21, paid: true },
  { name: 'Sick leave', daysPerYear: 14, paid: true }
];

async function ensureLeaveTypes(client) {
  // Same additive-insert-if-missing pattern as permissions/roles: the two
  // leave types the company actually uses are guaranteed to exist without
  // ever deleting a type (and the history tied to it) that's already there.
  var existing = await client.query('SELECT name FROM leave_types');
  var known = {};
  existing.rows.forEach(function (r) { known[r.name] = true; });
  for (var i = 0; i < LEAVE_TYPE_DEFS.length; i++) {
    var t = LEAVE_TYPE_DEFS[i];
    if (known[t.name]) continue;
    console.log('Adding leave type: ' + t.name);
    await client.query('INSERT INTO leave_types (name, days_per_year, paid, active) VALUES ($1, $2, $3, true)', [t.name, t.daysPerYear, t.paid]);
  }
}

async function ensureAdminDepartment(client) {
  var existing = await client.query("SELECT id FROM departments WHERE code = 'ADM'");
  if (existing.rows[0]) return existing.rows[0].id;
  console.log('Creating Administration department...');
  var id = uuid();
  await client.query(
    "INSERT INTO departments (id, code, name, manager_id, status) VALUES ($1, 'ADM', 'Administration', NULL, 'active')",
    [id]
  );
  return id;
}

async function ensureAdminUser(client, deptId, roleIds) {
  var email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  var password = process.env.ADMIN_PASSWORD || '';
  var firstName = (process.env.ADMIN_FIRST_NAME || '').trim();
  var lastName = (process.env.ADMIN_LAST_NAME || '').trim();
  if (!email || !password || !firstName || !lastName) {
    throw new Error('Set ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME and ADMIN_LAST_NAME to create the first real admin account.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  var existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) {
    console.log('A user with email ' + email + ' already exists — skipping admin creation.');
    return;
  }

  console.log('Creating admin account for ' + email + '...');
  var empId = uuid();
  await client.query(
    'INSERT INTO employees (id, code, first_name, last_name, email, phone, department_id, position_title, manager_id, employment_type, hire_date, status, location, shift) ' +
    "VALUES ($1,'ADM-001',$2,$3,$4,'',$5,'System Administrator',NULL,'permanent',$6,'active','','')",
    [empId, firstName, lastName, email, deptId, new Date().toISOString().slice(0, 10)]
  );

  await client.query("UPDATE departments SET manager_id = $1 WHERE id = $2 AND manager_id IS NULL", [empId, deptId]);

  var passwordHash = await bcrypt.hash(password, config.bcryptRounds);
  var userId = uuid();
  await client.query(
    'INSERT INTO users (id, employee_id, email, password_hash, status, must_change_password) VALUES ($1,$2,$3,$4,$5,false)',
    [userId, empId, email, passwordHash, 'active']
  );
  await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [userId, roleIds.administrator]);
  console.log('Admin account created. Sign in with ' + email + ' and the password you set in ADMIN_PASSWORD.');
}

async function run() {
  await withTransaction(async function (client) {
    var roleIds = await ensurePermissionsAndRoles(client);
    await ensureSettings(client);
    await ensureLeaveTypes(client);
    var deptId = await ensureAdminDepartment(client);
    await ensureAdminUser(client, deptId, roleIds);
  });
}

run()
  .then(function () { console.log('Bootstrap complete.'); pool.end(); })
  .catch(function (err) { console.error('Bootstrap failed:', err.message); pool.end(); process.exit(1); });
