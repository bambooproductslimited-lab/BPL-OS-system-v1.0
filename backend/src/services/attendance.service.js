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
function hmToMinutes(hm) {
  var parts = hm.split(':').map(Number);
  return parts[0] * 60 + parts[1];
}
// Bamboo Products Limited runs a Mon-Sat week — Sunday is a paid rest day
// for its staff, EXCEPT the Security department, which (like both
// restaurants, Star Bar and Bamboo Garden) is staffed every day of the
// week. A rest day only matters when there's no actual attendance record
// for it — someone who did clock in on their rest day keeps whatever
// their real record says (e.g. still shows late if they came in late).
var BPL_COMPANY_NAME = 'Bamboo Products Limited';
var SECURITY_DEPARTMENT_NAME = 'Security';
function isRestDay(companyName, departmentName, dateISO) {
  if (companyName !== BPL_COMPANY_NAME) return false;
  if (departmentName === SECURITY_DEPARTMENT_NAME) return false;
  return new Date(dateISO + 'T00:00').getDay() === 0; // Sunday
}

async function resolveLateAfter(employeeId) {
  return (await resolveLateRule(employeeId)).cutoff;
}

// The cutoff, plus where it came from — which decides how a tap is compared
// against it. Two genuinely different things wear the same HH:MM hat:
//
//   a shift cutoff is a point RELATIVE to that employee's own shift start,
//   and the shift may run through midnight;
//
//   the settings.late_after fallback is an ABSOLUTE time of day applied
//   company-wide to people who have no shift to be measured against.
//
// Only the first of those wraps.
async function resolveLateRule(employeeId) {
  var empRes = await pool.query(
    'SELECT e.shift_start, s.start_time AS shift_tpl_start FROM employees e LEFT JOIN shifts s ON s.id = e.shift_id WHERE e.id = $1',
    [employeeId]
  );
  var row = empRes.rows[0];
  var shiftStart = row && (row.shift_tpl_start || row.shift_start) ? String(row.shift_tpl_start || row.shift_start).slice(0, 5) : null;
  if (shiftStart) {
    return { cutoff: addMinutesToHM(shiftStart, LATE_GRACE_MINUTES), shiftStart: shiftStart };
  }
  var settingsRes = await pool.query('SELECT late_after FROM settings WHERE id = 1');
  return {
    cutoff: settingsRes.rows[0] ? settingsRes.rows[0].late_after.slice(0, 5) : '07:20',
    shiftStart: null
  };
}

// Late or present, and by how many minutes.
//
// Comparing the two clock strings directly is what this replaces, and it
// was wrong in both directions for anyone whose shift crosses midnight. A
// guard due at 18:00 has a cutoff of 18:20; turning up at 01:00 — seven
// hours late — compares '01:00' > '18:20', which is false, and recorded as
// present. Every evening and night shift in the company under-reported
// lateness the moment the clock passed midnight. The mirror image, a shift
// starting at 23:50 whose cutoff falls at 00:10 the next day, would have
// marked an on-time arrival as 1,420 minutes late; no shift template starts
// that late today, but the arithmetic below covers it either way.
//
// The tap is placed relative to the shift start, wrapped into
// [-12h, +12h) — beyond half a day either way there is no honest answer to
// which shift a tap belongs to, and the pairing rules, not this, decide
// that. Early is never late, however early.
function judgeLateness(rule, tapHM) {
  if (!rule.shiftStart) {
    // No shift: an absolute daily cutoff, compared as it always was.
    var late = tapHM > rule.cutoff;
    return {
      status: late ? 'late' : 'present',
      minutesLate: late ? Math.max(0, hmToMinutes(tapHM) - hmToMinutes(rule.cutoff)) : 0
    };
  }
  var offset = hmToMinutes(tapHM) - hmToMinutes(rule.shiftStart);
  if (offset >= 720) offset -= 1440;
  if (offset < -720) offset += 1440;
  if (offset <= LATE_GRACE_MINUTES) return { status: 'present', minutesLate: 0 };
  return { status: 'late', minutesLate: offset - LATE_GRACE_MINUTES };
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

  // Minutes past the late cutoff itself (not the shift's raw start time) —
  // the same value that decides 'late' vs 'present', so "5 minutes late"
  // always means 5 minutes past the point that actually matters, whether
  // that came from a shift template's grace period or the company-wide
  // settings.late_after fallback. Not persisted (attendance has no column
  // for it) — computed fresh for the kiosk's own result screen, which is
  // the only thing that currently reads it.
  var judged = judgeLateness(await resolveLateRule(employeeId), resolved.time);
  var status = judged.status;
  var minutesLate = judged.minutesLate;

  var res = await pool.query(
    'INSERT INTO attendance (employee_id, date, clock_in, status, source, clock_in_location) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [employeeId, resolved.date, resolved.time, status, source, sanitizeLocation(location)]
  );
  return Object.assign(res.rows[0], { minutesLate: minutesLate });
}

// Beyond this, the recorded shift is longer than anyone actually worked and
// almost certainly a forgotten tap-out paired with the next tap-in. It is
// still recorded — refusing would leave the row open forever — but flagged
// so a supervisor sees it rather than it passing as a 20-hour night.
var IMPLAUSIBLE_SHIFT_HOURS = 16;

// The employee's shift that is still running: the most recent row with a
// clock-in and no clock-out.
//
// There is no time limit on this by design. A shift that is not clocked out
// keeps running until somebody clocks it out, however long that takes, and
// the hours read accordingly. A tap-in that was never followed by a tap-out
// is therefore never quietly abandoned — it stays open, visible, and closes
// on the next tap. Shifts that ran implausibly long are flagged on the row
// (see below) so a supervisor can correct them.
//
// Only the upper bound remains: a shift cannot be closed by a tap that
// happened before it started, which matters because the kiosk's offline
// queue can replay a tap long after the fact.
//
// This replaces looking the row up by today's date, which is what broke
// night shifts. A guard starting 18:00 on Tuesday and finishing 06:00 on
// Wednesday taps twice on two different dates; keyed on the date, the second
// tap found no row for Wednesday and opened a second shift instead of
// closing Tuesday's. Keyed on what is actually open, both taps belong to the
// same shift and it does not matter which side of midnight they fall.
async function findOpenShift(employeeId, atISO) {
  var res = await pool.query(
    'SELECT * FROM attendance ' +
    'WHERE employee_id = $1 AND clock_in IS NOT NULL AND clock_out IS NULL ' +
    '  AND (date + clock_in) <= $2::timestamp ' +
    'ORDER BY (date + clock_in) DESC LIMIT 1',
    [employeeId, atISO]
  );
  return res.rows[0] || null;
}

function hoursBetween(startISO, endISO) {
  return (new Date(endISO).getTime() - new Date(startISO).getTime()) / 3600000;
}

async function clockOutEmployee(employeeId, occurredAt, location) {
  var resolved = resolveOccurredAt(occurredAt);
  var at = resolved.date + 'T' + resolved.time + ':00';
  var rec = await findOpenShift(employeeId, at);
  if (!rec) fail('conflict', 'No shift is open to clock out of.');

  var openedAt = String(rec.date).slice(0, 10) + 'T' + String(rec.clock_in).slice(0, 8);
  var ran = hoursBetween(openedAt, at);
  var note = rec.note;
  if (ran > IMPLAUSIBLE_SHIFT_HOURS) {
    var flag = 'Shift recorded as ' + ran.toFixed(1) + ' hours — check whether a clock-out was missed.';
    note = note ? note + ' ' + flag : flag;
  }

  var updated = await pool.query(
    'UPDATE attendance SET clock_out = $1, clock_out_date = $2, clock_out_location = $3, note = $4 WHERE id = $5 RETURNING *',
    [
      resolved.time,
      // Only recorded when it differs from the day the shift opened, so a
      // day shift's row is unchanged from how it has always looked.
      resolved.date === String(rec.date).slice(0, 10) ? null : resolved.date,
      sanitizeLocation(location), note, rec.id
    ]
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
    'SELECT e.id, e.department_id, e.manager_id, e.code, e.first_name, e.last_name, e.position_title, e.hourly_rate, ' +
    'd.name AS department_name, d.company_id, c.name AS company_name ' +
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
        status: r ? r.status : (isRestDay(e.company_name, e.department_name, date) ? 'off' : 'absent'), note: r ? r.note : ''
      };
    })
  };
}

var MAX_REPORT_RANGE_DAYS = 5 * 365; // sanity bound (catches a typo'd year), not a real operational limit

// kernel.js: handlers['attendance.report'] — one row per scoped employee per
// calendar day in the range, same "no record on a day = absent, unless it's
// that employee's rest day (see isRestDay), in which case it's off" rule
// list() already applies to a single day, now extended across the whole
// range: a gap in the attendance table reads as a real absence (or a rest
// day) rather than being left out of the report entirely. Same visibility
// scoping as list(): attendance.read.all sees everyone in reach, otherwise
// just your own record.
async function report(ctx, from, to, filters) {
  from = V.date(from, 'From date');
  to = V.date(to, 'To date');
  if (to < from) fail('invalid', 'To date must be on or after from date.');
  var rangeDays = Math.round((new Date(to + 'T00:00') - new Date(from + 'T00:00')) / 86400000) + 1;
  if (rangeDays > MAX_REPORT_RANGE_DAYS) fail('invalid', 'That date range looks like a mistake (over ' + Math.round(MAX_REPORT_RANGE_DAYS / 365) + ' years) — check the dates.');

  var scopeEmployees = await scopedEmployees(ctx, filters);
  var ids = scopeEmployees.map(function (e) { return e.id; });
  // Returned as an explicit flag rather than left for the caller to infer
  // from whether any row happens to carry hourlyRate — an empty result set
  // (no records in range) would otherwise look identical to "no payroll
  // access" and silently mislabel a real permission as a data gap.
  var canSeeHourlyRate = ctx.can('payroll.manage');
  if (!ids.length) return { from: from, to: to, rows: [], canViewPay: canSeeHourlyRate };

  var attRes = await pool.query(
    'SELECT * FROM attendance WHERE employee_id = ANY($1) AND date BETWEEN $2 AND $3 ORDER BY date, employee_id',
    [ids, from, to]
  );
  var recordByEmpDate = {};
  attRes.rows.forEach(function (r) { recordByEmpDate[r.employee_id + '|' + r.date] = r; });

  var dates = [];
  for (var d = new Date(from + 'T00:00'); d <= new Date(to + 'T00:00'); d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  // hourlyRate is compensation data — same payroll.manage gate as
  // employees.service.js's rowToEmployee(), omitted from the payload
  // entirely (not just hidden client-side) for anyone without it. The
  // TimeStation-style pivot report's Total Pay column blanks out when this
  // is absent.
  var rows = [];
  scopeEmployees.forEach(function (e) {
    dates.forEach(function (date) {
      var r = recordByEmpDate[e.id + '|' + date];
      var row = {
        employeeId: e.id, code: e.code, name: e.first_name + ' ' + e.last_name, positionTitle: e.position_title || '',
        department: e.department_name || '—', company: e.company_name || '—',
        date: date, clockIn: r && r.clock_in ? r.clock_in.slice(0, 5) : null, clockOut: r && r.clock_out ? r.clock_out.slice(0, 5) : null,
        clockInLocation: r ? r.clock_in_location : null, clockOutLocation: r ? r.clock_out_location : null,
        status: r ? r.status : (isRestDay(e.company_name, e.department_name, date) ? 'off' : 'absent'), source: r ? r.source : null, note: r ? r.note : ''
      };
      if (canSeeHourlyRate) row.hourlyRate = e.hourly_rate == null ? null : Number(e.hourly_rate);
      rows.push(row);
    });
  });

  return { from: from, to: to, canViewPay: canSeeHourlyRate, rows: rows };
}

// ── who has no shift, and what that does to their attendance ─────────────
//
// Lateness is judged against the employee's own shift start plus grace. With
// no shift there is nothing to judge against, so it falls back to the
// company-wide settings.late_after — a day-shift cutoff. Against that, a
// guard arriving on time at 18:00 records as 640 minutes late, and one
// arriving at 01:00 records as present.
//
// So this is not a tidiness report. Until it is empty, every lateness figure
// in the system includes people it is measuring against the wrong clock, and
// the lateness report below says so rather than quietly averaging them in.
async function unassignedShifts(ctx, filters) {
  if (!ctx.can('attendance.read.all')) fail('forbidden', 'Your role does not allow this action (attendance.read.all).');
  var employees = await scopedEmployees(ctx, filters);
  var settingsRes = await pool.query('SELECT late_after FROM settings WHERE id = 1');
  var fallback = settingsRes.rows[0] ? String(settingsRes.rows[0].late_after).slice(0, 5) : '07:20';

  var out = [];
  for (var i = 0; i < employees.length; i++) {
    var e = employees[i];
    var r = await pool.query(
      'SELECT COALESCE(s.start_time, emp.shift_start) AS starts FROM employees emp ' +
      'LEFT JOIN shifts s ON s.id = emp.shift_id WHERE emp.id = $1', [e.id]);
    if (r.rows[0] && r.rows[0].starts) continue;
    // How many recorded days this has already mis-scored, so the list is
    // ordered by what it is actually costing rather than alphabetically.
    //
    // Recomputed against the fallback cutoff rather than counting rows whose
    // stored status is 'late'. The stored value is whatever was decided when
    // the tap happened — including rows written before the midnight-wrap fix
    // — so counting it made this report disagree with the lateness report
    // about the same person on the same days.
    var days = await pool.query(
      'SELECT clock_in FROM attendance WHERE employee_id = $1 AND clock_in IS NOT NULL', [e.id]);
    var rule = { cutoff: fallback, shiftStart: null };
    var mis = days.rows.filter(function (r) {
      return judgeLateness(rule, String(r.clock_in).slice(0, 5)).status === 'late';
    }).length;
    out.push({
      employeeId: e.id, code: e.code, name: e.first_name + ' ' + e.last_name,
      positionTitle: e.position_title, department: e.department_name, company: e.company_name,
      daysRecorded: days.rows.length, lateRecords: mis
    });
  }
  out.sort(function (a, b) { return b.lateRecords - a.lateRecords || a.code.localeCompare(b.code); });
  return { fallbackCutoff: fallback, rows: out };
}

// ── lateness ─────────────────────────────────────────────────────────────
//
// late/present and the minutes behind it are decided on every clock-in and
// then never looked at again — there is no lateness report anywhere. This is
// it: per employee over a date range, with the days and the minutes.
//
// Anyone with no shift is included but marked, never silently averaged in.
// Their minutes are measured against a cutoff that does not describe their
// working day, so counting them in a department average would make the
// average meaningless without ever showing why.
async function latenessReport(ctx, from, to, filters) {
  if (!ctx.can('attendance.read.all')) fail('forbidden', 'Your role does not allow this action (attendance.read.all).');
  var start = V.date(from, 'From date');
  var end = V.date(to, 'To date');
  if (end < start) fail('invalid', 'The end date comes before the start date.');

  var employees = await scopedEmployees(ctx, filters);
  if (!employees.length) return { from: start, to: end, rows: [], totals: { late: 0, present: 0, minutes: 0 } };

  var ids = employees.map(function (e) { return e.id; });
  var att = await pool.query(
    'SELECT a.employee_id, a.date, a.clock_in, a.status, ' +
    '       COALESCE(s.start_time, e.shift_start) AS shift_start, s.name AS shift_name ' +
    'FROM attendance a JOIN employees e ON e.id = a.employee_id ' +
    'LEFT JOIN shifts s ON s.id = e.shift_id ' +
    'WHERE a.employee_id = ANY($1::uuid[]) AND a.date BETWEEN $2 AND $3 AND a.clock_in IS NOT NULL',
    [ids, start, end]);

  var settingsRes = await pool.query('SELECT late_after FROM settings WHERE id = 1');
  var fallback = settingsRes.rows[0] ? String(settingsRes.rows[0].late_after).slice(0, 5) : '07:20';

  var byEmp = {};
  employees.forEach(function (e) {
    byEmp[e.id] = {
      employeeId: e.id, code: e.code, name: e.first_name + ' ' + e.last_name,
      positionTitle: e.position_title, department: e.department_name, company: e.company_name,
      shiftName: null, hasShift: false, daysRecorded: 0, daysLate: 0, minutesLate: 0,
      worstMinutes: 0, worstDate: null
    };
  });

  att.rows.forEach(function (r) {
    var row = byEmp[r.employee_id];
    if (!row) return;
    row.daysRecorded += 1;
    if (r.shift_start) { row.hasShift = true; row.shiftName = r.shift_name || null; }
    // Recomputed from the shift rather than read off status, so a row stored
    // before the midnight-wrap fix is scored the same way as a new one.
    var rule = r.shift_start
      ? { cutoff: addMinutesToHM(String(r.shift_start).slice(0, 5), LATE_GRACE_MINUTES), shiftStart: String(r.shift_start).slice(0, 5) }
      : { cutoff: fallback, shiftStart: null };
    var judged = judgeLateness(rule, String(r.clock_in).slice(0, 5));
    if (judged.status === 'late') {
      row.daysLate += 1;
      row.minutesLate += judged.minutesLate;
      if (judged.minutesLate > row.worstMinutes) {
        row.worstMinutes = judged.minutesLate;
        row.worstDate = String(r.date).slice(0, 10);
      }
    }
  });

  var rows = Object.keys(byEmp).map(function (k) { return byEmp[k]; })
    .filter(function (r) { return r.daysRecorded > 0; });
  rows.forEach(function (r) {
    r.averageMinutesLate = r.daysLate ? Math.round(r.minutesLate / r.daysLate) : 0;
    r.latePercent = r.daysRecorded ? Math.round((r.daysLate / r.daysRecorded) * 1000) / 10 : 0;
  });
  rows.sort(function (a, b) { return b.minutesLate - a.minutesLate || a.code.localeCompare(b.code); });

  // Totals cover only people the figures actually describe.
  var scored = rows.filter(function (r) { return r.hasShift; });
  return {
    from: start, to: end, fallbackCutoff: fallback,
    rows: rows,
    totals: {
      employees: scored.length,
      withoutShift: rows.length - scored.length,
      daysRecorded: scored.reduce(function (n, r) { return n + r.daysRecorded; }, 0),
      daysLate: scored.reduce(function (n, r) { return n + r.daysLate; }, 0),
      minutesLate: scored.reduce(function (n, r) { return n + r.minutesLate; }, 0)
    }
  };
}

// kernel.js: handlers['attendance.adjust']
//
// No visibleEmployee() scoping on the target employee here — a security
// review confirmed this is intentional, not an oversight: attendance.adjust
// is only ever granted to hr_manager/finance_hr_manager/general_manager
// (see referenceData.js's ROLE_DEFS), all three explicitly company-wide
// with no department restriction. department_manager — the one role that
// IS restricted to one department — gets attendance.read.all but not
// attendance.adjust. If that ever changes (attendance.adjust attached to a
// narrower role), add a visibleEmployee(ctx, emp) check back in here —
// without it, that would silently become the same class of IDOR already
// fixed elsewhere (see documents.service.js/tasks.service.js).
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
// Same "no visibleEmployee() scoping — confirmed intentional, re-check if
// attendance.adjust's role grants ever change" note as adjust() above.
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
  findOpenShift: findOpenShift, hoursBetween: hoursBetween,
  clockIn: clockIn, clockOut: clockOut, list: list, adjust: adjust, remove: remove, rowToAttendance: rowToAttendance,
  clockInEmployee: clockInEmployee, clockOutEmployee: clockOutEmployee, resolveOccurredAt: resolveOccurredAt,
  resolveLateAfter: resolveLateAfter, resolveLateRule: resolveLateRule, judgeLateness: judgeLateness,
  unassignedShifts: unassignedShifts, latenessReport: latenessReport,
  report: report
};
