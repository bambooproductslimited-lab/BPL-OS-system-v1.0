var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Opening and closing checklists on the till (migration 0194): a manager
// writes the lists — things to do (a tick: "gas on, check for leaks") and
// things to read (a number in a range: "fridge 2, 0 to 5 °C") — for opening,
// closing or any time. Each day staff go through them on the till: who did
// each and when is kept; a reading out of its range is flagged and goes on
// the activity log for the manager. Done when every item is.

var AT = ['open', 'close', 'any'];
var MAX_LISTS = 12, MAX_ITEMS = 30;
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function nameOf(e) { return e ? (e.first_name + ' ' + (e.last_name || '')).trim() : ''; }
function numOrNull(v) { return v === '' || v === null || v === undefined || !isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100; }

function cleanItems(raw) {
  var list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_ITEMS) fail('invalid', 'Up to ' + MAX_ITEMS + ' things on one list.');
  var keys = new Set();
  var items = list.map(function (it) {
    it = it || {};
    var t = text(it.text, 140);
    if (t.length < 2) return null;
    var key = /^[a-z0-9]{6,16}$/.test(String(it.key || '')) && !keys.has(it.key) ? it.key : crypto.randomBytes(5).toString('hex');
    keys.add(key);
    if (it.kind === 'reading') {
      var min = numOrNull(it.min), max = numOrNull(it.max);
      if (min !== null && max !== null && max < min) fail('invalid', '"' + t + '": the highest it may be is below the lowest.');
      return { key: key, text: t, kind: 'reading', unit: text(it.unit, 12), min: min, max: max };
    }
    return { key: key, text: t, kind: 'tick' };
  }).filter(Boolean);
  if (!items.length) fail('invalid', 'Put at least one thing on the list.');
  return items;
}
function listOut(r) { return { id: r.id, name: r.name, at: r.at, items: r.items || [], active: r.active }; }
function rangeWords(it) {
  var u = it.unit ? ' ' + it.unit : '';
  return it.min !== null && it.max !== null ? it.min + ' to ' + it.max + u : it.min !== null ? 'at least ' + it.min + u : it.max !== null ? 'no more than ' + it.max + u : '';
}
function isBad(it, value) { return (it.min !== null && value < it.min) || (it.max !== null && value > it.max); }

// Today's lists with how far they are: [{ id, name, at, items: [{ …, done,
// value, bad, by, at }], done, total, finished }].
async function todayOf(companyId, day) {
  var lists = (await pool.query('SELECT * FROM restaurant_checklists WHERE company_id = $1 AND active ORDER BY sort_order, created_at', [companyId])).rows;
  var runs = lists.length ? (await pool.query(
    'SELECT r.*, e.first_name, e.last_name FROM restaurant_checklist_runs r LEFT JOIN employees e ON e.id = r.finished_by WHERE r.company_id = $1 AND r.day = $2', [companyId, day])).rows : [];
  return lists.map(function (l) {
    var run = runs.find(function (r) { return r.checklist_id === l.id; });
    var got = (run && run.items) || {};
    var items = (l.items || []).map(function (it) { return Object.assign({}, it, got[it.key] || { done: false }); });
    var done = items.filter(function (i) { return i.done; }).length;
    return { id: l.id, name: l.name, at: l.at, items: items, done: done, total: items.length, bad: items.filter(function (i) { return i.bad; }).length,
      finished: run && run.finished_at ? { at: run.finished_at, by: nameOf(run) } : null };
  });
}

// GET /api/pos/checklists — today's, for anyone on the till.
async function mine(token) {
  var s = await access.need(token, ['till', 'kds', 'stock', 'delivery']);
  var lists = await todayOf(s.posCompanyId, today());
  return { day: today(), lists: lists, open: lists.filter(function (l) { return !l.finished; }).length, canManage: s.access.role === 'manager' };
}

// POST /api/pos/checklists/mark { checklistId, key, done, value } — one
// thing done (or undone), with its reading.
async function mark(token, p) {
  p = p || {};
  var s = await access.need(token, ['till', 'kds', 'stock', 'delivery']);
  var company = s.posCompanyId, day = today();
  var l = (await pool.query('SELECT * FROM restaurant_checklists WHERE id = $1 AND company_id = $2 AND active', [p.checklistId, company])).rows[0];
  if (!l) fail('notfound', 'That checklist is gone.');
  var it = (l.items || []).find(function (x) { return x.key === p.key; });
  if (!it) fail('notfound', 'That is not on the list any more.');
  var me = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [s.posEmployeeId])).rows[0];
  var entry = { done: false };
  if (p.done !== false) {
    entry = { done: true, by: nameOf(me), at: new Date().toISOString() };
    if (it.kind === 'reading') {
      var v = numOrNull(p.value);
      if (v === null) fail('invalid', 'Type the reading for "' + it.text + '".');
      entry.value = v;
      entry.bad = isBad(it, v);
    }
  }
  var run = (await pool.query(
    'INSERT INTO restaurant_checklist_runs (company_id, checklist_id, day, items) VALUES ($1,$2,$3,jsonb_build_object($4::text, $5::jsonb)) ' +
    'ON CONFLICT (checklist_id, day) DO UPDATE SET items = restaurant_checklist_runs.items || jsonb_build_object($4::text, $5::jsonb) RETURNING *',
    [company, l.id, day, it.key, JSON.stringify(entry)])).rows[0];
  if (entry.bad) {
    await activity.log(pool, { companyId: company, employeeId: me.id, app: 'till', action: 'till.checklist_bad',
      summary: l.name + ': ' + it.text + ' read ' + entry.value + (it.unit ? ' ' + it.unit : '') + ', out of range (' + rangeWords(it) + ').' });
  }
  // All done: the list is finished (once).
  var allDone = (l.items || []).every(function (x) { return run.items[x.key] && run.items[x.key].done; });
  if (allDone && !run.finished_at) {
    await pool.query('UPDATE restaurant_checklist_runs SET finished_at = now(), finished_by = $2 WHERE id = $1 AND finished_at IS NULL', [run.id, me.id]);
    var bad = (l.items || []).filter(function (x) { return run.items[x.key] && run.items[x.key].bad; }).length;
    await activity.log(pool, { companyId: company, employeeId: me.id, app: 'till', action: 'till.checklist_done',
      summary: l.name + ' done' + (bad ? ', ' + bad + ' reading' + (bad === 1 ? '' : 's') + ' out of range' : '') + '.' });
  } else if (!allDone && run.finished_at) {
    await pool.query('UPDATE restaurant_checklist_runs SET finished_at = NULL, finished_by = NULL WHERE id = $1', [run.id]);
  }
  return mine(token);
}

// POST /api/pos/checklists/manage { action: list|save|remove|move, list:
// { id, name, at, items }, id, managerPin } — a manager's lists, and the
// last two weeks: each day, each list, how far it got and the readings out
// of range.
async function manage(token, p, ip) {
  p = p || {};
  var m = await access.settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  if (p.action === 'save') {
    var x = p.list || {};
    var name = text(x.name, 60);
    if (name.length < 2) fail('invalid', 'Name the checklist, e.g. Opening.');
    var at = AT.indexOf(x.at) >= 0 ? x.at : 'any';
    var items = cleanItems(x.items);
    if (x.id) {
      var up = await pool.query('UPDATE restaurant_checklists SET name = $3, at = $4, items = $5, updated_at = now() WHERE id = $1 AND company_id = $2 AND active RETURNING id', [x.id, company, name, at, JSON.stringify(items)]);
      if (!up.rowCount) fail('notfound', 'That checklist is gone.');
    } else {
      var n = (await pool.query('SELECT count(*)::int AS n FROM restaurant_checklists WHERE company_id = $1 AND active', [company])).rows[0].n;
      if (n >= MAX_LISTS) fail('invalid', 'Up to ' + MAX_LISTS + ' checklists.');
      await pool.query('INSERT INTO restaurant_checklists (company_id, name, at, items, sort_order) VALUES ($1,$2,$3,$4,$5)', [company, name, at, JSON.stringify(items), n]);
    }
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'till', action: 'till.checklist_saved', summary: 'Checklist "' + name + '" saved: ' + items.length + ' things.' });
  } else if (p.action === 'remove') {
    var gone = (await pool.query('UPDATE restaurant_checklists SET active = false, updated_at = now() WHERE id = $1 AND company_id = $2 AND active RETURNING name', [p.id, company])).rows[0];
    if (!gone) fail('notfound', 'That checklist is gone.');
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'till', action: 'till.checklist_removed', summary: 'Checklist "' + gone.name + '" taken off.' });
  }
  var lists = (await pool.query('SELECT * FROM restaurant_checklists WHERE company_id = $1 AND active ORDER BY sort_order, created_at', [company])).rows;
  var runs = (await pool.query(
    "SELECT r.*, r.day::text AS day_text, e.first_name, e.last_name FROM restaurant_checklist_runs r LEFT JOIN employees e ON e.id = r.finished_by WHERE r.company_id = $1 AND r.day > current_date - 14 ORDER BY r.day DESC", [company])).rows;
  var days = [];
  for (var i = 0; i < 14; i++) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  var history = days.map(function (d) {
    return {
      day: d,
      lists: lists.map(function (l) {
        var run = runs.find(function (r) { return r.checklist_id === l.id && r.day_text === d; });
        var got = (run && run.items) || {};
        var items = l.items || [];
        return {
          id: l.id, done: items.filter(function (it) { return got[it.key] && got[it.key].done; }).length, total: items.length,
          finished: run && run.finished_at ? { at: run.finished_at, by: nameOf(run) } : null,
          bad: items.filter(function (it) { return got[it.key] && got[it.key].bad; }).map(function (it) { return { text: it.text, value: got[it.key].value, unit: it.unit || '', range: rangeWords(it), by: got[it.key].by }; })
        };
      })
    };
  });
  return { lists: lists.map(listOut), history: history, managerName: nameOf(m.manager) };
}

module.exports = { mine: mine, mark: mark, manage: manage };
