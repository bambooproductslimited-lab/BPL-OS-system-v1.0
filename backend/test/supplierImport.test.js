/*
 * Importing the sourcing team's farmer & supplier sheet into Suppliers.
 *
 * The data below is invented on purpose. The real sheet holds real
 * farmers' names and phone numbers, and a test fixture is committed to the
 * repository's history for good — so these rows reproduce the sheet's
 * SHAPE (its headers, month/day dates, "N/A" cells, people entered more
 * than once under different names) without any of its people.
 *
 * Requires `npm run migrate && npm run seed` first (the pretest hook).
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var { pool } = require('../src/db/pool');
var svc = require('../src/services/supplierImport.service');
var suppliers = require('../src/services/suppliers.service');

var admin = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var nobody = { can: function () { return false; }, employee: { id: null }, user: { id: null } };

var server, base;
test.before(function (t, done) {
  server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; done(); });
});
test.after(async function () {
  await pool.query("DELETE FROM suppliers WHERE phone LIKE '0209 99%' OR phone2 LIKE '0209 99%' OR name LIKE 'Testfarmer%'");
  server.close();
  await pool.end();
});

var HEADER = 'Index,Date,Region,Town,District,Source,Price Ghs,Name  ,Mobile,2nd mobile,Accessment,Status,Expected Qty,IOU,IOU Notes';
function csv(lines) { return Buffer.from([HEADER].concat(lines).join('\r\n')); }

// ---- the pieces --------------------------------------------------------

test('a whole column of dates is read one way, decided by the dates that can only be read one way', function () {
  assert.equal(svc.detectDateOrder(['5/13/2021', '7/5/2022', '']), 'mdy');
  assert.equal(svc.detectDateOrder(['13/5/2021', '5/7/2022']), 'dmy');
  assert.equal(svc.detectDateOrder(['13/5/2021', '5/13/2021']), 'mixed');
  assert.equal(svc.detectDateOrder(['5/7/2022', '1/2/2021']), 'unknown');

  // The one that matters: on a month/day sheet, 7/5/2022 is 5 July, not 7 May.
  assert.equal(svc.parseSheetDate('7/5/2022', 'mdy'), '2022-07-05');
  assert.equal(svc.parseSheetDate('7/5/2022', 'dmy'), '2022-05-07');
  assert.equal(svc.parseSheetDate('2022-07-05', 'mdy'), '2022-07-05');
  assert.equal(svc.parseSheetDate('44329', 'mdy'), '2021-05-13', 'a date cell that lost its formatting');
  assert.equal(svc.parseSheetDate('2/30/2022', 'mdy'), null, 'no such day');
  assert.equal(svc.parseSheetDate('N/A', 'mdy'), null);
});

test('phone numbers are recognised however the sheet wrote them', function () {
  assert.equal(svc.phoneKey('0245 402 254'), '0245402254');
  assert.equal(svc.phoneKey('+233 24 540 2254'), '0245402254');
  assert.equal(svc.phoneKey('245402254'), '0245402254', 'a spreadsheet that dropped the leading zero');
  assert.equal(svc.phoneKey('05580 256 411'), '', 'eleven digits is not a Ghana mobile');
  assert.equal(svc.phoneKey(''), '');
});

test('assessments are tidied without inventing categories', function () {
  assert.equal(svc.normalizeAssessment('Meets Spec '), 'Meets spec');
  assert.equal(svc.normalizeAssessment('Do not Meet Spec'), 'Does not meet spec', 'the negative wins over the "meet spec" inside it');
  assert.equal(svc.normalizeAssessment('too many rejects'), 'Too many rejects');
  assert.equal(svc.normalizeAssessment('N/A'), '');
});

// ---- preview ------------------------------------------------------------

test('one person on three rows becomes one supplier, and nothing the sheet says is lost', async function () {
  var p = await svc.preview(admin, csv([
    '1,5/13/2021,Western,Daboase,Lower Manya,Daboase,4,Testfarmer Kofi,0209 990 001,,Meets Spec ,,,,',
    '2,,Western,Daboase,Wassa East,Daboase,1.5,Testfarmer Kofi Badu,0209 990 001,0209 990 002,Meets Spec ,Active,600,,',
    '3,5/12/2021,Western,Daboase,Lower Manya,Daboase,N/A,Testfarmer Kofi,0209990001,,,,,,',
    '4,7/5/2022,Central,Assin Foso,N/A,Assin Foso,N/A,Testfarmer Ama,0209 990 003,,Meets Spec ,,2000,1800,840 iou Search'
  ]));

  assert.equal(p.sheetRows, 4);
  assert.equal(p.dateOrder, 'mdy');
  assert.equal(p.suppliers.length, 2, 'three rows sharing a number are one person');
  assert.equal(p.summary.merged, 1);

  var kofi = p.suppliers.find(function (s) { return s.phone === '0209 990 001'; });
  assert.deepEqual(kofi.sheetRows, [2, 3, 4], 'sheet row numbers as the team sees them — the header is row 1');
  assert.equal(kofi.name, 'Testfarmer Kofi', 'the first name given');
  assert.equal(kofi.quotedPrice, 4, 'the first price given');
  assert.equal(kofi.sourcingStatus, 'Active', 'filled in from the row that had it');
  assert.equal(kofi.expectedQty, 600);
  assert.equal(kofi.phone2, '0209 990 002');
  assert.equal(kofi.firstContactDate, '2021-05-12', 'the earliest date on any of their rows');
  assert.equal(kofi.district, 'Lower Manya');
  assert.match(kofi.notes, /Also recorded on the sheet as: Testfarmer Kofi Badu/);
  assert.match(kofi.notes, /Sheet also gave price: 1\.5 GHS per pole/, 'the disagreeing price is kept, not dropped');
  assert.match(kofi.notes, /Wassa East/);
  assert.ok(kofi.warnings.some(function (w) { return /4 \/ 1\.5/.test(w); }), 'and the conflict is flagged in the preview');

  var ama = p.suppliers.find(function (s) { return s.phone === '0209 990 003'; });
  assert.equal(ama.district, '', '"N/A" is an empty cell, not a district called N/A');
  assert.equal(ama.quotedPrice, null, '"N/A" price is no price, not zero');
  assert.equal(ama.iouAmount, 1800);
  assert.equal(ama.iouNotes, '840 iou Search');
  assert.equal(ama.firstContactDate, '2022-07-05', '5 July — the sheet is month/day');
});

test('a row with no name or no phone is still imported, and says so', async function () {
  var p = await svc.preview(admin, csv([
    '1,,Central,Koasa,Budumburam,Swedro,2.5,,0209 990 010,,,,,,',
    '2,,Volta,Ho west,Tsebi,Dzolopuita,4,Testfarmer Chris,,,Too many rejects,,,,'
  ]));
  var unnamed = p.suppliers.find(function (s) { return s.phone === '0209 990 010'; });
  assert.equal(unnamed.name, 'Unnamed farmer — Koasa');
  assert.ok(unnamed.warnings.some(function (w) { return /No name/.test(w); }));
  var chris = p.suppliers.find(function (s) { return s.name === 'Testfarmer Chris'; });
  assert.equal(chris.phone, '');
  assert.equal(chris.assessment, 'Too many rejects');
  assert.ok(chris.warnings.some(function (w) { return /No usable phone/.test(w); }));
});

test('a file that is not the farmer sheet is refused with a useful message', async function () {
  await assert.rejects(function () { return svc.preview(admin, Buffer.from('Item,Qty\r\nNails,4')); },
    function (e) { return e.code === 'invalid' && /Name or Mobile/.test(e.message); });
});

test('importing needs supplier.manage', async function () {
  await assert.rejects(function () { return svc.preview(nobody, csv(['1,,Central,X,,,,Testfarmer Z,0209 990 099,,,,,,'])); },
    function (e) { return e.code === 'forbidden'; });
  await assert.rejects(function () { return svc.commit(nobody, [{ name: 'Testfarmer Z' }]); },
    function (e) { return e.code === 'forbidden'; });
});

// ---- commit and re-import ------------------------------------------------

test('importing, then importing the same sheet again, changes nothing the second time', async function () {
  var sheet = csv([
    '1,5/13/2021,Western,Dompim,Shama,Dompim,4,Testfarmer Yaw,0209 990 020,,Meets Spec ,Yet to Cut,,,',
    '2,,Western,Dompim,Shama,Dompim,4,Testfarmer Yaw,0209 990 020,,Meets Spec ,,,,'
  ]);
  var first = await svc.commit(admin, (await svc.preview(admin, sheet)).suppliers);
  assert.deepEqual(first, { created: 1, updated: 0, unchanged: 0 });

  var again = await svc.preview(admin, sheet);
  assert.equal(again.summary.unchanged, 1);
  assert.deepEqual(await svc.commit(admin, again.suppliers), { created: 0, updated: 0, unchanged: 1 });

  var n = (await pool.query("SELECT count(*)::int n FROM suppliers WHERE phone = '0209 990 020'")).rows[0].n;
  assert.equal(n, 1, 'still one supplier');
});

test('an updated sheet refreshes the sourcing figures but never undoes corrections made in the OS', async function () {
  await svc.commit(admin, (await svc.preview(admin, csv([
    '1,5/13/2021,Central,Mankessim,Mankessim,Kojo,3,Testfarmer Kojo,0209 990 030,,Meets Spec ,Schedule for meeting,,,'
  ]))).suppliers);
  var row = (await pool.query("SELECT * FROM suppliers WHERE phone = '0209 990 030'")).rows[0];

  // Someone corrects the name and the region in the OS...
  await suppliers.update(admin, row.id, {
    name: 'Testfarmer Kojo Mensah', contactPerson: 'Kojo Mensah', materialsSupplied: 'Raw bamboo poles',
    phone: row.phone, region: 'Central Region'
  });

  // ...and meanwhile the sheet moves on: they are cutting now, at a new price, with an IOU.
  var p = await svc.preview(admin, csv([
    '1,5/13/2021,Central,Mankessim,Mankessim,Kojo,3.5,Testfarmer Kojo,0209 990 030,0209 990 031,Meets Spec ,Cutting,1500,900,Awaiting IOU'
  ]));
  var c = p.suppliers[0];
  assert.equal(c.action, 'update');
  assert.ok(c.changes.some(function (x) { return /Status: Schedule for meeting → Cutting/.test(x); }), 'the preview says what will change');

  assert.deepEqual(await svc.commit(admin, p.suppliers), { created: 0, updated: 1, unchanged: 0 });
  var after = suppliers.rowToSupplier((await pool.query('SELECT * FROM suppliers WHERE id = $1', [row.id])).rows[0]);

  assert.equal(after.sourcingStatus, 'Cutting', 'the sheet owns the sourcing status');
  assert.equal(after.quotedPrice, 3.5);
  assert.equal(after.expectedQty, 1500);
  assert.equal(after.iouAmount, 900);
  assert.equal(after.iouNotes, 'Awaiting IOU');
  assert.equal(after.phone2, '0209 990 031', 'filled in because the OS had none');
  assert.equal(after.name, 'Testfarmer Kojo Mensah', 'a name corrected in the OS does not revert to the sheet spelling');
  assert.equal(after.region, 'Central Region', 'nor does a region edited in the OS');
});

test('commit re-checks every value itself, and a bad one leaves nothing half-written', async function () {
  var p = await svc.preview(admin, csv([
    '1,,Central,Nkum,Nkum,Isaac,3,Testfarmer Good,0209 990 040,,,,,,',
    '2,,Central,Nkum,Nkum,Isaac,3,Testfarmer Bad,0209 990 041,,,,,,'
  ]));
  p.suppliers[1].quotedPrice = -5; // what a tampered request would send
  await assert.rejects(function () { return svc.commit(admin, p.suppliers); },
    function (e) { return e.code === 'invalid' && /Testfarmer Bad/.test(e.message) && /negative/.test(e.message); });
  var written = (await pool.query("SELECT count(*)::int n FROM suppliers WHERE phone IN ('0209 990 040', '0209 990 041')")).rows[0].n;
  assert.equal(written, 0, 'the good row before it was rolled back too — an import is all or nothing');
});

// ---- over HTTP, and the supplier form ------------------------------------

async function login(email) {
  var res = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email, password: 'bamboo123' })
  });
  return (await res.json()).token;
}

test('the preview endpoint takes an uploaded CSV, and only from someone who can manage suppliers', async function () {
  var adminToken = await login('kelvin.duho@bplghana.com');
  var employeeToken = await login('alice.kamau@bplghana.com');
  function form() {
    var f = new FormData();
    f.append('file', new Blob([csv(['1,5/13/2021,Western,Axim,,,4,Testfarmer Http,0209 990 050,,,,,,'])], { type: 'text/csv' }), 'Farmers & Suppliers.csv');
    return f;
  }
  var denied = await fetch(base + '/api/suppliers/import/preview', { method: 'POST', headers: { Authorization: 'Bearer ' + employeeToken }, body: form() });
  assert.equal(denied.status, 403);
  var ok = await fetch(base + '/api/suppliers/import/preview', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: form() });
  assert.equal(ok.status, 200);
  var body = await ok.json();
  assert.equal(body.suppliers[0].firstContactDate, '2021-05-13');
});

test('saving the supplier form without the new fields does not wipe them', async function () {
  // The window between deploying the backend and the frontend: an old,
  // cached supplier form sends only the original seven fields.
  var s = await suppliers.create(admin, {
    name: 'Testfarmer Legacy', contactPerson: 'Legacy', materialsSupplied: 'Raw bamboo poles', phone: '0209 990 060',
    region: 'Volta', quotedPrice: 4, sourcingStatus: 'Active', iouAmount: 500
  });
  var saved = await suppliers.update(admin, s.id, {
    name: 'Testfarmer Legacy', contactPerson: 'Legacy', materialsSupplied: 'Raw bamboo poles', phone: '0209 990 060', email: '', address: ''
  });
  assert.equal(saved.region, 'Volta');
  assert.equal(saved.quotedPrice, 4);
  assert.equal(saved.sourcingStatus, 'Active');
  assert.equal(saved.iouAmount, 500);

  // And clearing a field on purpose still works — an explicit empty value is not an omission.
  var cleared = await suppliers.update(admin, s.id, {
    name: 'Testfarmer Legacy', contactPerson: 'Legacy', materialsSupplied: 'Raw bamboo poles', phone: '0209 990 060', iouAmount: ''
  });
  assert.equal(cleared.iouAmount, null);
  assert.equal(cleared.region, 'Volta');
});
