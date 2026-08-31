var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { parseCsvBuffer, field, parseDateLoose } = require('../lib/csvImport');
var employeesService = require('./employees.service');

// Import from a plain HR spreadsheet (as opposed to timestation.service.js,
// which pulls the same shape of data but live from the TimeStation API) —
// same preview/commit shape as toolRoomImport.service.js and
// itDeviceImport.service.js.
//
// Unlike TimeStation's sync, this deliberately does NOT auto-create
// departments: an HR sheet is a one-time, admin-driven import, so an
// unrecognized department name is surfaced as a skip for a human to fix
// (rename the sheet's column or create the department first) rather than
// silently inventing a new one under a guessed company — the same
// company_id-defaulting problem that TimeStation's own auto-create path
// has to work around (see timestation.service.js#findOrCreateDepartment).
//
// Department names are matched within the sheet's own Company column when
// present (unambiguous even across companies that reuse a name, e.g. every
// company's own "Kitchen"); without a Company column, a department name
// that exists in more than one company is flagged ambiguous rather than
// guessed — same reasoning as timestation.service.js's ambiguousDeptNames
// guard.

var EMPLOYMENT_TYPE_ALIASES = {
  permanent: 'permanent', 'full time': 'permanent', fulltime: 'permanent', staff: 'permanent',
  contract: 'contract', contractor: 'contract',
  casual: 'casual', temp: 'casual', temporary: 'casual', 'part time': 'casual', parttime: 'casual',
  'day rate': 'day_rate', dayrate: 'day_rate', 'by day': 'day_rate', daily: 'day_rate'
};
function mapEmploymentType(raw) {
  var key = String(raw || '').trim().toLowerCase();
  if (EMPLOYMENT_TYPE_ALIASES[key]) return { value: EMPLOYMENT_TYPE_ALIASES[key], recognized: true };
  return { value: 'permanent', recognized: !key };
}

function splitName(fullName) {
  var parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '—' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function preview(ctx, buffer) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');

  var rows = parseCsvBuffer(buffer);
  if (!rows.length) fail('invalid', 'That file has no data rows.');

  var deptRes = await pool.query(
    'SELECT d.id, d.name, c.id AS company_id, c.name AS company_name FROM departments d JOIN companies c ON c.id = d.company_id'
  );
  var deptsByName = {}; // lowercased dept name -> [{id, name, companyId, companyName}]
  var deptsByCompanyAndName = {}; // "companyname|deptname" -> single dept row
  deptRes.rows.forEach(function (d) {
    var key = d.name.toLowerCase();
    if (!deptsByName[key]) deptsByName[key] = [];
    deptsByName[key].push(d);
    deptsByCompanyAndName[d.company_name.toLowerCase() + '|' + key] = d;
  });

  var shiftRes = await pool.query('SELECT id, department_id, name, start_time, end_time FROM shifts');

  var empRes = await pool.query('SELECT email FROM employees');
  var existingEmails = new Set(empRes.rows.map(function (r) { return r.email.toLowerCase(); }));

  var out = [];
  var seenEmails = new Set();

  rows.forEach(function (row, rowIdx) {
    var n = row.norm;
    var fullName = field(n, ['name', 'fullname', 'employeename']);
    var firstName = field(n, ['firstname', 'first']);
    var lastName = field(n, ['lastname', 'last', 'surname']);
    if (!firstName && !lastName && fullName) {
      var split = splitName(fullName);
      firstName = split.firstName;
      lastName = split.lastName;
    }
    var email = field(n, ['email', 'workemail', 'emailaddress']).toLowerCase();
    var phone = field(n, ['phone', 'phonenumber', 'mobile', 'cell']);
    var positionTitle = field(n, ['jobtitle', 'title', 'position', 'role']);
    var companyName = field(n, ['company', 'business']);
    var deptName = field(n, ['department', 'group', 'dept']);
    var employmentTypeRaw = field(n, ['employmenttype', 'type', 'staffType', 'stafftype']);
    var hireDate = parseDateLoose(field(n, ['hiredate', 'datehired', 'startdate', 'joindate']));
    var shiftName = field(n, ['shift', 'shiftname']);

    if (!firstName && !lastName && !email) return; // blank spreadsheet row — skip silently, not an error

    var sourceRow = String(rowIdx + 1);
    var warnings = [];
    var willSkip = false;
    var skipReason = null;
    var deptId = null;
    var deptMatches = deptsByName[deptName.toLowerCase()] || [];

    if (!email) {
      warnings.push('No email — enter one before importing, or this person will be skipped.');
      willSkip = true;
      skipReason = 'no_email';
    } else if (existingEmails.has(email) || seenEmails.has(email)) {
      warnings.push('An employee with this email already exists — skipped to avoid a duplicate.');
      willSkip = true;
      skipReason = 'duplicate';
    }
    seenEmails.add(email);

    if (!deptName) {
      warnings.push('No department in sheet — this person will be skipped.');
      willSkip = true;
      skipReason = skipReason || 'no_department';
    } else if (companyName) {
      var direct = deptsByCompanyAndName[companyName.toLowerCase() + '|' + deptName.toLowerCase()];
      if (direct) {
        deptId = direct.id;
      } else {
        warnings.push('"' + deptName + '" isn’t a department of "' + companyName + '" — this person will be skipped.');
        willSkip = true;
        skipReason = skipReason || 'unknown_department';
      }
    } else if (deptMatches.length === 1) {
      deptId = deptMatches[0].id;
    } else if (deptMatches.length > 1) {
      warnings.push('"' + deptName + '" matches more than one department (' + deptMatches.map(function (d) { return d.company_name; }).join(', ') + ') — add a Company column to disambiguate.');
      willSkip = true;
      skipReason = skipReason || 'ambiguous_department';
    } else {
      warnings.push('"' + deptName + '" doesn’t match any existing department — create it first, or fix the sheet.');
      willSkip = true;
      skipReason = skipReason || 'unknown_department';
    }

    var typeMap = mapEmploymentType(employmentTypeRaw);
    if (!typeMap.recognized && employmentTypeRaw) warnings.push('Unrecognized employment type "' + employmentTypeRaw + '" — imported as Permanent; review after import.');

    var shiftId = null;
    if (deptId && shiftName) {
      var shiftMatch = shiftRes.rows.find(function (s) { return s.department_id === deptId && s.name.toLowerCase() === shiftName.toLowerCase(); });
      if (shiftMatch) shiftId = shiftMatch.id;
      else warnings.push('Shift "' + shiftName + '" not found for this department — imported with no shift assigned.');
    }

    if (!firstName) { warnings.push('No first name — this person will be skipped.'); willSkip = true; skipReason = skipReason || 'invalid'; }
    if (!positionTitle) positionTitle = 'Staff';

    out.push({
      firstName: firstName,
      lastName: lastName || '—',
      email: email,
      phone: phone,
      positionTitle: positionTitle,
      departmentId: deptId,
      departmentName: deptName,
      companyName: companyName || (deptMatches.length === 1 ? deptMatches[0].company_name : ''),
      shiftId: shiftId,
      employmentType: typeMap.value,
      hireDate: hireDate,
      sourceRow: sourceRow,
      willSkip: willSkip,
      skipReason: skipReason,
      warnings: warnings
    });
  });

  return { rows: out };
}

async function commit(ctx, rows) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!Array.isArray(rows) || !rows.length) fail('invalid', 'Nothing to import.');

  var created = 0, skipped = 0, failed = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.willSkip) { skipped++; continue; }
    try {
      await employeesService.create(ctx, {
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        phone: r.phone,
        positionTitle: r.positionTitle,
        departmentId: r.departmentId,
        shiftId: r.shiftId || null,
        employmentType: r.employmentType,
        hireDate: r.hireDate || undefined
      });
      created++;
    } catch (e) {
      failed.push({ name: (r.firstName + ' ' + r.lastName).trim(), reason: e.message || 'Unknown error' });
    }
  }

  await audit(pool, ctx, 'employee.import', 'employee', 'bulk',
    'Imported ' + created + ' employee(s) from a spreadsheet' + (skipped ? ' (' + skipped + ' skipped)' : '') + (failed.length ? ' (' + failed.length + ' failed)' : '') + '.');
  return { created: created, skipped: skipped, failed: failed };
}

module.exports = { preview: preview, commit: commit };
