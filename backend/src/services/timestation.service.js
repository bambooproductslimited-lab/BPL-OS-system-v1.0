var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var config = require('../config');
var employeesService = require('./employees.service');
var kioskService = require('./kiosk.service');
var attendanceService = require('./attendance.service');

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

// The commit() that created a placeholder-email employee (see
// autoFillMissingEmails() in EmployeesPage.jsx) embedded a 6-char fragment
// of that TimeStation employee_id into the address, specifically so a later
// sync could find its way back to the right record without a real email to
// match on. Same derivation, read back out here.
function idFragOf(timestationEmployeeId) {
  return String(timestationEmployeeId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase();
}
var PLACEHOLDER_EMAIL_RE = /\.([a-z0-9]+)@no-email\.placeholder$/i;

// kernel.js: handlers['timestation.preview']
async function preview(ctx) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');

  var data = await timestationRequest('/employees');
  var tsEmployees = data.employees || [];

  var deptRes = await pool.query('SELECT id, name, code FROM departments');
  var deptByName = {};
  var takenCodes = new Set();
  deptRes.rows.forEach(function (d) { deptByName[d.name.toLowerCase()] = d; takenCodes.add(d.code); });

  var empRes = await pool.query('SELECT id, email, timestation_employee_id FROM employees');
  var existingByEmail = {};
  var unlinkedPlaceholderByFrag = {};
  empRes.rows.forEach(function (e) {
    if (e.email) existingByEmail[e.email.toLowerCase()] = e;
    if (!e.timestation_employee_id) {
      var m = PLACEHOLDER_EMAIL_RE.exec(e.email || '');
      if (m) unlinkedPlaceholderByFrag[m[1]] = e;
    }
  });

  var seenDeptNames = {}; // dedupe "will create" rows across multiple employees in the same new department
  var out = [];

  tsEmployees.forEach(function (te) {
    var name = splitName(te.name);
    var email = String(te.email || '').trim().toLowerCase();
    var deptName = te.primary_department || te.current_department || 'Unassigned';
    var existingDept = deptByName[deptName.toLowerCase()];
    var warnings = [];
    var willSkip = false;
    var skipReason = null;
    var willLink = false;
    var existingEmployeeId = null;

    var emailMatch = email ? existingByEmail[email] : null;
    var placeholderMatch = !email ? unlinkedPlaceholderByFrag[idFragOf(te.employee_id)] : null;

    if (emailMatch) {
      willSkip = true;
      skipReason = 'duplicate';
      if (!emailMatch.timestation_employee_id) {
        willLink = true;
        existingEmployeeId = emailMatch.id;
        warnings.push('Already in the OS — this run will just link it to TimeStation for the attendance sync (no new record created).');
      } else {
        warnings.push('An employee with this email already exists in the OS — skipped to avoid a duplicate.');
      }
    } else if (placeholderMatch) {
      willSkip = true;
      skipReason = 'already_linked_placeholder';
      willLink = true;
      existingEmployeeId = placeholderMatch.id;
      warnings.push('Already imported earlier under a placeholder email — this run will just link it to TimeStation for the attendance sync.');
    } else if (!email) {
      warnings.push('No email on this TimeStation record — enter one before importing, or this person will be skipped.');
      willSkip = true;
      skipReason = 'no_email';
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
      skipReason: skipReason,
      willSkip: willSkip,
      willLink: willLink,
      existingEmployeeId: existingEmployeeId,
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

  var created = 0, skipped = 0, linked = 0, failed = [], pinIssues = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.willSkip) {
      skipped++;
      if (r.willLink && r.existingEmployeeId && r.timestationEmployeeId) {
        // Idempotent — only fills a NULL, so re-running the sync never
        // steals a link from a different (already-linked) employee.
        var linkRes = await pool.query(
          'UPDATE employees SET timestation_employee_id = $1 WHERE id = $2 AND timestation_employee_id IS NULL',
          [r.timestationEmployeeId, r.existingEmployeeId]
        );
        if (linkRes.rowCount) linked++;
      }
      continue;
    }
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
      if (r.timestationEmployeeId) {
        await pool.query('UPDATE employees SET timestation_employee_id = $1 WHERE id = $2', [r.timestationEmployeeId, newEmployee.id]);
      }
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
    'Imported ' + created + ' employee(s) from TimeStation' + (skipped ? ' (' + skipped + ' skipped)' : '') + (linked ? ' (' + linked + ' linked for attendance sync)' : '') + (failed.length ? ' (' + failed.length + ' failed)' : '') + (pinIssues.length ? ' (' + pinIssues.length + ' kiosk PIN issue(s))' : '') + '.');
  return { created: created, skipped: skipped, linked: linked, failed: failed, pinIssues: pinIssues };
}

// Not a real operational limit — TimeStation's own "last 2,000 shifts"
// cap (see the truncation warning below) means a wide date range costs
// exactly the same one API call per employee as a narrow one, so there's
// no need to chunk a full-history pull into smaller windows. This just
// catches an obviously wrong date (e.g. a typo'd year).
var MAX_ATTENDANCE_RANGE_DAYS = 20 * 365;

// TimeStation's /shifts endpoint is per-employee (employee_id is a required
// query param — there's no "give me every business's shifts at once" call),
// so this only covers employees that already have a timestation_employee_id
// (set by the employee sync — see preview()/commit() above). Anyone without
// one — a Bamboo-native hire never seen in TimeStation, or someone not yet
// linked — is simply untouched, exactly like the employee sync's rule
// ("TimeStation is authoritative for everyone it covers", nothing more).
//
// A TimeStation "shift" is one continuous in/out pair, but our attendance
// table is one row per employee per calendar day — if TimeStation shows more
// than one shift for the same person on the same day (a split shift, or a
// forgotten-checkout followed by a fresh clock-in), they're merged into a
// single row (earliest clock-in, latest clock-out) and flagged in the
// preview so it's not a silent surprise.
async function fetchShiftsForEmployee(timestationEmployeeId, startDate, endDate) {
  var qs = 'employee_id=' + encodeURIComponent(timestationEmployeeId) + '&start_date=' + startDate + '&end_date=' + endDate;
  var data = await timestationRequest('/shifts?' + qs);
  return data.shifts || [];
}

// kernel.js: handlers['timestation.previewAttendance']
async function previewAttendance(ctx, startDate, endDate) {
  if (!ctx.can('attendance.adjust')) fail('forbidden', 'Your role does not allow this action (attendance.adjust).');
  startDate = V.date(startDate, 'Start date');
  endDate = V.date(endDate, 'End date');
  if (endDate < startDate) fail('invalid', 'End date must be on or after start date.');
  var rangeDays = Math.round((new Date(endDate + 'T00:00') - new Date(startDate + 'T00:00')) / 86400000) + 1;
  if (rangeDays > MAX_ATTENDANCE_RANGE_DAYS) fail('invalid', 'That date range looks like a mistake (over ' + Math.round(MAX_ATTENDANCE_RANGE_DAYS / 365) + ' years) — check the dates.');
  if (!config.timestation.configured) fail('invalid', 'TimeStation is not configured — set TIMESTATION_API_KEY on the server.');

  var empRes = await pool.query(
    "SELECT id, first_name, last_name, shift_start, timestation_employee_id FROM employees WHERE status = 'active' AND timestation_employee_id IS NOT NULL"
  );
  if (!empRes.rows.length) fail('invalid', 'No employees are linked to TimeStation yet — run "Sync from TimeStation" on the Employees page first.');

  var out = [];
  for (var i = 0; i < empRes.rows.length; i++) {
    var emp = empRes.rows[i];
    var shifts = await fetchShiftsForEmployee(emp.timestation_employee_id, startDate, endDate);
    if (!shifts.length) continue;

    // TimeStation caps a single response at "the last 2,000 shifts" — if
    // exactly that many came back, there may be older ones this range
    // didn't reach. Flag it rather than silently import a partial history.
    if (shifts.length >= 2000) {
      out.push({
        employeeId: emp.id, employeeName: emp.first_name + ' ' + emp.last_name, date: null,
        clockIn: null, clockOut: null, status: null, action: 'skip',
        warnings: ['TimeStation returned its maximum of 2,000 shifts for this range — there may be older history not shown here. If full history matters for this person, re-run with an earlier end date to pull the older portion separately.']
      });
    }

    var byDate = {};
    var skippedNoCheckIn = 0;
    shifts.forEach(function (s) {
      if (!s.in || !s.in.time) { skippedNoCheckIn++; return; }
      var date = s.in.time.slice(0, 10);
      var clockIn = s.in.time.slice(11, 16);
      var clockOut = (s.out && s.out.time) ? s.out.time.slice(11, 16) : null;
      if (!byDate[date]) byDate[date] = { date: date, clockIn: clockIn, clockOut: clockOut, shiftCount: 1 };
      else {
        var g = byDate[date];
        g.shiftCount++;
        if (clockIn < g.clockIn) g.clockIn = clockIn;
        if (clockOut === null || g.clockOut === null) g.clockOut = null;
        else if (clockOut > g.clockOut) g.clockOut = clockOut;
      }
    });

    var lateAfter = await attendanceService.resolveLateAfter(emp.id);
    var dates = Object.keys(byDate).sort();
    for (var d = 0; d < dates.length; d++) {
      var g = byDate[dates[d]];
      var status = g.clockIn > lateAfter ? 'late' : 'present';
      var existingRes = await pool.query('SELECT status, clock_in, clock_out, source FROM attendance WHERE employee_id = $1 AND date = $2', [emp.id, g.date]);
      var existing = existingRes.rows[0];

      var action, warnings = [];
      if (!existing) {
        action = 'create';
      } else if (existing.source !== 'timestation') {
        action = 'overwrite';
        warnings.push('Replaces an existing ' + existing.source + ' attendance record for this date.');
      } else if ((existing.clock_in ? existing.clock_in.slice(0, 5) : null) === g.clockIn &&
        (existing.clock_out ? existing.clock_out.slice(0, 5) : null) === g.clockOut && existing.status === status) {
        action = 'unchanged';
      } else {
        action = 'update';
      }
      if (g.shiftCount > 1) warnings.push(g.shiftCount + ' separate shifts on this date were merged into one record (earliest in, latest out).');

      out.push({
        employeeId: emp.id, employeeName: emp.first_name + ' ' + emp.last_name, date: g.date,
        clockIn: g.clockIn, clockOut: g.clockOut, status: status, action: action, warnings: warnings
      });
    }
    if (skippedNoCheckIn) {
      out.push({
        employeeId: emp.id, employeeName: emp.first_name + ' ' + emp.last_name, date: null,
        clockIn: null, clockOut: null, status: null, action: 'skip',
        warnings: [skippedNoCheckIn + ' shift(s) in this range have no recorded check-in time on TimeStation — skipped, add manually if needed.']
      });
    }
  }

  out.sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : a.employeeName.localeCompare(b.employeeName); });
  return { rows: out };
}

// kernel.js: handlers['timestation.commitAttendance']
async function commitAttendance(ctx, rows) {
  if (!ctx.can('attendance.adjust')) fail('forbidden', 'Your role does not allow this action (attendance.adjust).');
  if (!Array.isArray(rows) || !rows.length) fail('invalid', 'Nothing to sync.');

  var created = 0, updated = 0, unchanged = 0, failed = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.action === 'skip' || r.action === 'unchanged') { unchanged++; continue; }
    try {
      await pool.query(
        'INSERT INTO attendance (employee_id, date, clock_in, clock_out, status, source, note, adjusted_by) ' +
        "VALUES ($1,$2,$3,$4,$5,'timestation','',NULL) " +
        'ON CONFLICT (employee_id, date) DO UPDATE SET clock_in = $3, clock_out = $4, status = $5, source = \'timestation\', note = \'\', adjusted_by = NULL',
        [r.employeeId, r.date, r.clockIn, r.clockOut, r.status]
      );
      if (r.action === 'create') created++; else updated++;
    } catch (e) {
      failed.push({ name: r.employeeName, date: r.date, reason: e.message || 'Unknown error' });
    }
  }

  await audit(pool, ctx, 'attendance.timestationSync', 'attendance', 'bulk',
    'Synced attendance from TimeStation: ' + created + ' created, ' + updated + ' updated' + (failed.length ? ', ' + failed.length + ' failed' : '') + '.');
  return { created: created, updated: updated, unchanged: unchanged, failed: failed };
}

module.exports = {
  preview: preview, commit: commit, splitName: splitName, deriveDeptCode: deriveDeptCode, idFragOf: idFragOf,
  previewAttendance: previewAttendance, commitAttendance: commitAttendance
};
