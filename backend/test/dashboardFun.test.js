// The OS overview's livelier facts: today's arrivals and who was in first,
// the last seven days, who is online, birthdays and work anniversaries
// coming up, new joiners, and each restaurant's takings by hour. On two
// throwaway employees of its own; always only among the people one may see.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var dashboard = require('../src/services/dashboard.service');
var { buildContext } = require('../src/services/context.service');

var ctx, early, fresh, sbr;
function day(n) { var d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function yearsAgo(n, plusDays) { var d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - n); d.setUTCDate(d.getUTCDate() + plusDays); return d.toISOString().slice(0, 10); }

test.before(async function () {
  ctx = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [ctx.employee.id])).rows[0].department_id;
  early = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, date_of_birth, status, last_seen_at) " +
    "VALUES ('ZQD-1','Zq','Early','zqd.1@example.com',$1,'Tester','permanent',$2,$3,'active', now()) RETURNING id",
    [dept, yearsAgo(2, 3), yearsAgo(30, 2)])).rows[0].id;
  fresh = (await pool.query(
    "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) " +
    "VALUES ('ZQD-2','Zq','Fresh','zqd.2@example.com',$1,'Apprentice','permanent',$2,'active') RETURNING id",
    [dept, day(-5)])).rows[0].id;
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, status) VALUES ($1, CURRENT_DATE, '00:01', 'present')", [early]);
  await pool.query("INSERT INTO attendance (employee_id, date, clock_in, clock_out, status) VALUES ($1, CURRENT_DATE - 1, '09:10', '17:00', 'late')", [fresh]);
  sbr = (await pool.query("SELECT id FROM companies WHERE code = 'SBR'")).rows[0].id;
  await pool.query("INSERT INTO restaurant_orders (company_id, order_no, cashier_id, subtotal, total, status) VALUES ($1, 'D3F-R-1', $2, 90, 90, 'completed')", [sbr, ctx.employee.id]);
});
test.after(async function () {
  await pool.query("DELETE FROM restaurant_orders WHERE order_no LIKE 'D3F-%'");
  await pool.query('DELETE FROM attendance WHERE employee_id = ANY($1)', [[early, fresh]]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [[early, fresh]]);
  await pool.end();
});

test('arrivals, who was in first, and the last seven days', async function () {
  var d = await dashboard.load(ctx);
  assert.equal(d.firstInToday.id, early);
  assert.equal(d.firstInToday.time, '00:01');
  assert.deepEqual(d.arrivals[0], { time: '00:01', late: false });
  assert.equal(d.week.length, 7);
  assert.equal(d.week[6].date, d.today);
  assert.ok(d.week[6].present >= 1);
  assert.ok(d.week[5].late >= 1, 'yesterday someone came in late');
  assert.ok(d.lateList.every(function (p) { return p.id; }) && d.notClockedInList.every(function (p) { return p.id; }), 'people come with their id for the photo');
  assert.ok(d.departments.every(function (g) { return g.id; }));
});

test('online, birthdays and work anniversaries, new joiners, takings by hour', async function () {
  var d = await dashboard.load(ctx);
  assert.ok(d.online.people.some(function (p) { return p.id === early; }));
  var b = d.celebrations.filter(function (c) { return c.id === early && c.kind === 'birthday'; })[0];
  assert.equal(b.daysTo, 2);
  assert.equal(b.years, undefined, 'no ages');
  var a = d.celebrations.filter(function (c) { return c.id === early && c.kind === 'anniversary'; })[0];
  assert.deepEqual([a.daysTo, a.years], [3, 2]);
  var n = d.newJoiners.filter(function (p) { return p.id === fresh; })[0];
  assert.deepEqual([n.hireDate, n.title], [day(-5), 'Apprentice']);
  var r = (await dashboard.load(ctx, 'SBR')).restaurants[0];
  assert.ok(r.byHour.reduce(function (s, h) { return s + h.today; }, 0) >= 90);
});

test('only among the people one may see', async function () {
  var limited = Object.assign({}, ctx, { can: function () { return false; } });
  var d = await dashboard.load(limited);
  assert.equal(d.online.count, 0);
  assert.ok(d.celebrations.every(function (c) { return c.id === ctx.employee.id; }));
  assert.ok(d.newJoiners.every(function (p) { return p.id === ctx.employee.id; }));
  assert.ok(!d.firstInToday || d.firstInToday.id === ctx.employee.id);
  assert.ok(d.arrivals.length <= 1);
});
