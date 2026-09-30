var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');

// Merging two records of the same person (for example an account made by
// hand, then the same person again from a TimeStation import). Everything
// that belongs to the duplicate moves to the record being kept: attendance,
// leave, payslips, tasks, chats, approvals and the rest. Details the kept
// record lacks are taken from the duplicate (TimeStation link, kiosk PIN
// and face, photo, phone, shift, pay …). Then the duplicate is removed.
//
// What points at an employee is read from the database itself (every
// foreign key to employees), so a table added later is covered without
// touching this file. Where both records have a row that can only exist
// once (a day of attendance, a chat membership, a leave balance …) the
// kept record's row stays, except:
//   - attendance: a day with clock times beats one without;
//   - leave balances: the days used are added together;
//   - payslips in the same pay run, or two open cash drawers: the merge
//     stops, because one of them would be wrong money.
// One-to-one chats with the same colleague are joined into one; a chat
// between the two records themselves is removed. If both records can sign
// in, the duplicate's login is removed (never the one doing the merge).
// Needs employee.write and user.manage. Previewed first; audited.

function need(ctx) {
  if (!ctx.can('employee.write') || !ctx.can('user.manage')) fail('forbidden', 'Your role does not allow this action (employee.write and user.manage).');
}
function q(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }
function name(e) { return e.first_name + ' ' + e.last_name; }
function directKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

// Every column that points at employees(id), with the unique indexes that
// include it: [{ table, column, uniques: [{ cols: [...], where }] }].
var refsCache = null;
async function references(db) {
  if (refsCache) return refsCache;
  var fks = (await db.query(
    "SELECT cl.relname AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid " +
    "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] " +
    "WHERE c.contype = 'f' AND c.confrelid = 'employees'::regclass AND array_length(c.conkey, 1) = 1 ORDER BY 1, 2")).rows;
  var out = [];
  for (var i = 0; i < fks.length; i++) {
    var f = fks[i];
    var idx = (await db.query(
      'SELECT ix.indexrelid, pg_get_expr(ix.indpred, ix.indrelid) AS pred, ' +
      '(SELECT array_agg(att.attname::text ORDER BY k.n) FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, n) JOIN pg_attribute att ON att.attrelid = ix.indrelid AND att.attnum = k.attnum) AS cols ' +
      'FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid WHERE t.relname = $1 AND ix.indisunique', [f.tbl])).rows;
    out.push({
      table: f.tbl, column: f.col,
      uniques: idx.filter(function (x) { return x.cols && x.cols.indexOf(f.col) >= 0; }).map(function (x) { return { cols: x.cols, where: x.pred }; })
    });
  }
  refsCache = out;
  return out;
}

async function load(db, id, label) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('invalid', 'Choose the ' + label + '.');
  var e = (await db.query('SELECT * FROM employees WHERE id = $1', [id])).rows[0];
  if (!e) fail('notfound', 'The ' + label + ' was not found.');
  return e;
}

// Blanks on the kept record filled from the duplicate. Pairs move together.
var FILL = [
  ['phone'], ['position_title'], ['manager_id'], ['location'], ['shift_id'], ['shift_start', 'shift_end'], ['second_shift_start', 'second_shift_end'],
  ['timestation_employee_id'], ['kiosk_pin_hash', 'kiosk_pin_encrypted'], ['face_descriptor', 'face_enrolled_at', 'face_enrolled_by'],
  ['photo_key', 'photo_updated_at'], ['hourly_rate'], ['basic_salary', 'allowance'], ['ssnit_number'], ['tin'],
  ['language'], ['work_days'], ['leave_days_total']
];
var UNIQUE_FIELDS = ['timestation_employee_id', 'kiosk_pin_hash', 'ssnit_number', 'tin'];
function blank(v) { return v === null || v === undefined || v === '' || (typeof v === 'number' && v === 0); }
function fills(keep, dup) {
  var out = [];
  FILL.forEach(function (group) {
    if (blank(keep[group[0]]) && !blank(dup[group[0]]) && !(group[0] === 'manager_id' && dup.manager_id === keep.id)) out.push(group);
  });
  if (!(Number(keep.daily_rate) > 0) && Number(dup.daily_rate) > 0) out.push(['daily_rate', 'pay_cycle']);
  return out;
}
var FIELD_LABEL = {
  phone: 'phone number', position_title: 'job title', manager_id: 'manager', location: 'location', shift_id: 'shift',
  shift_start: 'shift times', second_shift_start: 'second shift', timestation_employee_id: 'TimeStation link', kiosk_pin_hash: 'kiosk PIN', face_descriptor: 'kiosk face',
  photo_key: 'photo', hourly_rate: 'hourly rate', basic_salary: 'basic salary and allowance', ssnit_number: 'SSNIT number', tin: 'TIN',
  language: 'kiosk language', work_days: 'work week', leave_days_total: 'leave days', daily_rate: 'daily rate and pay cycle'
};

// What would happen: rows that move, per table, and what is taken over.
async function preview(ctx, keepId, dupId) {
  need(ctx);
  var keep = await load(pool, keepId, 'record to keep');
  var dup = await load(pool, dupId, 'duplicate');
  if (keep.id === dup.id) fail('invalid', 'Pick two different records.');
  var refs = await references(pool);
  var moves = [];
  for (var i = 0; i < refs.length; i++) {
    var r = refs[i];
    if (r.table === 'employees') continue;
    var n = (await pool.query('SELECT count(*)::int AS n FROM ' + q(r.table) + ' WHERE ' + q(r.column) + ' = $1', [dup.id])).rows[0].n;
    if (n) moves.push({ table: r.table, column: r.column, rows: n });
  }
  var logins = (await pool.query('SELECT employee_id, email, status, last_login_at FROM users WHERE employee_id = ANY($1)', [[keep.id, dup.id]])).rows;
  var keepLogin = logins.filter(function (u) { return u.employee_id === keep.id; })[0] || null;
  var dupLogin = logins.filter(function (u) { return u.employee_id === dup.id; })[0] || null;
  var clash = await blockers(pool, keep.id, dup.id);
  var sameDays = (await pool.query('SELECT count(*)::int AS n FROM attendance a JOIN attendance b ON b.date = a.date AND b.shift_no = a.shift_no AND b.employee_id = $2 WHERE a.employee_id = $1', [keep.id, dup.id])).rows[0].n;
  var direct = (await pool.query("SELECT count(*)::int AS n FROM conversations WHERE kind = 'direct' AND direct_key = $1", [directKey(keep.id, dup.id)])).rows[0].n;
  return {
    keep: summary(keep), duplicate: summary(dup),
    moves: moves,
    takes: fills(keep, dup).map(function (g) { return FIELD_LABEL[g[0]] || g[0]; }),
    logins: { keep: keepLogin && { email: keepLogin.email, status: keepLogin.status }, duplicate: dupLogin && { email: dupLogin.email, status: dupLogin.status } },
    loginRemoved: !!(keepLogin && dupLogin),
    loginMoves: !keepLogin && !!dupLogin,
    sameAttendanceDays: sameDays,
    chatBetweenThemRemoved: direct > 0,
    blockers: clash,
    isYou: ctx.employee.id === dup.id
  };
}
function summary(e) {
  return { id: e.id, code: e.code, name: name(e), email: e.email, status: e.status, positionTitle: e.position_title || '', hireDate: e.hire_date, timestation: !!e.timestation_employee_id };
}

// Things the merge won't guess about.
async function blockers(db, keepId, dupId) {
  var out = [];
  var runs = (await db.query(
    'SELECT pr.run_no FROM payslips a JOIN payslips b ON b.pay_run_id = a.pay_run_id AND b.employee_id = $2 JOIN pay_runs pr ON pr.id = a.pay_run_id WHERE a.employee_id = $1', [keepId, dupId])).rows;
  if (runs.length) out.push('Both records are paid in pay run ' + runs.map(function (r) { return r.run_no; }).join(', ') + '. Delete that run if it is a draft, or remove one of the payslips, then merge.');
  var drawers = (await db.query("SELECT count(*)::int AS n FROM restaurant_drawer_sessions WHERE status = 'open' AND cashier_id = ANY($1)", [[keepId, dupId]])).rows[0].n;
  if (drawers > 1) out.push('Both records have a cash drawer open at the till. Close one first.');
  return out;
}

async function merge(ctx, keepId, dupId) {
  need(ctx);
  var removedFiles = [];
  var result = await withTransaction(async function (client) {
    var keep = await load(client, keepId, 'record to keep');
    var dup = await load(client, dupId, 'duplicate');
    if (keep.id === dup.id) fail('invalid', 'Pick two different records.');
    if (ctx.employee.id === dup.id) fail('invalid', 'You are signed in as the record that would be removed. Keep the one you sign in with.');
    var stop = await blockers(client, keep.id, dup.id);
    if (stop.length) fail('conflict', stop.join(' '));
    // Serialise merges of these two people.
    await client.query('SELECT id FROM employees WHERE id = ANY($1) FOR UPDATE', [[keep.id, dup.id]]);
    var K = keep.id, D = dup.id;
    var moved = 0;

    // Logins: move the duplicate's if the kept record has none; if both
    // have one, the duplicate's is removed (its roles and codes with it).
    var logins = (await client.query('SELECT id, employee_id, email FROM users WHERE employee_id = ANY($1)', [[K, D]])).rows;
    var dupLogin = logins.filter(function (u) { return u.employee_id === D; })[0];
    var keepLogin = logins.filter(function (u) { return u.employee_id === K; })[0];
    if (dupLogin && keepLogin) {
      // Its history in the audit log is kept, under the login that stays.
      await client.query('UPDATE audit_logs SET actor_user_id = $1 WHERE actor_user_id = $2', [keepLogin.id, dupLogin.id]);
      await client.query('DELETE FROM users WHERE id = $1', [dupLogin.id]);
    }

    // One-to-one chats: with the same colleague → one chat; between the two → removed.
    var directs = (await client.query("SELECT id, direct_key, last_message_at FROM conversations WHERE kind = 'direct' AND (split_part(direct_key, '|', 1) = $1 OR split_part(direct_key, '|', 2) = $1)", [D])).rows;
    for (var i = 0; i < directs.length; i++) {
      var c = directs[i];
      var parts = c.direct_key.split('|');
      var peer = parts[0] === D ? parts[1] : parts[0];
      if (peer === K) { await client.query('DELETE FROM conversations WHERE id = $1', [c.id]); continue; }
      var other = (await client.query('SELECT id FROM conversations WHERE direct_key = $1', [directKey(K, peer)])).rows[0];
      if (other) {
        await client.query('UPDATE messages SET conversation_id = $2 WHERE conversation_id = $1', [c.id, other.id]);
        await client.query('UPDATE conversations SET last_message_at = greatest(last_message_at, $2), updated_at = clock_timestamp() WHERE id = $1', [other.id, c.last_message_at]);
        await client.query('DELETE FROM conversations WHERE id = $1', [c.id]);
      } else {
        await client.query('UPDATE conversations SET direct_key = $2 WHERE id = $1', [c.id, directKey(K, peer)]);
      }
    }

    // Attendance: on a day both have, a day with clock times wins.
    await client.query(
      'DELETE FROM attendance k USING attendance d WHERE k.employee_id = $1 AND d.employee_id = $2 AND d.date = k.date AND d.shift_no = k.shift_no AND k.clock_in IS NULL AND d.clock_in IS NOT NULL', [K, D]);
    // Leave balances: the days used add up.
    await client.query(
      'UPDATE leave_balances k SET used = k.used + d.used, entitled = greatest(k.entitled, d.entitled) FROM leave_balances d ' +
      'WHERE k.employee_id = $1 AND d.employee_id = $2 AND d.leave_type_id = k.leave_type_id AND d.year = k.year', [K, D]);

    // Every other reference, table by table. A row that can exist only
    // once per person, and which the kept record already has, is dropped.
    var refs = await references(client);
    for (var r = 0; r < refs.length; r++) {
      var ref = refs[r];
      if (ref.table === 'employees') continue;
      var t = q(ref.table), col = q(ref.column);
      for (var u = 0; u < ref.uniques.length; u++) {
        var uq = ref.uniques[u];
        // Rules that hold only sometimes (one open cash drawer each) are checked in blockers().
        if (uq.where) continue;
        var others = uq.cols.filter(function (x) { return x !== ref.column; });
        var match = others.map(function (x) { return 'k.' + q(x) + ' IS NOT DISTINCT FROM d.' + q(x); });
        await client.query('DELETE FROM ' + t + ' d WHERE d.' + col + ' = $2 AND EXISTS (SELECT 1 FROM ' + t + ' k WHERE k.' + col + ' = $1' +
          (match.length ? ' AND ' + match.join(' AND ') : '') + ')', [K, D]);
      }
      var res = await client.query('UPDATE ' + t + ' SET ' + col + ' = $1 WHERE ' + col + ' = $2', [K, D]);
      moved += res.rowCount;
    }
    // Ids kept in lists rather than links.
    await client.query("UPDATE messages SET mentions = array(SELECT DISTINCT unnest(array_replace(mentions, $2::uuid, $1::uuid))) WHERE $2::uuid = ANY(mentions)", [K, D]);
    await client.query("UPDATE crm_site_visits SET assessor_ids = array(SELECT DISTINCT unnest(array_replace(assessor_ids, $2::uuid, $1::uuid))) WHERE $2::uuid = ANY(assessor_ids)", [K, D]);
    // Other employees who reported to the duplicate now report to the kept record (done above via manager_id).
    await client.query('UPDATE employees SET manager_id = $1 WHERE manager_id = $2 AND id <> $1', [K, D]);
    await client.query('UPDATE employees SET face_enrolled_by = $1 WHERE face_enrolled_by = $2', [K, D]);

    // Details the kept record lacks. Unique ones are freed from the duplicate first.
    var take = fills(keep, dup);
    var freed = UNIQUE_FIELDS.filter(function (f) { return take.some(function (g) { return g.indexOf(f) >= 0; }); });
    if (freed.length) await client.query('UPDATE employees SET ' + freed.map(function (f) { return q(f) + ' = NULL'; }).join(', ') + ' WHERE id = $1', [D]);
    if (take.length) {
      var sets = [], vals = [K];
      take.forEach(function (g) { g.forEach(function (f) { vals.push(dup[f]); sets.push(q(f) + ' = $' + vals.length); }); });
      await client.query('UPDATE employees SET ' + sets.join(', ') + ', updated_at = now() WHERE id = $1', vals);
    }
    // The earlier start date is the real one.
    if (dup.hire_date && (!keep.hire_date || dup.hire_date < keep.hire_date)) await client.query('UPDATE employees SET hire_date = $2 WHERE id = $1', [K, dup.hire_date]);
    await client.query('UPDATE employees SET manager_id = NULL WHERE id = $1 AND manager_id = $1', [K]);
    if (dup.photo_key && !take.some(function (g) { return g[0] === 'photo_key'; })) removedFiles.push(dup.photo_key);

    await client.query('DELETE FROM employees WHERE id = $1', [D]);
    await audit(client, ctx, 'employee.merge', 'employee', K,
      'Merged ' + name(dup) + ' (' + dup.code + ', ' + dup.email + ') into ' + name(keep) + ' (' + keep.code + '): ' + moved + ' linked rows moved' +
      (take.length ? '; took ' + take.map(function (g) { return FIELD_LABEL[g[0]] || g[0]; }).join(', ') : '') +
      (dupLogin && keepLogin ? '; removed the duplicate\'s login ' + dupLogin.email : dupLogin ? '; moved its login ' + dupLogin.email : '') + '.');
    return { kept: summary(keep), moved: moved, took: take.map(function (g) { return FIELD_LABEL[g[0]] || g[0]; }) };
  });
  for (var f = 0; f < removedFiles.length; f++) await fileStore.del(removedFiles[f]);
  return result;
}

module.exports = { preview: preview, merge: merge };
