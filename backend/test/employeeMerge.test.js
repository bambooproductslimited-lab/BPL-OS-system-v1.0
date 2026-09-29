// Merging two records of the same person (employeeMerge.service.js): an
// account made by hand, then the same person again from TimeStation. All
// that belongs to the duplicate moves to the kept record, blanks are filled
// from it, clashes resolve sensibly, and the duplicate is gone.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var merge = require('../src/services/employeeMerge.service');
var { buildContext } = require('../src/services/context.service');

var boss, K, D, peer, dept, keepUser, dupUser, other;
async function cleanup() {
  await pool.query("DELETE FROM conversations WHERE name = 'Zqm group' OR direct_key LIKE ANY (SELECT '%' || id || '%' FROM employees WHERE code LIKE 'ZQM-%')");
  await pool.query("DELETE FROM tasks WHERE title LIKE 'Zqm %'");
  await pool.query("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE code LIKE 'ZQM-%')");
  await pool.query("DELETE FROM users WHERE email LIKE 'zqm.%'");
  await pool.query("UPDATE employees SET manager_id = NULL WHERE manager_id IN (SELECT id FROM employees WHERE code LIKE 'ZQM-%')");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZQM-%'");
}
async function emp(code, email, extra) {
  var cols = ['code', 'first_name', 'last_name', 'email', 'department_id', 'hire_date', 'status', 'employment_type'];
  var vals = [code, 'Zqm', 'Kelvin', email, dept, extra.hire || '2024-01-01', 'active', 'permanent'];
  Object.keys(extra).filter(function (k) { return k !== 'hire'; }).forEach(function (k) { cols.push(k); vals.push(extra[k]); });
  return (await pool.query('INSERT INTO employees (' + cols.join(',') + ') VALUES (' + vals.map(function (_, i) { return '$' + (i + 1); }).join(',') + ') RETURNING id', vals)).rows[0].id;
}
async function user(empId, email) {
  var hash = (await pool.query('SELECT password_hash FROM users LIMIT 1')).rows[0].password_hash;
  return (await pool.query("INSERT INTO users (employee_id, email, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id", [empId, email, hash])).rows[0].id;
}
async function count(sql, args) { return (await pool.query(sql, args)).rows[0].n; }

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  await cleanup();
  dept = (await pool.query("SELECT d.id FROM departments d JOIN companies c ON c.id = d.company_id WHERE c.code = 'BPL' LIMIT 1")).rows[0].id;
  K = await emp('ZQM-1', 'zqm.admin@example.com', { hire: '2025-06-01' });
  D = await emp('ZQM-2', 'zqm.ts@example.com', { hire: '2023-02-01', phone: '0240001111', timestation_employee_id: 'zqm-ts-77', kiosk_pin_hash: 'zqm-pin-hash', daily_rate: 150, pay_cycle: 'monthly', ssnit_number: 'ZQM000000001' });
  peer = await emp('ZQM-3', 'zqm.peer@example.com', { manager_id: D });
  keepUser = await user(K, 'zqm.admin@example.com');
  dupUser = await user(D, 'zqm.ts@example.com');
  await pool.query("INSERT INTO audit_logs (actor_user_id, actor_name, action, entity, entity_id, summary) VALUES ($1, 'Zqm', 'zqm.test', 'employee', $2, 'Zqm history')", [dupUser, D]);

  // Attendance: 2 days only on the duplicate; one day on both (kept has no clock, duplicate has).
  await pool.query("INSERT INTO attendance (employee_id, date, status, clock_in) VALUES ($1, '2019-05-06', 'present', '08:00'), ($1, '2019-05-07', 'present', '08:05'), ($1, '2019-05-08', 'late', '08:40')", [D]);
  await pool.query("INSERT INTO attendance (employee_id, date, status) VALUES ($1, '2019-05-08', 'absent')", [K]);
  // Leave: a request and balances of the same type and year on both.
  var lt = (await pool.query('SELECT id FROM leave_types LIMIT 1')).rows[0].id;
  await pool.query("INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, status) VALUES ($1, $2, '2019-06-03', '2019-06-04', 2, 'approved')", [D, lt]);
  await pool.query('INSERT INTO leave_balances (employee_id, leave_type_id, year, entitled, used) VALUES ($1, $3, 2019, 20, 3), ($2, $3, 2019, 15, 2)', [K, D, lt]);
  // A task assigned to both.
  var t = (await pool.query("INSERT INTO tasks (title, priority, status, created_by) VALUES ('Zqm task', 'medium', 'not_started', $1) RETURNING id", [D])).rows[0].id;
  await pool.query('INSERT INTO task_assignees (task_id, employee_id) VALUES ($1, $2), ($1, $3)', [t, K, D]);
  // Chats: both have a one-to-one chat with the peer; a chat between the two; a group with both.
  var key = function (a, b) { return a < b ? a + '|' + b : b + '|' + a; };
  var c1 = (await pool.query("INSERT INTO conversations (kind, direct_key, last_message_at) VALUES ('direct', $1, now()) RETURNING id", [key(K, peer)])).rows[0].id;
  var c2 = (await pool.query("INSERT INTO conversations (kind, direct_key, last_message_at) VALUES ('direct', $1, now()) RETURNING id", [key(D, peer)])).rows[0].id;
  var c3 = (await pool.query("INSERT INTO conversations (kind, direct_key, last_message_at) VALUES ('direct', $1, now()) RETURNING id", [key(K, D)])).rows[0].id;
  var g = (await pool.query("INSERT INTO conversations (kind, name, last_message_at) VALUES ('group', 'Zqm group', now()) RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO conversation_members (conversation_id, employee_id) VALUES ($1,$3),($1,$5),($2,$4),($2,$5),($6,$3),($6,$4),($7,$3),($7,$4),($7,$5)', [c1, c2, K, D, peer, c3, g]);
  await pool.query("INSERT INTO messages (from_id, to_id, body, conversation_id) VALUES ($1, $2, 'Zqm to peer from admin', $3), ($4, $2, 'Zqm to peer from ts', $5), ($2, $4, 'Zqm reply to ts', $5)", [K, peer, c1, D, c2]);
  await pool.query("INSERT INTO messages (from_id, body, conversation_id, mentions) VALUES ($1, 'Zqm @both', $2, ARRAY[$3::uuid, $1::uuid])", [peer, g, D]);
  other = { c1: c1, c2: c2, c3: c3, g: g, t: t, lt: lt };
});
test.after(async function () { await cleanup(); await pool.end(); });

test('the preview says what would move, and needs employee.write and user.manage', async function () {
  var p = await merge.preview(boss, K, D);
  assert.equal(p.keep.code, 'ZQM-1');
  assert.equal(p.duplicate.timestation, true);
  var att = p.moves.find(function (m) { return m.table === 'attendance'; });
  assert.equal(att.rows, 3);
  assert.ok(p.takes.indexOf('TimeStation link') >= 0 && p.takes.indexOf('kiosk PIN') >= 0 && p.takes.indexOf('phone number') >= 0 && p.takes.indexOf('SSNIT number') >= 0);
  assert.equal(p.loginRemoved, true);
  assert.equal(p.sameAttendanceDays, 1);
  assert.equal(p.chatBetweenThemRemoved, true);
  assert.deepEqual(p.blockers, []);
  var hr = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { can: function (x) { return x !== 'user.manage' && boss.can(x); } });
  await assert.rejects(merge.preview(hr, K, D), /user.manage/);
  await assert.rejects(merge.preview(boss, K, K), /two different/);
});

test('a shared pay run stops the merge', async function () {
  var run = (await pool.query("INSERT INTO pay_runs (run_no, cycle, period_start, period_end, pay_date, status, created_by) VALUES ('ZQM-RUN', 'monthly', '2019-01-01', '2019-01-31', '2019-02-05', 'draft', $1) RETURNING id", [K])).rows[0].id;
  await pool.query('INSERT INTO payslips (pay_run_id, employee_id, days_worked, daily_rate, gross_pay, ssnit_employee, ssnit_employer, taxable_income, paye_tax, net_pay) VALUES ($1,$2,0,0,0,0,0,0,0,0), ($1,$3,0,0,0,0,0,0,0,0)', [run, K, D]);
  assert.equal((await merge.preview(boss, K, D)).blockers.length, 1);
  await assert.rejects(merge.merge(boss, K, D), /ZQM-RUN/);
  await pool.query('DELETE FROM payslips WHERE pay_run_id = $1', [run]);
  await pool.query('DELETE FROM pay_runs WHERE id = $1', [run]);
});

test('merging moves everything, fills blanks, resolves clashes, and removes the duplicate', async function () {
  var r = await merge.merge(boss, K, D);
  assert.ok(r.moved > 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM employees WHERE id = $1', [D]), 0);
  var k = (await pool.query('SELECT * FROM employees WHERE id = $1', [K])).rows[0];
  assert.equal(k.timestation_employee_id, 'zqm-ts-77');
  assert.equal(k.kiosk_pin_hash, 'zqm-pin-hash');
  assert.equal(k.phone, '0240001111');
  assert.equal(k.ssnit_number, 'ZQM000000001');
  assert.equal(Number(k.daily_rate), 150);
  assert.equal(String(k.hire_date).slice(0, 10), '2023-02-01', 'the earlier start date');
  assert.equal(k.email, 'zqm.admin@example.com', 'the kept record keeps its own email');
  // Attendance: 3 days, the clashing day keeps the clocked one.
  var att = (await pool.query("SELECT to_char(date, 'YYYY-MM-DD') AS d, status FROM attendance WHERE employee_id = $1 ORDER BY date", [K])).rows;
  assert.deepEqual(att.map(function (a) { return a.d + ' ' + a.status; }), ['2019-05-06 present', '2019-05-07 present', '2019-05-08 late']);
  // Leave: the request moved; the balance adds the days used.
  assert.equal(await count('SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1', [K]), 1);
  var bal = (await pool.query('SELECT entitled, used FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND year = 2019', [K, other.lt])).rows;
  assert.equal(bal.length, 1);
  assert.deepEqual([Number(bal[0].entitled), Number(bal[0].used)], [20, 5]);
  // The task: one assignee now, and the kept record made it.
  assert.equal(await count('SELECT count(*)::int AS n FROM task_assignees WHERE task_id = $1', [other.t]), 1);
  assert.equal((await pool.query('SELECT created_by FROM tasks WHERE id = $1', [other.t])).rows[0].created_by, K);
  // Chats: one chat with the peer holding all three messages; the chat between them gone; the group has them once.
  assert.equal(await count('SELECT count(*)::int AS n FROM conversations WHERE id = ANY($1)', [[other.c2, other.c3]]), 0);
  assert.equal(await count('SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1', [other.c1]), 3);
  assert.equal(await count('SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1', [other.g]), 2);
  assert.deepEqual((await pool.query('SELECT mentions FROM messages WHERE conversation_id = $1', [other.g])).rows[0].mentions.sort(), [K, peer].sort());
  // The peer reports to the kept record now.
  assert.equal((await pool.query('SELECT manager_id FROM employees WHERE id = $1', [peer])).rows[0].manager_id, K);
  // Logins: the duplicate's is gone, its history is under the kept login.
  assert.equal(await count('SELECT count(*)::int AS n FROM users WHERE id = $1', [dupUser]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'zqm.test' AND actor_user_id = $1", [keepUser]), 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'employee.merge' AND entity_id = $1", [K]), 1);
  await pool.query("DELETE FROM audit_logs WHERE action IN ('zqm.test') OR (action = 'employee.merge' AND entity_id = $1)", [K]);
});

test('you can\'t merge away the record you are signed in as', async function () {
  var me = await emp('ZQM-4', 'zqm.me@example.com', {});
  var ctx = Object.assign(Object.create(Object.getPrototypeOf(boss)), boss, { employee: Object.assign({}, boss.employee, { id: me }) });
  await assert.rejects(merge.merge(ctx, K, me), /signed in as/);
});
