// Ported from kernel.js's notify(employeeId, title, body, link).
async function notify(db, employeeId, title, body, link) {
  await db.query(
    'INSERT INTO notifications (employee_id, title, body, link) VALUES ($1,$2,$3,$4)',
    [employeeId, title, body || '', link || null]
  );
}

module.exports = { notify: notify };
