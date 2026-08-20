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
    body: JSON.stringify({ origin: 'factory', destination: 'Showroom - Accra', shippedToName: 'Showroom - Accra', driverName: 'Kwame', vehicleNo: 'GT-1', items: [{ description: 'Bamboo Chair', qty: 5, unit: 'each' }] })
  });
  assert.equal(created.status, 201);
  var wb = await created.json();
  assert.match(wb.waybillNo, /^WB-\d{4}-\d{4}$/);
  assert.equal(wb.status, 'dispatched');
  assert.equal(wb.items.length, 1);

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
