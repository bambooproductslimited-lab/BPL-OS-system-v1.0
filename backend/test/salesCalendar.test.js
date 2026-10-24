/*
 * The marketing calendar in the sales app (mkHome.service.js calendar()):
 * marketing.read sees everything; a sales rep (crm.read, no marketing.read)
 * sees the campaigns, events, promotions, holidays and moments, and only
 * their own requests — not the events' checklists or the requests
 * routines will make. Anyone with neither is turned away.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var home = require('../src/services/mkHome.service');
var events = require('../src/services/mkEvents.service');
var requests = require('../src/services/mkRequests.service');
var routines = require('../src/services/mkRoutines.service');

var boss, repA, repB;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }

async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE link IN (SELECT '/mkrequests?open=' || id FROM marketing_requests WHERE title LIKE 'ZSC%')");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZSC%'");
  await pool.query("DELETE FROM marketing_request_routines WHERE title LIKE 'ZSC%'");
  await pool.query("DELETE FROM marketing_events WHERE name LIKE 'ZSC%'");
  await pool.query("DELETE FROM marketing_promotions WHERE name LIKE 'ZSC%'");
  await pool.query("DELETE FROM users WHERE email LIKE 'zsc.%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZSC-%'");
}
async function makeRep(code) {
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [boss.employee.id])).rows[0].department_id;
  var e = (await pool.query("INSERT INTO employees (code, first_name, last_name, email, department_id, hire_date) VALUES ($1, 'Rep', 'Zsc', $2, $3, '2025-01-01') RETURNING id",
    [code, code.toLowerCase() + '@zsc.example', dept])).rows[0].id;
  var u = (await pool.query("INSERT INTO users (employee_id, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [e, 'zsc.' + code.toLowerCase() + '@example.com'])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'sales_rep'", [u]);
  return buildContext(u);
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  await cleanup();
  repA = await makeRep('ZSC-A');
  repB = await makeRep('ZSC-B');
  await events.createEvent(boss, { company: 'BPL', name: 'ZSC Garden Expo', kind: 'trade_fair', startsOn: '2032-03-20', endsOn: '2032-03-21', venue: 'ZSC Hall' });
  await events.createPromotion(boss, { company: 'BPL', name: 'ZSC Ten off', code: 'zsc 10', kind: 'percent', value: 10, startsOn: '2032-03-05', endsOn: '2032-03-15' });
  await requests.create(repA, { company: 'BPL', title: 'ZSC Flyer for rep A', dueOn: '2032-03-10' });
  await requests.create(repB, { company: 'BPL', title: 'ZSC Flyer for rep B', dueOn: '2032-03-11' });
  await routines.create(boss, { company: 'BPL', title: 'ZSC Weekly post', kind: 'social_post', every: 'week', weekdays: [1], startsOn: '2032-03-01', dueAfterDays: 2 });
});
test.after(async function () { await cleanup(); await pool.end(); });

function titles(cal, kind) { return cal.items.filter(function (i) { return i.kind === kind; }).map(function (i) { return i.title; }); }

test('marketing sees the whole calendar', async function () {
  var cal = await home.calendar(boss, { company: 'BPL', from: '2032-03-01', to: '2032-03-31' });
  assert.equal(cal.full, true);
  assert.ok(titles(cal, 'request').includes('ZSC Flyer for rep A') && titles(cal, 'request').includes('ZSC Flyer for rep B'));
  assert.ok(titles(cal, 'task').length > 0, 'the expo\'s checklist');
  assert.ok(titles(cal, 'routine').includes('ZSC Weekly post'));
});

test('a sales rep sees what they sell around and their own requests, not marketing\'s workings', async function () {
  assert.equal(repA.can('marketing.read'), false);
  var cal = await home.calendar(repA, { company: 'BPL', from: '2032-03-01', to: '2032-03-31' });
  assert.equal(cal.full, false);
  assert.ok(titles(cal, 'event').includes('ZSC Garden Expo'));
  var promo = cal.items.find(function (i) { return i.kind === 'promotion' && i.title === 'ZSC Ten off'; });
  assert.ok(promo && promo.code, 'the promotion and its code');
  assert.ok(cal.items.some(function (i) { return i.kind === 'moment' && i.key === 'womens_day'; }));
  assert.deepEqual(titles(cal, 'request').filter(function (t) { return /^ZSC/.test(t); }), ['ZSC Flyer for rep A']);
  assert.deepEqual(titles(cal, 'task'), []);
  assert.deepEqual(titles(cal, 'routine'), []);
});

test('someone with neither marketing nor the CRM is turned away', async function () {
  var nobody = { employee: repA.employee, can: function () { return false; } };
  await assert.rejects(home.calendar(nobody, { company: 'BPL' }), /marketing.read/);
});
