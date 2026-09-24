var { pool } = require('../db/pool');
var { notify } = require('../utils/notify');
var sms = require('./sms.service');

// An alert to a member of staff: the notification bell (and a phone pop-up,
// for anyone who turned those on — utils/notify.js), plus a text message
// when "Text staff their alerts" is on in Company settings and texts are set
// up. Used by the morning alert and the expiry warnings.
//
// The text is sent after the bell row is written and never fails the
// caller: no credit, or no phone number on file, just means no text.
async function alert(employeeId, title, body, link, settings) {
  await notify(pool, employeeId, title, body, link);
  if (!settings || !settings.staffAlertsBySms || !sms.configured()) return { texted: false };
  var emp = (await pool.query("SELECT phone FROM employees WHERE id = $1 AND status = 'active'", [employeeId])).rows[0];
  if (!emp || !sms.smsNumber(emp.phone)) return { texted: false };
  try {
    await sms.send({ to: emp.phone, message: 'Bamboo OS: ' + title + '. ' + body, purpose: 'staff_alert', refId: employeeId });
    return { texted: true };
  } catch (e) {
    console.error('Staff alert text not sent:', e.message);
    return { texted: false };
  }
}

// Active employees whose role has any of these permissions.
async function holdersOf(permissions) {
  return (await pool.query(
    'SELECT DISTINCT u.id AS user_id, u.employee_id FROM users u JOIN user_roles ur ON ur.user_id = u.id ' +
    'JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN employees e ON e.id = u.employee_id ' +
    "WHERE u.status = 'active' AND e.status = 'active' AND rp.permission_key = ANY($1)",
    [permissions]
  )).rows;
}

module.exports = { alert: alert, holdersOf: holdersOf };
