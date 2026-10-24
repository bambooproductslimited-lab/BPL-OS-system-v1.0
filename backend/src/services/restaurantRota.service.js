var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// The restaurant's rota (migration 0184) — Square's shift scheduling: who
// works when, week by week, planned by a manager in the till's back office
// (POST /api/pos/settings/rota). A shift is a person, a day, a start and an
// end (past midnight when it ends before it starts), and what they do. The
// week is planned in draft; published, each person on it is told their
// shifts, and the till shows who is on today. A shift changed after the week
// was published waits to be published again. Copied from last week in one
// go. The planned hours and what they cost sit beside the sales of the same
// days last week, so the week is planned against the work there is.

var ROLES = ['Cashier', 'Waiter', 'Kitchen', 'Bar', 'Manager', 'Cleaner', 'Delivery'];
function who(m) { return { user: { id: null }, employee: { first_name: m.first_name, last_name: m.last_name } }; }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function dayOf(d) { return d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null; }
function addDays(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function isDay(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !isNaN(new Date(v + 'T00:00:00Z')); }
function isTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')); }
function mins(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
// Hours of a shift; past midnight when it ends before it starts.
function hoursOf(starts, ends) { var a = mins(starts), b = mins(ends); return round2(((b > a ? b : b + 1440) - a) / 60); }
// The Monday of the week a day is in.
function mondayOf(day) { var d = new Date((isDay(day) ? day : new Date().toISOString().slice(0, 10)) + 'T00:00:00Z'); var k = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - k); return d.toISOString().slice(0, 10); }
function today() { return new Date().toISOString().slice(0, 10); }

function shiftOut(r) {
  return { id: r.id, employeeId: r.employee_id, name: r.first_name ? r.first_name + ' ' + r.last_name : '', day: dayOf(r.day), starts: String(r.starts).slice(0, 5), ends: String(r.ends).slice(0, 5),
    hours: hoursOf(String(r.starts).slice(0, 5), String(r.ends).slice(0, 5)), role: r.role, note: r.note, published: r.published };
}
// What an hour of a person costs: their hourly rate, else a day's pay over 8, else a month's over 26 × 8.
function rateOf(e) {
  return Number(e.hourly_rate) > 0 ? Number(e.hourly_rate) : Number(e.daily_rate) > 0 ? Number(e.daily_rate) / 8 : Number(e.basic_salary) > 0 ? Number(e.basic_salary) / 208 : null;
}

async function staff(companyId) { return require('./restaurantTillAccess.service').staffOf(companyId); }

// The week: its shifts, the people, the planned hours and their cost, and
// the sales of the same days last week.
async function week(companyId, weekOf) {
  var from = mondayOf(weekOf), to = addDays(from, 6);
  var rows = (await pool.query(
    'SELECT s.*, e.first_name, e.last_name, e.hourly_rate, e.daily_rate, e.basic_salary FROM restaurant_rota_shifts s JOIN employees e ON e.id = s.employee_id ' +
    'WHERE s.company_id = $1 AND s.day BETWEEN $2 AND $3 ORDER BY s.day, s.starts, e.first_name', [companyId, from, to])).rows;
  var people = await staff(companyId);
  var cost = 0, noRate = 0, perPerson = {};
  var shifts = rows.map(function (r) {
    var s = shiftOut(r), rate = rateOf(r);
    if (rate == null) noRate++; else cost += rate * s.hours;
    perPerson[s.employeeId] = round2((perPerson[s.employeeId] || 0) + s.hours);
    return s;
  });
  var sales = (await pool.query(
    "SELECT o.created_at::date AS day, coalesce(sum(o.total - o.refunded_total), 0) AS net FROM restaurant_orders o " +
    "WHERE o.company_id = $1 AND o.status = 'completed' AND o.created_at::date BETWEEN $2 AND $3 GROUP BY 1", [companyId, addDays(from, -7), addDays(to, -7)])).rows;
  var lastWeek = {};
  sales.forEach(function (r) { lastWeek[addDays(dayOf(r.day), 7)] = round2(r.net); });
  var days = [];
  for (var i = 0; i < 7; i++) {
    var d = addDays(from, i);
    var on = shifts.filter(function (s) { return s.day === d; });
    days.push({ day: d, people: on.length, hours: round2(on.reduce(function (a, s) { return a + s.hours; }, 0)), salesLastWeek: lastWeek[d] || 0 });
  }
  var hours = round2(shifts.reduce(function (a, s) { return a + s.hours; }, 0));
  var salesLast = round2(days.reduce(function (a, d) { return a + d.salesLastWeek; }, 0));
  var templates = (await pool.query(
    "SELECT DISTINCT s.name, s.start_time, s.end_time FROM shifts s JOIN departments d ON d.id = s.department_id WHERE d.company_id = $1 AND s.status = 'active' ORDER BY s.start_time", [companyId])).rows
    .map(function (t) { return { name: t.name, starts: String(t.start_time).slice(0, 5), ends: String(t.end_time).slice(0, 5) }; });
  return {
    weekStart: from, weekEnd: to, today: today(), roles: ROLES, templates: templates,
    staff: people.map(function (p) { return Object.assign({}, p, { hours: perPerson[p.id] || 0 }); }),
    shifts: shifts, days: days, hours: hours, cost: round2(cost), noRate: noRate,
    drafts: shifts.filter(function (s) { return !s.published; }).length,
    salesLastWeek: salesLast, salesPerHour: hours > 0 && salesLast > 0 ? round2(salesLast / hours) : null,
    costShare: salesLast > 0 && cost > 0 ? round2(cost / salesLast * 100) : null
  };
}

async function checkPerson(db, companyId, employeeId) {
  var ok = (await staff(companyId)).some(function (p) { return p.id === employeeId; });
  if (!ok) fail('invalid', 'That person does not work at this restaurant.');
}

async function save(companyId, m, p) {
  var s = p.shift || {};
  if (!isDay(s.day)) fail('invalid', 'Which day?');
  if (!isTime(s.starts) || !isTime(s.ends)) fail('invalid', 'Give the start and the end, like 08:00 and 16:30.');
  if (s.starts === s.ends) fail('invalid', 'A shift ends after it starts.');
  if (hoursOf(s.starts, s.ends) > 16) fail('invalid', 'A shift is 16 hours at most.');
  await checkPerson(pool, companyId, s.employeeId);
  var role = text(s.role, 30), note = text(s.note, 200);
  return withTransaction(async function (db) {
    // The same person twice at once is a mistake.
    var clash = (await db.query(
      'SELECT starts, ends FROM restaurant_rota_shifts WHERE company_id = $1 AND employee_id = $2 AND day = $3 AND id IS DISTINCT FROM $4', [companyId, s.employeeId, s.day, s.id || null])).rows
      .find(function (o) {
        var a1 = mins(s.starts), a2 = a1 + hoursOf(s.starts, s.ends) * 60, b1 = mins(String(o.starts).slice(0, 5)), b2 = b1 + hoursOf(String(o.starts).slice(0, 5), String(o.ends).slice(0, 5)) * 60;
        return a1 < b2 && b1 < a2;
      });
    if (clash) fail('conflict', 'They already work ' + String(clash.starts).slice(0, 5) + '–' + String(clash.ends).slice(0, 5) + ' that day.');
    var row;
    if (s.id) {
      row = (await db.query(
        'UPDATE restaurant_rota_shifts SET employee_id = $3, day = $4, starts = $5, ends = $6, role = $7, note = $8, published = false, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *',
        [s.id, companyId, s.employeeId, s.day, s.starts, s.ends, role, note])).rows[0];
      if (!row) fail('notfound', 'That shift is gone.');
    } else {
      row = (await db.query(
        'INSERT INTO restaurant_rota_shifts (company_id, employee_id, day, starts, ends, role, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [companyId, s.employeeId, s.day, s.starts, s.ends, role, note, m.id])).rows[0];
    }
    return row;
  });
}

async function remove(companyId, id) {
  var r = await pool.query('DELETE FROM restaurant_rota_shifts WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!r.rowCount) fail('notfound', 'That shift is gone.');
}

// Last week's shifts into this one, a week on: those not there already.
async function copyLast(companyId, m, weekOf) {
  var from = mondayOf(weekOf);
  var last = (await pool.query('SELECT * FROM restaurant_rota_shifts WHERE company_id = $1 AND day BETWEEN $2 AND $3', [companyId, addDays(from, -7), addDays(from, -1)])).rows;
  if (!last.length) fail('invalid', 'Last week has no shifts to copy.');
  var n = 0;
  for (var i = 0; i < last.length; i++) {
    var s = last[i], day = addDays(dayOf(s.day), 7);
    var there = (await pool.query('SELECT 1 FROM restaurant_rota_shifts WHERE company_id = $1 AND employee_id = $2 AND day = $3 AND starts = $4', [companyId, s.employee_id, day, s.starts])).rows[0];
    if (there) continue;
    await pool.query('INSERT INTO restaurant_rota_shifts (company_id, employee_id, day, starts, ends, role, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [companyId, s.employee_id, day, s.starts, s.ends, s.role, s.note, m.id]);
    n++;
  }
  return n;
}

var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// The week out: drafts published, and each person told their shifts.
async function publish(companyId, m, weekOf) {
  var from = mondayOf(weekOf), to = addDays(from, 6);
  var rows = (await pool.query(
    'UPDATE restaurant_rota_shifts SET published = true, updated_at = now() WHERE company_id = $1 AND day BETWEEN $2 AND $3 AND NOT published RETURNING employee_id',
    [companyId, from, to])).rows;
  if (!rows.length) fail('invalid', 'Nothing new to publish this week.');
  var told = Array.from(new Set(rows.map(function (r) { return r.employee_id; })));
  var co = (await pool.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
  for (var i = 0; i < told.length; i++) {
    var mine = (await pool.query('SELECT day, starts, ends, role FROM restaurant_rota_shifts WHERE company_id = $1 AND employee_id = $2 AND day BETWEEN $3 AND $4 ORDER BY day, starts', [companyId, told[i], from, to])).rows;
    var lines = mine.map(function (s) { var d = new Date(dayOf(s.day) + 'T00:00:00Z'); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ': ' + String(s.starts).slice(0, 5) + '–' + String(s.ends).slice(0, 5) + (s.role ? ' (' + s.role + ')' : ''); });
    await notify(pool, told[i], '📅 Your shifts at ' + (co ? co.name : 'the restaurant') + ', week of ' + from, lines.join(' · ') || 'No shifts this week.', null);
  }
  await audit(pool, who(m), 'restaurant.rota_publish', 'company', companyId, 'Published the rota for the week of ' + from + ': ' + rows.length + ' shift(s), ' + told.length + ' people told.');
  return { published: rows.length, told: told.length };
}

// ---- swaps ---------------------------------------------------------------
// Someone offers a shift of theirs on the till; a colleague takes it; a
// manager approves (the shift becomes the colleague's) or declines. The
// managers are told when a shift is taken, both people when it is decided.

function swapOut(r) {
  return { id: r.id, status: r.status, note: r.note, shift: { id: r.shift_id, day: dayOf(r.day), starts: String(r.starts).slice(0, 5), ends: String(r.ends).slice(0, 5), role: r.role },
    offeredBy: { id: r.offered_by, name: r.o_first + ' ' + r.o_last }, takenBy: r.taken_by ? { id: r.taken_by, name: r.t_first + ' ' + r.t_last } : null, createdAt: r.created_at };
}
var SWAP_SELECT = 'SELECT w.*, s.day, s.starts, s.ends, s.role, o.first_name AS o_first, o.last_name AS o_last, t.first_name AS t_first, t.last_name AS t_last ' +
  'FROM restaurant_shift_swaps w JOIN restaurant_rota_shifts s ON s.id = w.shift_id JOIN employees o ON o.id = w.offered_by LEFT JOIN employees t ON t.id = w.taken_by ';
async function managersOf(companyId) {
  return (await pool.query("SELECT employee_id AS id FROM restaurant_till_staff WHERE company_id = $1 AND role = 'manager'", [companyId])).rows.map(function (r) { return r.id; });
}
async function nameOf(id) { var e = (await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [id])).rows[0]; return e ? e.first_name + ' ' + e.last_name : ''; }
function shiftWords(r) { var d = new Date(dayOf(r.day) + 'T00:00:00Z'); return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + String(r.starts).slice(0, 5) + '–' + String(r.ends).slice(0, 5); }

// The swaps waiting on someone, for the manager's rota.
async function swapsOpen(companyId) {
  return (await pool.query(SWAP_SELECT + "WHERE w.company_id = $1 AND w.status IN ('open', 'taken') AND s.day >= $2 ORDER BY (w.status = 'taken') DESC, s.day, s.starts", [companyId, today()])).rows.map(swapOut);
}

// POST /api/pos/rota/swaps { action: 'mine' | 'offer' | 'take' | 'cancel', shiftId, swapId, note } — anyone signed in.
async function swaps(companyId, employeeId, p) {
  p = p || {};
  var action = p.action || 'mine';
  if (action === 'offer') {
    var sh = (await pool.query('SELECT * FROM restaurant_rota_shifts WHERE id = $1 AND company_id = $2', [p.shiftId, companyId])).rows[0];
    if (!sh || sh.employee_id !== employeeId) fail('forbidden', 'Only your own shifts can be offered.');
    if (!sh.published) fail('conflict', 'That shift is not on the published rota yet.');
    if (dayOf(sh.day) < today()) fail('conflict', 'That shift has passed.');
    var made = await pool.query("INSERT INTO restaurant_shift_swaps (company_id, shift_id, offered_by, note) VALUES ($1, $2, $3, $4) ON CONFLICT (shift_id) WHERE status IN ('open', 'taken') DO NOTHING RETURNING id",
      [companyId, sh.id, employeeId, text(p.note, 200)]);
    if (!made.rowCount) fail('conflict', 'That shift is offered already.');
  } else if (action === 'take' || action === 'cancel') {
    var w = (await pool.query(SWAP_SELECT + 'WHERE w.id = $1 AND w.company_id = $2', [p.swapId, companyId])).rows[0];
    if (!w) fail('notfound', 'That swap is gone.');
    if (action === 'cancel') {
      if (w.offered_by !== employeeId) fail('forbidden', 'Only who offered it can take it back.');
      if (['open', 'taken'].indexOf(w.status) < 0) fail('conflict', 'That swap is decided already.');
      await pool.query("UPDATE restaurant_shift_swaps SET status = 'cancelled', decided_at = now() WHERE id = $1", [w.id]);
    } else {
      if (w.offered_by === employeeId) fail('invalid', 'That is your own shift.');
      if (dayOf(w.day) < today()) fail('conflict', 'That shift has passed.');
      var clash = (await pool.query('SELECT starts, ends FROM restaurant_rota_shifts WHERE company_id = $1 AND employee_id = $2 AND day = $3', [companyId, employeeId, w.day])).rows
        .find(function (o) { return overlaps(String(w.starts).slice(0, 5), String(w.ends).slice(0, 5), String(o.starts).slice(0, 5), String(o.ends).slice(0, 5)); });
      if (clash) fail('conflict', 'You already work ' + String(clash.starts).slice(0, 5) + '–' + String(clash.ends).slice(0, 5) + ' that day.');
      var took = await pool.query("UPDATE restaurant_shift_swaps SET status = 'taken', taken_by = $2 WHERE id = $1 AND status = 'open' RETURNING id", [w.id, employeeId]);
      if (!took.rowCount) fail('conflict', 'Someone took it first.');
      var taker = await nameOf(employeeId);
      var mgrs = await managersOf(companyId);
      for (var i = 0; i < mgrs.length; i++) await notify(pool, mgrs[i], '🔁 ' + taker + ' would take ' + w.o_first + ' ' + w.o_last + '\'s shift', shiftWords(w) + '. Approve it in the rota.', null);
      await notify(pool, w.offered_by, '🔁 ' + taker + ' would take your shift', shiftWords(w) + '. A manager approves it.', null);
    }
  } else if (action !== 'mine') fail('invalid', 'Unknown action.');
  var mine = (await pool.query('SELECT * FROM restaurant_rota_shifts WHERE company_id = $1 AND employee_id = $2 AND published AND day BETWEEN $3 AND $4 ORDER BY day, starts', [companyId, employeeId, today(), addDays(today(), 27)])).rows.map(shiftOut);
  var live = (await pool.query(SWAP_SELECT + "WHERE w.company_id = $1 AND w.status IN ('open', 'taken') AND s.day >= $2 ORDER BY s.day, s.starts", [companyId, today()])).rows.map(swapOut);
  return {
    mine: mine.map(function (s) { var w2 = live.find(function (x) { return x.shift.id === s.id; }); return Object.assign(s, { swap: w2 ? { id: w2.id, status: w2.status, takenBy: w2.takenBy } : null }); }),
    open: live.filter(function (x) { return x.status === 'open' && x.offeredBy.id !== employeeId; }),
    waiting: live.filter(function (x) { return x.status === 'taken' && x.takenBy && x.takenBy.id === employeeId; })
  };
}
function overlaps(a1s, a1e, b1s, b1e) {
  var a = toMin(a1s), ae = a + hoursOf(a1s, a1e) * 60, b = toMin(b1s), be = b + hoursOf(b1s, b1e) * 60;
  return a < be && b < ae;
}
function toMin(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }

// A manager decides a taken swap.
async function decide(companyId, m, p) {
  var approve = !!p.approve;
  return withTransaction(async function (db) {
    var w = (await db.query(SWAP_SELECT + 'WHERE w.id = $1 AND w.company_id = $2 FOR UPDATE OF w', [p.swapId, companyId])).rows[0];
    if (!w) fail('notfound', 'That swap is gone.');
    if (w.status !== 'taken') fail('conflict', w.status === 'open' ? 'Nobody has taken that shift yet.' : 'That swap is decided already.');
    if (approve) {
      await db.query('UPDATE restaurant_rota_shifts SET employee_id = $2, updated_at = now() WHERE id = $1', [w.shift_id, w.taken_by]);
    }
    await db.query('UPDATE restaurant_shift_swaps SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1', [w.id, approve ? 'approved' : 'declined', m.id]);
    var words = shiftWords(w);
    await notify(db, w.offered_by, approve ? '✅ Your shift went to ' + w.t_first + ' ' + w.t_last : '✖ Your shift stays yours', words + (approve ? '. You are off then.' : '. The swap was declined.'), null);
    await notify(db, w.taken_by, approve ? '✅ The shift is yours' : '✖ The swap was declined', words + (approve ? ' — on the rota now.' : '.'), null);
    await audit(db, who(m), 'restaurant.rota_swap', 'restaurant_shift_swaps', w.id, (approve ? 'Approved' : 'Declined') + ' ' + w.o_first + ' ' + w.o_last + ' → ' + w.t_first + ' ' + w.t_last + ', ' + words + '.');
  });
}

// POST /api/pos/settings/rota { managerPin, action: 'week' | 'save' | 'remove' | 'copy' | 'publish' | 'decide', weekOf, shift, id, swapId, approve }
async function tab(companyId, m, p) {
  p = p || {};
  var action = p.action || 'week';
  var out = {};
  if (action === 'save') { var row = await save(companyId, m, p); out.saved = row.id; p.weekOf = p.weekOf || dayOf(row.day); }
  else if (action === 'remove') await remove(companyId, p.id);
  else if (action === 'copy') out.copied = await copyLast(companyId, m, p.weekOf);
  else if (action === 'publish') Object.assign(out, await publish(companyId, m, p.weekOf));
  else if (action === 'decide') await decide(companyId, m, p);
  else if (action !== 'week') fail('invalid', 'Unknown action.');
  return Object.assign(await week(companyId, p.weekOf), out, { swaps: await swapsOpen(companyId) });
}

// For the till: who works today, published shifts only.
async function onToday(companyId) {
  var rows = (await pool.query(
    'SELECT s.*, e.first_name, e.last_name FROM restaurant_rota_shifts s JOIN employees e ON e.id = s.employee_id ' +
    'WHERE s.company_id = $1 AND s.day = $2 AND s.published ORDER BY s.starts, e.first_name', [companyId, today()])).rows;
  return rows.map(shiftOut);
}

module.exports = { tab: tab, week: week, onToday: onToday, swaps: swaps, mondayOf: mondayOf, hoursOf: hoursOf };
