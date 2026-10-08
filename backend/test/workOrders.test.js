// Work orders (migration 0136): a WO number, who it is for, the form's
// fields, a project manager who sees and hears about the WO, the sheet's
// statuses, the timing worked out (days to close, on time), and the import
// of the workshop's sheet — its Form, Stage and Arc Stage tabs matched by
// timestamp, staff names matched to the directory, nothing imported twice.
var test = require('node:test');
var assert = require('node:assert/strict');
var ExcelJS = require('exceljs');
var { pool } = require('../src/db/pool');
var tasks = require('../src/services/tasks.service');
var woImport = require('../src/services/workOrderImport.service');
var { buildContext } = require('../src/services/context.service');

var boss, worker, pmCtx, bossId, workerId, pmId, aliceId, ids = [];

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function company(code) { return (await pool.query('SELECT id FROM companies WHERE code = $1', [code])).rows[0].id; }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  worker = await ctxFor('samuel.kiptoo@bplghana.com');
  pmCtx = await ctxFor('faith.wanjiru@bplghana.com');
  bossId = boss.employee.id; workerId = worker.employee.id; pmId = pmCtx.employee.id;
  aliceId = (await pool.query("SELECT id FROM employees WHERE email = 'alice.kamau@bplghana.com'")).rows[0].id;
});
test.after(async function () {
  if (ids.length) await pool.query('DELETE FROM tasks WHERE id = ANY($1)', [ids]);
  await pool.query("DELETE FROM tasks WHERE sheet_stamp >= '2030-03-01' AND sheet_stamp < '2030-04-01'");
  await pool.query("DELETE FROM crm_name_aliases WHERE name_key = 'zqcapi'");
  await pool.query("DELETE FROM notifications WHERE body LIKE '%Wox%' OR title LIKE '%Wox%'");
  await pool.end();
});

test('a WO has a number, who it is for, the form’s fields and a project manager who sees it and is told', async function () {
  var bpl = await company('BPL');
  var issued = today(), due = addDays(issued, 3);
  var wo = await tasks.create(boss, {
    title: 'Wox round table and stand', forCompanyId: bpl, quantity: '2', itemCode: 'Zq51', specification: 'L=59" W=36" H=30"',
    materials: 'bamboo poles, V51 board', materialQuantity: '6', materialSpec: '8ft', process: 'cut to size, assemble and polish',
    projectManagerId: pmId, assigneeIds: [workerId], issuedOn: issued, dueDate: due, contact: '+233 20 555 0000'
  });
  ids.push(wo.id);
  assert.match(wo.number, /^WO-\d{4,}$/);
  assert.equal(wo.requestedFor, 'Bamboo Products Limited');
  assert.equal(wo.forCompanyCode, 'BPL');
  assert.equal(wo.quantity, '2');
  assert.equal(wo.process, 'cut to size, assemble and polish');
  assert.equal(wo.projectManager.id, pmId);
  assert.equal(wo.plannedDays, 3);
  assert.equal(wo.daysOpen, 0);
  assert.ok(wo.companyCodes.indexOf('BPL') >= 0);

  // The project manager hears about it and has it among "mine".
  var told = await pool.query("SELECT title FROM notifications WHERE employee_id = $1 AND body = 'Wox round table and stand'", [pmId]);
  assert.equal(told.rows[0].title, 'New work order ' + wo.number);
  assert.ok((await tasks.list(pmCtx, { scope: 'mine' })).some(function (t) { return t.id === wo.id; }));
  assert.ok((await tasks.list(boss, { scope: 'all', q: wo.number.toLowerCase() })).some(function (t) { return t.id === wo.id; }));

  // The sheet's statuses; completing records when, and the timing reads it.
  assert.equal((await tasks.setStatus(worker, wo.id, 'awaiting_material')).status, 'awaiting_material');
  assert.equal((await tasks.setStatus(worker, wo.id, 'in_progress')).status, 'in_progress');
  var done = await tasks.setStatus(worker, wo.id, 'completed');
  assert.equal(done.daysToClose, 0);
  assert.equal(done.onTime, true);
  assert.equal(done.daysOpen, null);
  // Both whoever issued it and its project manager are told.
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM notifications WHERE employee_id = ANY($1) AND title = 'Work order completed' AND body LIKE '%Wox round%'", [[bossId, pmId]])).rows[0].n, 2);
  var cancelled = await tasks.setStatus(boss, wo.id, 'cancelled');
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.completedAt, null);
});

test('what a WO form refuses', async function () {
  await assert.rejects(tasks.create(boss, { title: 'Wox late', issuedOn: '2031-05-10', dueDate: '2031-05-01' }), /can’t be before the date issued/);
  await assert.rejects(tasks.create(boss, { title: 'Wox nowhere', forCompanyId: '00000000-0000-0000-0000-000000000000' }), /company was not found/);
  await assert.rejects(tasks.create(boss, { title: 'Wox odd', status: 'completed' }), /Status is not a valid option/);
  await assert.rejects(tasks.create(boss, { title: 'Wox crowd', workers: 2.5 }), /Number of workers/);
  await assert.rejects(tasks.create(await ctxFor('alice.kamau@bplghana.com'), { title: 'Wox not mine' }), /not allow/);
  var talk = await tasks.create(boss, { title: 'Wox still talking', status: 'discussing', customerName: 'Zqw Hotel' });
  ids.push(talk.id);
  assert.equal(talk.status, 'discussing');
  assert.equal(talk.requestedFor, 'Zqw Hotel');
});

// A workbook laid out like the workshop's: Form Responses 1 (its timestamp
// heading is "0."), Stage and Arc Stage, whose copies of a timestamp are a
// fraction of a second off.
async function workbook() {
  var wb = new ExcelJS.Workbook();
  var formHead = ['0.', 'Email Address', 'customer name', 'SO Link', 'Item number', 'Description of WO', 'Quantity', 'Specification and Link', 'Material Needed',
    'Project Manager', 'Team Members', 'Process', 'Images', 'Other', 'Prepared by', 'Date Issued', 'Estimate Date Due', 'Material Quantity', 'Material Specification', 'Images 2', 'Other Attachments', 'Contact'];
  function at(day, hh) { return new Date(Date.UTC(2030, 2, day, hh, 15, 30, 400)); }
  function d(day) { return new Date(Date.UTC(2030, 2, day)); }
  var rows = [
    [at(2, 9), '', 'poki', '-', 'Zq51', 'Wox shelf for the bar', 2, '2ft x 8ft', 'V51 board', 'Faith', 'Alice, Zqcapi', 'cut to size, assemble and polish', '', '', 'Kelvin', d(2), d(4), 1, '8ft', '', '', '-'],
    [at(3, 10), '', 'Star bar', '', '', 'Wox fix the sink tap', 1, '', '', 'Faith', 'Alice', 'remove the old one and fix the new one', '', '', 'Zqnobody', d(3), d(3), '', '', '', '', ''],
    [at(5, 11), '', 'Bamboo garden 2', '', '', 'Wox weave panel', '1,1', '', 'Slats', 'Zqstranger', '', '', '', '', 'Kelvin', d(5), d(9), '', '', '', '', ''],
    [at(6, 12), '', 'Zqw Hotel', '548', '', 'Wox poles for a client', 24, '', 'bamboo poles', 'Faith', 'Alice', '', '', '', 'Kelvin', d(6), d(8), '', '', '', '', ''],
    [at(7, 13), '', 'BPL', '', '', 'Wox pending one', 1, '', '', 'Faith', 'Alice', '', '', '', 'Kelvin', d(7), d(8), '', '', '', '', '']
  ];
  var form = wb.addWorksheet('Form Responses 1');
  form.addRow(formHead);
  rows.forEach(function (r) { form.addRow(r); });

  // Stage: Open Date, Est. Due Date, Closed, Status, Week, Index, Timestamp, then the form's columns.
  var stage = wb.addWorksheet('Stage');
  stage.addRow(['Open Date', 'Est. Due Date', 'Closed', 'Status', 'Week', 'Index', 'Timestamp'].concat(formHead.slice(1)));
  function off(t, ms) { return new Date(t.getTime() + ms); }
  stage.addRow([d(2), d(4), d(4), 'Completed', 10, '', off(rows[0][0], 600)].concat(rows[0].slice(1)));
  stage.addRow([d(3), d(3), '', 'Suspended', '', '', off(rows[1][0], -700)].concat(rows[1].slice(1)));
  stage.addRow([d(5), d(9), '', 'Awaiting Mtl', '', '', off(rows[2][0], 300)].concat(rows[2].slice(1)));
  stage.addRow([d(6), d(8), '', 'In Process', '', '', rows[3][0]].concat(rows[3].slice(1)));

  // Arc Stage: Date (closed), Status, Week, Index, then the form's columns with the work it took.
  var arc = wb.addWorksheet('Arc Stage');
  arc.addRow(['Date', 'Status', 'Week', 'Index'].concat(formHead.slice(0, 7), ['Number of workers', 'Number of days', 'Who'], formHead.slice(7)));
  arc.addRow([d(4), 'In Process', 10, 1].concat(rows[0].slice(0, 7), [2, 1, 'Alice'], rows[0].slice(7)));
  arc.addRow([d(10), 'Cancelled', 11, 2].concat(rows[3].slice(0, 7), [3, 2, 'Samuel'], rows[3].slice(7)));
  // Not on the form or Stage any more: a WO of its own.
  arc.addRow([d(12), 'Completed', 11, 3].concat([at(11, 8), '', 'BPL', '', '', 'Wox archived only', 1], [1, 1, ''], ['', '', 'Faith', 'Alice', '', '', '', 'Kelvin', d(11), d(12), '', '', '', '', '']));
  return { buffer: await wb.xlsx.writeBuffer() };
}

test('the WO sheet: tabs matched by timestamp, statuses, people and companies, nothing twice', async function () {
  var file = await workbook();
  var firstEver = (await pool.query('SELECT count(*)::int AS n FROM tasks WHERE sheet_stamp IS NOT NULL')).rows[0].n === 0;

  var p = await woImport.preview(boss, file, {});
  assert.deepEqual(p.tabs.map(function (t) { return t.kind; }).sort(), ['archive', 'form', 'stage']);
  assert.equal(p.found, 6);
  assert.equal(p.toAdd, 6);
  // Stage speaks for a WO; Arc only when Stage says less (Completed beats Arc's In Process; Arc's Cancelled beats Stage's In Process).
  assert.deepEqual(p.byStatus, { completed: 2, waiting: 1, awaiting_material: 1, cancelled: 1, not_started: 1 });
  assert.equal(p.renumber, firstEver);
  var unknown = p.people.filter(function (x) { return !x.employeeId; }).map(function (x) { return x.name; }).sort();
  assert.deepEqual(unknown, ['Zqcapi', 'Zqnobody', 'Zqstranger']);
  var faith = p.people.find(function (x) { return x.name === 'Faith'; });
  assert.equal(faith.employeeId, pmId);
  assert.deepEqual(faith.roles, ['pm']);
  function matched(name) { return p.requestedFor.find(function (x) { return x.name === name; }).matched; }
  assert.equal(matched('poki'), 'Poki');
  assert.equal(matched('Star bar'), 'Star Bar Restaurant');
  assert.equal(matched('Bamboo garden 2'), 'Bamboo Garden');
  assert.equal(matched('Zqw Hotel'), null);

  // Running it, saying who "Zqcapi" is.
  var r = await woImport.run(boss, file, { aliases: JSON.stringify({ Zqcapi: workerId }) });
  assert.equal(r.added, 6);
  var got = (await pool.query("SELECT * FROM tasks WHERE sheet_stamp >= '2030-03-01' AND sheet_stamp < '2030-04-01' ORDER BY sheet_stamp")).rows;
  assert.equal(got.length, 6);
  // Numbered in date order.
  for (var i = 1; i < got.length; i++) assert.ok(got[i].wo_no > got[i - 1].wo_no);

  var shelf = await tasks.get(boss, got[0].id);
  assert.equal(shelf.status, 'completed');
  assert.equal(shelf.forCompanyCode, 'PKI');
  assert.equal(shelf.projectManager.id, pmId);
  assert.deepEqual(shelf.assigneeIds.slice().sort(), [aliceId, workerId].sort());   // Zqcapi, now known as Samuel
  assert.equal(shelf.createdBy, bossId);                                           // prepared by Kelvin
  assert.equal(shelf.issuedOn, '2030-03-02');
  assert.equal(shelf.dueDate, '2030-03-04');
  assert.equal(String(shelf.completedAt).length > 0, true);
  assert.equal(shelf.daysToClose, 2);
  assert.equal(shelf.onTime, true);
  assert.equal(shelf.workers, 2);
  assert.equal(shelf.workDays, 1);
  assert.equal(shelf.quantity, '2');
  assert.equal(shelf.itemCode, 'Zq51');
  assert.equal(shelf.contact, '');                                                 // "-" says nothing
  assert.equal(shelf.imported, true);

  var tap = await tasks.get(boss, got[1].id);
  assert.equal(tap.status, 'waiting');
  assert.equal(tap.forCompanyCode, 'SBR');
  assert.equal(tap.preparedByName, 'Zqnobody');                                    // kept as written
  assert.equal(tap.createdByName, 'Zqnobody');

  var panel = await tasks.get(boss, got[2].id);
  assert.equal(panel.status, 'awaiting_material');
  assert.equal(panel.pmName, 'Zqstranger');
  assert.equal(panel.projectManager, null);
  assert.equal(panel.quantity, '1,1');

  var poles = await tasks.get(boss, got[3].id);
  assert.equal(poles.status, 'cancelled');
  assert.equal(poles.customerName, 'Zqw Hotel');
  assert.equal(poles.soRef, '548');
  assert.ok(poles.assigneeIds.indexOf(workerId) >= 0);                            // the archive's "Who"

  assert.equal((await tasks.get(boss, got[4].id)).status, 'not_started');
  var archived = await tasks.get(boss, got[5].id);
  assert.equal(archived.title, 'Wox archived only');
  assert.equal(archived.status, 'completed');

  // The name given is remembered for the next import.
  assert.equal((await pool.query("SELECT employee_id FROM crm_name_aliases WHERE name_key = 'zqcapi'")).rows[0].employee_id, workerId);

  // A WO from the sheet that was due before it was issued can still be edited.
  await pool.query("UPDATE tasks SET due_date = '2030-03-01' WHERE id = $1", [got[4].id]);
  var edited = await tasks.update(boss, got[4].id, { title: 'Wox pending one, edited' });
  assert.equal(edited.title, 'Wox pending one, edited');
  assert.equal(edited.dueDate, '2030-03-01');
  // A WO numbered ahead of the import keeps working: the next new one follows on.
  var next = await tasks.create(boss, { title: 'Wox after the import' });
  ids.push(next.id);
  assert.ok(next.woNo > Math.max.apply(null, got.map(function (g) { return g.wo_no; })));

  // Again: nothing is added twice.
  var again = await woImport.preview(boss, file, {});
  assert.equal(again.already, 6);
  assert.equal(again.toAdd, 0);
  assert.equal((await woImport.run(boss, file, {})).added, 0);
});

test('only someone who may issue WOs can import them, and only a workbook', async function () {
  await assert.rejects(woImport.preview(await ctxFor('alice.kamau@bplghana.com'), { buffer: Buffer.from('x') }, {}), /not allow/);
  await assert.rejects(woImport.preview(boss, { buffer: Buffer.from('not a workbook') }, {}), /couldn’t be read/);
  await assert.rejects(woImport.preview(boss, null, {}), /Choose the \.xlsx file/);
  await assert.rejects(woImport.run(boss, await workbook(), { aliases: JSON.stringify({ Zqcapi: '00000000-0000-0000-0000-000000000000' }) }), /not found/);
});
