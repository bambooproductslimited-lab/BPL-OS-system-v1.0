/*
 * Import from Google Drive (googleDrive.service.js): the Finish Inventory
 * workbooks read straight from Drive with a service account, then the same
 * preview and import as an uploaded .xlsx.
 *
 * Google is a stand-in on localhost that checks what the OS sends — the
 * signed sign-in (verified against the key pair made here), the read-only
 * scope, the search, the export — so nothing leaves the machine. Products
 * use the Z74 code and days in July 2025, and are removed afterwards.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('http');
var crypto = require('crypto');
var ExcelJS = require('exceljs');
var config = require('../src/config');
var { pool } = require('../src/db/pool');
var drive = require('../src/services/googleDrive.service');

var admin = { can: function () { return true; }, employee: { id: null }, user: { id: null } };
var nobody = { can: function () { return false; }, employee: { id: null }, user: { id: null } };
var keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
var SA = 'bamboo-os@test-project.iam.gserviceaccount.com';
var fake, saved;
var seen = { tokens: 0, queries: [], exports: 0, media: 0 };
var workbookBuf;

var HEADER = ['Items/Description ', 'Category', 'Variation', 'UOM', 'Opening Stock', 'Received', 'total stock', 'transfered', 'Breakage', 'Sold (Square)', 'Expected Closing', 'Physical Count', 'Variance'];
function line(ws, r, item, variation, open, sold, physical) {
  var expected = open - sold;
  ws.getRow(r).values = [item, 'Bamboo', variation, 'pcs', open, null, { formula: 'E' + r + '+F' + r, result: open }, null, null, sold || null,
    { formula: 'E' + r + '-J' + r, result: expected }, physical === undefined ? { formula: 'K' + r, result: expected } : physical, { formula: 'K' + r + '-L' + r, result: 0 }];
}
async function workbook() {
  var wb = new ExcelJS.Workbook();
  var d1 = wb.addWorksheet('1');
  d1.getRow(1).values = HEADER;
  line(d1, 2, 'Z74 Drive Slats', "8' - pcs", 50, 5);
  var d2 = wb.addWorksheet('2');
  d2.getRow(1).values = HEADER;
  line(d2, 2, 'Z74 Drive Slats', "8' - pcs", 45, 3, 40);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function cleanup() {
  await pool.query("DELETE FROM product_aliases WHERE alias LIKE 'Z74%'");
  await pool.query("DELETE FROM inventory_tx WHERE item_type = 'product' AND item_id IN (SELECT id FROM products WHERE sku LIKE 'Z74%')");
  await pool.query("DELETE FROM stock_sheet_lines WHERE product_id IN (SELECT id FROM products WHERE sku LIKE 'Z74%')");
  await pool.query("DELETE FROM products WHERE sku LIKE 'Z74%'");
}

function verifyAssertion(assertion) {
  var parts = assertion.split('.');
  var ok = crypto.createVerify('RSA-SHA256').update(parts[0] + '.' + parts[1]).verify(keys.publicKey, Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  return { ok: ok, claims: JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) };
}

test.before(async function () {
  await cleanup();
  workbookBuf = await workbook();
  saved = Object.assign({}, { serviceAccountEmail: config.googleDrive.serviceAccountEmail, privateKey: config.googleDrive.privateKey, tokenUrl: config.googleDrive.tokenUrl, apiBase: config.googleDrive.apiBase, jsonInvalid: config.googleDrive.jsonInvalid });
  fake = http.createServer(function (req, res) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var url = new URL(req.url, 'http://x');
      var send = function (status, body, type) {
        res.statusCode = status;
        res.setHeader('Content-Type', type || 'application/json');
        res.end(type ? body : JSON.stringify(body));
      };
      if (url.pathname === '/token') {
        seen.tokens++;
        var form = new URLSearchParams(Buffer.concat(chunks).toString());
        var v = verifyAssertion(form.get('assertion'));
        if (!v.ok || v.claims.iss !== SA || v.claims.scope !== 'https://www.googleapis.com/auth/drive.readonly') return send(400, { error: 'invalid_grant', error_description: 'bad assertion' });
        return send(200, { access_token: 'tok-' + seen.tokens, expires_in: 3600 });
      }
      if (!/^Bearer tok-\d+$/.test(req.headers.authorization || '')) return send(401, { error: { message: 'no auth' } });
      if (url.pathname === '/drive/v3/files') {
        seen.queries.push(url.searchParams.get('q'));
        return send(200, { files: [
          { id: 'SHEETID00001', name: '202507 Z74 Finish Inventory', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2025-08-01T10:00:00Z', owners: [{ displayName: 'Kampz' }] },
          { id: 'XLSXID000002', name: 'Z74 Finish Inventory (upload).xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime: '2025-07-20T10:00:00Z', owners: [] }
        ] });
      }
      if (url.pathname === '/drive/v3/files/SHEETID00001') return send(200, { id: 'SHEETID00001', name: '202507 Z74 Finish Inventory', mimeType: 'application/vnd.google-apps.spreadsheet' });
      if (url.pathname === '/drive/v3/files/SHEETID00001/export') {
        seen.exports++;
        assert.equal(url.searchParams.get('mimeType'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        return send(200, workbookBuf, 'application/octet-stream');
      }
      if (url.pathname === '/drive/v3/files/XLSXID000002') {
        if (url.searchParams.get('alt') === 'media') { seen.media++; return send(200, workbookBuf, 'application/octet-stream'); }
        return send(200, { id: 'XLSXID000002', name: 'Z74 Finish Inventory (upload).xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      if (url.pathname === '/drive/v3/files/DISABLED0001') return send(403, { error: { message: 'Google Drive API has not been used in project 123 before or it is disabled.' } });
      return send(404, { error: { message: 'File not found' } });
    });
  });
  await new Promise(function (done) { fake.listen(0, done); });
  var base = 'http://127.0.0.1:' + fake.address().port;
  Object.assign(config.googleDrive, {
    serviceAccountEmail: SA, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    tokenUrl: base + '/token', apiBase: base, jsonInvalid: false
  });
  drive.resetToken();
});
test.after(async function () {
  await cleanup();
  Object.assign(config.googleDrive, saved);
  drive.resetToken();
  fake.close();
  await pool.end();
});

test('only inventory managers; not set up says so', async function () {
  await assert.rejects(drive.list(nobody, {}), /inventory\.manage/);
  await assert.rejects(drive.preview(nobody, 'SHEETID00001'), /inventory\.manage/);
  await assert.rejects(drive.commit(nobody, 'SHEETID00001', '2025-07', {}), /inventory\.manage/);

  var key = config.googleDrive.privateKey;
  config.googleDrive.privateKey = '';
  try {
    var r = await drive.list(admin, {});
    assert.equal(r.configured, false);
    assert.deepEqual(r.files, []);
    await assert.rejects(drive.preview(admin, 'SHEETID00001'), /isn't connected yet/);
  } finally { config.googleDrive.privateKey = key; }
});

test('the list: Finish Inventory sheets shared with the OS, each with its month and days already in the OS', async function () {
  var r = await drive.list(admin, {});
  assert.equal(r.configured, true);
  assert.equal(r.serviceAccountEmail, SA);
  assert.deepEqual(r.files.map(function (f) { return [f.id, f.month, f.daysInOs]; }), [['SHEETID00001', '2025-07', 0], ['XLSXID000002', null, null]]);
  assert.equal(r.files[0].owner, 'Kampz');
  assert.match(seen.queries[0], /name contains 'Finish Inventory'/);
  assert.match(seen.queries[0], /trashed = false/);
  await drive.list(admin, { all: true });
  assert.doesNotMatch(seen.queries[1], /Finish Inventory/, 'every spreadsheet when asked');
  assert.equal(seen.tokens, 1, 'one sign-in, reused while it lasts');
});

test('a Google Sheet is exported as .xlsx and previewed like an upload; importing fills in the days', async function () {
  var p = await drive.preview(admin, 'SHEETID00001');
  assert.equal(p.month, '2025-07', 'month from the sheet\'s name');
  assert.deepEqual(p.days.map(function (d) { return d.date; }), ['2025-07-01', '2025-07-02']);
  assert.equal(p.newProducts, 1);
  assert.deepEqual(p.driveFile, { id: 'SHEETID00001', name: '202507 Z74 Finish Inventory' });
  assert.equal(seen.exports, 1);

  var c = await drive.commit(admin, 'SHEETID00001', '2025-07', {});
  assert.equal(c.days, 2);
  assert.equal(c.created, 1);
  assert.equal(seen.exports, 2, 'fetched again for the import, not trusted from the preview');
  var lines = (await pool.query(
    "SELECT date::text AS date, physical FROM stock_sheet_lines WHERE product_id = (SELECT id FROM products WHERE sku LIKE 'Z74%' LIMIT 1) ORDER BY date")).rows;
  assert.deepEqual(lines.map(function (l) { return l.date; }), ['2025-07-01', '2025-07-02']);
  assert.equal(Number(lines[1].physical), 40);

  var r = await drive.list(admin, {});
  assert.equal(r.files[0].daysInOs, 2, 'the list now shows the month as filled in');
});

test('an .xlsx uploaded to Drive is downloaded as it is; its month comes from the choice made', async function () {
  var p = await drive.preview(admin, 'XLSXID000002', '2025-07');
  assert.equal(seen.media, 1);
  assert.equal(p.month, '2025-07');
  assert.equal(p.days.length, 2);
});

test('missing, oddly named and blocked files come back in plain words', async function () {
  await assert.rejects(drive.preview(admin, 'GONEFILE0001'), /isn't in Google Drive any more/);
  await assert.rejects(drive.preview(admin, '../../etc'), /isn't a Google Drive file/);
  await assert.rejects(drive.preview(admin, 'DISABLED0001'), /Google Drive API is turned off/);
});

test('a key Google refuses: told to check the key and the Drive API', async function () {
  var other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var key = config.googleDrive.privateKey;
  config.googleDrive.privateKey = other.privateKey.export({ type: 'pkcs8', format: 'pem' });
  drive.resetToken();
  try {
    await assert.rejects(drive.list(admin, {}), /didn't accept the service account/);
  } finally {
    config.googleDrive.privateKey = key;
    drive.resetToken();
  }
});

test('names with a month in them', function () {
  assert.equal(drive.monthFromName('202609 BPL Finish Inventory'), '2026-09');
  assert.equal(drive.monthFromName('2026-06 Finish Inventory'), '2026-06');
  assert.equal(drive.monthFromName('2026 BPL Finish Inventory'), null);
  assert.equal(drive.monthFromName('202613 nonsense'), null);
});
