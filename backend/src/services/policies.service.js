var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Policies to read and sign (migration 0201): the staff handbook, the code
// of conduct, the safety rules — written here or a PDF — published to
// everyone, a company or a department. Staff read them in My space and sign
// with their name; whoever keeps the policies sees who has and who has not,
// and can remind them. A new version (what changed, in a line) asks everyone
// to sign again. A joiner gets each on their first-day checklist, ticked
// when they sign. Those late to sign are reminded weekly (the daily alerts).

var CATEGORIES = ['handbook', 'conduct', 'safety', 'it', 'hr', 'food', 'finance', 'other'];

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function addDays(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function can(ctx) { return ctx.can('policy.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (policy.manage).'); }
function letters(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, ''); }

var PSEL = 'SELECT p.*, c.name AS company, d.name AS department FROM policies p LEFT JOIN companies c ON c.id = p.company_id LEFT JOIN departments d ON d.id = p.department_id ';

// The active staff a policy is for.
async function audienceOf(pol, db) {
  return (await (db || pool).query(
    "SELECT e.id, e.first_name, e.last_name, e.hire_date, e.position_title, d.name AS department FROM employees e LEFT JOIN departments d ON d.id = e.department_id " +
    "WHERE e.status = 'active' AND ($1::uuid IS NULL OR d.company_id = $1) AND ($2::uuid IS NULL OR e.department_id = $2) ORDER BY e.first_name, e.last_name",
    [pol.company_id || null, pol.department_id || null])).rows;
}

// When it should be signed by: from the version (or their first day, if later).
function dueOf(pol, hireDate) {
  var from = dayText(pol.published_at) || today();
  var hired = dayText(hireDate);
  if (hired && hired > from) from = hired;
  return addDays(from, pol.sign_days);
}

function policyOut(p) {
  return {
    id: p.id, title: p.title, category: p.category, summary: p.summary, body: p.body, hasFile: !!p.file, fileType: p.file ? p.file.type : null,
    version: p.version, versionNote: p.version_note, status: p.status, publishedAt: p.published_at,
    audience: p.department_id ? { kind: 'department', id: p.department_id, name: p.department } : p.company_id ? { kind: 'company', id: p.company_id, name: p.company } : { kind: 'all' },
    mustSign: p.must_sign, signDays: p.sign_days, joiners: p.joiners, updatedAt: p.updated_at
  };
}

async function policyOf(id) {
  var p = (await pool.query(PSEL + 'WHERE p.id = $1', [uuidOr(id)])).rows[0];
  if (!p) fail('notfound', 'That policy is gone.');
  return p;
}

// Who has signed this version, who signed an older one, who has not.
async function statusOf(p) {
  var people = await audienceOf(p);
  var sigs = (await pool.query('SELECT employee_id, version, signed_at, signed_name FROM policy_signatures WHERE policy_id = $1 ORDER BY version DESC', [p.id])).rows;
  var by = {};
  sigs.forEach(function (s) { if (!by[s.employee_id]) by[s.employee_id] = []; by[s.employee_id].push(s); });
  var t = today();
  return people.map(function (e) {
    var mine = by[e.id] || [];
    var now = mine.find(function (s) { return s.version === p.version; });
    var due = dueOf(p, e.hire_date);
    return {
      id: e.id, name: nameOf(e.first_name, e.last_name), department: e.department, position: e.position_title,
      signedAt: now ? now.signed_at : null, signedVersion: mine.length ? mine[0].version : null,
      due: due, overdue: p.status === 'published' && p.must_sign && !now && due < t
    };
  });
}

// GET /api/policies
async function overview(ctx) {
  need(ctx);
  var rows = (await pool.query(PSEL + "ORDER BY CASE p.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, p.title")).rows;
  var list = [];
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i], o = policyOut(p);
    if (p.status === 'published') {
      var st = await statusOf(p);
      o.people = st.length;
      o.signed = st.filter(function (s) { return s.signedAt; }).length;
      o.overdue = st.filter(function (s) { return s.overdue; }).length;
    }
    list.push(o);
  }
  var published = list.filter(function (x) { return x.status === 'published' && x.mustSign; });
  var companies = (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows;
  var departments = (await pool.query('SELECT d.id, d.name, c.name AS company FROM departments d LEFT JOIN companies c ON c.id = d.company_id ORDER BY c.name, d.name')).rows;
  return {
    policies: list, categories: CATEGORIES, companies: companies, departments: departments,
    summary: {
      published: list.filter(function (x) { return x.status === 'published'; }).length,
      drafts: list.filter(function (x) { return x.status === 'draft'; }).length,
      toSign: published.reduce(function (a, x) { return a + (x.people - x.signed); }, 0),
      overdue: published.reduce(function (a, x) { return a + x.overdue; }, 0),
      complete: published.filter(function (x) { return x.people > 0 && x.signed === x.people; }).length,
      rate: published.reduce(function (a, x) { return a + x.people; }, 0) ? Math.round(published.reduce(function (a, x) { return a + x.signed; }, 0) / published.reduce(function (a, x) { return a + x.people; }, 0) * 100) : null
    }
  };
}

async function inAudience(p, empId) {
  if (!empId) return false;
  return !!(await pool.query("SELECT 1 FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $3 AND e.status = 'active' AND ($1::uuid IS NULL OR d.company_id = $1) AND ($2::uuid IS NULL OR e.department_id = $2)",
    [p.company_id || null, p.department_id || null, empId])).rows[0];
}

// GET /api/policies/:id — whoever keeps them: the people and the versions;
// a member of staff it is for: the policy and where they stand.
async function get(ctx, id) {
  var p = await policyOf(id);
  var out = policyOut(p);
  if (can(ctx)) {
    out.people = p.status === 'published' ? await statusOf(p) : [];
    out.versions = (await pool.query('SELECT v.version, v.title, v.note, v.published_at, e.first_name, e.last_name FROM policy_versions v LEFT JOIN employees e ON e.id = v.by_id WHERE v.policy_id = $1 ORDER BY v.version DESC', [p.id])).rows.map(function (v) {
      return { version: v.version, title: v.title, note: v.note, publishedAt: v.published_at, by: nameOf(v.first_name, v.last_name) };
    });
    out.canManage = true;
  } else if (!(p.status === 'published' && await inAudience(p, me(ctx)))) fail('notfound', 'That policy is not for you.');
  var mine = me(ctx) ? (await pool.query('SELECT version, signed_at FROM policy_signatures WHERE policy_id = $1 AND employee_id = $2 ORDER BY version DESC', [p.id, me(ctx)])).rows : [];
  var cur = mine.find(function (s) { return s.version === p.version; });
  out.mine = { signedAt: cur ? cur.signed_at : null, olderVersion: !cur && mine.length ? mine[0].version : null, forMe: p.status === 'published' && await inAudience(p, me(ctx)) };
  return out;
}

async function tellAudience(p, title, body) {
  var people = await audienceOf(p);
  for (var i = 0; i < people.length; i++) await notify(pool, people[i].id, title, body, '/myspace');
  return people.length;
}

// POST /api/policies, PUT /api/policies/:id { title, category, summary, body,
// file (data URL), removeFile, companyId, departmentId, mustSign, signDays,
// joiners, newVersion, versionNote }
async function save(ctx, id, p) {
  need(ctx);
  p = p || {};
  var title = text(p.title, 140);
  if (title.length < 3) fail('invalid', 'What is the policy called?');
  var category = CATEGORIES.indexOf(p.category) >= 0 ? p.category : 'other';
  var body = String(p.body == null ? '' : p.body).replace(/\r/g, '').trim().slice(0, 30000);
  var file = p.file ? await require('./licences.service').keepFile(p.file, p.fileName || title + '.pdf', 'policy') : undefined;
  var company = uuidOr(p.companyId), dept = uuidOr(p.departmentId);
  if (dept) {
    var d = (await pool.query('SELECT company_id FROM departments WHERE id = $1', [dept])).rows[0];
    if (!d) fail('invalid', 'Which department?');
    company = d.company_id;
  }
  var signDays = Math.max(1, Math.min(90, Math.round(Number(p.signDays) || 14)));
  var meta = [text(p.summary, 400), company, dept, p.mustSign !== false, signDays, p.joiners !== false];
  if (!id) {
    if (body.length < 20 && !file) fail('invalid', 'Write the policy, or add it as a PDF.');
    var row = (await pool.query('INSERT INTO policies (title, category, summary, body, file, company_id, department_id, must_sign, sign_days, joiners, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [title, category, meta[0], body, file ? JSON.stringify(file) : null, meta[1], meta[2], meta[3], meta[4], meta[5], me(ctx)])).rows[0];
    await audit(pool, ctx, 'policy.create', 'policy', row.id, '"' + title + '" drafted.');
    return get(ctx, row.id);
  }
  var cur = await policyOf(id);
  if (cur.status === 'retired') fail('conflict', 'It is retired.');
  var newFile = file !== undefined ? file : p.removeFile ? null : cur.file;
  if (body.length < 20 && !newFile) fail('invalid', 'Write the policy, or add it as a PDF.');
  var changed = title !== cur.title || body !== cur.body || JSON.stringify(newFile || null) !== JSON.stringify(cur.file || null);
  if (cur.status === 'published' && changed) {
    if (!p.newVersion) fail('conflict', 'It is published: changing what it says makes a new version, and everyone signs again.');
    var note = text(p.versionNote, 300);
    if (note.length < 3) fail('invalid', 'What changed, in a line?');
    var v = cur.version + 1;
    await withTransaction(async function (db) {
      await db.query('UPDATE policies SET title = $2, category = $3, body = $4, file = $5, version = $6, version_note = $7, published_at = now(), summary = $8, company_id = $9, department_id = $10, must_sign = $11, sign_days = $12, joiners = $13, updated_at = now() WHERE id = $1',
        [cur.id, title, category, body, newFile ? JSON.stringify(newFile) : null, v, note, meta[0], meta[1], meta[2], meta[3], meta[4], meta[5]]);
      await db.query('INSERT INTO policy_versions (policy_id, version, title, body, file, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [cur.id, v, title, body, newFile ? JSON.stringify(newFile) : null, note, me(ctx)]);
    });
    var fresh = await policyOf(cur.id);
    if (fresh.must_sign) await tellAudience(fresh, '📜 ' + title + ' has changed: please read and sign again', note + ' — by ' + addDays(today(), fresh.sign_days) + ', in My space.');
    await audit(pool, ctx, 'policy.version', 'policy', cur.id, '"' + title + '" version ' + v + ': ' + note);
    return get(ctx, cur.id);
  }
  await pool.query('UPDATE policies SET title = $2, category = $3, body = $4, file = $5, summary = $6, company_id = $7, department_id = $8, must_sign = $9, sign_days = $10, joiners = $11, updated_at = now() WHERE id = $1',
    [cur.id, title, category, body, newFile ? JSON.stringify(newFile) : null, meta[0], meta[1], meta[2], meta[3], meta[4], meta[5]]);
  await audit(pool, ctx, 'policy.update', 'policy', cur.id, '"' + title + '" changed.');
  return get(ctx, cur.id);
}

// POST /api/policies/:id/publish
async function publish(ctx, id) {
  need(ctx);
  var p = await policyOf(id);
  if (p.status !== 'draft') fail('conflict', 'It has been published already.');
  await withTransaction(async function (db) {
    await db.query("UPDATE policies SET status = 'published', published_at = now(), updated_at = now() WHERE id = $1", [p.id]);
    await db.query('INSERT INTO policy_versions (policy_id, version, title, body, file, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [p.id, p.version, p.title, p.body, p.file ? JSON.stringify(p.file) : null, 'First published', me(ctx)]);
  });
  var fresh = await policyOf(p.id);
  var told = await tellAudience(fresh, p.must_sign ? '📜 Please read and sign: ' + p.title : '📜 A policy to read: ' + p.title, (p.summary ? p.summary + ' — ' : '') + (p.must_sign ? 'Sign it by ' + addDays(today(), p.sign_days) + ', in My space.' : 'In My space.'));
  await audit(pool, ctx, 'policy.publish', 'policy', p.id, '"' + p.title + '" published to ' + told + ' people.');
  return get(ctx, p.id);
}

// POST /api/policies/:id/retire
async function retire(ctx, id) {
  need(ctx);
  var p = await policyOf(id);
  if (p.status === 'retired') fail('conflict', 'It is retired already.');
  await pool.query("UPDATE policies SET status = 'retired', updated_at = now() WHERE id = $1", [p.id]);
  await pool.query("UPDATE onboard_steps SET done_at = now(), note = 'Policy retired' WHERE kind = 'policy' AND ref_id = $1 AND done_at IS NULL", [p.id]);
  await audit(pool, ctx, 'policy.retire', 'policy', p.id, '"' + p.title + '" retired.');
  return get(ctx, p.id);
}

// POST /api/policies/:id/sign { name, agree } — the person, from My space.
async function sign(ctx, id, p) {
  p = p || {};
  if (!me(ctx)) fail('forbidden', 'Only staff sign policies.');
  var pol = await policyOf(id);
  if (pol.status !== 'published') fail('conflict', 'That policy is not in force.');
  if (!pol.must_sign) fail('conflict', 'That one is only to read.');
  if (!(await inAudience(pol, me(ctx)))) fail('forbidden', 'That policy is not for you.');
  if (p.agree !== true) fail('invalid', 'Tick that you have read and understood it.');
  var typed = text(p.name, 120);
  var e = ctx.employee;
  var first = letters(e.first_name), last = letters(e.last_name), t = letters(typed);
  if (t.length < 3 || !((first && t.indexOf(first) >= 0) || (last && t.indexOf(last) >= 0))) fail('invalid', 'Type your name to sign.');
  var done = await withTransaction(async function (db) {
    var r = await db.query('INSERT INTO policy_signatures (policy_id, employee_id, version, signed_name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [pol.id, me(ctx), pol.version, typed]);
    if (!r.rowCount) return false;
    // Their first-day step for it ticks itself.
    var steps = (await db.query("SELECT s.id, s.list_id FROM onboard_steps s JOIN onboard_lists l ON l.id = s.list_id WHERE s.kind = 'policy' AND s.ref_id = $1 AND l.employee_id = $2 AND s.done_at IS NULL AND l.status = 'open'", [pol.id, me(ctx)])).rows;
    for (var i = 0; i < steps.length; i++) {
      await db.query('UPDATE onboard_steps SET done_at = now(), done_by = $2 WHERE id = $1', [steps[i].id, me(ctx)]);
      var left = (await db.query('SELECT count(*)::int AS n FROM onboard_steps WHERE list_id = $1 AND done_at IS NULL', [steps[i].list_id])).rows[0].n;
      if (!left) await db.query("UPDATE onboard_lists SET status = 'done', done_at = now() WHERE id = $1 AND status = 'open'", [steps[i].list_id]);
    }
    return true;
  });
  if (!done) fail('conflict', 'You have signed this version already.');
  await audit(pool, ctx, 'policy.sign', 'policy', pol.id, '"' + pol.title + '" version ' + pol.version + ' signed.');
  return { ok: true, version: pol.version };
}

// POST /api/policies/:id/remind — everyone it is for who has not signed.
async function remind(ctx, id) {
  need(ctx);
  var p = await policyOf(id);
  if (p.status !== 'published' || !p.must_sign) fail('conflict', 'Nobody needs to sign it.');
  var st = await statusOf(p);
  var left = st.filter(function (s) { return !s.signedAt; });
  for (var i = 0; i < left.length; i++) await notify(pool, left[i].id, '📜 A reminder: please read and sign ' + p.title, (left[i].overdue ? 'It was due on ' + left[i].due + '.' : 'By ' + left[i].due + '.') + ' In My space.', '/myspace');
  await audit(pool, ctx, 'policy.remind', 'policy', p.id, '"' + p.title + '": ' + left.length + ' reminded.');
  return { reminded: left.length };
}

// GET /api/policies/mine — My space.
async function mine(ctx) {
  if (!me(ctx)) return { toSign: [], signed: [], toRead: [] };
  var emp = (await pool.query('SELECT e.hire_date, e.department_id, d.company_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1', [me(ctx)])).rows[0] || {};
  var rows = (await pool.query(PSEL + "WHERE p.status = 'published' AND (p.company_id IS NULL OR p.company_id = $1) AND (p.department_id IS NULL OR p.department_id = $2) ORDER BY p.published_at DESC", [emp.company_id || null, emp.department_id || null])).rows;
  var sigs = (await pool.query('SELECT policy_id, version, signed_at FROM policy_signatures WHERE employee_id = $1', [me(ctx)])).rows;
  var t = today();
  var out = { toSign: [], signed: [], toRead: [] };
  rows.forEach(function (p) {
    var o = policyOut(p);
    delete o.body;
    var mineSigs = sigs.filter(function (s) { return s.policy_id === p.id; });
    var cur = mineSigs.find(function (s) { return s.version === p.version; });
    if (!p.must_sign) out.toRead.push(o);
    else if (cur) out.signed.push(Object.assign(o, { signedAt: cur.signed_at }));
    else {
      var due = dueOf(p, emp.hire_date);
      out.toSign.push(Object.assign(o, { due: due, overdue: due < t, again: mineSigs.length > 0 }));
    }
  });
  out.toSign.sort(function (a, b) { return a.due.localeCompare(b.due); });
  return out;
}

// GET /api/policies/:id/file?version= — the PDF, for whoever may read it.
async function fileOf(ctx, id, version) {
  var p = await policyOf(id);
  if (!can(ctx) && !(p.status === 'published' && await inAudience(p, me(ctx)))) fail('notfound', 'That policy is not for you.');
  var file = p.file;
  if (version && Number(version) !== p.version && can(ctx)) {
    var v = (await pool.query('SELECT file FROM policy_versions WHERE policy_id = $1 AND version = $2', [p.id, Math.round(Number(version))])).rows[0];
    file = v ? v.file : null;
  }
  if (!file) fail('notfound', 'It has no PDF.');
  return file;
}

// For a joiner's first-day checklist: the policies they will need to sign.
async function forJoiner(employeeId) {
  var emp = (await pool.query('SELECT e.department_id, d.company_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1', [employeeId])).rows[0];
  if (!emp) return [];
  return (await pool.query("SELECT id, title, sign_days FROM policies WHERE status = 'published' AND must_sign AND joiners AND (company_id IS NULL OR company_id = $1) AND (department_id IS NULL OR department_id = $2) ORDER BY title", [emp.company_id || null, emp.department_id || null])).rows;
}

// Has this person signed the version in force?
async function hasSigned(policyId, employeeId) {
  return !!(await pool.query('SELECT 1 FROM policy_signatures s JOIN policies p ON p.id = s.policy_id AND p.version = s.version WHERE s.policy_id = $1 AND s.employee_id = $2', [policyId, employeeId])).rows[0];
}

// For the daily alerts: who is late to sign what.
async function lateSigners() {
  var rows = (await pool.query(PSEL + "WHERE p.status = 'published' AND p.must_sign")).rows;
  var byPerson = {}, byPolicy = [];
  for (var i = 0; i < rows.length; i++) {
    var st = await statusOf(rows[i]);
    var late = st.filter(function (s) { return s.overdue; });
    if (late.length) byPolicy.push({ id: rows[i].id, title: rows[i].title, late: late.length, of: st.length });
    late.forEach(function (s) { (byPerson[s.id] = byPerson[s.id] || []).push(rows[i].title); });
  }
  return { byPerson: byPerson, byPolicy: byPolicy };
}

module.exports = { overview: overview, get: get, save: save, publish: publish, retire: retire, sign: sign, remind: remind, mine: mine, fileOf: fileOf, forJoiner: forJoiner, hasSigned: hasSigned, lateSigners: lateSigners, CATEGORIES: CATEGORIES };
