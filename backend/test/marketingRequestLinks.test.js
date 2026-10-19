// Links on a request to marketing (mkRequests.service.js, migration 0151):
// anyone on it adds a reference (a Drive folder, a design, a post to copy);
// marketing adds where the finished work lives, and the one who asked is
// told. Web addresses only — "www.…" gets https:// in front, and
// javascript:, data:, mailto: or a link with a password in it are refused.
// Whoever added a link, or marketing, can take it off. On throwaway ZML
// requests.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var requests = require('../src/services/mkRequests.service');

var boss, staff, helper;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
async function cleanup() {
  await pool.query("DELETE FROM notifications WHERE link IN (SELECT '/mkrequests?open=' || id FROM marketing_requests WHERE title LIKE 'ZML%')");
  await pool.query("DELETE FROM marketing_requests WHERE title LIKE 'ZML%'");
}
async function told(who, id) {
  return (await pool.query('SELECT title, body FROM notifications WHERE employee_id = $1 AND link = $2 ORDER BY at', [who, '/mkrequests?open=' + id])).rows;
}

test.before(async function () {
  boss = await ctxFor('kelvin.duho@bplghana.com');
  staff = await ctxFor('alice.kamau@bplghana.com');
  helper = await ctxFor('john.sitati@bplghana.com');
  await cleanup();
});
test.after(async function () { await cleanup(); await pool.end(); });

test('anyone on a request adds a reference link; marketing adds where the finished work is, and the asker is told', async function () {
  var r = await requests.create(staff, { company: 'BPL', title: 'ZML Showroom flyer', kind: 'flyer' });
  r = await requests.addLink(staff, r.id, { url: '  drive.google.com/drive/folders/zml ', label: 'Photos of the showroom', delivered: true });
  assert.deepEqual(r.links.map(function (k) { return [k.url, k.label, k.host, k.delivered, k.byId]; }),
    [['https://drive.google.com/drive/folders/zml', 'Photos of the showroom', 'drive.google.com', false, staff.employee.id]], 'only marketing hands back the finished work');
  assert.ok(r.links[0].by);

  r = await requests.addLink(boss, r.id, { url: 'https://www.facebook.com/zml/posts/1', delivered: true });
  assert.deepEqual(r.links.map(function (k) { return [k.host, k.delivered]; }), [['facebook.com', true], ['drive.google.com', false]], 'the finished work first');
  var mine = await told(staff.employee.id, r.id);
  assert.deepEqual(mine.map(function (n) { return [n.title, n.body]; }), [['Your ZML Showroom flyer is ready', 'facebook.com']]);

  var listed = (await requests.list(staff, {})).requests.find(function (x) { return x.id === r.id; });
  assert.deepEqual([listed.links, listed.delivered, listed.files], [2, 1, 0], 'a finished link counts as finished work on the board');
});

test('only web links: others are refused, whatever is typed', async function () {
  var r = await requests.create(staff, { company: 'BPL', title: 'ZML Banner', kind: 'banner' });
  var bad = [['', /Paste the link/], ['javascript:alert(1)', /Only web links/], ['data:text/html,<b>x</b>', /Only web links/], ['mailto:someone@example.com', /Only web links/],
    ['ftp://files.example.com/a.zip', /Only web links/], ['hello', /not a web link/], ['https://user:secret@example.com/x', /password/]];
  for (var b of bad) await assert.rejects(requests.addLink(staff, r.id, { url: b[0] }), b[1], b[0]);
  r = await requests.addLink(staff, r.id, { url: 'example.com:8080/brief?x=1' });
  assert.equal(r.links[0].url, 'https://example.com:8080/brief?x=1');
  assert.equal(r.links.length, 1);
});

test('who may add and take off a link', async function () {
  var r = await requests.create(staff, { company: 'BPL', title: 'ZML Price list', kind: 'other' });
  await assert.rejects(requests.addLink(helper, r.id, { url: 'https://example.com/zml' }), /not yours/);
  r = await requests.addLink(boss, r.id, { url: 'https://example.com/zml-boss' });
  r = await requests.addLink(staff, r.id, { url: 'https://example.com/zml-staff' });
  var bossLink = r.links.find(function (k) { return k.url.endsWith('boss'); }), staffLink = r.links.find(function (k) { return k.url.endsWith('staff'); });
  await assert.rejects(requests.removeLink(staff, r.id, bossLink.id), /whoever added it/);
  r = await requests.removeLink(staff, r.id, staffLink.id);
  assert.deepEqual(r.links.map(function (k) { return k.id; }), [bossLink.id]);
  r = await requests.removeLink(boss, r.id, bossLink.id);
  assert.equal(r.links.length, 0);
  await assert.rejects(requests.removeLink(boss, r.id, bossLink.id), /not found/);
});

test('links given with a new request; a bad one stops it being made', async function () {
  var r = await requests.create(staff, { company: 'BPL', title: 'ZML Menu card', kind: 'other', links: ['www.canva.com/design/zml', { url: 'https://instagram.com/p/zml', label: 'Like this one' }] });
  assert.deepEqual(r.links.map(function (k) { return [k.url, k.label]; }), [['https://www.canva.com/design/zml', ''], ['https://instagram.com/p/zml', 'Like this one']]);
  await assert.rejects(requests.create(staff, { company: 'BPL', title: 'ZML Not made', kind: 'other', links: ['javascript:alert(1)'] }), /Only web links/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketing_requests WHERE title = 'ZML Not made'")).rows[0].n, 0);
});
