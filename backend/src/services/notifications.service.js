var { pool } = require('../db/pool');

function rowToNotification(r) {
  return { id: r.id, employeeId: r.employee_id, title: r.title, body: r.body, link: r.link, at: r.at, read: r.read };
}

// kernel.js: handlers['notifications.mine']
async function mine(ctx) {
  var res = await pool.query('SELECT * FROM notifications WHERE employee_id = $1 ORDER BY at DESC', [ctx.employee.id]);
  return res.rows.map(rowToNotification);
}

// kernel.js: handlers['notifications.markRead']
async function markRead(ctx, id) {
  if (id) {
    await pool.query('UPDATE notifications SET read = true WHERE employee_id = $1 AND id = $2', [ctx.employee.id, id]);
  } else {
    await pool.query('UPDATE notifications SET read = true WHERE employee_id = $1', [ctx.employee.id]);
  }
  return true;
}

module.exports = { mine: mine, markRead: markRead };
