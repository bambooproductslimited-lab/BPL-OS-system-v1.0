var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var fileStore = require('../lib/fileStore');
var config = require('../config');
var sms = require('./sms.service');
var S = require('./mkShared');

// Asking marketing for something: anyone signed in can ask for a flyer, a
// social post, a banner, a video, photos… with a brief, who it is for and
// when it is needed, and attach what helps. Marketing (marketing.manage)
// takes it on — assigns someone, moves it new → in progress → review →
// done (or declines it, saying why) — talks about it in the comments and
// hands back the finished work as files. The one who asked sees their own
// requests; marketing (marketing.read) sees them all. Each step tells the
// other side (utils/notify.js): a new request goes to marketing, the
// assignment to the one assigned, review/done/declined to the one who asked.
// Besides the one leading it (assigned_to), marketing can add a team
// (marketing_request_members, migration 0147): anyone on staff, who then
// sees it in their requests, talks about it and is told as it moves —
// and, when added, gets a text too (Company settings → Text messages).
// Links sit beside the files (marketing_request_links, migration 0151): a
// reference to look at, or — from marketing — where the finished work lives.

var KINDS = ['social_post', 'flyer', 'brochure', 'banner', 'signage', 'video', 'photos', 'website', 'presentation', 'event', 'other'];
var STATUSES = ['new', 'in_progress', 'review', 'done', 'declined'];
var OPEN = ['new', 'in_progress', 'review'];

function out(r) {
  var today = S.todayIso();
  return {
    id: r.id, number: r.number, ref: 'MR-' + String(r.number).padStart(4, '0'), company: { code: r.company_code, name: r.company_name },
    title: r.title, kind: r.kind, brief: r.brief, audience: r.audience, dueOn: r.due_on, priority: r.priority, status: r.status, note: r.note,
    requester: { id: r.requested_by, name: S.employeeName(r.req_first, r.req_last), photo: r.req_photo ? new Date(r.req_photo).getTime() : null },
    assignee: r.assigned_to ? { id: r.assigned_to, name: S.employeeName(r.as_first, r.as_last), photo: r.as_photo ? new Date(r.as_photo).getTime() : null } : null,
    team: (r.members || []).map(function (m) { return { id: m.id, name: S.employeeName(m.first, m.last), position: m.position || null, photo: m.photo ? new Date(m.photo).getTime() : null }; }),
    campaign: r.campaign_id ? { id: r.campaign_id, name: r.campaign_name } : null,
    routine: r.routine_id ? { id: r.routine_id, on: r.routine_on } : null,
    comments: Number(r.comments || 0), files: Number(r.files || 0), links: Number(r.links || 0), delivered: Number(r.delivered || 0),
    overdue: !!(r.due_on && r.due_on < today && OPEN.indexOf(r.status) >= 0),
    createdAt: r.created_at, updatedAt: r.updated_at, doneAt: r.done_at
  };
}
var SELECT = 'SELECT r.*, co.code AS company_code, co.name AS company_name, c.name AS campaign_name, ' +
  'q.first_name AS req_first, q.last_name AS req_last, CASE WHEN q.photo_key IS NOT NULL THEN q.photo_updated_at END AS req_photo, ' +
  'a.first_name AS as_first, a.last_name AS as_last, CASE WHEN a.photo_key IS NOT NULL THEN a.photo_updated_at END AS as_photo, ' +
  '(SELECT count(*) FROM marketing_request_comments x WHERE x.request_id = r.id) AS comments, ' +
  "(SELECT coalesce(json_agg(json_build_object('id', e.id, 'first', e.first_name, 'last', e.last_name, 'position', e.position_title, " +
  "'photo', CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END) ORDER BY m.added_at), '[]'::json) " +
  'FROM marketing_request_members m JOIN employees e ON e.id = m.employee_id WHERE m.request_id = r.id) AS members, ' +
  '(SELECT count(*) FROM marketing_request_files f WHERE f.request_id = r.id) AS files, ' +
  '(SELECT count(*) FROM marketing_request_links k WHERE k.request_id = r.id) AS links, ' +
  '((SELECT count(*) FROM marketing_request_files f WHERE f.request_id = r.id AND f.delivered) + ' +
  ' (SELECT count(*) FROM marketing_request_links k WHERE k.request_id = r.id AND k.delivered)) AS delivered ' +
  'FROM marketing_requests r JOIN companies co ON co.id = r.company_id LEFT JOIN marketing_campaigns c ON c.id = r.campaign_id ' +
  'JOIN employees q ON q.id = r.requested_by LEFT JOIN employees a ON a.id = r.assigned_to ';

function me(ctx) {
  if (!ctx || !ctx.employee) fail('forbidden', 'Sign in first.');
  return ctx.employee.id;
}
async function row(id) {
  var r = (await pool.query(SELECT + 'WHERE r.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'Request not found.');
  return r;
}
function onTeam(r, who) { return (r.members || []).some(function (m) { return m.id === who; }); }
function canSee(ctx, r) { return r.requested_by === ctx.employee.id || r.assigned_to === ctx.employee.id || onTeam(r, ctx.employee.id) || S.canRead(ctx); }
// Marketing's side of a request: the one leading it and the team.
function workers(r) { return (r.assigned_to ? [r.assigned_to] : []).concat((r.members || []).map(function (m) { return m.id; })); }
async function visible(ctx, id) {
  me(ctx);
  var r = await row(id);
  if (!canSee(ctx, r)) fail('forbidden', 'This request is not yours to see.');
  return r;
}

// The board's filters (GET /api/mk/requests): a range of days on when it
// was asked for (dateBy asked, the default), the date it is needed by
// (needed) or when it was done (done); its type; one person on it — who
// asked, leads it or is on the team; urgent only; late only (past the date
// needed and not done); made by a routine; and words in its title, brief,
// number (MR-0012), or the name of who asked or leads it.
var DATE_BY = { asked: 'r.created_at', needed: 'r.due_on', done: 'r.done_at' };
var ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function filtersOf(opts, args) {
  var where = [];
  function arg(v) { args.push(v); return '$' + args.length; }
  var col = DATE_BY[opts.dateBy] || DATE_BY.asked;
  if (ISO_DAY.test(opts.from || '')) where.push(col + ' >= ' + arg(opts.from) + '::date');
  if (ISO_DAY.test(opts.to || '')) where.push(col + ' < ' + arg(opts.to) + "::date + interval '1 day'");
  if (KINDS.indexOf(opts.kind) >= 0) where.push('r.kind = ' + arg(opts.kind));
  if (UUID.test(opts.person || '')) {
    var p = arg(opts.person);
    where.push('(r.requested_by = ' + p + ' OR r.assigned_to = ' + p + ' OR EXISTS (SELECT 1 FROM marketing_request_members m WHERE m.request_id = r.id AND m.employee_id = ' + p + '))');
  }
  if (opts.urgent === '1') where.push("r.priority = 'urgent'");
  if (opts.late === '1') where.push('r.due_on < ' + arg(S.todayIso()) + "::date AND r.status IN ('new', 'in_progress', 'review')");
  if (opts.routine === '1') where.push('r.routine_id IS NOT NULL');
  var q = String(opts.q || '').trim().slice(0, 80);
  if (q) {
    var w = arg('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
    where.push('(r.title ILIKE ' + w + ' OR r.brief ILIKE ' + w + " OR ('MR-' || lpad(r.number::text, 4, '0')) ILIKE " + w +
      " OR (q.first_name || ' ' || q.last_name) ILIKE " + w + " OR (a.first_name || ' ' || a.last_name) ILIKE " + w + ')');
  }
  return where;
}

// GET /api/mk/requests?scope=mine|all&company=&from=&to=&dateBy=&kind=&person=&urgent=&late=&routine=&q=
// The requests that match (up to 500), counted by step; and, for the page's
// banner, the counts of all of them in scope whatever the filters (totals),
// and everyone on any of them, to filter by.
async function list(ctx, opts) {
  opts = opts || {};
  var my = me(ctx);
  var all = opts.scope === 'all' && S.canRead(ctx);
  var args = [], where = [];
  if (all) {
    if (opts.company) { var co = await S.company(opts.company); args.push(co.id); where.push('r.company_id = $' + args.length); }
  } else {
    args.push(my); where.push('(r.requested_by = $1 OR r.assigned_to = $1 OR EXISTS (SELECT 1 FROM marketing_request_members m WHERE m.request_id = r.id AND m.employee_id = $1))');
  }
  var scopeArgs = args.slice(), scopeWhere = where.length ? 'WHERE ' + where.join(' AND ') : '';
  var filters = filtersOf(opts, args);
  var rows = (await pool.query(SELECT + (where.concat(filters).length ? 'WHERE ' + where.concat(filters).join(' AND ') : '') +
    " ORDER BY CASE WHEN r.status IN ('new', 'in_progress', 'review') THEN 0 ELSE 1 END, r.priority = 'urgent' DESC, r.due_on NULLS LAST, r.created_at DESC LIMIT 500", args)).rows;
  var items = rows.map(out);
  var counts = {};
  STATUSES.forEach(function (s) { counts[s] = items.filter(function (i) { return i.status === s; }).length; });
  var today = S.todayIso();
  var t = (await pool.query(
    'SELECT ' + STATUSES.map(function (st) { return "count(*) FILTER (WHERE r.status = '" + st + "')::int AS " + st; }).join(', ') +
    ", count(*) FILTER (WHERE r.due_on < $" + (scopeArgs.length + 1) + "::date AND r.status IN ('new', 'in_progress', 'review'))::int AS overdue" +
    ", count(*) FILTER (WHERE r.status = 'done' AND r.done_at >= date_trunc('month', $" + (scopeArgs.length + 1) + '::date))::int AS done_month ' +
    'FROM marketing_requests r ' + scopeWhere, scopeArgs.concat([today]))).rows[0];
  var people = (await pool.query(
    'SELECT e.id, e.first_name, e.last_name FROM employees e WHERE e.id IN (' +
    'SELECT r.requested_by FROM marketing_requests r ' + scopeWhere + ' UNION SELECT r.assigned_to FROM marketing_requests r ' + scopeWhere +
    ' UNION SELECT m.employee_id FROM marketing_request_members m JOIN marketing_requests r ON r.id = m.request_id ' + scopeWhere +
    ') ORDER BY e.first_name, e.last_name', scopeArgs)).rows;
  var totals = { counts: {}, overdue: t.overdue, doneMonth: t.done_month };
  STATUSES.forEach(function (st) { totals.counts[st] = t[st]; });
  return {
    scope: all ? 'all' : 'mine', canManage: ctx.can('marketing.manage'), canSeeAll: S.canRead(ctx),
    requests: items, counts: counts, overdue: items.filter(function (i) { return i.overdue; }).length,
    filtered: filters.length > 0, more: rows.length === 500, totals: totals,
    people: people.map(function (e) { return { id: e.id, name: S.employeeName(e.first_name, e.last_name) }; })
  };
}

// GET /api/mk/requests/:id — with its comments, files and links.
async function get(ctx, id) {
  var r = await visible(ctx, id);
  var q = await Promise.all([
    pool.query('SELECT x.id, x.body, x.created_at, x.author_id, e.first_name, e.last_name, CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END AS photo ' +
      'FROM marketing_request_comments x JOIN employees e ON e.id = x.author_id WHERE x.request_id = $1 ORDER BY x.created_at', [id]),
    pool.query('SELECT f.id, f.file_name, f.mime, f.size_bytes, f.delivered, f.created_at, f.uploaded_by, e.first_name, e.last_name FROM marketing_request_files f ' +
      'JOIN employees e ON e.id = f.uploaded_by WHERE f.request_id = $1 ORDER BY f.delivered DESC, f.created_at', [id]),
    pool.query('SELECT k.id, k.url, k.label, k.delivered, k.created_at, k.added_by, e.first_name, e.last_name FROM marketing_request_links k ' +
      'JOIN employees e ON e.id = k.added_by WHERE k.request_id = $1 ORDER BY k.delivered DESC, k.created_at', [id])
  ]);
  var o = out(r);
  o.thread = q[0].rows.map(function (c) { return { id: c.id, body: c.body, at: c.created_at, author: { id: c.author_id, name: S.employeeName(c.first_name, c.last_name), photo: c.photo ? new Date(c.photo).getTime() : null } }; });
  o.attachments = q[1].rows.map(function (f) { return { id: f.id, name: f.file_name, mime: f.mime, size: f.size_bytes, delivered: f.delivered, at: f.created_at, byId: f.uploaded_by, by: S.employeeName(f.first_name, f.last_name) }; });
  o.links = q[2].rows.map(function (k) { return { id: k.id, url: k.url, label: k.label, host: hostOf(k.url), delivered: k.delivered, at: k.created_at, byId: k.added_by, by: S.employeeName(k.first_name, k.last_name) }; });
  o.mine = r.requested_by === ctx.employee.id;
  o.canManage = ctx.can('marketing.manage');
  return o;
}

function briefFields(p) {
  var title = S.text(p.title, 160);
  if (!title) fail('invalid', 'Say what you need.');
  return {
    title: title, kind: S.oneOf(p.kind, KINDS, 'Kind', 'other'), brief: S.text(p.brief, 4000), audience: S.text(p.audience, 300),
    dueOn: S.dateOrNull(p.dueOn, 'Needed by'), priority: S.oneOf(p.priority, ['normal', 'urgent'], 'Priority', 'normal')
  };
}

// A link as it is typed or pasted. Web addresses only (http, https):
// "www.…" or "drive.google.com/…" gets https:// in front; javascript:,
// data:, mailto: and the like are refused, and so is a link with a
// password in it.
var MAX_LINKS = 30;
function linkUrl(v) {
  var s = S.text(v, 2000);
  if (!s) fail('invalid', 'Paste the link first.');
  if (/^(javascript|data|vbscript|file|blob|mailto|tel|about):/i.test(s)) fail('invalid', 'Only web links (http or https) can be added.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  var u;
  try { u = new URL(s); } catch (e) { fail('invalid', 'That is not a web link: ' + s.slice(0, 80)); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('invalid', 'Only web links (http or https) can be added.');
  if (u.hostname.indexOf('.') < 0) fail('invalid', 'That is not a web link: ' + s.slice(0, 80));
  if (u.username || u.password) fail('invalid', 'A link with a password in it cannot be added.');
  return u.href;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
// Links given with a new request: strings, or { url, label }.
function linksGiven(v) {
  if (v === undefined || v === null || v === '') return [];
  if (!Array.isArray(v)) fail('invalid', 'Links must be a list.');
  if (v.length > 10) fail('invalid', 'Up to 10 links with a new request; add more after.');
  return v.map(function (x) { return typeof x === 'string' ? { url: linkUrl(x), label: '' } : { url: linkUrl(x && x.url), label: S.text(x && x.label, 160) }; });
}

// POST /api/mk/requests { company, title, kind, brief, audience, dueOn, priority, links? } — anyone.
async function create(ctx, p) {
  var my = me(ctx);
  var co = await S.company(p.company);
  var f = briefFields(p);
  var links = linksGiven(p.links);
  if (f.dueOn && f.dueOn < S.todayIso()) fail('invalid', 'The date it is needed by has already passed.');
  var id = await withTransaction(async function (db) {
    var r = (await db.query(
      'INSERT INTO marketing_requests (company_id, title, kind, brief, audience, due_on, priority, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, number',
      [co.id, f.title, f.kind, f.brief, f.audience, f.dueOn, f.priority, my])).rows[0];
    for (var k of links) await db.query('INSERT INTO marketing_request_links (request_id, url, label, added_by) VALUES ($1,$2,$3,$4)', [r.id, k.url, k.label, my]);
    var who = S.employeeName(ctx.employee.firstName || ctx.employee.first_name, ctx.employee.lastName || ctx.employee.last_name) || 'Someone';
    for (var m of await S.managers()) {
      if (m === my) continue;
      await notify(db, m, (f.priority === 'urgent' ? 'Urgent request: ' : 'New request: ') + f.title,
        who + ' asked marketing for this' + (f.dueOn ? ', needed by ' + f.dueOn : '') + '.', '/mkrequests?open=' + r.id);
    }
    await audit(db, ctx, 'marketing.request.create', 'marketing_request', r.id, 'MR-' + String(r.number).padStart(4, '0') + ': ' + f.title + '.');
    return r.id;
  });
  return get(ctx, id);
}

// PUT /api/mk/requests/:id — the brief. The one who asked may change it
// while it is new; marketing at any time, with the assignee, campaign and note.
async function update(ctx, id, p) {
  var r = await visible(ctx, id);
  var manage = ctx.can('marketing.manage');
  if (!manage && !(r.requested_by === ctx.employee.id && r.status === 'new')) fail('forbidden', 'Marketing has started on this; ask in the comments for changes.');
  var f = briefFields(p);
  var assignee = manage ? (p.assignedTo === undefined ? r.assigned_to : p.assignedTo || null) : r.assigned_to;
  var campaign = manage ? (p.campaignId === undefined ? r.campaign_id : p.campaignId || null) : r.campaign_id;
  if (assignee && !(await pool.query("SELECT 1 FROM employees WHERE id = $1 AND status <> 'terminated'", [assignee])).rows[0]) fail('invalid', 'Unknown person to assign.');
  if (campaign) {
    var c = (await pool.query('SELECT company_id FROM marketing_campaigns WHERE id = $1', [campaign])).rows[0];
    if (!c || c.company_id !== r.company_id) fail('invalid', 'That campaign is not this company\'s.');
  }
  await withTransaction(async function (db) {
    await db.query('UPDATE marketing_requests SET title = $2, kind = $3, brief = $4, audience = $5, due_on = $6, priority = $7, assigned_to = $8, campaign_id = $9, note = $10, updated_at = now() WHERE id = $1',
      [id, f.title, f.kind, f.brief, f.audience, f.dueOn, f.priority, assignee, campaign, manage && p.note !== undefined ? S.text(p.note, 2000) : r.note]);
    // The one leading it isn't also listed on the team.
    if (assignee) await db.query('DELETE FROM marketing_request_members WHERE request_id = $1 AND employee_id = $2', [id, assignee]);
    if (assignee && assignee !== r.assigned_to && assignee !== ctx.employee.id) {
      await notify(db, assignee, 'Assigned to you: ' + f.title, 'A marketing request' + (f.dueOn ? ', needed by ' + f.dueOn : '') + '.', '/mkrequests?open=' + id);
    }
    await audit(db, ctx, 'marketing.request.update', 'marketing_request', id, 'Updated MR-' + String(r.number).padStart(4, '0') + '.');
  });
  return get(ctx, id);
}

var STATUS_WORD = { new: 'is back to new', in_progress: 'is being worked on', review: 'is ready for you to look at', done: 'is done', declined: 'was declined' };

// POST /api/mk/requests/:id/status { status, note? } — marketing moves it on;
// declining needs a reason. The one who asked may also approve work in
// review (done) or send it back (in progress) with what to change.
async function setStatus(ctx, id, p) {
  var r = await visible(ctx, id);
  var status = S.oneOf(p.status, STATUSES, 'Status');
  var manage = ctx.can('marketing.manage');
  var asker = r.requested_by === ctx.employee.id;
  if (!manage && !(asker && r.status === 'review' && (status === 'done' || status === 'in_progress'))) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
  var note = p.note === undefined ? r.note : S.text(p.note, 2000);
  if (status === 'declined' && !note) fail('invalid', 'Say why it is declined.');
  await withTransaction(async function (db) {
    await db.query('UPDATE marketing_requests SET status = $2, note = $3, updated_at = now(), done_at = CASE WHEN $2 = \'done\' THEN now() ELSE NULL END WHERE id = $1', [id, status, note]);
    if (asker && !manage && status === 'in_progress' && p.note) {
      await db.query('INSERT INTO marketing_request_comments (request_id, author_id, body) VALUES ($1,$2,$3)', [id, ctx.employee.id, S.text(p.note, 2000)]);
    }
    var tell = asker ? (workers(r).length ? workers(r) : await S.managers()) : [r.requested_by].concat(workers(r));
    for (var who of Array.from(new Set(tell))) {
      if (who === ctx.employee.id) continue;
      await notify(db, who, 'MR-' + String(r.number).padStart(4, '0') + ' ' + (STATUS_WORD[status] || status), r.title + (status === 'declined' ? ': ' + note : ''), '/mkrequests?open=' + id);
    }
    await audit(db, ctx, 'marketing.request.status', 'marketing_request', id, 'MR-' + String(r.number).padStart(4, '0') + ': ' + r.status + ' → ' + status + '.');
  });
  return get(ctx, id);
}

// POST /api/mk/requests/:id/comments { body }
async function comment(ctx, id, p) {
  var r = await visible(ctx, id);
  var body = S.text(p.body, 2000);
  if (!body) fail('invalid', 'Write something first.');
  await withTransaction(async function (db) {
    await db.query('INSERT INTO marketing_request_comments (request_id, author_id, body) VALUES ($1,$2,$3)', [id, ctx.employee.id, body]);
    await db.query('UPDATE marketing_requests SET updated_at = now() WHERE id = $1', [id]);
    var tell = r.requested_by === ctx.employee.id ? (workers(r).length ? workers(r) : await S.managers()) : [r.requested_by].concat(workers(r));
    for (var who of Array.from(new Set(tell))) {
      if (who === ctx.employee.id) continue;
      await notify(db, who, 'New comment on MR-' + String(r.number).padStart(4, '0'), body.slice(0, 140), '/mkrequests?open=' + id);
    }
  });
  return get(ctx, id);
}

// POST /api/mk/requests/:id/files (multipart: file, delivered?) — references
// from anyone on it; the finished work (delivered) from marketing.
async function addFile(ctx, id, file, p) {
  var r = await visible(ctx, id);
  if (!file) fail('invalid', 'Pick a file.');
  var delivered = (p && (p.delivered === true || p.delivered === 'true')) && ctx.can('marketing.manage');
  var key = await fileStore.put(file.originalname, file.buffer, file.mimetype);
  await withTransaction(async function (db) {
    await db.query('INSERT INTO marketing_request_files (request_id, file_key, file_name, mime, size_bytes, delivered, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, key, file.originalname, file.mimetype || '', file.size || (file.buffer ? file.buffer.length : 0), delivered, ctx.employee.id]);
    await db.query('UPDATE marketing_requests SET updated_at = now() WHERE id = $1', [id]);
    if (delivered && r.requested_by !== ctx.employee.id) {
      await notify(db, r.requested_by, 'Your ' + r.title + ' is attached', file.originalname, '/mkrequests?open=' + id);
    }
  });
  return get(ctx, id);
}

async function fileRow(ctx, id, fileId) {
  await visible(ctx, id);
  var f = (await pool.query('SELECT * FROM marketing_request_files WHERE id = $1 AND request_id = $2', [fileId, id])).rows[0];
  if (!f) fail('notfound', 'File not found.');
  return f;
}
// The file, for GET /api/mk/requests/:id/files/:fileId.
async function file(ctx, id, fileId) {
  var f = await fileRow(ctx, id, fileId);
  return { key: f.file_key, fileName: f.file_name };
}
// DELETE /api/mk/requests/:id/files/:fileId — whoever added it, or marketing.
async function removeFile(ctx, id, fileId) {
  var f = await fileRow(ctx, id, fileId);
  if (f.uploaded_by !== ctx.employee.id && !ctx.can('marketing.manage')) fail('forbidden', 'Only whoever added it, or marketing, can remove it.');
  await pool.query('DELETE FROM marketing_request_files WHERE id = $1', [fileId]);
  await fileStore.del(f.file_key).catch(function () {});
  return get(ctx, id);
}

// POST /api/mk/requests/:id/links { url, label?, delivered? } — like a file:
// a reference from anyone on it; where the finished work lives (delivered)
// from marketing, and the one who asked is told.
async function addLink(ctx, id, p) {
  var r = await visible(ctx, id);
  p = p || {};
  var url = linkUrl(p.url);
  var label = S.text(p.label, 160);
  var delivered = (p.delivered === true || p.delivered === 'true') && ctx.can('marketing.manage');
  var n = (await pool.query('SELECT count(*)::int AS n FROM marketing_request_links WHERE request_id = $1', [id])).rows[0].n;
  if (n >= MAX_LINKS) fail('invalid', 'This request has ' + MAX_LINKS + ' links already; remove one first.');
  await withTransaction(async function (db) {
    await db.query('INSERT INTO marketing_request_links (request_id, url, label, delivered, added_by) VALUES ($1,$2,$3,$4,$5)', [id, url, label, delivered, ctx.employee.id]);
    await db.query('UPDATE marketing_requests SET updated_at = now() WHERE id = $1', [id]);
    if (delivered && r.requested_by !== ctx.employee.id) {
      await notify(db, r.requested_by, 'Your ' + r.title + ' is ready', label || hostOf(url), '/mkrequests?open=' + id);
    }
  });
  return get(ctx, id);
}
// DELETE /api/mk/requests/:id/links/:linkId — whoever added it, or marketing.
async function removeLink(ctx, id, linkId) {
  await visible(ctx, id);
  var k = (await pool.query('SELECT added_by FROM marketing_request_links WHERE id = $1 AND request_id = $2', [linkId, id])).rows[0];
  if (!k) fail('notfound', 'Link not found.');
  if (k.added_by !== ctx.employee.id && !ctx.can('marketing.manage')) fail('forbidden', 'Only whoever added it, or marketing, can remove it.');
  await pool.query('DELETE FROM marketing_request_links WHERE id = $1', [linkId]);
  return get(ctx, id);
}

var MAX_TEAM = 20;

// PUT /api/mk/requests/:id/team { employeeIds } — who works on it with the
// one leading it (marketing.manage). Anyone on staff; the one leading it is
// left out (shown on their own). Those newly added are told.
async function setTeam(ctx, id, p) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
  var r = await visible(ctx, id);
  var raw = p && p.employeeIds;
  if (!Array.isArray(raw)) fail('invalid', 'Say who is on the team.');
  var ids = Array.from(new Set(raw.map(String))).filter(function (x) { return x && x !== r.assigned_to; });
  if (ids.length > MAX_TEAM) fail('invalid', 'A team can have up to ' + MAX_TEAM + ' people.');
  if (ids.length) {
    var ok = (await pool.query("SELECT id FROM employees WHERE id::text = ANY($1) AND status <> 'terminated'", [ids])).rows.map(function (e) { return e.id; });
    if (ok.length !== ids.length) fail('invalid', 'Someone picked is not on the staff list.');
  }
  var before = (r.members || []).map(function (m) { return m.id; });
  var added = ids.filter(function (x) { return before.indexOf(x) < 0; });
  var removed = before.filter(function (x) { return ids.indexOf(x) < 0; });
  if (!added.length && !removed.length) return Object.assign(await get(ctx, id), { texts: null });
  await withTransaction(async function (db) {
    if (removed.length) await db.query('DELETE FROM marketing_request_members WHERE request_id = $1 AND employee_id = ANY($2)', [id, removed]);
    for (var who of added) {
      await db.query('INSERT INTO marketing_request_members (request_id, employee_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, who, ctx.employee.id]);
      if (who !== ctx.employee.id) {
        await notify(db, who, 'You are on the team for MR-' + String(r.number).padStart(4, '0'), r.title + (r.due_on ? ', needed by ' + r.due_on : '') + '.', '/mkrequests?open=' + id);
      }
    }
    await db.query('UPDATE marketing_requests SET updated_at = now() WHERE id = $1', [id]);
    await audit(db, ctx, 'marketing.request.team', 'marketing_request', id,
      'MR-' + String(r.number).padStart(4, '0') + ' team: ' + ids.length + ' people' + (added.length ? ', ' + added.length + ' added' : '') + (removed.length ? ', ' + removed.length + ' removed' : '') + '.');
  });
  var texts = await textTeam(ctx, r, added.filter(function (x) { return x !== ctx.employee.id; }));
  return Object.assign(await get(ctx, id), { texts: texts });
}

// A text to each person just put on the team, to the phone on their
// employee record — after the change is saved, and never failing it: no
// number, texts off or not set up, or no credit just means no text.
// { sent, noPhone, failed }, or null when texts are off or not set up.
function shortDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
async function textTeam(ctx, r, who) {
  if (!who.length || !sms.configured() || !(await sms.messaging()).requestTeamBySms) return null;
  var out = { sent: 0, noPhone: 0, failed: 0 };
  var phones = (await pool.query("SELECT id, phone FROM employees WHERE id = ANY($1) AND status = 'active'", [who])).rows;
  var title = r.title.length > 60 ? r.title.slice(0, 59) + '…' : r.title;
  var link = config.appUrl ? ' ' + config.appUrl + '/mkrequests?open=' + r.id : '';
  var message = 'Bamboo OS: you are on the team for MR-' + String(r.number).padStart(4, '0') + ' ' + title +
    (r.due_on ? ', needed by ' + shortDate(r.due_on) : '') + '.' + link;
  for (var e of phones) {
    if (!sms.smsNumber(e.phone)) { out.noPhone++; continue; }
    if ((await sms.autoSentToday()) >= sms.AUTO_DAILY_LIMIT) { out.failed++; continue; }
    try {
      await sms.send({ to: e.phone, message: message, purpose: 'auto_request_team', refId: r.id, sentBy: ctx.employee.id });
      out.sent++;
    } catch (err) {
      console.error('Request team text not sent:', err.message);
      out.failed++;
    }
  }
  out.noPhone += who.length - phones.length;
  return out;
}

// GET /api/mk/requests/people — everyone on staff who can be put on a
// request's team (marketing.manage), marketing's own people marked.
async function people(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
  var mk = new Set((await team(ctx)).map(function (e) { return e.id; }));
  return (await pool.query(
    "SELECT e.id, e.code, e.first_name, e.last_name, e.position_title, CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END AS photo FROM employees e WHERE e.status = 'active' ORDER BY e.first_name, e.last_name"
  )).rows.map(function (e) {
    return { id: e.id, code: e.code, firstName: e.first_name, lastName: e.last_name || '', positionTitle: e.position_title || '', photo: e.photo ? new Date(e.photo).getTime() : null, marketing: mk.has(e.id) };
  });
}

// The people marketing can assign work to: those who can manage marketing.
async function team(ctx) {
  S.requireRead(ctx);
  return (await pool.query(
    'SELECT DISTINCT e.id, e.first_name, e.last_name, CASE WHEN e.photo_key IS NOT NULL THEN e.photo_updated_at END AS photo FROM employees e ' +
    'JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id ' +
    "WHERE rp.permission_key IN ('marketing.manage', 'marketing.read') AND e.status = 'active' AND u.status = 'active' ORDER BY e.first_name, e.last_name"
  )).rows.map(function (e) { return { id: e.id, name: S.employeeName(e.first_name, e.last_name), photo: e.photo ? new Date(e.photo).getTime() : null }; });
}

module.exports = { list: list, get: get, create: create, update: update, setStatus: setStatus, comment: comment, addFile: addFile, file: file, removeFile: removeFile, addLink: addLink, removeLink: removeLink, team: team, setTeam: setTeam, people: people, textTeam: textTeam, KINDS: KINDS, STATUSES: STATUSES };
