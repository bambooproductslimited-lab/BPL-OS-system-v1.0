var { pool } = require('../db/pool');
var { notify } = require('../utils/notify');
var { buildContext } = require('../services/context.service');
var remindersService = require('../services/reminders.service');

// The morning alert to staff: once a day, from 07:00 Ghana time, each person
// is told what needs chasing in the parts of the OS they can see — bills
// overdue and due in the next three days (Bamboo Products invoices and/or
// Poki rent and utilities), and products at or below their reorder level.
// It lands in the notification bell and, for anyone who has turned on phone
// pop-ups, on their phone. Nothing is sent to someone with nothing to act on.
//
// staff_digests (migration 0076) makes it once per person per day however
// often this runs or restarts.

var INTERVAL_MS = 15 * 60 * 1000;
var SEND_FROM_HOUR_UTC = 7; // Ghana is on GMT all year
var DUE_SOON_DAYS = 3;

function money(totals) {
  return Object.keys(totals).map(function (c) {
    return c + ' ' + totals[c].toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }).join(' + ');
}

// What one person should hear about this morning, or null.
async function digestFor(ctx) {
  var parts = [];
  var chasePayments = ctx.can('invoice.read') || ctx.can('poki.read') || ctx.can('poki.manage');
  if (chasePayments) {
    var list = await remindersService.due(ctx, { windowDays: DUE_SOON_DAYS });
    var overdue = list.rows.filter(function (r) { return r.daysOverdue > 0; });
    var soon = list.rows.filter(function (r) { return r.daysOverdue <= 0; });
    var sum = function (rows) {
      var t = {};
      rows.forEach(function (r) { t[r.currency] = (t[r.currency] || 0) + r.balanceDue; });
      return t;
    };
    if (overdue.length) parts.push(overdue.length + ' bill' + (overdue.length === 1 ? '' : 's') + ' overdue (' + money(sum(overdue)) + ')');
    if (soon.length) parts.push(soon.length + ' due in the next ' + DUE_SOON_DAYS + ' days (' + money(sum(soon)) + ')');
  }
  var lowStock = 0;
  if (ctx.can('inventory.read')) {
    lowStock = (await pool.query('SELECT count(*)::int AS n FROM products WHERE reorder_level > 0 AND current_stock <= reorder_level')).rows[0].n;
    if (lowStock) parts.push(lowStock + ' product' + (lowStock === 1 ? '' : 's') + ' at or below reorder level');
  }
  if (!parts.length) return null;
  var paymentsFirst = chasePayments && parts.length && !/reorder/.test(parts[0]);
  return {
    title: paymentsFirst ? 'Payments to chase today' : 'Stock to reorder',
    body: parts.join(' · ') + '.',
    link: paymentsFirst ? '/reminders' : '/inventory'
  };
}

async function runOnce(now) {
  var at = now || new Date();
  if (at.getUTCHours() < SEND_FROM_HOUR_UTC) return 0;
  var date = at.toISOString().slice(0, 10);
  var sent = 0;
  try {
    var users = (await pool.query(
      "SELECT DISTINCT u.id, u.employee_id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id " +
      "WHERE u.status = 'active' AND rp.permission_key IN ('invoice.read', 'poki.read', 'poki.manage', 'inventory.read') " +
      "AND NOT EXISTS (SELECT 1 FROM staff_digests d WHERE d.employee_id = u.employee_id AND d.kind = 'morning' AND d.date = $1)",
      [date]
    )).rows;
    for (var i = 0; i < users.length; i++) {
      var ctx = await buildContext(users[i].id);
      if (!ctx) continue;
      var d = await digestFor(ctx);
      // Claimed first: two instances running at once still send once.
      var claimed = await pool.query(
        "INSERT INTO staff_digests (employee_id, kind, date) VALUES ($1, 'morning', $2) ON CONFLICT DO NOTHING RETURNING employee_id",
        [users[i].employee_id, date]
      );
      if (!claimed.rowCount || !d) continue;
      await notify(pool, users[i].employee_id, d.title, d.body, d.link);
      sent++;
    }
    if (sent) console.log('Morning digest: sent to ' + sent + ' person(s).');
  } catch (e) {
    console.error('Morning digest failed:', e.message);
  }
  return sent;
}

function start() {
  setTimeout(runOnce, 60 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce, digestFor: digestFor };
