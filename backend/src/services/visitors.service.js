var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Visitors and gate passes (Operations → Visitors and gate passes; migration
// 0199). The front desk signs visitors in and out, and their host is told
// they have arrived; anyone expecting someone adds them from My space and
// sends them their pass (a link with a code to show at the gate). Who is on
// site right now — staff clocked in and visitors in — for a fire roll call.
// Goods leaving the site go on a gate pass: asked for, approved by a manager,
// checked out at the gate by security and, if it is coming back, checked
// back in; late returns are chased each day (jobs/dailyAlerts.js).

var PURPOSES = ['meeting', 'delivery', 'interview', 'contractor', 'customer', 'official', 'other'];
var REASONS = ['delivery', 'repair', 'loan', 'return_to_supplier', 'sold', 'disposal', 'other'];
var REQUEST_PERMS = ['visitor.manage', 'gatepass.approve', 'inventory.manage', 'asset.manage', 'toolroom.manage', 'warehouse.manage', 'waybill.manage', 'itdevice.manage'];

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function newCode() { return crypto.randomBytes(5).toString('base64').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6).padEnd(6, 'X'); }
function passRef(n) { return 'GP-' + String(n).padStart(4, '0'); }

var VSEL = 'SELECT v.*, h.first_name AS h_first, h.last_name AS h_last, h.phone AS h_phone, c.name AS company FROM visitors v LEFT JOIN employees h ON h.id = v.host_id LEFT JOIN companies c ON c.id = v.company_id ';
function visitorOut(v, full) {
  var out = {
    id: v.id, name: v.name, fromOrg: v.from_org, purpose: v.purpose, status: v.status, code: v.code,
    host: v.host_id ? { id: v.host_id, name: nameOf(v.h_first, v.h_last) } : null, company: v.company || '', companyId: v.company_id,
    expectedAt: v.expected_at, arrivedAt: v.arrived_at, leftAt: v.left_at, badge: v.badge, vehicle: v.vehicle, note: v.note
  };
  if (full) { out.phone = v.phone; out.email = v.email; }
  return out;
}
var PSEL = 'SELECT p.*, c.name AS company, r.first_name AS r_first, r.last_name AS r_last, a.first_name AS a_first, a.last_name AS a_last FROM gate_passes p LEFT JOIN companies c ON c.id = p.company_id ' +
  'LEFT JOIN employees r ON r.id = p.requested_by LEFT JOIN employees a ON a.id = p.approved_by ';
function passOut(p) {
  var items = p.items || [];
  return {
    id: p.id, number: p.number, ref: passRef(p.number), company: p.company || '', companyId: p.company_id, items: items, count: items.reduce(function (s, i) { return s + (Number(i.qty) || 0); }, 0),
    carrier: p.carrier, vehicle: p.vehicle, reason: p.reason, returnable: p.returnable, backBy: dayText(p.back_by), note: p.note, status: p.status,
    requestedBy: p.requested_by ? { id: p.requested_by, name: nameOf(p.r_first, p.r_last) } : null, approvedBy: p.approved_by ? nameOf(p.a_first, p.a_last) : null, approvedAt: p.approved_at,
    rejectReason: p.reject_reason, outAt: p.out_at, backAt: p.back_at, createdAt: p.created_at,
    late: p.status === 'out' && p.returnable && p.back_by && dayText(p.back_by) < today()
  };
}

async function people() {
  return (await pool.query("SELECT e.id, e.first_name, e.last_name, e.position_title, e.phone, c.name AS company FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows.map(function (p) {
    return { id: p.id, name: nameOf(p.first_name, p.last_name), position: p.position_title || '', company: p.company || '' };
  });
}

// GET /api/visitors?company= — the front desk: expected today, on site,
// gone; the gate passes waiting.
async function desk(ctx, q) {
  if (!ctx.can('visitor.manage') && !ctx.can('gatepass.approve')) fail('forbidden', 'Your role does not allow this action (visitor.manage).');
  q = q || {};
  var company = uuidOr(q.company);
  var cArgs = company ? [company] : [];
  var cWhere = company ? ' AND v.company_id = $1' : '';
  var front = ctx.can('visitor.manage');
  var todayRows = front ? (await pool.query(VSEL + "WHERE (v.status = 'in' OR coalesce(v.arrived_at, v.expected_at)::date = current_date OR (v.status = 'expected' AND v.expected_at::date = current_date))" + cWhere + ' ORDER BY coalesce(v.arrived_at, v.expected_at)', cArgs)).rows.map(function (v) { return visitorOut(v, true); }) : [];
  var upcoming = front ? (await pool.query(VSEL + "WHERE v.status = 'expected' AND v.expected_at::date > current_date AND v.expected_at < now() + interval '8 days'" + cWhere + ' ORDER BY v.expected_at LIMIT 20', cArgs)).rows.map(function (v) { return visitorOut(v, true); }) : [];
  var history = front ? (await pool.query(VSEL + "WHERE v.status = 'out' AND v.left_at::date < current_date AND v.left_at > now() - interval '30 days'" + cWhere + ' ORDER BY v.left_at DESC LIMIT 30', cArgs)).rows.map(function (v) { return visitorOut(v, false); }) : [];
  var passes = (await pool.query(PSEL + "WHERE (p.status IN ('requested', 'approved') OR (p.status = 'out' AND p.returnable) OR p.created_at > now() - interval '14 days')" + (company ? ' AND p.company_id = $1' : '') + ' ORDER BY p.created_at DESC LIMIT 60', cArgs)).rows.map(passOut);
  var week = (await pool.query("SELECT to_char(coalesce(arrived_at, expected_at), 'YYYY-MM-DD') AS d, count(*)::int AS n FROM visitors v WHERE v.arrived_at > current_date - 13" + cWhere + ' GROUP BY 1', cArgs)).rows;
  var days = [];
  for (var i = 13; i >= 0; i--) { var d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); var r = week.find(function (x) { return x.d === d; }); days.push({ day: d, visitors: r ? r.n : 0 }); }
  return {
    companies: (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows, company: company || '', people: await people(), purposes: PURPOSES, reasons: REASONS,
    today: todayRows, upcoming: upcoming, history: history, passes: passes, days: days, canDesk: front, canApprove: ctx.can('gatepass.approve'),
    summary: {
      expected: todayRows.filter(function (v) { return v.status === 'expected'; }).length, inside: todayRows.filter(function (v) { return v.status === 'in'; }).length,
      gone: todayRows.filter(function (v) { return v.status === 'out'; }).length,
      toApprove: passes.filter(function (p) { return p.status === 'requested'; }).length, toGo: passes.filter(function (p) { return p.status === 'approved'; }).length,
      outBack: passes.filter(function (p) { return p.status === 'out' && p.returnable; }).length, late: passes.filter(function (p) { return p.late; }).length
    }
  };
}

async function visitorOf(id) {
  var v = (await pool.query(VSEL + 'WHERE v.id = $1', [uuidOr(id)])).rows[0];
  if (!v) fail('notfound', 'That visitor is gone.');
  return v;
}
async function hostOf(id) {
  if (!uuidOr(id)) return null;
  var h = (await pool.query("SELECT e.id, e.first_name, e.last_name, d.company_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1 AND e.status = 'active'", [id])).rows[0];
  if (!h) fail('invalid', 'Pick who they are here to see.');
  return h;
}

async function insertVisitor(db, f) {
  for (var t = 0; t < 5; t++) {
    try {
      return (await db.query(
        'INSERT INTO visitors (company_id, name, phone, email, from_org, host_id, purpose, expected_at, arrived_at, badge, vehicle, code, status, note, created_by, signed_in_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id',
        [f.company, f.name, f.phone, f.email, f.fromOrg, f.host, f.purpose, f.expectedAt, f.arrivedAt, f.badge, f.vehicle, newCode(), f.status, f.note, f.by, f.signedInBy])).rows[0].id;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  fail('unavailable', 'Try again.');
}
function fieldsOf(p) {
  var name = text(p.name, 80);
  if (name.length < 3) fail('invalid', 'Their full name?');
  var email = text(p.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('invalid', 'That email address does not look right.');
  return { name: name, phone: text(p.phone, 30), email: email, fromOrg: text(p.fromOrg, 80), purpose: PURPOSES.indexOf(p.purpose) >= 0 ? p.purpose : 'meeting', vehicle: text(p.vehicle, 30), badge: text(p.badge, 20), note: text(p.note, 300) };
}

// POST /api/visitors/expect { name, phone, email, fromOrg, purpose,
// expectedAt, hostId, companyId, note } — anyone expecting someone.
async function expect(ctx, p) {
  p = p || {};
  if (!me(ctx)) fail('forbidden', 'Only staff add visitors.');
  var f = fieldsOf(p);
  var at = p.expectedAt ? new Date(p.expectedAt) : null;
  if (!at || isNaN(at.getTime())) fail('invalid', 'When are they coming?');
  if (at.getTime() < Date.now() - 12 * 3600000) fail('invalid', 'That time has passed.');
  var host = ctx.can('visitor.manage') && p.hostId ? await hostOf(p.hostId) : await hostOf(me(ctx));
  var id = await insertVisitor(pool, Object.assign(f, { company: uuidOr(p.companyId) || host.company_id, host: host.id, expectedAt: at, arrivedAt: null, status: 'expected', by: me(ctx), signedInBy: null }));
  await audit(pool, ctx, 'visitor.expect', 'visitor', id, f.name + ' expected ' + at.toISOString().slice(0, 16).replace('T', ' ') + ' (GMT).');
  return visitorOut(await visitorOf(id), true);
}

// POST /api/visitors/in { id } or { name, …, hostId } — signed in at the
// desk; the host is told.
async function signIn(ctx, p) {
  need(ctx, 'visitor.manage');
  p = p || {};
  var id;
  if (p.id) {
    var v = await visitorOf(p.id);
    if (v.status !== 'expected') fail('conflict', v.status === 'in' ? 'They are signed in already.' : 'That visit is over.');
    await pool.query("UPDATE visitors SET status = 'in', arrived_at = now(), badge = $2, vehicle = coalesce(nullif($3, ''), vehicle), signed_in_by = $4 WHERE id = $1", [v.id, text(p.badge, 20), text(p.vehicle, 30), me(ctx)]);
    id = v.id;
  } else {
    var f = fieldsOf(p);
    var host = await hostOf(p.hostId);
    if (!host && f.purpose !== 'delivery') fail('invalid', 'Who are they here to see?');
    id = await insertVisitor(pool, Object.assign(f, { company: uuidOr(p.companyId) || (host && host.company_id) || null, host: host ? host.id : null, expectedAt: null, arrivedAt: new Date(), status: 'in', by: me(ctx), signedInBy: me(ctx) }));
  }
  var row = await visitorOf(id);
  if (row.host_id && row.host_id !== me(ctx)) await notify(pool, row.host_id, '🛎️ ' + row.name + ' is at reception', [row.from_org, row.purpose === 'meeting' ? '' : row.purpose.replace('_', ' ')].filter(Boolean).join(' · ') || 'Here to see you.', '/myspace');
  await audit(pool, ctx, 'visitor.in', 'visitor', id, row.name + ' signed in' + (row.host_id ? ' to see ' + nameOf(row.h_first, row.h_last) : '') + '.');
  return visitorOut(row, true);
}

// POST /api/visitors/:id/out
async function signOut(ctx, id) {
  need(ctx, 'visitor.manage');
  var v = await visitorOf(id);
  if (v.status !== 'in') fail('conflict', 'They are not signed in.');
  await pool.query("UPDATE visitors SET status = 'out', left_at = now(), signed_out_by = $2 WHERE id = $1", [v.id, me(ctx)]);
  await audit(pool, ctx, 'visitor.out', 'visitor', v.id, v.name + ' signed out.');
  return visitorOut(await visitorOf(v.id), true);
}
// POST /api/visitors/:id/cancel — the host or the desk.
async function cancel(ctx, id) {
  var v = await visitorOf(id);
  if (!ctx.can('visitor.manage') && v.host_id !== me(ctx)) fail('forbidden', 'That visit is not yours.');
  if (v.status !== 'expected') fail('conflict', 'Only a visit still to come can be cancelled.');
  await pool.query("UPDATE visitors SET status = 'cancelled' WHERE id = $1", [v.id]);
  await audit(pool, ctx, 'visitor.cancel', 'visitor', v.id, 'Visit by ' + v.name + ' cancelled.');
  return visitorOut(await visitorOf(v.id), true);
}

// GET /api/visitors/mine — My space: who is coming to see me, who is here.
async function mine(ctx) {
  var id = me(ctx);
  if (!id) return { visitors: [] };
  var rows = (await pool.query(VSEL + "WHERE v.host_id = $1 AND (v.status = 'in' OR (v.status = 'expected' AND v.expected_at > now() - interval '12 hours') OR (v.status = 'out' AND v.left_at > now() - interval '1 day')) ORDER BY coalesce(v.arrived_at, v.expected_at) LIMIT 10", [id])).rows;
  return { visitors: rows.map(function (v) { return visitorOut(v, true); }), purposes: PURPOSES, companies: (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows };
}

// GET /api/visitors/rollcall?company= — who is on site now: staff clocked in
// and not out, visitors signed in.
async function rollCall(ctx, q) {
  if (!ctx.can('visitor.manage') && !ctx.can('safety.manage')) fail('forbidden', 'Your role does not allow this action (visitor.manage).');
  var company = uuidOr((q || {}).company);
  var staff = (await pool.query(
    'SELECT e.id, e.first_name, e.last_name, e.position_title, d.name AS department, c.name AS company, a.clock_in FROM attendance a JOIN employees e ON e.id = a.employee_id ' +
    'LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
    "WHERE a.date = current_date AND a.clock_in IS NOT NULL AND a.clock_out IS NULL AND e.status = 'active'" + (company ? ' AND d.company_id = $1' : '') + ' ORDER BY c.name, d.name, e.first_name', company ? [company] : [])).rows.map(function (s) {
    return { id: s.id, name: nameOf(s.first_name, s.last_name), position: s.position_title || '', department: s.department || '', company: s.company || '', since: s.clock_in ? String(s.clock_in).slice(0, 5) : '' };
  });
  var visitors = (await pool.query(VSEL + "WHERE v.status = 'in'" + (company ? ' AND v.company_id = $1' : '') + ' ORDER BY v.arrived_at', company ? [company] : [])).rows.map(function (v) { return visitorOut(v, true); });
  return { at: new Date().toISOString(), staff: staff, visitors: visitors, total: staff.length + visitors.length };
}

// GET /api/visit/:code — the visitor's own pass, no sign-in.
async function pass(code) {
  var v = (await pool.query(VSEL + 'WHERE v.code = $1', [String(code || '').toUpperCase().slice(0, 12)])).rows[0];
  if (!v || v.status === 'cancelled') fail('notfound', 'That pass is not valid.');
  return { name: v.name, fromOrg: v.from_org, host: nameOf(v.h_first, v.h_last), company: v.company || '', expectedAt: v.expected_at, arrivedAt: v.arrived_at, leftAt: v.left_at, status: v.status, code: v.code, purpose: v.purpose };
}

// ── Gate passes ──
async function passOf(id) {
  var p = (await pool.query(PSEL + 'WHERE p.id = $1', [uuidOr(id)])).rows[0];
  if (!p) fail('notfound', 'That gate pass is gone.');
  return p;
}

// POST /api/visitors/passes { companyId, items: [{ what, qty }], carrier,
// vehicle, reason, returnable, backBy, note }
async function requestPass(ctx, p) {
  if (!REQUEST_PERMS.some(function (k) { return ctx.can(k); })) fail('forbidden', 'Your role does not allow this action (gatepass).');
  p = p || {};
  var items = (Array.isArray(p.items) ? p.items : []).map(function (i) { return { what: text(i && i.what, 120), qty: Math.max(1, Math.min(100000, Math.round(Number(i && i.qty) || 1))) }; }).filter(function (i) { return i.what.length >= 2; }).slice(0, 30);
  if (!items.length) fail('invalid', 'What is going out?');
  var reason = REASONS.indexOf(p.reason) >= 0 ? p.reason : 'other';
  var returnable = !!p.returnable;
  var backBy = returnable ? (/^\d{4}-\d{2}-\d{2}$/.test(String(p.backBy || '')) && p.backBy >= today() ? p.backBy : fail('invalid', 'When does it come back?')) : null;
  var company = uuidOr(p.companyId) || ((await pool.query('SELECT d.company_id FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.id = $1', [me(ctx)])).rows[0] || {}).company_id || null;
  var row = await withTransaction(async function (db) {
    await db.query('LOCK TABLE gate_passes IN SHARE ROW EXCLUSIVE MODE');
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM gate_passes')).rows[0].n;
    return (await db.query('INSERT INTO gate_passes (number, company_id, items, carrier, vehicle, reason, returnable, back_by, note, requested_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [n, company, JSON.stringify(items), text(p.carrier, 80), text(p.vehicle, 30), reason, returnable, backBy, text(p.note, 300), me(ctx)])).rows[0];
  });
  var summary = items.map(function (i) { return i.qty + ' × ' + i.what; }).join(', ');
  // A manager who asks for one approves it at once.
  if (ctx.can('gatepass.approve')) return decide(ctx, row.id, { approve: true });
  var holders = await require('./staffAlerts.service').holdersOf(['gatepass.approve']);
  for (var i = 0; i < holders.length; i++) if (holders[i].employee_id !== me(ctx)) await notify(pool, holders[i].employee_id, '🚪 Gate pass to approve: ' + passRef(row.number), summary.slice(0, 160), '/visitors?pass=' + row.id);
  await audit(pool, ctx, 'gatepass.request', 'gate_pass', row.id, passRef(row.number) + ' asked for: ' + summary + '.');
  return passOut(await passOf(row.id));
}

// POST /api/visitors/passes/:id/decide { approve, reason }
async function decide(ctx, id, p) {
  need(ctx, 'gatepass.approve');
  p = p || {};
  var g = await passOf(id);
  if (g.status !== 'requested') fail('conflict', 'It has been decided already.');
  if (p.approve) {
    await pool.query("UPDATE gate_passes SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1", [g.id, me(ctx)]);
  } else {
    var reason = text(p.reason, 200);
    if (reason.length < 3) fail('invalid', 'Why not? A few words.');
    await pool.query("UPDATE gate_passes SET status = 'rejected', approved_by = $2, approved_at = now(), reject_reason = $3 WHERE id = $1", [g.id, me(ctx), reason]);
  }
  if (g.requested_by && g.requested_by !== me(ctx)) await notify(pool, g.requested_by, (p.approve ? '✅ Gate pass approved: ' : '🚫 Gate pass turned down: ') + passRef(g.number), p.approve ? 'Security can let it out.' : text(p.reason, 200), '/visitors?pass=' + g.id);
  await audit(pool, ctx, 'gatepass.decide', 'gate_pass', g.id, passRef(g.number) + (p.approve ? ' approved.' : ' turned down.'));
  return passOut(await passOf(g.id));
}

// POST /api/visitors/passes/:id/out (and /back) — security at the gate.
async function gate(ctx, id, back) {
  need(ctx, 'visitor.manage');
  var g = await passOf(id);
  if (back) {
    if (g.status !== 'out' || !g.returnable) fail('conflict', 'It is not out to come back.');
    await pool.query("UPDATE gate_passes SET status = 'back', back_at = now(), back_checked_by = $2 WHERE id = $1", [g.id, me(ctx)]);
  } else {
    if (g.status !== 'approved') fail('conflict', g.status === 'requested' ? 'It is not approved yet: it cannot go out.' : 'It cannot go out now.');
    await pool.query("UPDATE gate_passes SET status = 'out', out_at = now(), out_by = $2 WHERE id = $1", [g.id, me(ctx)]);
  }
  if (g.requested_by && g.requested_by !== me(ctx)) await notify(pool, g.requested_by, (back ? '↩️ Back through the gate: ' : '🚚 Out of the gate: ') + passRef(g.number), (g.items || []).map(function (i) { return i.qty + ' × ' + i.what; }).join(', ').slice(0, 160), '/visitors?pass=' + g.id);
  await audit(pool, ctx, 'gatepass.gate', 'gate_pass', g.id, passRef(g.number) + (back ? ' came back.' : ' went out.'));
  return passOut(await passOf(g.id));
}

// GET /api/visitors/passes/:id
async function getPass(ctx, id) {
  var g = await passOf(id);
  if (!ctx.can('visitor.manage') && !ctx.can('gatepass.approve') && g.requested_by !== me(ctx)) fail('forbidden', 'That gate pass is not yours to see.');
  return passOut(g);
}

// For the daily round: returnable goods not back by their day.
async function latePasses() {
  return (await pool.query("SELECT id, number, requested_by, back_by, items FROM gate_passes WHERE status = 'out' AND returnable AND back_by < current_date")).rows;
}

module.exports = { desk: desk, expect: expect, signIn: signIn, signOut: signOut, cancel: cancel, mine: mine, rollCall: rollCall, pass: pass, requestPass: requestPass, decide: decide, gate: gate, getPass: getPass, latePasses: latePasses, REQUEST_PERMS: REQUEST_PERMS };
