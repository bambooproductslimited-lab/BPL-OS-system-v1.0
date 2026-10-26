var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');
var maintenance = require('./maintenance.service');

// A restaurant's equipment on its till (migration 0196) — the same assets
// register as the OS (Assets), kept to this restaurant: fridges, freezers,
// cookers, the generator, the gas, the coffee machine.
//
//  - Anyone on the till or the kitchen screen reports a problem (More →
//    Something broken?): which one, what is wrong, still working or not,
//    a photo. Whoever looks after assets in the OS is told.
//  - The manager, in the back office (Setup → Equipment): every piece, its
//    next service and warranty, the problems open, the repair or service
//    done (who, what it cost, a photo), the next service planned, and new
//    equipment added.

var REPORTERS = ['till', 'kds', 'stock', 'delivery'];
var CATEGORIES = ['Fridge and freezer', 'Cooking', 'Coffee and drinks', 'Power and gas', 'Air and water', 'Furniture', 'Electronics', 'Other'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') : String(d).slice(0, 10); }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function nameOf(first, last) { return first ? (first + ' ' + (last || '')).trim() : ''; }

function equipmentOut(a, open, last) {
  var next = dayText(a.next_service_date);
  var left = next ? Math.round((Date.parse(next + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000) : null;
  return {
    id: a.id, assetNo: a.asset_no, name: a.description, category: a.category, location: a.location || '', serialNo: a.serial_no || '', status: a.status,
    purchaseDate: dayText(a.purchase_date), purchasePrice: round2(a.purchase_price), warrantyUntil: dayText(a.warranty_until), underWarranty: !!(a.warranty_until && dayText(a.warranty_until) >= today()),
    serviceIntervalDays: a.service_interval_days || null, nextServiceDate: next, serviceIn: left, notes: a.notes || '',
    open: open || [], last: last || null
  };
}
function problemOut(m) {
  return {
    id: m.id, assetId: m.asset_id, status: m.status, what: m.fault_report, urgency: m.urgency || '', date: dayText(m.date), technician: m.technician || '',
    photos: (m.photos || []).length, reportedBy: nameOf(m.rep_first, m.rep_last), reportedAt: m.reported_at, source: m.source,
    cost: round2(m.cost), notes: m.notes || '', partsReplaced: m.parts_replaced || '', completedAt: m.completed_at, doneBy: nameOf(m.by_first, m.by_last)
  };
}
var REC_SELECT = 'SELECT m.*, re.first_name AS rep_first, re.last_name AS rep_last, be.first_name AS by_first, be.last_name AS by_last FROM maintenance_records m ' +
  'JOIN assets a ON a.id = m.asset_id LEFT JOIN employees re ON re.id = m.reported_by LEFT JOIN employees be ON be.id = m.created_by ';

async function assetOf(companyId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('invalid', 'Which one?');
  var a = (await pool.query('SELECT * FROM assets WHERE id = $1 AND company_id = $2', [id, companyId])).rows[0];
  if (!a) fail('notfound', 'That is not this restaurant\'s equipment.');
  return a;
}

// GET /api/pos/equipment — for the report: this restaurant's equipment.
async function choices(token) {
  var s = await access.need(token, REPORTERS);
  var rows = (await pool.query(
    "SELECT a.*, (SELECT count(*) FROM maintenance_records m WHERE m.asset_id = a.id AND m.status = 'reported')::int AS open_n FROM assets a WHERE a.company_id = $1 AND a.status <> 'retired' ORDER BY a.location, a.description",
    [s.posCompanyId])).rows;
  return { equipment: rows.map(function (a) { return { id: a.id, name: a.description, category: a.category, location: a.location || '', status: a.status, open: a.open_n }; }), canManage: s.access.role === 'manager' };
}

// POST /api/pos/equipment/report { assetId, what, urgency, photo } — anyone
// signed in on the till or the kitchen screen.
async function report(token, p, ip) {
  p = p || {};
  var s = await access.need(token, REPORTERS);
  var a = await assetOf(s.posCompanyId, p.assetId);
  var rec = await maintenance.reportProblem(a, { what: p.what, urgency: p.urgency, photos: p.photo ? [p.photo] : [], source: 'till', by: s.posEmployeeId });
  await activity.log(pool, { companyId: s.posCompanyId, employeeId: s.posEmployeeId, app: 'till', action: 'equipment.reported',
    summary: 'Problem reported on ' + a.description + (a.location ? ' (' + a.location + ')' : '') + ': ' + rec.fault_report + ' — ' + { stopped: 'stopped working', working: 'still working', unsafe: 'not safe to use' }[rec.urgency] + '.',
    refType: 'maintenance', refId: rec.id });
  void ip;
  return { id: rec.id, name: a.description, urgency: rec.urgency };
}

// What the back office shows: every piece of equipment, what is open, what
// was done lately, and what to look at.
async function view(company) {
  var assets = (await pool.query('SELECT * FROM assets WHERE company_id = $1 ORDER BY (status = \'retired\'), location, description', [company])).rows;
  var ids = assets.map(function (a) { return a.id; });
  var recs = ids.length ? (await pool.query(REC_SELECT + "WHERE m.asset_id = ANY($1::uuid[]) AND (m.status <> 'completed' OR m.completed_at > now() - interval '120 days') ORDER BY m.status = 'completed', coalesce(m.completed_at, m.reported_at, m.date::timestamptz) DESC", [ids])).rows : [];
  var open = recs.filter(function (m) { return m.status !== 'completed'; }), done = recs.filter(function (m) { return m.status === 'completed'; });
  var list = assets.map(function (a) {
    var mine = open.filter(function (m) { return m.asset_id === a.id; }).map(problemOut);
    var last = done.find(function (m) { return m.asset_id === a.id; });
    return equipmentOut(a, mine, last ? problemOut(last) : null);
  });
  var live = list.filter(function (e) { return e.status !== 'retired'; });
  return {
    equipment: list, recent: done.slice(0, 20).map(function (m) { var a = assets.find(function (x) { return x.id === m.asset_id; }); return Object.assign(problemOut(m), { name: a ? a.description : '' }); }),
    summary: {
      problems: open.filter(function (m) { return m.status === 'reported'; }).length, stopped: live.filter(function (e) { return e.status === 'in_repair'; }).length,
      planned: open.filter(function (m) { return m.status === 'scheduled' || m.status === 'in_progress'; }).length,
      serviceDue: live.filter(function (e) { return e.serviceIn !== null && e.serviceIn >= 0 && e.serviceIn <= 7; }).length,
      serviceLate: live.filter(function (e) { return e.serviceIn !== null && e.serviceIn < 0; }).length,
      spent90: round2(done.filter(function (m) { return m.completed_at && new Date(m.completed_at) > new Date(Date.now() - 90 * 86400000); }).reduce(function (t, m) { return t + Number(m.cost); }, 0))
    },
    categories: CATEGORIES, today: today()
  };
}

// The asset's fields from the till; this restaurant's, numbered as the OS does.
function fieldsOf(e) {
  var name = text(e.name, 120);
  if (name.length < 2) fail('invalid', 'What is it? e.g. Walk-in fridge.');
  var interval = e.serviceIntervalDays === '' || e.serviceIntervalDays == null ? null : Math.round(Number(e.serviceIntervalDays));
  if (interval !== null && !(interval > 0 && interval <= 3650)) fail('invalid', 'Serviced every how many days? 1 or more.');
  var date = function (v, label) { if (v === '' || v == null) return null; if (!DAY.test(String(v))) fail('invalid', label + ': pick a day.'); return v; };
  return {
    name: name, category: text(e.category, 40) || 'Other', location: text(e.location, 120), serialNo: text(e.serialNo, 80), notes: text(e.notes, 1000),
    purchaseDate: date(e.purchaseDate, 'Bought on'), purchasePrice: Math.max(0, round2(e.purchasePrice)), warrantyUntil: date(e.warrantyUntil, 'Warranty until'),
    serviceIntervalDays: interval, nextServiceDate: date(e.nextServiceDate, 'Next service'), status: ['in_use', 'in_repair', 'retired'].indexOf(e.status) >= 0 ? e.status : 'in_use'
  };
}

// POST /api/pos/settings/equipment { managerPin, action: 'list' | 'save' |
// 'fix' | 'plan' | 'dismiss', … }
async function tab(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId, by = m.manager;
  var who = nameOf(by.first_name, by.last_name);
  var done = null;
  if (p.action === 'save') {
    var f = fieldsOf(p.equipment || {});
    var saved = await withTransaction(async function (db) {
      if (p.equipment && p.equipment.id) {
        var cur = await assetOf(company, p.equipment.id);
        var retiredOn = f.status === 'retired' ? (cur.retired_on || today()) : null;
        await db.query(
          'UPDATE assets SET category = $2, description = $3, location = $4, serial_no = $5, notes = $6, purchase_date = $7, purchase_price = $8, warranty_until = $9, ' +
          'service_interval_days = $10, next_service_date = $11, status = $12, retired_on = $13, updated_at = now() WHERE id = $1',
          [cur.id, f.category, f.name, f.location, f.serialNo, f.notes, f.purchaseDate, f.purchasePrice, f.warrantyUntil, f.serviceIntervalDays, f.nextServiceDate, f.status, retiredOn]);
        return { id: cur.id, no: cur.asset_no, isNew: false };
      }
      await db.query("SELECT pg_advisory_xact_lock(hashtext('assets'))");
      var n = (await db.query("SELECT coalesce(max(substring(asset_no from '^AST-(\\d+)$')::int), 0) AS n FROM assets")).rows[0].n;
      var no = 'AST-' + String(n + 1).padStart(3, '0');
      var next = f.nextServiceDate || (f.serviceIntervalDays ? addDays(today(), f.serviceIntervalDays) : null);
      var row = (await db.query(
        'INSERT INTO assets (asset_no, category, description, purchase_date, purchase_price, location, condition, warranty_until, next_service_date, company_id, serial_no, notes, status, service_interval_days, updated_at) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,'good',$7,$8,$9,$10,$11,$12,$13, now()) RETURNING id",
        [no, f.category, f.name, f.purchaseDate, f.purchasePrice, f.location, f.warrantyUntil, next, company, f.serialNo, f.notes, f.status, f.serviceIntervalDays])).rows[0];
      return { id: row.id, no: no, isNew: true };
    });
    await activity.log(pool, { companyId: company, employeeId: by.id, app: 'settings', action: 'settings.equipment',
      summary: (saved.isNew ? 'Equipment added: ' : 'Equipment changed: ') + f.name + ' (' + saved.no + ')' + (f.status === 'retired' ? ', retired' : '') + ', by ' + who + '.', refType: 'asset', refId: saved.id });
    done = { saved: saved.id };
  } else if (p.action === 'fix') {
    // Repaired, or serviced: who did it, what it cost, a photo.
    var rec = await recordOf(company, p.id);
    var out = await withTransaction(async function (db) { return maintenance.completeWith(db, rec.id, p.done || {}, by.id); });
    await maintenance.tellReporter(out.was, out.asset, out.record);
    await activity.log(pool, { companyId: company, employeeId: by.id, app: 'settings', action: 'settings.equipment',
      summary: (out.was.reported_at ? 'Fixed: ' : 'Serviced: ') + out.asset.description + ' — ' + out.record.fault_report + ' (' + out.record.technician + (Number(out.record.cost) ? ', GHS ' + round2(out.record.cost).toFixed(2) : '') + ').',
      amount: Number(out.record.cost) || null, refType: 'maintenance', refId: rec.id });
    done = { fixed: rec.id };
  } else if (p.action === 'plan') {
    // A service or repair visit planned for a day.
    var date = DAY.test(String(p.date || '')) ? p.date : fail('invalid', 'Pick the day.');
    if (date < today()) fail('invalid', 'That day is past.');
    if (p.id) {
      var r = await recordOf(company, p.id);
      if (r.status !== 'reported') fail('conflict', 'That is planned already.');
      await pool.query("UPDATE maintenance_records SET status = 'scheduled', date = $2, technician = $3 WHERE id = $1", [r.id, date, text(p.technician, 60)]);
      done = { planned: r.id };
    } else {
      var a = await assetOf(company, p.assetId);
      var what = text(p.what, 300) || 'Service';
      var made = await withTransaction(async function (db) {
        return maintenance.insertPlanned(db, a, { planned: true, date: date, technician: text(p.technician, 60), faultReport: what, by: by.id, source: 'till' });
      });
      done = { planned: made.id };
    }
    await activity.log(pool, { companyId: company, employeeId: by.id, app: 'settings', action: 'settings.equipment', summary: 'Visit planned for ' + date + (p.technician ? ' with ' + text(p.technician, 60) : '') + ', by ' + who + '.', refType: 'maintenance', refId: done.planned });
  } else if (p.action === 'dismiss') {
    var d = await recordOf(company, p.id);
    if (d.status === 'completed') fail('conflict', 'Work done stays on record.');
    await withTransaction(async function (db) {
      await db.query('DELETE FROM maintenance_records WHERE id = $1', [d.id]);
      await maintenance.backInUse(db, d.asset_id);
    });
    await activity.log(pool, { companyId: company, employeeId: by.id, app: 'settings', action: 'settings.equipment', summary: 'Taken off the list: ' + d.fault_report + ', by ' + who + '.', refType: 'maintenance', refId: d.id });
    done = { dismissed: d.id };
  }
  return Object.assign(await view(company), { done: done });
}
async function recordOf(company, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) fail('notfound', 'That is gone.');
  var r = (await pool.query('SELECT m.* FROM maintenance_records m JOIN assets a ON a.id = m.asset_id WHERE m.id = $1 AND a.company_id = $2', [id, company])).rows[0];
  if (!r) fail('notfound', 'That is gone.');
  return r;
}

// GET /api/pos/equipment/photo/:id/:n
async function photoOf(token, id, n) {
  var s = await access.need(token, REPORTERS);
  var r = await recordOf(s.posCompanyId, id);
  var ph = (r.photos || [])[Number(n)];
  if (!ph) fail('notfound', 'No such photo.');
  return { key: ph.key, name: 'equipment-' + (Number(n) + 1) + (ph.type === 'image/png' ? '.png' : '.jpg') };
}

// For the owner's view: problems open, out of use, services due.
async function forOwner(companyIds) {
  var out = {};
  if (!companyIds.length) return out;
  (await pool.query(
    "SELECT a.company_id, count(DISTINCT m.id) FILTER (WHERE m.reported_at IS NOT NULL AND m.status <> 'completed')::int AS problems, count(DISTINCT a.id) FILTER (WHERE a.status = 'in_repair')::int AS stopped, " +
    "count(DISTINCT a.id) FILTER (WHERE a.status <> 'retired' AND a.next_service_date <= current_date + 7)::int AS service_due " +
    'FROM assets a LEFT JOIN maintenance_records m ON m.asset_id = a.id WHERE a.company_id = ANY($1::uuid[]) GROUP BY a.company_id', [companyIds])).rows
    .forEach(function (r) { out[r.company_id] = { problems: r.problems, stopped: r.stopped, serviceDue: r.service_due }; });
  return out;
}

module.exports = { CATEGORIES: CATEGORIES, choices: choices, report: report, tab: tab, view: view, photoOf: photoOf, forOwner: forOwner };
