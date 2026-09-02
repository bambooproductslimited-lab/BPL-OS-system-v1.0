var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { visibleEmployee, fetchEmployeeById } = require('../middleware/rbac');

function todayISO() { return new Date().toISOString().slice(0, 10); }
function nowHM() { return new Date().toTimeString().slice(0, 5); }

// The OS now spans several businesses with genuinely different shifts (via
// the TimeStation sync — factory, restaurant, security, construction crew,
// etc.), so lateness can no longer be judged against one company-wide clock
// time. Priority: the employee's assigned shift template (employees.shift_id
// -> shifts.start_time — set per company/department, see migration 0032),
// then a personal shift_start override (employees.shift_start, predates the
// shift catalogue but still supported), then the old company-wide fallback
// — settings.late_after, unchanged for anyone with neither.
var LATE_GRACE_MINUTES = 20; // matches the historical default (shift 07:00, late after 07:20)
function addMinutesToHM(hm, minutes) {
  var parts = hm.split(':').map(Number);
  var total = ((parts[0] * 60 + parts[1] + minutes) % 1440 + 1440) % 1440;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
async function resolveLateAfter(employeeId) {
  var empRes = await pool.query(
    'SELECT e.shift_start, s.start_time AS shift_tpl_start FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1',
    [employeeId]
  );
  var row = empRes.rows[0];
  var shiftStart = row && (row.shift_tpl_start || row.shift_start) ? String(row.shift_tpl_start || row.shift_start).slice(0, 5) : null;
  if (shiftStart) return addMinutesToHM(shiftStart, LATE_GRACE_MINUTES);
  var settingsRes = await pool.query('SELECT late_after FROM settings WHERE id = 1');
  return settingsRes.rows[0] ? settingsRes.rows[0].late_after.slice(0, 5) : '07:20';
}

// The kiosk's offline queue (see KioskPage.jsx) replays a tap after
// reconnecting, potentially well after it actually happened — resolving to
// "now" at sync time would record the wrong clock-in time (and the wrong
// late/present status) for the whole outage. occurredAt lets a caller pass
// the real tap time through; every other caller (the live kiosk tap, and
// the web "clock myself in" button) omits it and gets the server's own
// authoritative now(), exactly as before. Bounded so a stale/never-flushed
// queue entry can't backdate attendance indefinitely — offline outages of
// longer than two weeks need a manual attendance.adjust correction instead.
var MAX_BACKDATE_MS = 14 * 24 * 60 * 60 * 1000;
var FUTURE_SKEW_MS = 5 * 60 * 1000; // small clock-skew tolerance
function resolveOccurredAt(occurredAt) {
  if (!occurredAt) return { date: todayISO(), time: nowHM() };
  var d = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (isNaN(d.getTime())) fail('invalid', 'Invalid timestamp.');
  var deltaMs = Date.now() - d.getTime();
  if (deltaMs < -FUTURE_SKEW_MS) fail('invalid', 'That timestamp is in the future.');
  if (deltaMs > MAX_BACKDATE_MS) fail('invalid', 'That timestamp is too old to sync automatically — ask HR to adjust attendance manually.');
  return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5) };
}

// The kiosk device's browser reports its GPS fix on each clock event (see
// KioskPage.jsx) — a plain {lat, lng, accuracy} object, unauthenticated and
// client-supplied, so it's range-checked and any junk (missing, wrong
// shape, out-of-range) is quietly dropped to null rather than failing the
// clock event over it. accuracy is in meters, straight from the browser's
// Geolocation API; not range-checked since any non-negative number is
// meaningful (a kiosk indoors can easily report accuracy in the hundreds
// of meters).
function sanitizeLocation(loc) {
  if (!loc || typeof loc !== 'object') return null;
  var lat = Number(loc.lat), lng = Number(loc.lng);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  var accuracy = Number(loc.accuracy);
  return { lat: lat, lng: lng, accuracy: isFinite(accuracy) && accuracy >= 0 ? accuracy : null };
}

// clockInEmployee/clockOutEmployee — the actual attendance-row logic,
// factored out from clockIn/clockOut below (which are the ctx-based, "I am
// clocking myself in from the web app" handlers) so the kiosk service can
// drive the exact same business rules for a PIN-identified employee,
// tagged with source='kiosk' instead of 'web'. Neither takes ctx or does a
// permission check — that's the caller's job (clockIn/clockOut check
// attendance.self; kiosk.service.js's PIN match is its own gate). location
// is only ever populated by the kiosk; clockIn/clockOut (the web "clock
// myself in" handlers below) don't collect it, so it's simply null there.
async function clockInEmployee(employeeId, source, occurredAt, location) {
  var resolved = resolveOccurredAt(occurredAt);
  var existing = await pool.query('SELECT id FROM attendance WHERE employee_id = $1 AND date = $2', [employeeId, resolved.date]);
  if (existing.rows[0]) fail('conflict', 'Already clocked in today.');

  var lateAfter = await resolveLateAfter(employeeId);
  var status = resolved.time > lateAfter ? 'late' : 'present';

  var res = await pool.query(
    'INSERT INTO attendance (employee_id, date, clock_in, status, source, clock_in_location) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [employeeId, resolved.date, resolved.time, status, source, sanitizeLocation(location)]
  );
  return res.rows[0];
}

async function clockOutEmployee(employeeId, occurredAt, location) {
  var resolved = resolveOccurredAt(occurredAt);
  var res = await pool.query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [employeeId, resolved.date]);
  var rec = res.rows[0];
  if (!rec) fail('conflict', 'Not clocked in today.');
  if (rec.clock_out) fail('conflict', 'Already clocked out today.');

  var updated = await pool.query(
    'UPDATE attendance SET clock_out = $1, clock_out_location = $2 WHERE id = $3 RETURNING *',
    [resolved.time, sanitizeLocation(location), rec.id]
  );
  return updated.rows[0];
}

// kernel.js: handlers['attendance.clockIn']
async function clockIn(ctx) {
  if (!ctx.can('attendance.self')) fail('forbidden', 'Your role does not allow this action (attendance.self).');
  var rec = await clockInEmployee(ctx.employee.id, 'web');
  await audit(pool, ctx, 'attendance.clockIn', 'attendance', rec.id, 'Clocked in at ' + rec.clock_in.slice(0, 5) + (rec.status === 'late' ? ' (late).' : '.'));
  return rowToAttendance(rec);
}

// kernel.js: handlers['attendance.clockOut']
async function clockOut(ctx) {
  if (!ctx.can('attendance.self')) fail('forbidden', 'Your role does not allow this action (attendance.self).');
  var rec = await clockOutEmployee(ctx.employee.id);
  await audit(pool, ctx, 'attendance.clockOut', 'attendance', rec.id, 'Clocked out at ' + rec.clock_out.slice(0, 5) + '.');
  return rowToAttendance(rec);
}

// Shared by list() and report(): everyone visible to ctx, joined with their
// department (and its company) so a caller can filter by companyId/
// departmentId — the Companies/Departments tier added in migration 0032.
// "mine" (no attendance.read.all) ignores both filters, same as before —
// there's only ever one row in that case, the caller's own — but still
// joins departments/companies for it, so the self-view keeps showing a real
// department/company name instead of ctx.employee's bare department_id.
async function scopedEmployees(ctx, filters) {
  var canAll = ctx.can('attendance.read.all');
  var baseQuery =
    'SELECT e.id, e.department_id, e.manager_id, e.code, e.first_name, e.last_name, d.name AS department_name, d.company_id, c.name AS company_name ' +
    'FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id ' +
    "WHERE e.status != 'terminated'";
  if (!canAll) {
    var selfRes = await pool.query(baseQuery + ' AND e.id = $1', [ctx.employee.id]);
    return selfRes.rows;
  }
  var empRes = await pool.query(baseQuery);
  var out = [];
  for (var i = 0; i < empRes.rows.length; i++) {
    var e = empRes.rows[i];
    if (filters && filters.companyId && e.company_id !== filters.companyId) continue;
    if (filters && filters.departmentId && e.department_id !== filters.departmentId) continue;
    if (await visibleEmployee(ctx, e)) out.push(e);
  }
  return out;
}

// kernel.js: handlers['attendance.list']
async function list(ctx, params) {
  var date = (params && params.date) || todayISO();
  var scopeEmployees = await scopedEmployees(ctx, params);

  var attRes = await pool.query('SELECT * FROM attendance WHERE date = $1', [date]);
  var byEmp = {};
  attRes.rows.forEach(function (r) { byEmp[r.employee_id] = r; });

  return {
    date: date,
    scopeSize: scopeEmployees.length,
    rows: scopeEmployees.map(function (e) {
      var r = byEmp[e.id];
      return {
        id: r ? r.id : null, employeeId: e.id, name: e.first_name + ' ' + e.last_name, code: e.code,
        department: e.department_name || '—', company: e.company_name || '—',
        clockIn: r ? r.clock_in : null, clockOut: r ? r.clock_out : null,
        clockInLocation: r ? r.clock_in_location : null, clockOutLocation: r ? r.clock_out_location : null,
        status: r ? r.status : 'absent', note: r ? r.note : ''
      };
    })
  };
}

var MAX_REPORT_RANGE_DAYS = 5 * 365; // sanity bound (catches a typo'd year), not a real operational limit

// kernel.js: handlers['attendance.report'] — every actual attendance record
// in the range, not a per-day roster like list() (no synthesized "absent"
// placeholder rows for days with nothing recorded — a report should show
// what's really in the table, not an assumption about what "should" have
// happened). Same visibility scoping as list(): attendance.read.all sees
// everyone in reach, otherwise just your own record.
async function report(ctx, from, to, filters) {
  from = V.date(from, 'From date');
  to = V.date(to, 'To date');
  if (to < from) fail('invalid', 'To date must be on or after from date.');
  var rangeDays = Math.round((new Date(to + 'T00:00') - new Date(from + 'T00:00')) / 86400000) + 1;
  if (rangeDays > MAX_REPORT_RANGE_DAYS) fail('invalid', 'That date range looks like a mistake (over ' + Math.round(MAX_REPORT_RANGE_DAYS / 365) + ' years) — check the dates.');

  var scopeEmployees = await scopedEmployees(ctx, filters);
  var ids = scopeEmployees.map(function (e) { return e.id; });
  if (!ids.length) return { from: from, to: to, rows: [] };

  var empById = {};
  scopeEmployees.forEach(function (e) { empById[e.id] = e; });

  var attRes = await pool.query(
    'SELECT * FROM attendance WHERE employee_id = ANY($1) AND date BETWEEN $2 AND $3 ORDER BY date, employee_id',
    [ids, from, to]
  );

  return {
    from: from, to: to,
    rows: attRes.rows.map(function (r) {
      var e = empById[r.employee_id];
      return {
        employeeId: r.employee_id, code: e.code, name: e.first_name + ' ' + e.last_name,
        department: e.department_name || '—', company: e.company_name || '—',
        date: r.date, clockIn: r.clock_in ? r.clock_in.slice(0, 5) : null, clockOut: r.clock_out ? r.clock_out.slice(0, 5) : null,
        clockInLocation: r.clock_in_location, clockOutLocation: r.clock_out_location,
        status: r.status, source: r.source, note: r.note
      };
    })
  };
}

// kernel.js: handlers['attendance.adjust']
async function adjust(ctx, p) {
  if (!ctx.can('attendance.adjust')) fail('forbidden', 'Your role does not allow this action (attendance.adjust).');

  var rec;
  if (p.id) {
    var res = await pool.query('SELECT * FROM attendance WHERE id = $1', [p.id]);
    rec = res.rows[0];
  }
  if (!rec) {
    var emp = await fetchEmployeeById(p.employeeId);
    if (!emp) fail('notfound', 'Employee not found.');
    var date = V.date(p.date, 'Date');
    var insertRes = await pool.query(
      "INSERT INTO attendance (employee_id, date, status, source) VALUES ($1,$2,'present','adjustment') RETURNING *",
      [emp.id, date]
    );
    rec = insertRes.rows[0];
  }

  var status = p.status ? V.oneOf(p.status, ['present', 'late', 'absent', 'leave', 'off'], 'Status') : rec.status;
  var note = V.text(p.note, 'Reason for the correction', 200);

  var updated = await pool.query(
    'UPDATE attendance SET clock_in = COALESCE($1, clock_in), clock_out = COALESCE($2, clock_out), status = $3, note = $4, adjusted_by = $5 WHERE id = $6 RETURNING *',
    [p.clockIn !== undefined ? (p.clockIn || null) : rec.clock_in, p.clockOut !== undefined ? (p.clockOut || null) : rec.clock_out, status, note, ctx.employee.id, rec.id]
  );

  await audit(pool, ctx, 'attendance.adjust', 'attendance', rec.id, 'Corrected attendance for ' + rec.date + ': ' + note);
  return rowToAttendance(updated.rows[0]);
}

// kernel.js: handlers['attendance.delete']
async function remove(ctx, id) {
  if (!ctx.can('attendance.adjust')) fail('forbidden', 'Your role does not allow this action (attendance.adjust).');
  var res = await pool.query('SELECT * FROM attendance WHERE id = $1', [id]);
  var rec = res.rows[0];
  if (!rec) fail('notfound', 'Attendance record not found.');
  await pool.query('DELETE FROM attendance WHERE id = $1', [id]);
  await audit(pool, ctx, 'attendance.delete', 'attendance', id, 'Deleted attendance record for ' + rec.date + '.');
  return true;
}

function rowToAttendance(r) {
  return {
    id: r.id, employeeId: r.employee_id, date: r.date,
    clockIn: r.clock_in ? r.clock_in.slice(0, 5) : null, clockOut: r.clock_out ? r.clock_out.slice(0, 5) : null,
    clockInLocation: r.clock_in_location, clockOutLocation: r.clock_out_location,
    status: r.status, source: r.source, note: r.note, adjustedBy: r.adjusted_by
  };
}

module.exports = {
  clockIn: clockIn, clockOut: clockOut, list: list, adjust: adjust, remove: remove, rowToAttendance: rowToAttendance,
  clockInEmployee: clockInEmployee, clockOutEmployee: clockOutEmployee, resolveOccurredAt: resolveOccurredAt,
  resolveLateAfter: resolveLateAfter, report: report
};
