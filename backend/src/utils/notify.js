var { pool } = require('../db/pool');

// Ported from kernel.js's notify(employeeId, title, body, link), and now
// also the one place a Web Push pop-up is raised — every notification in
// Bamboo OS goes through here, so nothing has to be wired up per feature.
//
// The push is NOT sent inline, and that matters. Most callers pass a
// transaction client: notify() runs in the middle of approving leave,
// assigning a task, posting an announcement. Sending inside the
// transaction would push a notification for something that then rolled
// back, and a slow or unreachable push service would hold a database
// transaction open while it timed out.
//
// So the send is deferred to the next tick and, before it goes, re-reads
// the row through the POOL rather than the caller's client. If the
// transaction committed, the row is there and the pop-up goes out. If it
// rolled back, the row is not, and nothing is sent — which is exactly the
// behaviour wanted, without notify() having to know anything about its
// caller's transaction.
function schedulePush(notificationId) {
  setImmediate(async function () {
    try {
      var row = (await pool.query(
        'SELECT employee_id, title, body, link FROM notifications WHERE id = $1', [notificationId])).rows[0];
      if (!row) return; // the transaction rolled back — there is nothing to announce
      // Required lazily: this module is imported by nearly every service,
      // and push.service.js pulls in web-push and the database.
      var pushService = require('../services/push.service');
      await pushService.sendToEmployee(row.employee_id, {
        title: row.title, body: row.body, link: row.link, id: notificationId
      });
    } catch { /* a pop-up that cannot be delivered must never break what triggered it */ }
  });
}

async function notify(db, employeeId, title, body, link) {
  var res = await db.query(
    'INSERT INTO notifications (employee_id, title, body, link) VALUES ($1,$2,$3,$4) RETURNING id',
    [employeeId, title, body || '', link || null]
  );
  schedulePush(res.rows[0].id);
}

module.exports = { notify: notify };
