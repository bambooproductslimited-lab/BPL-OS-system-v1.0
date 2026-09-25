var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Announcements. An audience is everyone ('all'), one company ('company',
// company_id) or one department ('department', department_id). Who has read
// each one — and, when the publisher asks for it, confirmed it — is kept in
// announcement_reads (migration 0082), so the page can show what is new to
// you and tell a publisher who has not read it yet. An announcement can have
// a category, be pinned to the top, and stop showing after a date.

var CATEGORIES = ['general', 'policy', 'event', 'safety', 'celebration'];

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Ported from kernel.js's announcementVisible(ctx, a), plus the company
// audience (migration 0082). myCompanyId is the viewer's company.
function announcementVisible(ctx, a, myCompanyId) {
  if (a.audience_scope === 'all') return true;
  if (a.published_by === ctx.employee.id) return true;
  if (a.audience_scope === 'department' && a.department_id === ctx.employee.department_id) return true;
  if (a.audience_scope === 'company' && myCompanyId && a.company_id === myCompanyId) return true;
  return ctx.can('employee.read.all');
}

async function companyOfDepartment(departmentId) {
  if (!departmentId) return null;
  var res = await pool.query('SELECT company_id FROM departments WHERE id = $1', [departmentId]);
  return res.rows[0] ? res.rows[0].company_id : null;
}

// Everyone an announcement is for: active staff in its audience, not the
// person who published it.
function inAudience(a, e) {
  if (e.id === a.published_by) return false;
  if (a.audience_scope === 'all') return true;
  if (a.audience_scope === 'company') return e.company_id === a.company_id;
  return e.department_id === a.department_id;
}
// lock (inside a transaction): hold these employee rows until it commits,
// so nobody in the audience can be deleted between being looked up and
// being notified — which would otherwise fail the whole publish.
async function activeStaff(db, lock) {
  var res = await (db || pool).query(
    "SELECT e.id, e.first_name, e.last_name, e.department_id, e.photo_key, e.photo_updated_at, d.company_id, d.name AS department_name " +
    "FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active'" + (lock ? ' FOR KEY SHARE OF e' : '')
  );
  return res.rows;
}
function photoVersion(r) { return r.photo_key && r.photo_updated_at ? new Date(r.photo_updated_at).getTime() : null; }

function rowToAnnouncement(r, extra) {
  return Object.assign({
    id: r.id, title: r.title, body: r.body,
    // audience keeps its old meaning for older callers: 'all' or a department id.
    audience: r.audience_scope === 'all' ? 'all' : r.audience_scope === 'department' ? r.department_id : 'company',
    audienceScope: r.audience_scope, departmentId: r.department_id, companyId: r.company_id,
    category: r.category || 'general', requiresAck: !!r.requires_ack, expiresOn: r.expires_on || null,
    publishedBy: r.published_by, publishedAt: r.published_at, updatedAt: r.updated_at || null, pinned: r.pinned
  }, extra || {});
}

// kernel.js: handlers['announcements.list'] — newest first with pinned ones
// on top; each with whether the viewer has read / confirmed it, and for
// publishers how many of its audience have.
async function list(ctx) {
  var myCompanyId = await companyOfDepartment(ctx.employee.department_id);
  var res = await pool.query(
    'SELECT a.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, d.name AS department_name, c.name AS company_name, c.code AS company_code ' +
    'FROM announcements a JOIN employees e ON e.id = a.published_by ' +
    'LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN companies c ON c.id = a.company_id ' +
    'ORDER BY a.pinned DESC, a.published_at DESC'
  );
  var rows = res.rows.filter(function (r) { return announcementVisible(ctx, r, myCompanyId); });
  var ids = rows.map(function (r) { return r.id; });
  var mine = {};
  if (ids.length) {
    var myReads = await pool.query('SELECT announcement_id, read_at, acknowledged_at FROM announcement_reads WHERE employee_id = $1 AND announcement_id = ANY($2)', [ctx.employee.id, ids]);
    myReads.rows.forEach(function (r) { mine[r.announcement_id] = r; });
  }

  var stats = {};
  if (ctx.can('announcement.publish') && ids.length) {
    var staff = await activeStaff();
    var reads = await pool.query('SELECT announcement_id, employee_id, acknowledged_at FROM announcement_reads WHERE announcement_id = ANY($1)', [ids]);
    var readBy = {};
    reads.rows.forEach(function (r) {
      if (!readBy[r.announcement_id]) readBy[r.announcement_id] = {};
      readBy[r.announcement_id][r.employee_id] = r;
    });
    rows.forEach(function (a) {
      var audience = staff.filter(function (e) { return inAudience(a, e); });
      var got = readBy[a.id] || {};
      stats[a.id] = {
        audienceCount: audience.length,
        readCount: audience.filter(function (e) { return got[e.id]; }).length,
        ackCount: audience.filter(function (e) { return got[e.id] && got[e.id].acknowledged_at; }).length
      };
    });
  }

  var today = todayISO();
  return rows.map(function (r) {
    var me = mine[r.id];
    return rowToAnnouncement(r, Object.assign({
      publisherName: r.first_name + ' ' + r.last_name, publisherPhoto: photoVersion(r),
      departmentName: r.department_name || null, companyName: r.company_name || null, companyCode: r.company_code || null,
      expired: !!(r.expires_on && r.expires_on < today),
      mine: r.published_by === ctx.employee.id,
      read: !!me, acknowledged: !!(me && me.acknowledged_at)
    }, stats[r.id] || {}));
  });
}

async function resolveAudience(p) {
  var scope = 'all', departmentId = null, companyId = null;
  var a = p.audience;
  if (a === 'company' || p.audienceScope === 'company') {
    var co = await pool.query('SELECT id FROM companies WHERE id = $1', [p.companyId]);
    if (!co.rows[0]) fail('invalid', 'Choose a company for the audience.');
    scope = 'company'; companyId = p.companyId;
  } else if (a === 'department' || p.audienceScope === 'department' || (a && a !== 'all')) {
    var deptId = a === 'department' || p.audienceScope === 'department' ? p.departmentId : a;
    var dept = await pool.query('SELECT id FROM departments WHERE id = $1', [deptId]);
    if (!dept.rows[0]) fail('invalid', 'Audience is not a valid option.');
    scope = 'department'; departmentId = deptId;
  }
  return { scope: scope, departmentId: departmentId, companyId: companyId };
}
function readFields(p) {
  return {
    title: V.text(p.title, 'Title', 120),
    body: V.text(p.body, 'Body', 2000),
    category: V.oneOf(p.category || 'general', CATEGORIES, 'Category'),
    expiresOn: p.expiresOn ? V.date(p.expiresOn, 'Show until') : null
  };
}

// kernel.js: handlers['announcements.publish']
async function publish(ctx, p) {
  if (!ctx.can('announcement.publish')) fail('forbidden', 'Your role does not allow this action (announcement.publish).');
  var f = readFields(p);
  var aud = await resolveAudience(p);

  return withTransaction(async function (client) {
    var res = await client.query(
      'INSERT INTO announcements (title, body, audience_scope, department_id, company_id, published_by, pinned, category, requires_ack, expires_on) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [f.title, f.body, aud.scope, aud.departmentId, aud.companyId, ctx.employee.id, !!p.pinned, f.category, !!p.requiresAck, f.expiresOn]
    );
    var a = res.rows[0];
    await client.query('INSERT INTO announcement_reads (announcement_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a.id, ctx.employee.id]);

    var staff = await activeStaff(client, true);
    var audience = staff.filter(function (e) { return inAudience(a, e); });
    for (var i = 0; i < audience.length; i++) {
      await notify(client, audience[i].id, a.requires_ack ? 'Please read and confirm' : 'New announcement', f.title, 'announcements');
    }

    await audit(client, ctx, 'announcement.publish', 'announcement', a.id, 'Published "' + a.title + '".');
    return rowToAnnouncement(a, { audienceCount: audience.length, readCount: 0, ackCount: 0, mine: true, read: true, acknowledged: false });
  });
}

async function loadEditable(ctx, id) {
  if (!ctx.can('announcement.publish')) fail('forbidden', 'Your role does not allow this action (announcement.publish).');
  var res = await pool.query('SELECT * FROM announcements WHERE id = $1', [id]);
  var a = res.rows[0];
  if (!a) fail('notfound', 'Announcement not found.');
  if (!announcementVisible(ctx, a, await companyOfDepartment(ctx.employee.department_id))) fail('forbidden', 'Outside your scope.');
  return a;
}

// Change what it says, who it is for, its category, pin, confirmation and
// end date. Nobody is notified again.
async function update(ctx, id, p) {
  var a = await loadEditable(ctx, id);
  var f = readFields(p);
  var aud = await resolveAudience(p);
  var res = await pool.query(
    'UPDATE announcements SET title = $1, body = $2, audience_scope = $3, department_id = $4, company_id = $5, pinned = $6, category = $7, ' +
    'requires_ack = $8, expires_on = $9, updated_at = now() WHERE id = $10 RETURNING *',
    [f.title, f.body, aud.scope, aud.departmentId, aud.companyId, p.pinned === undefined ? a.pinned : !!p.pinned, f.category,
      p.requiresAck === undefined ? a.requires_ack : !!p.requiresAck, f.expiresOn, id]
  );
  await audit(pool, ctx, 'announcement.update', 'announcement', id, 'Edited "' + f.title + '".');
  return rowToAnnouncement(res.rows[0]);
}

async function setPinned(ctx, id, pinned) {
  var a = await loadEditable(ctx, id);
  await pool.query('UPDATE announcements SET pinned = $1 WHERE id = $2', [!!pinned, id]);
  await audit(pool, ctx, 'announcement.pin', 'announcement', id, (pinned ? 'Pinned "' : 'Unpinned "') + a.title + '".');
  return { ok: true };
}

async function remove(ctx, id) {
  var a = await loadEditable(ctx, id);
  await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
  await audit(pool, ctx, 'announcement.delete', 'announcement', id, 'Deleted "' + a.title + '".');
  return { ok: true };
}

// The viewer has seen these (the ones they may see).
async function markRead(ctx, ids) {
  ids = Array.isArray(ids) ? ids.filter(function (x) { return typeof x === 'string'; }).slice(0, 200) : [];
  if (!ids.length) return { marked: 0 };
  var myCompanyId = await companyOfDepartment(ctx.employee.department_id);
  var res = await pool.query('SELECT * FROM announcements WHERE id = ANY($1)', [ids]);
  var ok = res.rows.filter(function (a) { return announcementVisible(ctx, a, myCompanyId); }).map(function (a) { return a.id; });
  if (!ok.length) return { marked: 0 };
  var ins = await pool.query(
    'INSERT INTO announcement_reads (announcement_id, employee_id) SELECT unnest($1::uuid[]), $2 ON CONFLICT DO NOTHING',
    [ok, ctx.employee.id]
  );
  return { marked: ins.rowCount };
}

// "Got it": the viewer confirms they have read it.
async function acknowledge(ctx, id) {
  var res = await pool.query('SELECT * FROM announcements WHERE id = $1', [id]);
  var a = res.rows[0];
  if (!a) fail('notfound', 'Announcement not found.');
  if (!announcementVisible(ctx, a, await companyOfDepartment(ctx.employee.department_id))) fail('forbidden', 'Outside your scope.');
  await pool.query(
    'INSERT INTO announcement_reads (announcement_id, employee_id, acknowledged_at) VALUES ($1,$2,now()) ' +
    'ON CONFLICT (announcement_id, employee_id) DO UPDATE SET acknowledged_at = COALESCE(announcement_reads.acknowledged_at, now())',
    [id, ctx.employee.id]
  );
  return { ok: true };
}

// For publishers: everyone in the audience with whether and when they read
// and confirmed it — not yet read first.
async function readers(ctx, id) {
  var a = await loadEditable(ctx, id);
  var staff = (await activeStaff()).filter(function (e) { return inAudience(a, e); });
  var reads = await pool.query('SELECT employee_id, read_at, acknowledged_at FROM announcement_reads WHERE announcement_id = $1', [id]);
  var got = {};
  reads.rows.forEach(function (r) { got[r.employee_id] = r; });
  return staff.map(function (e) {
    var r = got[e.id];
    return {
      id: e.id, name: e.first_name + ' ' + e.last_name, photo: photoVersion(e), department: e.department_name,
      readAt: r ? r.read_at : null, acknowledgedAt: r ? r.acknowledged_at : null
    };
  }).sort(function (x, y) {
    if (!!x.readAt !== !!y.readAt) return x.readAt ? 1 : -1;
    return x.name.localeCompare(y.name);
  });
}

module.exports = {
  list: list, publish: publish, update: update, setPinned: setPinned, remove: remove,
  markRead: markRead, acknowledge: acknowledge, readers: readers, announcementVisible: announcementVisible
};
