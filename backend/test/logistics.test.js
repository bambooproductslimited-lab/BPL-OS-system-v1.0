/*
 * Integration test for the new logistics/inventory modules: waybills
 * (factory/showroom dispatch notes), tool room inventory (tools/equipment/
 * materials), and IT device inventory. Requires `npm run migrate && npm run
 * seed` first, same as the other test files.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');

var server;
var base;

test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(function () { server.close(); });

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}
function authed(token) { return { Authorization: 'Bearer ' + token }; }
function jsonAuthed(token) { return Object.assign({ 'Content-Type': 'application/json' }, authed(token)); }

async function employeeId(adminToken, email) {
  var list = await (await fetch(base + '/api/employees', { headers: authed(adminToken) })).json();
  return list.find(function (e) { return e.email === email; }).id;
}

test('waybills: create is permission-gated, dispatch + status flow, numbering', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com'); // department_manager
  var alice = await login('alice.kamau@bplghana.com'); // employee — no waybill.manage

  var denied = await fetch(base + '/api/waybills', {
    method: 'POST', headers: jsonAuthed(alice),
    body: JSON.stringify({ origin: 'factory', destination: 'Showroom', items: [{ description: 'x', qty: 1, unit: 'each' }] })
  });
  assert.equal(denied.status, 403);

  var created = await fetch(base + '/api/waybills', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ origin: 'factory', destination: 'Showroom - Accra', shippedToName: 'Showroom - Accra', driverName: 'Kwame', vehicleNo: 'GT-1', items: [{ itemNo: 'SN-001', description: 'Bamboo Chair', qty: 5, unit: 'each' }] })
  });
  assert.equal(created.status, 201);
  var wb = await created.json();
  assert.match(wb.waybillNo, /^WB-\d{4}-\d{4}$/);
  assert.equal(wb.status, 'dispatched');
  assert.equal(wb.items.length, 1);
  assert.equal(wb.items[0].itemNo, 'SN-001');

  var delivered = await fetch(base + '/api/waybills/' + wb.id + '/status', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ status: 'delivered' })
  });
  var deliveredBody = await delivered.json();
  assert.equal(deliveredBody.status, 'delivered');
  assert.ok(deliveredBody.deliveredAt);

  var list = await (await fetch(base + '/api/waybills', { headers: authed(admin) })).json();
  assert.ok(list.some(function (w) { return w.id === wb.id; }));
});

test('tool room: material stock tracked by quantity, tools check out/in, kind=material blocks checkout', async function () {
  var isreal = await login('isreal.omozuafo@bplghana.com'); // department_manager
  var admin = await login('kelvin.duho@bplghana.com');
  var aliceId = await employeeId(admin, 'alice.kamau@bplghana.com');

  var tool = await (await fetch(base + '/api/tool-room', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ code: 'TR-TEST-1', name: 'Test Drill', kind: 'tool', quantityOnHand: 1 })
  })).json();
  assert.equal(tool.status, 'available');

  var checkedOut = await (await fetch(base + '/api/tool-room/' + tool.id + '/checkout', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ employeeId: aliceId })
  })).json();
  assert.equal(checkedOut.status, 'checked_out');
  assert.equal(checkedOut.checkedOutTo, aliceId);

  var checkedIn = await (await fetch(base + '/api/tool-room/' + tool.id + '/checkout', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ employeeId: null })
  })).json();
  assert.equal(checkedIn.status, 'available');
  assert.equal(checkedIn.checkedOutTo, null);

  var material = await (await fetch(base + '/api/tool-room', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ code: 'MAT-TEST-1', name: 'Test Glue', kind: 'material', unit: 'litre', quantityOnHand: 2, reorderLevel: 5 })
  })).json();
  assert.equal(material.lowStock, undefined); // create() doesn't compute lowStock — only list() does

  var list = await (await fetch(base + '/api/tool-room', { headers: authed(isreal) })).json();
  var listedMaterial = list.find(function (i) { return i.id === material.id; });
  assert.equal(listedMaterial.lowStock, true);

  var blockedCheckout = await fetch(base + '/api/tool-room/' + material.id + '/checkout', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ employeeId: aliceId })
  });
  assert.equal(blockedCheckout.status, 400);
});

test('IT devices: create/update permission-gated to itdevice.manage, auto tag, assignment', async function () {
  var emmanuel = await login('emmanuel.chang@bplghana.com'); // it_manager
  var isreal = await login('isreal.omozuafo@bplghana.com'); // department_manager — no itdevice.manage
  var admin = await login('kelvin.duho@bplghana.com');
  var aliceId = await employeeId(admin, 'alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/it-devices', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ category: 'Laptop' })
  });
  assert.equal(denied.status, 403);

  var created = await fetch(base + '/api/it-devices', {
    method: 'POST', headers: jsonAuthed(emmanuel),
    body: JSON.stringify({ category: 'Laptop', brand: 'Dell', model: 'Latitude 5420', serialNumber: 'SN-TEST-1', assignedEmployeeId: aliceId })
  });
  assert.equal(created.status, 201);
  var device = await created.json();
  assert.match(device.deviceTag, /^IT-\d{3,}$/);
  assert.equal(device.status, 'in_use');
  assert.equal(device.assignedEmployeeId, aliceId);

  var updated = await fetch(base + '/api/it-devices/' + device.id, {
    method: 'PUT', headers: jsonAuthed(emmanuel),
    body: JSON.stringify({ category: 'Laptop', brand: 'Dell', model: 'Latitude 5420', serialNumber: 'SN-TEST-1', condition: 'fair', status: 'under_repair' })
  });
  var updatedBody = await updated.json();
  assert.equal(updatedBody.status, 'under_repair');
  assert.equal(updatedBody.condition, 'fair');

  var list = await (await fetch(base + '/api/it-devices', { headers: authed(emmanuel) })).json();
  assert.ok(list.some(function (d) { return d.id === device.id; }));
});

test('IT devices import: sheet rows with Total > 1 expand into that many devices, credentials excluded by default, permission-gated', async function () {
  var emmanuel = await login('emmanuel.chang@bplghana.com'); // it_manager
  var isreal = await login('isreal.omozuafo@bplghana.com'); // department_manager — no itdevice.manage

  var csv = [
    'ID,Brand,Device,Model,Date Recieve,Total,In-Use,Status,Who/Where?,Number,Username,Open Pass,Link,Remark,Last Checked Date (EC)',
    '901,Apple,Smart Device,"iPad Air 2 (A1566 - 64GB)",,2,2,Deployed,BG1,-,,0008,,Square up,',
    '902,Apple,Smart Device,"iPad Air 2 (A1566 - 64GB)",,1,1,Deployed,"Nicholas (for Bolt Evening)",-,,8282,,Square up,'
  ].join('\n');

  var deniedForm = new FormData();
  deniedForm.append('file', new Blob([csv], { type: 'text/csv' }), 'it.csv');
  var denied = await fetch(base + '/api/it-devices/import/preview', { method: 'POST', headers: authed(isreal), body: deniedForm });
  assert.equal(denied.status, 403);

  var form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'it.csv');
  var previewRes = await fetch(base + '/api/it-devices/import/preview', { method: 'POST', headers: authed(emmanuel), body: form });
  assert.equal(previewRes.status, 200);
  var preview = await previewRes.json();

  // Row 901 (Total 2) expands to 2 units, row 902 (Total 1) to 1 — 3 device rows total.
  assert.equal(preview.rows.length, 3);
  assert.deepEqual(preview.rows.map(function (r) { return r.deviceTag; }), ['IT-901-1', 'IT-901-2', 'IT-902']);
  preview.rows.forEach(function (r) {
    assert.equal(r.status, 'in_use'); // "Deployed" maps to in_use
    assert.equal(r.brand, 'Apple');
    assert.equal(r.model, 'iPad Air 2 (A1566 - 64GB)');
    // Open Pass (8282/0008) must never appear in notes when includeCredentials wasn't requested.
    assert.ok(r.notes.indexOf('8282') < 0 && r.notes.indexOf('0008') < 0, 'credentials leaked into notes: ' + r.notes);
  });
  assert.equal(preview.rows[0].location, 'BG1'); // "BG1" doesn't match an employee name — kept as location
  assert.equal(preview.rows[2].location, 'Nicholas (for Bolt Evening)'); // no employee named Nicholas in seed data — kept as location text, not assigned
  assert.equal(preview.rows[2].assignedEmployeeId, null);

  var committed = await fetch(base + '/api/it-devices/import/commit', {
    method: 'POST', headers: jsonAuthed(emmanuel), body: JSON.stringify({ rows: preview.rows })
  });
  assert.equal(committed.status, 200);
  var summary = await committed.json();
  assert.equal(summary.created, 3);
  assert.equal(summary.skipped, 0);

  var list = await (await fetch(base + '/api/it-devices', { headers: authed(emmanuel) })).json();
  var tags = list.map(function (d) { return d.deviceTag; });
  assert.ok(tags.indexOf('IT-901-1') >= 0 && tags.indexOf('IT-901-2') >= 0 && tags.indexOf('IT-902') >= 0);

  // Re-importing the same sheet must not duplicate — existing tags are skipped.
  var form2 = new FormData();
  form2.append('file', new Blob([csv], { type: 'text/csv' }), 'it.csv');
  var preview2 = await (await fetch(base + '/api/it-devices/import/preview', { method: 'POST', headers: authed(emmanuel), body: form2 })).json();
  assert.ok(preview2.rows.every(function (r) { return r.willSkip; }));
  var committed2 = await fetch(base + '/api/it-devices/import/commit', {
    method: 'POST', headers: jsonAuthed(emmanuel), body: JSON.stringify({ rows: preview2.rows })
  });
  var summary2 = await committed2.json();
  assert.equal(summary2.created, 0);
  assert.equal(summary2.skipped, 3);
});

test('IT devices import: includeCredentials opts device passcodes into notes explicitly', async function () {
  var emmanuel = await login('emmanuel.chang@bplghana.com');
  var csv = [
    'ID,Brand,Device,Model,Total,In-Use,Status,Who/Where?,Username,Open Pass,Remark',
    '999,Apple,Router,AirPort,1,1,Deployed,Office,admin,1234,'
  ].join('\n');

  var form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'it.csv');
  form.append('includeCredentials', 'true');
  var preview = await (await fetch(base + '/api/it-devices/import/preview', { method: 'POST', headers: authed(emmanuel), body: form })).json();
  assert.equal(preview.rows.length, 1);
  assert.match(preview.rows[0].notes, /1234/);
  assert.match(preview.rows[0].notes, /admin/);
});
