var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Training and certificates (People → Training and certificates; migration
// 0198): the certificates staff must hold — a food handler's health
// certificate in the kitchens, fire safety, first aid, a forklift licence on
// the factory floor — which companies need which, each person's with its
// number, the day it runs out and a photo; what is missing or running out
// at a glance. A training session (who was invited, who came) gives those
// who came the certificate it is for. Staff add their own from My space; a
// manager checks it. The daily round reminds a month and a week before one
// runs out (jobs/dailyAlerts.js).

var DAY = /^\d{4}-\d{2}-\d{2}$/;
var SOON = 30;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function daysBetween(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function addMonths(day, n) { var d = new Date(day + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('training.manage')) fail('forbidden', 'Your role does not allow this action (training.manage).'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }

function stateOf(expires, t) {
  if (!expires) return { state: 'ok', daysLeft: null };
  var left = daysBetween(t, dayText(expires));
  return { state: left < 0 ? 'expired' : left <= SOON ? 'soon' : 'ok', daysLeft: left };
}
function certOut(c, t) {
  var s = stateOf(c.expires_on, t || today());
  return {
    id: c.id, employeeId: c.employee_id, employee: c.first_name ? nameOf(c.first_name, c.last_name) : undefined, typeId: c.type_id, type: c.type_name, number: c.number, issuer: c.issuer,
    issuedOn: dayText(c.issued_on), expiresOn: dayText(c.expires_on), state: s.state, daysLeft: s.daysLeft, hasPhoto: !!c.photo, note: c.note,
    verified: !!c.verified_at, verifiedBy: c.v_first ? nameOf(c.v_first, c.v_last) : null, verifiedAt: c.verified_at, createdAt: c.created_at
  };
}
var CSEL = 'SELECT c.*, t.name AS type_name, e.first_name, e.last_name, v.first_name AS v_first, v.last_name AS v_last FROM staff_certs c JOIN cert_types t ON t.id = c.type_id ' +
  'JOIN employees e ON e.id = c.employee_id LEFT JOIN employees v ON v.id = c.verified_by ';

async function typesOf() {
  return (await pool.query('SELECT * FROM cert_types WHERE active ORDER BY name')).rows.map(function (t) {
    return { id: t.id, name: t.name, validMonths: t.valid_months, requiredFor: t.required_for || [] };
  });
}

// GET /api/training?company= — the matrix: people by certificate.
async function overview(ctx, q) {
  need(ctx);
  q = q || {};
  var t = today();
  var companies = (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows;
  var types = await typesOf();
  var co = companies.find(function (c) { return c.id === q.company; }) || null;
  var people = (await pool.query("SELECT e.id, e.first_name, e.last_name, e.code, e.position_title, d.company_id, c.name AS company FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id " +
    "WHERE e.status = 'active'" + (co ? ' AND d.company_id = $1' : '') + ' ORDER BY c.name, e.first_name, e.last_name LIMIT 600', co ? [co.id] : [])).rows;
  var certs = (await pool.query(CSEL + 'WHERE c.employee_id = ANY($1::uuid[]) ORDER BY c.expires_on DESC NULLS FIRST', [people.map(function (p) { return p.id; })])).rows;
  // Each person's latest of each kind.
  var latest = new Map();
  certs.forEach(function (c) { var k = c.employee_id + ':' + c.type_id; var have = latest.get(k); if (!have || (dayText(c.expires_on) || '9999') > (dayText(have.expires_on) || '9999')) latest.set(k, c); });
  var counts = { ok: 0, soon: 0, expired: 0, missing: 0, unverified: 0 };
  var rows = people.map(function (p) {
    var cells = {};
    types.forEach(function (ty) {
      var c = latest.get(p.id + ':' + ty.id);
      var required = ty.requiredFor.indexOf(p.company_id) >= 0;
      if (c) {
        var o = certOut(c, t);
        cells[ty.id] = { id: o.id, state: o.state, expiresOn: o.expiresOn, daysLeft: o.daysLeft, verified: o.verified, required: required };
        counts[o.state]++;
        if (!o.verified) counts.unverified++;
      } else if (required) { cells[ty.id] = { state: 'missing', required: true }; counts.missing++; }
    });
    return { id: p.id, name: nameOf(p.first_name, p.last_name), code: p.code, position: p.position_title || '', company: p.company, companyId: p.company_id, cells: cells };
  });
  var due = certs.map(function (c) { return certOut(c, t); }).filter(function (c) { return c.state !== 'ok' && latest.get(c.employeeId + ':' + c.typeId) && latest.get(c.employeeId + ':' + c.typeId).id === c.id; })
    .sort(function (a, b) { return a.daysLeft - b.daysLeft; }).slice(0, 30);
  var sessions = (await pool.query("SELECT s.*, t.name AS type_name, (SELECT count(*)::int FROM training_attendees WHERE training_id = s.id) AS invited, (SELECT count(*)::int FROM training_attendees WHERE training_id = s.id AND status = 'attended') AS came " +
    "FROM trainings s LEFT JOIN cert_types t ON t.id = s.type_id WHERE s.day >= current_date - 60 ORDER BY s.day DESC LIMIT 20")).rows.map(sessionOut);
  return {
    companies: companies, company: co ? co.id : '', types: types, people: rows, counts: counts, due: due, sessions: sessions,
    unverified: (await pool.query(CSEL + 'WHERE c.verified_at IS NULL ORDER BY c.created_at DESC LIMIT 20')).rows.map(function (c) { return certOut(c, t); }),
    staff: (await pool.query("SELECT e.id, e.first_name, e.last_name, d.company_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name LIMIT 1000")).rows.map(function (e) { return { id: e.id, name: nameOf(e.first_name, e.last_name), companyId: e.company_id }; }),
    today: t
  };
}
function sessionOut(s) {
  return {
    id: s.id, companyId: s.company_id, title: s.title, typeId: s.type_id, type: s.type_name || '', day: dayText(s.day), starts: s.starts ? String(s.starts).slice(0, 5) : null, hours: s.hours == null ? null : Number(s.hours),
    location: s.location, trainer: s.trainer, notes: s.notes, invited: s.invited || 0, came: s.came || 0, upcoming: dayText(s.day) >= today()
  };
}

// GET /api/training/people/:id — one person's certificates and sessions.
async function person(ctx, id) {
  var pid = uuidOr(id);
  if (!pid) fail('notfound', 'Who?');
  if (pid !== me(ctx)) need(ctx);
  var e = (await pool.query('SELECT e.id, e.first_name, e.last_name, e.code, e.position_title, d.company_id, c.name AS company FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.id = $1', [pid])).rows[0];
  if (!e) fail('notfound', 'That person is gone.');
  var t = today();
  var types = await typesOf();
  var certs = (await pool.query(CSEL + 'WHERE c.employee_id = $1 ORDER BY c.expires_on DESC NULLS LAST, c.created_at DESC', [pid])).rows.map(function (c) { return certOut(c, t); });
  var have = certs.map(function (c) { return c.typeId; });
  return {
    person: { id: e.id, name: nameOf(e.first_name, e.last_name), code: e.code, position: e.position_title || '', company: e.company || '' },
    certs: certs, types: types,
    missing: types.filter(function (ty) { return ty.requiredFor.indexOf(e.company_id) >= 0 && have.indexOf(ty.id) < 0; }).map(function (ty) { return { id: ty.id, name: ty.name }; }),
    sessions: (await pool.query('SELECT s.*, t.name AS type_name, a.status FROM training_attendees a JOIN trainings s ON s.id = a.training_id LEFT JOIN cert_types t ON t.id = s.type_id WHERE a.employee_id = $1 ORDER BY s.day DESC LIMIT 12', [pid])).rows.map(function (s) {
      var o = sessionOut(s); o.status = s.status; return o;
    }),
    canManage: ctx.can('training.manage')
  };
}
// GET /api/training/mine
async function mine(ctx) {
  if (!me(ctx)) fail('forbidden', 'Sign in as a member of staff.');
  return person(ctx, me(ctx));
}

// POST /api/training/certs { id?, employeeId, typeId, number, issuer, issuedOn, expiresOn, photo, note }
// A manager's are checked as they are added; a person's own wait for a check.
async function saveCert(ctx, p) {
  p = p || {};
  var manage = ctx.can('training.manage');
  var cur = p.id ? (await pool.query('SELECT * FROM staff_certs WHERE id = $1', [uuidOr(p.id)])).rows[0] : null;
  if (p.id && !cur) fail('notfound', 'That certificate is gone.');
  var emp = cur ? cur.employee_id : uuidOr(p.employeeId) || me(ctx);
  if (!emp) fail('invalid', 'Whose certificate is it?');
  if (!manage && emp !== me(ctx)) fail('forbidden', 'Your role does not allow this action (training.manage).');
  if (!manage && cur && cur.verified_at) fail('conflict', 'It has been checked: ask your manager to change it.');
  var ty = (await pool.query('SELECT * FROM cert_types WHERE id = $1', [uuidOr(p.typeId) || (cur && cur.type_id)])).rows[0];
  if (!ty) fail('invalid', 'Which certificate?');
  var issued = DAY.test(String(p.issuedOn || '')) ? p.issuedOn : null;
  if (issued && issued > today()) fail('invalid', 'Issued on a day to come?');
  var expires = DAY.test(String(p.expiresOn || '')) ? p.expiresOn : issued && ty.valid_months ? addMonths(issued, ty.valid_months) : null;
  if (ty.valid_months && !expires) fail('invalid', 'When was it issued, or when does it run out?');
  if (issued && expires && expires < issued) fail('invalid', 'It cannot run out before it was issued.');
  var photo = cur ? cur.photo : null;
  if (p.photo) { var ph = await require('./restaurantCashOffice.service').photoFrom(p.photo, 'certificate'); photo = { key: ph.key, type: ph.type }; }
  var f = [emp, ty.id, text(p.number, 60), text(p.issuer, 80), issued, expires, photo, text(p.note, 300)];
  var id;
  if (cur) {
    id = cur.id;
    await pool.query('UPDATE staff_certs SET employee_id = $2, type_id = $3, number = $4, issuer = $5, issued_on = $6, expires_on = $7, photo = $8, note = $9, verified_by = $10, verified_at = CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END, updated_at = now() WHERE id = $1',
      [id].concat(f, [manage ? me(ctx) : null]));
  } else {
    id = (await pool.query('INSERT INTO staff_certs (employee_id, type_id, number, issuer, issued_on, expires_on, photo, note, verified_by, verified_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9::uuid IS NULL THEN NULL ELSE now() END,$10) RETURNING id',
      f.concat([manage ? me(ctx) : null, me(ctx)]))).rows[0].id;
  }
  var who = (await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [emp])).rows[0];
  if (!manage) {
    var holders = await require('./staffAlerts.service').holdersOf(['training.manage']);
    for (var i = 0; i < holders.length; i++) if (holders[i].employee_id !== me(ctx)) await notify(pool, holders[i].employee_id, '📜 Check ' + nameOf(who.first_name, who.last_name) + '\'s ' + ty.name, 'Added from My space' + (expires ? ', until ' + expires : '') + '.', '/training?person=' + emp);
  }
  await audit(pool, ctx, 'training.cert', 'staff_cert', id, nameOf(who.first_name, who.last_name) + ': ' + ty.name + (expires ? ' until ' + expires : '') + (manage ? '' : ' (to check)') + '.');
  return person(ctx, emp);
}
// POST /api/training/certs/:id/verify
async function verify(ctx, id) {
  need(ctx);
  var c = (await pool.query('UPDATE staff_certs SET verified_by = $2, verified_at = now(), updated_at = now() WHERE id = $1 RETURNING *', [uuidOr(id), me(ctx)])).rows[0];
  if (!c) fail('notfound', 'That certificate is gone.');
  await audit(pool, ctx, 'training.verify', 'staff_cert', c.id, 'Checked a certificate.');
  return person(ctx, c.employee_id);
}
// DELETE /api/training/certs/:id
async function removeCert(ctx, id) {
  var c = (await pool.query('SELECT * FROM staff_certs WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!c) fail('notfound', 'That certificate is gone.');
  if (!ctx.can('training.manage') && !(c.employee_id === me(ctx) && !c.verified_at)) fail('forbidden', 'Your role does not allow this action (training.manage).');
  await pool.query('DELETE FROM staff_certs WHERE id = $1', [c.id]);
  if (c.photo) await require('../lib/fileStore').del(c.photo.key);
  await audit(pool, ctx, 'training.cert', 'staff_cert', c.id, 'Removed a certificate.');
  return person(ctx, c.employee_id);
}
async function photoKey(ctx, id) {
  var c = (await pool.query('SELECT employee_id, photo FROM staff_certs WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!c || !c.photo) fail('notfound', 'No photo.');
  if (c.employee_id !== me(ctx)) need(ctx);
  return c.photo;
}

// POST /api/training/types { id?, name, validMonths, requiredFor: [companyId] }
async function saveType(ctx, p) {
  need(ctx);
  p = p || {};
  var name = text(p.name, 80);
  if (name.length < 3) fail('invalid', 'Name the certificate.');
  var months = p.validMonths === '' || p.validMonths == null ? null : Math.round(Number(p.validMonths));
  if (months != null && !(months >= 1 && months <= 240)) fail('invalid', 'Valid for 1 to 240 months, or leave it empty.');
  var req = (Array.isArray(p.requiredFor) ? p.requiredFor : []).map(uuidOr).filter(Boolean);
  try {
    if (p.id) await pool.query('UPDATE cert_types SET name = $2, valid_months = $3, required_for = $4, active = $5 WHERE id = $1', [uuidOr(p.id), name, months, req, p.active === undefined ? true : !!p.active]);
    else await pool.query('INSERT INTO cert_types (name, valid_months, required_for) VALUES ($1, $2, $3)', [name, months, req]);
  } catch (e) { if (e.code === '23505') fail('conflict', 'There is one called that already.'); throw e; }
  await audit(pool, ctx, 'training.type', 'cert_type', p.id || null, 'Certificate ' + name + ': ' + (months ? 'valid ' + months + ' months' : 'no fixed term') + ', needed in ' + req.length + ' compan' + (req.length === 1 ? 'y' : 'ies') + '.');
  return overview(ctx, {});
}

// POST /api/training/sessions { title, typeId, companyId, day, starts, hours, location, trainer, notes, employeeIds }
async function saveSession(ctx, p) {
  need(ctx);
  p = p || {};
  var title = text(p.title, 100);
  if (title.length < 3) fail('invalid', 'What is the training?');
  var day = DAY.test(String(p.day || '')) ? p.day : fail('invalid', 'Which day?');
  var starts = /^\d{2}:\d{2}$/.test(String(p.starts || '')) ? p.starts : null;
  var hours = p.hours === '' || p.hours == null ? null : Math.round(Number(p.hours) * 10) / 10;
  if (hours != null && !(hours > 0 && hours <= 100)) fail('invalid', 'How many hours?');
  var people = (Array.isArray(p.employeeIds) ? p.employeeIds : []).map(uuidOr).filter(Boolean);
  if (!people.length) fail('invalid', 'Who is invited?');
  var s = await withTransaction(async function (db) {
    var row = (await db.query('INSERT INTO trainings (company_id, title, type_id, day, starts, hours, location, trainer, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [uuidOr(p.companyId), title, uuidOr(p.typeId), day, starts, hours, text(p.location, 80), text(p.trainer, 80), text(p.notes, 500), me(ctx)])).rows[0];
    for (var i = 0; i < people.length; i++) await db.query('INSERT INTO training_attendees (training_id, employee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, people[i]]);
    return row;
  });
  if (day >= today()) for (var i = 0; i < people.length; i++) await notify(pool, people[i], '🎓 Training: ' + title, day + (starts ? ' at ' + starts : '') + (s.location ? ' · ' + s.location : ''), '/myspace');
  await audit(pool, ctx, 'training.session', 'training', s.id, 'Training ' + title + ' on ' + day + ', ' + people.length + ' invited.');
  return session(ctx, s.id);
}
// GET /api/training/sessions/:id
async function session(ctx, id) {
  need(ctx);
  var s = (await pool.query('SELECT s.*, t.name AS type_name FROM trainings s LEFT JOIN cert_types t ON t.id = s.type_id WHERE s.id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That training is gone.');
  var out = sessionOut(s);
  out.attendees = (await pool.query('SELECT a.status, e.id, e.first_name, e.last_name, e.position_title FROM training_attendees a JOIN employees e ON e.id = a.employee_id WHERE a.training_id = $1 ORDER BY e.first_name', [s.id])).rows.map(function (a) {
    return { id: a.id, name: nameOf(a.first_name, a.last_name), position: a.position_title || '', status: a.status };
  });
  out.invited = out.attendees.length;
  out.came = out.attendees.filter(function (a) { return a.status === 'attended'; }).length;
  return out;
}
// POST /api/training/sessions/:id/attendance { marks: { employeeId: 'attended' | 'missed' | 'invited' } }
// Those who came get the session's certificate, from that day.
async function attendance(ctx, id, p) {
  need(ctx);
  var s = (await pool.query('SELECT s.*, t.valid_months, t.name AS type_name FROM trainings s LEFT JOIN cert_types t ON t.id = s.type_id WHERE s.id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That training is gone.');
  if (dayText(s.day) > today()) fail('conflict', 'Mark who came on the day, or after.');
  var marks = (p && p.marks) || {};
  var given = 0;
  await withTransaction(async function (db) {
    for (var emp in marks) {
      var st = ['attended', 'missed', 'invited'].indexOf(marks[emp]) >= 0 ? marks[emp] : null;
      if (!st || !uuidOr(emp)) continue;
      var r = await db.query('UPDATE training_attendees SET status = $3 WHERE training_id = $1 AND employee_id = $2 RETURNING employee_id', [s.id, emp, st]);
      if (!r.rowCount || st !== 'attended' || !s.type_id) continue;
      var have = (await db.query('SELECT 1 FROM staff_certs WHERE employee_id = $1 AND type_id = $2 AND issued_on = $3', [emp, s.type_id, s.day])).rows[0];
      if (have) continue;
      await db.query('INSERT INTO staff_certs (employee_id, type_id, issuer, issued_on, expires_on, note, verified_by, verified_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$7)',
        [emp, s.type_id, s.trainer || '', s.day, s.valid_months ? addMonths(dayText(s.day), s.valid_months) : null, 'From the training: ' + s.title, me(ctx)]);
      given++;
    }
  });
  await audit(pool, ctx, 'training.attendance', 'training', s.id, 'Attendance for ' + s.title + (given ? '; ' + given + ' certificate(s) given' : '') + '.');
  var out = await session(ctx, s.id);
  out.given = given;
  return out;
}

// For the daily round: the latest of each person's certificates that runs
// out within a month (or has), for staff still with us.
async function dueSoon(day) {
  return (await pool.query("SELECT DISTINCT ON (c.employee_id, c.type_id) c.id, c.employee_id, c.expires_on, t.name AS type_name, e.first_name, e.last_name FROM staff_certs c JOIN cert_types t ON t.id = c.type_id JOIN employees e ON e.id = c.employee_id " +
    "WHERE e.status = 'active' AND t.active AND c.expires_on IS NOT NULL ORDER BY c.employee_id, c.type_id, c.expires_on DESC")).rows.filter(function (c) {
    return daysBetween(day, dayText(c.expires_on)) <= SOON && daysBetween(day, dayText(c.expires_on)) >= -60;
  });
}

module.exports = { overview: overview, person: person, mine: mine, saveCert: saveCert, verify: verify, removeCert: removeCert, photoKey: photoKey, saveType: saveType, saveSession: saveSession, session: session, attendance: attendance, dueSoon: dueSoon };
