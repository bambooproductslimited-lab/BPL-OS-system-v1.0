var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var config = require('../config');
var employeesService = require('./employees.service');
var kioskService = require('./kiosk.service');

// One-way pull from TimeStation (time & attendance) into the OS's own
// Employee directory — never writes anything back to TimeStation. Auth is
// HTTP Basic with the API key as username and no password, per TimeStation's
// own API v1.2 docs.
//
// TimeStation's account this connects to ("Chou & Associates Ltd.") spans
// several unrelated businesses under one login, not just Bamboo Products —
// confirmed with the business owner that every department/employee should
// still be imported, so this deliberately does not filter by department.
//
// Compensation: TimeStation only ever exposes a flat hourly_rate, and this
// account has zero custom fields configured, so there is no Monthly/Daily
// Rate, allowance, Staff Type or Report Group data to pull — hourly_rate is
// surfaced in the preview as a reference figure only; HR still sets the OS's
// real dailyRate the same way as for any other new hire (payroll.manage-
// gated, via the Employees screen), never guess-converted here.
//
// Kiosk PIN: TimeStation's own pin is auto-imported as the new employee's
// Bamboo OS kiosk PIN (owner's explicit choice), via the same
// kiosk.service.js.setPin() the manual "Kiosk PIN" dialog uses — same
// hashing, same uniqueness constraint. TimeStation's account spans several
// businesses, so its PINs aren't guaranteed unique the way Bamboo OS
// requires; a collision doesn't fail the employee's creation, just leaves
// that one PIN unset with a warning for HR to assign manually.
async function timestationRequest(path) {
  if (!config.timestation.configured) fail('invalid', 'TimeStation is not configured — set TIMESTATION_API_KEY on the server.');
  var res = await fetch(config.timestation.baseUrl + path, {
    headers: { Authorization: 'Basic ' + Buffer.from(config.timestation.apiKey + ':').toString('base64') }
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) fail('invalid', 'TimeStation API error on GET ' + path + ': ' + (data.message || res.status));
  return data;
}

function splitName(fullName) {
  var parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '—' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Departments come back with a 5-char CHECK constraint on code (see
// departments.service.js's save()) — derive something short and unique from
// the TimeStation department name's initials, falling back to a truncation,
// then a numeric suffix if that's still taken.
function deriveDeptCode(name, takenCodes) {
  var words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  var base = words.length > 1 ? words.map(function (w) { return w[0]; }).join('').slice(0, 5) : (words[0] || 'DEPT').slice(0, 5);
  if (!base) base = 'DEPT';
  var code = base;
  var n = 1;
  while (takenCodes.has(code)) {
    var suffix = String(n++);
    code = base.slice(0, 5 - suffix.length) + suffix;
  }
  takenCodes.add(code);
  return code;
}

// kernel.js: handlers['timestation.preview']
async function preview(ctx) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');

  var data = await timestationRequest('/employees');
  var tsEmployees = data.employees || [];

  var deptRes = await pool.query('SELECT id, name, code FROM departments');
  var deptByName = {};
  var takenCodes = new Set();
  deptRes.rows.forEach(function (d) { deptByName[d.name.toLowerCase()] = d; takenCodes.add(d.code); });

  var empRes = await pool.query("SELECT email FROM employees WHERE email <> ''");
  var existingEmails = new Set(empRes.rows.map(function (e) { return e.email.toLowerCase(); }));

  var seenDeptNames = {}; // dedupe "will create" rows across multiple employees in the same new department
  var out = [];

  tsEmployees.forEach(function (te) {
    var name = splitName(te.name);
    var email = String(te.email || '').trim().toLowerCase();
    var deptName = te.primary_department || te.current_department || 'Unassigned';
    var existingDept = deptByName[deptName.toLowerCase()];
    var warnings = [];
    var willSkip = false;

    if (!email) {
      warnings.push('No email on this TimeStation record — cannot create a matching employee. Skipped.');
      willSkip = true;
    } else if (existingEmails.has(email)) {
      warnings.push('An employee with this email already exists in the OS — skipped to avoid a duplicate.');
      willSkip = true;
    }

    var willCreateDept = !existingDept && !seenDeptNames[deptName.toLowerCase()];
    if (!existingDept) seenDeptNames[deptName.toLowerCase()] = true;

    out.push({
      timestationEmployeeId: te.employee_id,
      firstName: name.firstName,
      lastName: name.lastName,
      positionTitle: te.title || '',
      email: email,
      departmentName: deptName,
      departmentWillCreate: willCreateDept,
      hourlyRate: te.hourly_rate || '',
      pin: te.pin || '',
      willSkip: willSkip,
      warnings: warnings
    });
  });

  return { rows: out };
}

async function findOrCreateDepartment(client, name, takenCodes) {
  var existing = await client.query('SELECT id FROM departments WHERE lower(name) = lower($1)', [name]);
  if (existing.rows[0]) return existing.rows[0].id;
  var code = deriveDeptCode(name, takenCodes);
  var created = await client.query(
    "INSERT INTO departments (name, code, status) VALUES ($1,$2,'active') RETURNING id",
    [name, code]
  );
  return created.rows[0].id;
}

// kernel.js: handlers['timestation.commit']
// Departments are resolved/created up front (each employees.create() call
// manages its own transaction internally, so this isn't one big all-or-
// nothing transaction) — reasonable for a bulk import where one row's
// failure (e.g. a race on email uniqueness) shouldn't roll back everyone
// else; failures are collected and returned per-row instead.
async function commit(ctx, rows) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  if (!Array.isArray(rows) || !rows.length) fail('invalid', 'Nothing to import.');

  var deptRes = await pool.query('SELECT id, name, code FROM departments');
  var takenCodes = new Set(deptRes.rows.map(function (d) { return d.code; }));
  var deptIdByName = {};
  deptRes.rows.forEach(function (d) { deptIdByName[d.name.toLowerCase()] = d.id; });

  var created = 0, skipped = 0, failed = [], pinIssues = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.willSkip) { skipped++; continue; }
    try {
      var deptId = deptIdByName[String(r.departmentName || '').toLowerCase()];
      if (!deptId) {
        deptId = await findOrCreateDepartment(pool, r.departmentName, takenCodes);
        deptIdByName[String(r.departmentName || '').toLowerCase()] = deptId;
      }
      var newEmployee = await employeesService.create(ctx, {
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        departmentId: deptId,
        positionTitle: r.positionTitle || 'Staff',
        employmentType: 'permanent'
      });
      created++;

      var pin = String(r.pin || '').trim();
      var name = (r.firstName + ' ' + r.lastName).trim();
      if (pin) {
        if (!/^\d{4}$/.test(pin)) {
          pinIssues.push({ name: name, reason: 'TimeStation PIN "' + pin + '" is not 4 digits — kiosk PIN left unset, add one manually.' });
        } else {
          try {
            await kioskService.setPin(ctx, newEmployee.id, pin);
          } catch (pinErr) {
            pinIssues.push({ name: name, reason: (pinErr.message || 'Could not set kiosk PIN.') + ' Left unset — add one manually.' });
          }
        }
      }
    } catch (e) {
      failed.push({ name: (r.firstName + ' ' + r.lastName).trim(), reason: e.message || 'Unknown error' });
    }
  }

  await audit(pool, ctx, 'employee.import', 'employee', 'bulk',
    'Imported ' + created + ' employee(s) from TimeStation' + (skipped ? ' (' + skipped + ' skipped)' : '') + (failed.length ? ' (' + failed.length + ' failed)' : '') + (pinIssues.length ? ' (' + pinIssues.length + ' kiosk PIN issue(s))' : '') + '.');
  return { created: created, skipped: skipped, failed: failed, pinIssues: pinIssues };
}

module.exports = { preview: preview, commit: commit, splitName: splitName, deriveDeptCode: deriveDeptCode };
