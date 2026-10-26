var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Maintenance on assets: services and repairs done (completed), or planned
// for a day (scheduled) and marked done later. A completed service moves
// the asset's next service date on by its service interval, when it has
// one (migration 0087), and an asset in for repair is back in use.
//
// A problem can also be reported (migration 0196) before anyone plans the
// repair — from a restaurant's till (restaurantEquipment.service.js) or by
// anyone on the factory floor (OS → Report a problem): what is wrong, how
// bad (stopped, still working, unsafe), photos. Stopped or unsafe takes the
// asset out of use until it is fixed; whoever looks after assets is told.

var URGENCIES = ['stopped', 'working', 'unsafe'];
var MAX_PHOTOS = 3;

function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : null; }

function rowToRecord(r, extra) {
  return Object.assign({
    id: r.id, assetId: r.asset_id, date: r.date, technician: r.technician, cost: Number(r.cost),
    faultReport: r.fault_report, downtimeHours: Number(r.downtime_hours), partsReplaced: r.parts_replaced, status: r.status,
    notes: r.notes || '', completedAt: r.completed_at || null,
    urgency: r.urgency || '', photos: (r.photos || []).length, source: r.source || 'office', reportedAt: r.reported_at || null
  }, extra || {});
}

var LIST_SELECT = 'SELECT m.*, a.asset_no, a.description, a.category, a.location, a.status AS asset_status, a.company_id, c.name AS company_name, ' +
  'e.first_name, e.last_name, re.first_name AS rep_first, re.last_name AS rep_last FROM maintenance_records m JOIN assets a ON a.id = m.asset_id ' +
  'LEFT JOIN companies c ON c.id = a.company_id LEFT JOIN employees e ON e.id = m.created_by LEFT JOIN employees re ON re.id = m.reported_by ';
function listOut(r) {
  return rowToRecord(r, {
    assetLabel: r.asset_no + ' — ' + r.description, assetNo: r.asset_no, assetName: r.description, assetCategory: r.category,
    assetLocation: r.location || '', assetStatus: r.asset_status, companyId: r.company_id || null, companyName: r.company_name || '',
    loggedBy: r.first_name ? r.first_name + ' ' + r.last_name : null, reportedBy: nameOf(r.rep_first, r.rep_last)
  });
}

// kernel.js: handlers['maintenance.list'] — reported problems first.
async function list(ctx) {
  if (!ctx.can('asset.read')) fail('forbidden', 'Your role does not allow this action (asset.read).');
  var res = await pool.query(LIST_SELECT + "ORDER BY (m.status = 'reported') DESC, m.date DESC");
  return res.rows.map(listOut);
}

// After a completed service: the next one is due an interval later, and an
// asset that was in for repair is back in use.
async function afterService(client, asset, date, nextServiceDate) {
  var next = nextServiceDate || (asset.service_interval_days ? addDays(date, asset.service_interval_days) : null);
  if (next) await client.query('UPDATE assets SET next_service_date = $1 WHERE id = $2', [next, asset.id]);
  if (asset.status === 'in_repair') await client.query("UPDATE assets SET status = 'in_use' WHERE id = $1", [asset.id]);
}

// kernel.js: handlers['maintenance.create']
async function create(ctx, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var assetRes = await pool.query('SELECT * FROM assets WHERE id = $1', [p.assetId || null]);
  var asset = assetRes.rows[0];
  if (!asset) fail('invalid', 'Choose an asset.');

  var planned = p.status === 'scheduled';
  var technician = planned ? String(p.technician || '').trim().slice(0, 60) : V.text(p.technician, 'Technician', 60);
  var faultReport = V.text(p.faultReport, planned ? 'What needs doing' : 'Fault report', 300);
  var date = V.date(p.date || todayISO(), 'Date');
  if (!planned && date > todayISO()) fail('invalid', 'Work done cannot be in the future; plan it instead.');
  var nextServiceDate = p.nextServiceDate ? V.date(p.nextServiceDate, 'Next service date') : null;

  return withTransaction(async function (client) {
    var m = await insertPlanned(client, asset, { planned: planned, date: date, technician: technician, faultReport: faultReport, cost: p.cost, downtimeHours: p.downtimeHours,
      partsReplaced: p.partsReplaced, notes: p.notes, by: ctx.employee.id, nextServiceDate: nextServiceDate });
    await audit(client, ctx, 'maintenance.create', 'maintenance', m.id, (planned ? 'Planned maintenance on ' : 'Logged maintenance on ') + asset.asset_no + ': ' + faultReport);
    return rowToRecord(m);
  });
}
// Work planned for a day, or done already: the record, and the asset's dates.
async function insertPlanned(client, asset, f) {
  var res = await client.query(
    'INSERT INTO maintenance_records (asset_id, date, technician, cost, fault_report, downtime_hours, parts_replaced, status, created_by, completed_at, notes, source) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
    [asset.id, f.date, f.technician, f.planned ? 0 : Math.max(0, Number(f.cost) || 0), f.faultReport, f.planned ? 0 : Math.max(0, Number(f.downtimeHours) || 0),
      f.planned ? '' : String(f.partsReplaced || '').trim(), f.planned ? 'scheduled' : 'completed', f.by, f.planned ? null : new Date(), String(f.notes || '').trim().slice(0, 500), f.source || 'office']
  );
  var m = res.rows[0];
  if (f.planned) {
    if (!asset.next_service_date || f.date < asset.next_service_date) await client.query('UPDATE assets SET next_service_date = $1 WHERE id = $2', [f.date, asset.id]);
  } else {
    await afterService(client, asset, f.date, f.nextServiceDate || null);
  }
  return m;
}

// Reported or planned work is done: who did it, what it cost, parts and
// downtime, a photo. The OS (asset.manage) and a restaurant's back office
// both come here.
async function completeWith(client, id, p, byId) {
  var m = (await client.query('SELECT * FROM maintenance_records WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!m) fail('notfound', 'Maintenance record not found.');
  if (m.status === 'completed') fail('conflict', 'That work is already marked done.');
  var asset = (await client.query('SELECT * FROM assets WHERE id = $1', [m.asset_id])).rows[0];
  var technician = V.text(p.technician || m.technician, 'Technician', 60);
  var date = V.date(p.date || todayISO(), 'Date');
  if (date > todayISO()) fail('invalid', 'Work done cannot be in the future.');
  var photos = m.photos || [];
  if (p.photo) photos = photos.concat([await require('./restaurantCashOffice.service').photoFrom(p.photo, 'repair-done')]).slice(-6);
  var updated = (await client.query(
    "UPDATE maintenance_records SET status = 'completed', technician = $2, date = $3, cost = $4, downtime_hours = $5, parts_replaced = $6, " +
    'notes = $7, completed_at = now(), photos = $8, created_by = coalesce(created_by, $9) WHERE id = $1 RETURNING *',
    [id, technician, date, Math.max(0, Number(p.cost) || 0), Math.max(0, Number(p.downtimeHours) || 0), String(p.partsReplaced || '').trim().slice(0, 300),
      String(p.notes || m.notes || '').trim().slice(0, 500), JSON.stringify(photos), byId || null]
  )).rows[0];
  // The planned date no longer holds the asset's next service.
  // A problem reported (planned or not) is a repair: it moves no service
  // date on, and the asset is back in use unless something else stops it.
  if (!m.reported_at && asset.next_service_date && String(asset.next_service_date) === String(m.date)) await client.query('UPDATE assets SET next_service_date = NULL WHERE id = $1', [asset.id]);
  if (m.reported_at) {
    if (p.nextServiceDate) await client.query('UPDATE assets SET next_service_date = $2 WHERE id = $1', [asset.id, V.date(p.nextServiceDate, 'Next service date')]);
    await backInUse(client, asset.id);
  } else {
    await afterService(client, asset, date, p.nextServiceDate ? V.date(p.nextServiceDate, 'Next service date') : null);
  }
  return { record: updated, asset: asset, was: m };
}

// A planned service is done: who did it, what it cost, parts and downtime.
async function complete(ctx, id, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  p = p || {};
  var out = await withTransaction(async function (client) {
    var done = await completeWith(client, id, p, ctx.employee ? ctx.employee.id : null);
    await audit(client, ctx, 'maintenance.complete', 'maintenance', id, 'Done: ' + done.record.fault_report + ' on ' + done.asset.asset_no + '.');
    return done;
  });
  if (out.was.reported_at) await tellReporter(out.was, out.asset, out.record);
  return rowToRecord(out.record);
}

// A planned service that will not happen, or a problem that is not one.
async function remove(ctx, id) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  var m = (await pool.query('SELECT * FROM maintenance_records WHERE id = $1', [id])).rows[0];
  if (!m) fail('notfound', 'Maintenance record not found.');
  if (m.status === 'completed') fail('conflict', 'Work already done stays on record.');
  await withTransaction(async function (client) {
    await client.query('DELETE FROM maintenance_records WHERE id = $1', [id]);
    await backInUse(client, m.asset_id);
  });
  await audit(pool, ctx, 'maintenance.delete', 'maintenance', id, (m.reported_at ? 'Dismissed a reported problem: ' : 'Removed planned work: ') + m.fault_report + '.');
  return true;
}
// Nothing stopped is left open on it: back in use.
async function backInUse(client, assetId) {
  var left = (await client.query("SELECT 1 FROM maintenance_records WHERE asset_id = $1 AND reported_at IS NOT NULL AND status <> 'completed' AND urgency IN ('stopped', 'unsafe') LIMIT 1", [assetId])).rows[0];
  if (!left) await client.query("UPDATE assets SET status = 'in_use' WHERE id = $1 AND status = 'in_repair'", [assetId]);
}

// ── problems reported ──

// Whoever looks after assets is told, the report linked.
async function tellManagers(asset, rec, who) {
  var holders = await require('./staffAlerts.service').holdersOf(['asset.manage']);
  var icon = rec.urgency === 'unsafe' ? '⚠️' : rec.urgency === 'stopped' ? '🛑' : '🔧';
  var words = { stopped: 'stopped working', unsafe: 'not safe to use', working: 'still working' }[rec.urgency] || '';
  for (var i = 0; i < holders.length; i++) {
    if (rec.reported_by && holders[i].employee_id === rec.reported_by) continue;
    await notify(pool, holders[i].employee_id, icon + ' ' + asset.description + (words ? ': ' + words : ''),
      text(rec.fault_report, 120) + (who ? ' — ' + who : '') + (asset.location ? ' · ' + asset.location : ''), '/assets?problem=' + rec.id);
  }
}
// Who reported it is told it is fixed.
async function tellReporter(was, asset, rec) {
  if (!was.reported_by || was.reported_by === rec.created_by) return;
  var user = (await pool.query("SELECT 1 FROM users WHERE employee_id = $1 AND status = 'active'", [was.reported_by])).rows[0];
  if (!user) return;
  await notify(pool, was.reported_by, '✅ Fixed: ' + asset.description, text(was.fault_report, 120) + (rec.technician ? ' — ' + rec.technician : ''), '/report-problem');
}

// The report itself — the till and the OS both come here. f: { what,
// urgency, photos: [dataUrl], source, by }.
async function reportProblem(asset, f) {
  var what = text(f.what, 300);
  if (what.length < 3) fail('invalid', 'What is wrong? A few words.');
  var urgency = URGENCIES.indexOf(f.urgency) >= 0 ? f.urgency : fail('invalid', 'Is it still working?');
  if (asset.status === 'retired') fail('conflict', 'That one is retired.');
  var photos = [];
  var given = (Array.isArray(f.photos) ? f.photos : []).slice(0, MAX_PHOTOS);
  for (var i = 0; i < given.length; i++) photos.push(await require('./restaurantCashOffice.service').photoFrom(given[i], 'problem-' + asset.asset_no.toLowerCase()));
  var rec = await withTransaction(async function (client) {
    var open = (await client.query("SELECT id FROM maintenance_records WHERE asset_id = $1 AND status = 'reported' AND lower(fault_report) = lower($2) AND reported_at > now() - interval '1 day'", [asset.id, what])).rows[0];
    if (open) fail('conflict', 'That was reported already today.');
    var row = (await client.query(
      "INSERT INTO maintenance_records (asset_id, date, technician, fault_report, status, urgency, photos, reported_by, reported_at, source) VALUES ($1, $2, '', $3, 'reported', $4, $5, $6, now(), $7) RETURNING *",
      [asset.id, todayISO(), what, urgency, JSON.stringify(photos), f.by || null, f.source])).rows[0];
    if (urgency !== 'working') await client.query("UPDATE assets SET status = 'in_repair', updated_at = now() WHERE id = $1 AND status = 'in_use'", [asset.id]);
    return row;
  });
  var who = f.by ? (await pool.query('SELECT first_name, last_name FROM employees WHERE id = $1', [f.by])).rows[0] : null;
  await tellManagers(asset, rec, who ? nameOf(who.first_name, who.last_name) : f.whoName || null);
  return rec;
}

// GET /api/maintenance/report — anyone signed in: what can be reported on
// (assets in use or in for repair), and the problems they reported lately.
async function reportChoices(ctx) {
  if (!ctx.employee) fail('forbidden', 'Sign in as a member of staff to report a problem.');
  var assets = (await pool.query(
    "SELECT a.id, a.asset_no, a.description, a.category, a.location, a.status, c.id AS company_id, c.name AS company_name, " +
    "(SELECT count(*) FROM maintenance_records m WHERE m.asset_id = a.id AND m.status = 'reported')::int AS open FROM assets a LEFT JOIN companies c ON c.id = a.company_id " +
    "WHERE a.status <> 'retired' ORDER BY c.name NULLS LAST, a.location, a.description LIMIT 1000")).rows;
  var mine = (await pool.query(LIST_SELECT + "WHERE m.reported_by = $1 AND (m.status <> 'completed' OR m.completed_at > now() - interval '30 days') ORDER BY m.reported_at DESC LIMIT 20", [ctx.employee.id])).rows;
  return {
    assets: assets.map(function (a) { return { id: a.id, assetNo: a.asset_no, name: a.description, category: a.category, location: a.location || '', status: a.status, companyId: a.company_id, companyName: a.company_name || '', open: a.open }; }),
    // Their own reports: what was done, not what it cost.
    mine: mine.map(function (m) { var o = listOut(m); delete o.cost; delete o.downtimeHours; delete o.partsReplaced; delete o.loggedBy; return o; }), urgencies: URGENCIES
  };
}

// POST /api/maintenance/report { assetId, what, urgency, photos } — anyone
// signed in, e.g. a machine on the factory floor.
async function report(ctx, p) {
  if (!ctx.employee) fail('forbidden', 'Sign in as a member of staff to report a problem.');
  p = p || {};
  var asset = (await pool.query('SELECT * FROM assets WHERE id = $1', [/^[0-9a-f-]{36}$/i.test(String(p.assetId || '')) ? p.assetId : null])).rows[0];
  if (!asset) fail('invalid', 'Which machine or piece of equipment?');
  var rec = await reportProblem(asset, { what: p.what, urgency: p.urgency, photos: p.photos, source: 'floor', by: ctx.employee.id });
  await audit(pool, ctx, 'maintenance.reported', 'maintenance', rec.id, 'Problem reported on ' + asset.asset_no + ' (' + asset.description + '): ' + rec.fault_report + ' [' + rec.urgency + '].');
  return listOut(Object.assign({}, rec, { asset_no: asset.asset_no, description: asset.description, category: asset.category, location: asset.location, asset_status: asset.status, company_id: asset.company_id,
    rep_first: ctx.employee.first_name, rep_last: ctx.employee.last_name }));
}

// POST /api/maintenance/:id/schedule { date, technician, notes } — a
// reported problem gets its repair visit.
async function schedule(ctx, id, p) {
  if (!ctx.can('asset.manage')) fail('forbidden', 'Your role does not allow this action (asset.manage).');
  p = p || {};
  var date = V.date(p.date || todayISO(), 'Date');
  var row = (await pool.query("UPDATE maintenance_records SET status = 'scheduled', date = $2, technician = $3, notes = CASE WHEN $4 <> '' THEN $4 ELSE notes END WHERE id = $1 AND status = 'reported' RETURNING *",
    [id, date, text(p.technician, 60), text(p.notes, 500)])).rows[0];
  if (!row) fail('conflict', 'Only a reported problem can be planned like this.');
  await audit(pool, ctx, 'maintenance.scheduled', 'maintenance', id, 'Repair planned for ' + date + (p.technician ? ' with ' + text(p.technician, 60) : '') + ': ' + row.fault_report + '.');
  return rowToRecord(row);
}

// GET /api/maintenance/:id/photos/:n — whoever sees assets, or reported it.
async function photoKey(ctx, id, n) {
  var r = (await pool.query('SELECT photos, reported_by FROM maintenance_records WHERE id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'No such photo.');
  if (!ctx.can('asset.read') && !(ctx.employee && r.reported_by === ctx.employee.id)) fail('forbidden', 'Your role does not allow this action (asset.read).');
  var ph = (r.photos || [])[Number(n)];
  if (!ph) fail('notfound', 'No such photo.');
  return { key: ph.key, name: 'problem-' + (Number(n) + 1) + (ph.type === 'image/png' ? '.png' : '.jpg') };
}

module.exports = {
  URGENCIES: URGENCIES, list: list, create: create, complete: complete, remove: remove, completeWith: completeWith, insertPlanned: insertPlanned, backInUse: backInUse,
  reportProblem: reportProblem, reportChoices: reportChoices, report: report, schedule: schedule, photoKey: photoKey, tellReporter: tellReporter, rowToRecord: rowToRecord
};
