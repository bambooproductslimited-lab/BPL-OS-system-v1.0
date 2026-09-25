// Company documents: which company a document belongs to, a description,
// editing any detail, a new version of the file, and files kept in the
// database when Cloudflare R2 is not set up (as in these tests).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var docs = require('../src/services/documents.service');
var fileStore = require('../src/lib/fileStore');
var { buildContext } = require('../src/services/context.service');

var boss, staff, companyId;

async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
function limited(ctx, drop) {
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { can: function (p) { return drop.indexOf(p) < 0 && ctx.can(p); } });
}
function file(name, text, type) {
  var buffer = Buffer.from(text);
  return { originalname: name, mimetype: type || 'application/pdf', size: buffer.length, buffer: buffer };
}
async function storedCount(key) {
  return (await pool.query('SELECT count(*)::int AS n FROM stored_files WHERE id = $1', [key.slice(3)])).rows[0].n;
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = limited(await ctxFor('samuel.kiptoo@bplghana.com'), ['document.manage', 'employee.read.all']);
  companyId = (await pool.query("SELECT id FROM companies ORDER BY code LIMIT 1")).rows[0].id;
});
test.after(async function () {
  var left = (await pool.query("SELECT object_key FROM documents WHERE title LIKE 'Zqd%'")).rows;
  for (var r of left) await fileStore.del(r.object_key);
  await pool.query("DELETE FROM documents WHERE title LIKE 'Zqd%'");
  await pool.end();
});

test('upload keeps the file in the database and records company, description and size', async function () {
  var d = await docs.upload(boss, { title: 'Zqd fire certificate', category: 'Certificate', description: 'Yard and warehouse.', companyId: companyId, expiresOn: '2031-05-01', file: file('fire.pdf', '%PDF-1.4 zq') });
  assert.deepEqual([d.companyId, d.description, d.size, d.contentType, d.version, d.expiresOn, d.hasFile], [companyId, 'Yard and warehouse.', 11, 'application/pdf', 1, '2031-05-01', true]);
  var row = (await pool.query('SELECT object_key FROM documents WHERE id = $1', [d.id])).rows[0];
  assert.match(row.object_key, /^db:/);

  var seen = (await docs.list(staff)).find(function (x) { return x.id === d.id; });
  assert.ok(seen.uploaderName && seen.companyCode && seen.companyName);
  assert.equal(seen.uploaderPhoto === null || typeof seen.uploaderPhoto === 'number', true);

  var f = await docs.fileFor(staff, d.id);
  assert.equal(f.fileName, 'fire.pdf');
  assert.equal((await fileStore.get(f.key)).buffer.toString(), '%PDF-1.4 zq');
  assert.deepEqual(await docs.getDownloadUrl(staff, d.id), { url: null, file: '/documents/' + d.id + '/file' });
});

test('editing changes only what was sent; the expiry alone still works', async function () {
  var d = await docs.upload(boss, { title: 'Zqd trade licence', category: 'Licence', file: file('lic.pdf', 'zq') });
  var e = await docs.update(boss, d.id, { title: 'Zqd trade licence 2026', description: 'Renew in May.' });
  assert.deepEqual([e.title, e.category, e.description, e.visibility, e.companyId], ['Zqd trade licence 2026', 'Licence', 'Renew in May.', 'all', null]);
  assert.ok(e.updatedAt);

  e = await docs.update(boss, d.id, { expiresOn: '2030-01-31' });
  assert.deepEqual([e.expiresOn, e.title, e.description], ['2030-01-31', 'Zqd trade licence 2026', 'Renew in May.']);
  var actions = (await pool.query('SELECT action FROM audit_logs WHERE entity_id = $1', [String(d.id)])).rows.map(function (r) { return r.action; });
  assert.ok(actions.indexOf('document.expiry') >= 0 && actions.indexOf('document.update') >= 0);

  e = await docs.update(boss, d.id, { visibility: 'managers', companyId: companyId });
  assert.deepEqual([e.visibility, e.companyId, e.expiresOn], ['managers', companyId, '2030-01-31']);
  assert.equal((await docs.list(staff)).some(function (x) { return x.id === d.id; }), false, 'staff no longer see a managers-only document');
  await assert.rejects(function () { return docs.fileFor(staff, d.id); }, /access/);

  await assert.rejects(function () { return docs.update(boss, d.id, { title: '' }); }, /Title/);
  await assert.rejects(function () { return docs.update(boss, d.id, { companyId: '00000000-0000-0000-0000-000000000000' }); }, /company/);
  await assert.rejects(function () { return docs.update(staff, d.id, { title: 'Zqd no' }); }, /document.manage/);
});

test('a new version replaces the file, moves the expiry on and removes the old file', async function () {
  var d = await docs.upload(boss, { title: 'Zqd insurance', category: 'Insurance', expiresOn: '2027-01-01', file: file('ins-2026.pdf', 'old') });
  var oldKey = (await pool.query('SELECT object_key FROM documents WHERE id = $1', [d.id])).rows[0].object_key;
  var v2 = await docs.replaceFile(boss, d.id, { expiresOn: '2028-01-01', file: file('ins-2027.png', 'newer', 'image/png') });
  assert.deepEqual([v2.version, v2.fileName, v2.contentType, v2.size, v2.expiresOn], [2, 'ins-2027.png', 'image/png', 5, '2028-01-01']);
  assert.equal(await storedCount(oldKey), 0, 'the old file is gone');
  var v3 = await docs.replaceFile(boss, d.id, { file: file('ins-2028.pdf', 'newest') });
  assert.deepEqual([v3.version, v3.expiresOn], [3, '2028-01-01'], 'no new date keeps the old one');

  await assert.rejects(function () { return docs.replaceFile(boss, d.id, {}); }, /Choose a file/);
  await assert.rejects(function () { return docs.replaceFile(staff, d.id, { file: file('x.pdf', 'x') }); }, /document.manage/);

  var key = (await pool.query('SELECT object_key FROM documents WHERE id = $1', [d.id])).rows[0].object_key;
  await assert.rejects(function () { return docs.remove(staff, d.id); }, /document.manage/);
  await docs.remove(boss, d.id);
  assert.equal(await storedCount(key), 0);
  await assert.rejects(function () { return docs.fileFor(boss, d.id); }, /not found/);
});

test('only document managers upload; a department document needs a real department', async function () {
  await assert.rejects(function () { return docs.upload(staff, { title: 'Zqd x', category: 'x', file: file('x.pdf', 'x') }); }, /document.manage/);
  await assert.rejects(function () { return docs.upload(boss, { title: 'Zqd y', category: 'y' }); }, /Choose a file/);
  var d = await docs.upload(boss, { title: 'Zqd dept form', category: 'Form', visibility: 'department', file: file('f.pdf', 'f') });
  assert.equal(d.departmentId, boss.employee.department_id);
  await assert.rejects(function () { return docs.upload(boss, { title: 'Zqd z', category: 'z', visibility: 'department', departmentId: '00000000-0000-0000-0000-000000000000', file: file('z.pdf', 'z') }); }, /department/);
});
