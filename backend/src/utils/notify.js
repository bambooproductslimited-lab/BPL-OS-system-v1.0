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
//
// Inside withTransaction (db/pool.js) the send waits for the COMMIT itself
// (client.afterCommit). Before that existed, the next-tick send raced the
// commit: a transaction still doing work after notify() hid the row, and the
// pop-up was silently dropped as if rolled back — which is what happened to
// every ringing call. For any other caller the re-read is tried a few times.
var RETRY_MS = [0, 300, 2000];
function schedulePush(notificationId, push, attempt) {
  attempt = attempt || 0;
  setTimeout(async function () {
    try {
      var row = (await pool.query(
        'SELECT employee_id, title, body, link FROM notifications WHERE id = $1', [notificationId])).rows[0];
      if (!row) {
        // not committed yet, or rolled back — the latter never appears
        if (attempt + 1 < RETRY_MS.length) schedulePush(notificationId, push, attempt + 1);
        return;
      }
      // Required lazily: this module is imported by nearly every service,
      // and push.service.js pulls in web-push and the database.
      var pushService = require('../services/push.service');
      await pushService.sendToEmployee(row.employee_id,
        Object.assign({ title: row.title, body: row.body, link: row.link, id: notificationId }, push && push.data),
        push && push.options);
    } catch { /* a pop-up that cannot be delivered must never break what triggered it */ }
  }, RETRY_MS[attempt]).unref();
}

// push (optional): { data, options } for a pop-up that needs more than the
// usual — a ringing call carries its call id and Answer/Decline, and must
// arrive now or not at all. data is merged into what the device receives;
// options go to push.service's sendToEmployee.
async function notify(db, employeeId, title, body, link, push) {
  var res = await db.query(
    'INSERT INTO notifications (employee_id, title, body, link) VALUES ($1,$2,$3,$4) RETURNING id',
    [employeeId, title, body || '', link || null]
  );
  var id = res.rows[0].id;
  if (db && Array.isArray(db.afterCommit)) db.afterCommit.push(function () { schedulePush(id, push); });
  else schedulePush(id, push);
}

module.exports = { notify: notify };
