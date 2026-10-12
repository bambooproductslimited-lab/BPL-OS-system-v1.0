var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { visibleEmployee } = require('../middleware/rbac');

// Companies are the new top-level org unit — "Group" in the UI becomes
// "Company" (see migration 0032). Departments belong to exactly one
// company; this service returns companies with their departments nested
// (each department carrying its headcount and shift count), matching the
// same "expandable parent → children" shape Catalog uses for
// items/variations, since the frontend reuses that same UI pattern.

async function list(ctx) {
  if (!ctx.can('employee.read')) fail('forbidden', 'Your role does not allow this action (employee.read).');
  var companiesRes = await pool.query('SELECT * FROM companies ORDER BY name');
  var deptsRes = await pool.query(
    'SELECT d.id, d.company_id, d.code, d.name, d.status, d.manager_id, m.first_name AS mgr_first, m.last_name AS mgr_last, ' +
    'm.photo_key AS mgr_photo_key, m.photo_updated_at AS mgr_photo_at, ' +
    '(SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.status = \'active\') AS headcount, ' +
    '(SELECT count(*)::int FROM shifts s WHERE s.department_id = d.id AND s.status = \'active\') AS shift_count ' +
    'FROM departments d LEFT JOIN employees m ON m.id = d.manager_id ORDER BY d.name'
  );
  // The shift times of each department, and how many people each is
  // assigned to, so the page can show them without opening every one.
  var shiftsRes = await pool.query(
    "SELECT s.id, s.department_id, s.name, to_char(s.start_time, 'HH24:MI') AS start_time, to_char(s.end_time, 'HH24:MI') AS end_time, " +
    "(SELECT count(*)::int FROM employees e WHERE e.shift_id = s.id AND e.status <> 'terminated') AS assigned " +
    "FROM shifts s WHERE s.status = 'active' ORDER BY s.start_time, s.name"
  );
  var shiftsByDept = {};
  shiftsRes.rows.forEach(function (s) {
    if (!shiftsByDept[s.department_id]) shiftsByDept[s.department_id] = [];
    shiftsByDept[s.department_id].push({ id: s.id, name: s.name, startTime: s.start_time, endTime: s.end_time, assignedCount: s.assigned });
  });
  var deptsByCompany = {};
  deptsRes.rows.forEach(function (d) {
    if (!deptsByCompany[d.company_id]) deptsByCompany[d.company_id] = [];
    deptsByCompany[d.company_id].push({
      id: d.id, code: d.code, name: d.name, status: d.status,
      managerId: d.manager_id,
      managerName: d.mgr_first ? d.mgr_first + ' ' + d.mgr_last : '—',
      managerPhoto: d.mgr_photo_key && d.mgr_photo_at ? new Date(d.mgr_photo_at).getTime() : null,
      headcount: d.headcount, shiftCount: d.shift_count,
      shifts: shiftsByDept[d.id] || []
    });
  });
  return companiesRes.rows.map(function (c) {
    return { id: c.id, code: c.code, name: c.name, status: c.status, departments: deptsByCompany[c.id] || [] };
  });
}

async function save(ctx, id, p) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var name = V.text(p.name, 'Company name', 80);
  var code = V.text(p.code, 'Code', 8).toUpperCase();

  var res;
  if (id) {
    res = await pool.query('UPDATE companies SET name = $1, code = $2, updated_at = now() WHERE id = $3 RETURNING *', [name, code, id]);
    if (!res.rows[0]) fail('notfound', 'Company not found.');
  } else {
    res = await pool.query("INSERT INTO companies (name, code, status) VALUES ($1,$2,'active') RETURNING *", [name, code]);
  }
  var c = res.rows[0];
  await audit(pool, ctx, 'company.save', 'company', c.id, 'Saved company ' + c.code + ' — ' + c.name + '.');
  return { id: c.id, code: c.code, name: c.name, status: c.status };
}

async function remove(ctx, id) {
  if (!ctx.can('department.manage')) fail('forbidden', 'Your role does not allow this action (department.manage).');
  var res = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
  var c = res.rows[0];
  if (!c) fail('notfound', 'Company not found.');

  var deptCountRes = await pool.query('SELECT count(*)::int AS n FROM departments WHERE company_id = $1', [id]);
  if (deptCountRes.rows[0].n > 0) fail('conflict', 'Cannot delete ' + c.name + ' — it still has department(s). Remove or reassign them first.');

  await pool.query('DELETE FROM companies WHERE id = $1', [id]);
  await audit(pool, ctx, 'company.delete', 'company', id, 'Deleted company ' + c.code + ' — ' + c.name + '.');
  return true;
}

// GET /api/companies/overview — the Companies page: the list above, and
// for each company and department how many are in today (clocked in) and
// still in now, on approved leave today, joined this year, the average
// years with us, the newest and longest-serving person, and a few faces.
// Counts cover everyone (like the list's headcount); names and faces only
// people the caller may see. In-today needs attendance.read.all.
function photoOf(r) { return r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null; }
function years(hire, today) {
  if (!hire) return null;
  return Math.max(0, (new Date(today + 'T00:00:00Z') - new Date(String(hire).slice(0, 10) + 'T00:00:00Z')) / (365.25 * 86400000));
}
async function overview(ctx) {
  var companies = await list(ctx);
  var seeAttendance = ctx.can('attendance.read.all');
  var today = (await pool.query("SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d")).rows[0].d;
  var yearStart = today.slice(0, 4) + '-01-01';
  var q = await Promise.all([
    pool.query("SELECT e.id, e.first_name, e.last_name, e.department_id, e.manager_id, e.photo_key, e.photo_updated_at, " +
      "to_char(e.hire_date, 'YYYY-MM-DD') AS hire_date, e.position_title FROM employees e WHERE e.status = 'active' " +
      'ORDER BY (e.photo_key IS NULL), e.first_name, e.last_name'),
    pool.query("SELECT DISTINCT employee_id FROM leave_requests WHERE status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE"),
    seeAttendance ? pool.query('SELECT employee_id, bool_or(clock_out IS NULL) AS in_now FROM attendance WHERE date = CURRENT_DATE AND clock_in IS NOT NULL GROUP BY employee_id') : { rows: [] }
  ]);
  var onLeave = {}; q[1].rows.forEach(function (r) { onLeave[r.employee_id] = true; });
  var att = {}; q[2].rows.forEach(function (r) { att[r.employee_id] = r.in_now ? 'now' : 'left'; });
  var byDept = {};
  for (var i = 0; i < q[0].rows.length; i++) {
    var r = q[0].rows[i];
    var seen = await visibleEmployee(ctx, { id: r.id, department_id: r.department_id, manager_id: r.manager_id });
    (byDept[r.department_id] = byDept[r.department_id] || []).push({ r: r, seen: seen });
  }
  function facts(people) {
    var withHire = people.filter(function (p) { return p.r.hire_date; });
    // The newest and longest-serving of everyone, named only if the
    // caller may see them.
    var byHire = withHire.slice().sort(function (a, b) { return a.r.hire_date < b.r.hire_date ? -1 : 1; });
    function who(p) { return p && p.seen ? { id: p.r.id, name: p.r.first_name + ' ' + p.r.last_name, photo: photoOf(p.r), hireDate: p.r.hire_date, title: p.r.position_title || '' } : null; }
    return {
      people: people.length,
      inToday: seeAttendance ? people.filter(function (p) { return att[p.r.id]; }).length : null,
      inNow: seeAttendance ? people.filter(function (p) { return att[p.r.id] === 'now'; }).length : null,
      onLeave: people.filter(function (p) { return onLeave[p.r.id]; }).length,
      newThisYear: withHire.filter(function (p) { return p.r.hire_date >= yearStart; }).length,
      averageYears: withHire.length ? Math.round(withHire.reduce(function (s, p) { return s + years(p.r.hire_date, today); }, 0) / withHire.length * 10) / 10 : null,
      newest: who(byHire[byHire.length - 1]),
      longestServing: who(byHire[0])
    };
  }
  var group = [];
  companies.forEach(function (c) {
    var all = [];
    c.departments.forEach(function (d) {
      var people = byDept[d.id] || [];
      all = all.concat(people);
      var f = facts(people);
      d.inToday = f.inToday; d.inNow = f.inNow; d.onLeave = f.onLeave; d.newThisYear = f.newThisYear; d.averageYears = f.averageYears;
      d.faces = people.filter(function (p) { return p.seen; }).slice(0, 6).map(function (p) { return { id: p.r.id, name: p.r.first_name + ' ' + p.r.last_name, photo: photoOf(p.r) }; });
      d.hiddenPeople = people.filter(function (p) { return !p.seen; }).length;
    });
    group = group.concat(all);
    Object.assign(c, facts(all));
  });
  var g = facts(group);
  return {
    today: today, canSeeAttendance: seeAttendance, canManage: ctx.can('department.manage'),
    totals: { companies: companies.length, departments: companies.reduce(function (s, c) { return s + c.departments.length; }, 0), people: g.people, inToday: g.inToday,
      inNow: g.inNow, onLeave: g.onLeave, newThisYear: g.newThisYear, averageYears: g.averageYears, newest: g.newest, longestServing: g.longestServing },
    companies: companies
  };
}

module.exports = { list: list, overview: overview, save: save, remove: remove };
