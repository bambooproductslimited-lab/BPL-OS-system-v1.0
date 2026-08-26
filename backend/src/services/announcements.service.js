var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Ported from kernel.js's announcementVisible(ctx, a). kernel stores
// `audience` as either 'all' or a department id directly; here that's split
// into audience_scope + department_id, so this reads back to the same rule.
function announcementVisible(ctx, a) {
  if (a.audience_scope === 'all') return true;
  if (a.department_id === ctx.employee.department_id) return true;
  return ctx.can('employee.read.all');
}

function rowToAnnouncement(r, extra) {
  return Object.assign({
    id: r.id, title: r.title, body: r.body, audience: r.audience_scope === 'all' ? 'all' : r.department_id,
    publishedBy: r.published_by, publishedAt: r.published_at, pinned: r.pinned
  }, extra || {});
}

// kernel.js: handlers['announcements.list']
async function list(ctx) {
  var res = await pool.query(
    'SELECT a.*, e.first_name, e.last_name FROM announcements a JOIN employees e ON e.id = a.published_by ' +
    'ORDER BY a.pinned DESC, a.published_at DESC'
  );
  return res.rows.filter(function (r) { return announcementVisible(ctx, r); })
    .map(function (r) { return rowToAnnouncement(r, { publisherName: r.first_name + ' ' + r.last_name }); });
}

// kernel.js: handlers['announcements.publish']
async function publish(ctx, p) {
  if (!ctx.can('announcement.publish')) fail('forbidden', 'Your role does not allow this action (announcement.publish).');
  var title = V.text(p.title, 'Title', 120);
  var body = V.text(p.body, 'Body', 2000);

  var scope = 'all', departmentId = null;
  if (p.audience && p.audience !== 'all') {
    var deptRes = await pool.query('SELECT id FROM departments WHERE id = $1', [p.audience]);
    if (!deptRes.rows[0]) fail('invalid', 'Audience is not a valid option.');
    scope = 'department'; departmentId = p.audience;
  }

  return withTransaction(async function (client) {
    var res = await client.query(
      'INSERT INTO announcements (title, body, audience_scope, department_id, published_by, pinned) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [title, body, scope, departmentId, ctx.employee.id, !!p.pinned]
    );
    var a = res.rows[0];

    var audienceRes = scope === 'all'
      ? await client.query("SELECT id FROM employees WHERE status = 'active' AND id != $1", [ctx.employee.id])
      : await client.query("SELECT id FROM employees WHERE status = 'active' AND department_id = $1 AND id != $2", [departmentId, ctx.employee.id]);
    for (var i = 0; i < audienceRes.rows.length; i++) {
      await notify(client, audienceRes.rows[i].id, 'New announcement', title, 'announcements');
    }

    await audit(client, ctx, 'announcement.publish', 'announcement', a.id, 'Published "' + a.title + '".');
    return rowToAnnouncement(a);
  });
}

module.exports = { list: list, publish: publish, announcementVisible: announcementVisible };
