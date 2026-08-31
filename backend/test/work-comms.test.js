/*
 * Integration test for the Work & Comms modules (tasks, projects,
 * announcements, documents, messages). Requires `npm run migrate && npm run
 * seed` first, same as the other test files.
 */
var test = require('node:test');
var assert = require('node:assert/strict');

// Fake R2 credentials so storage.configured is true and documents.service
// exercises its real upload/download code paths — set before requiring the
// app, since config.js reads these at module-load time. The actual network
// call is stubbed below (S3Client.prototype.send), so nothing hits real R2.
process.env.R2_ACCOUNT_ID = 'test-account';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_BUCKET = 'test-bucket';

var app = require('../src/app');
var { S3Client } = require('@aws-sdk/client-s3');
S3Client.prototype.send = async function () { return {}; };

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

test('project + task lifecycle: create, assign, self-service status change, comment, delete', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var depts = await (await fetch(base + '/api/departments', { headers: authed(admin) })).json();
  var prodDept = depts.find(function (d) { return d.code === 'PROD'; });
  var aliceId = await employeeId(admin, 'alice.kamau@bplghana.com');

  var deniedProject = await fetch(base + '/api/projects', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ name: 'Denied', departmentId: prodDept.id })
  });
  assert.equal(deniedProject.status, 403);

  var projectRes = await fetch(base + '/api/projects', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ name: 'Work-Comms Test Project', departmentId: prodDept.id, memberIds: [aliceId] })
  });
  assert.equal(projectRes.status, 201);
  var project = await projectRes.json();

  var statusRes = await fetch(base + '/api/projects/' + project.id + '/status', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ status: 'active' })
  });
  assert.equal((await statusRes.json()).status, 'active');

  var taskRes = await fetch(base + '/api/tasks', {
    method: 'POST', headers: jsonAuthed(isreal),
    body: JSON.stringify({ title: 'Work-Comms Test Task', projectId: project.id, assigneeIds: [aliceId], priority: 'high' })
  });
  assert.equal(taskRes.status, 201);
  var task = await taskRes.json();
  assert.equal(task.status, 'not_started');
  assert.deepEqual(task.assigneeNames, ['Alice Kamau']);

  var mineRes = await fetch(base + '/api/tasks?scope=mine', { headers: authed(alice) });
  var mine = await mineRes.json();
  assert.ok(mine.some(function (t) { return t.id === task.id; }));

  // Alice is an assignee, not a manager — she can still change status (no task.manage gate on setStatus).
  var selfStatusRes = await fetch(base + '/api/tasks/' + task.id + '/status', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ status: 'in_progress' })
  });
  assert.equal((await selfStatusRes.json()).status, 'in_progress');

  var commentRes = await fetch(base + '/api/tasks/' + task.id + '/comments', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ body: 'On it.' })
  });
  assert.equal(commentRes.status, 201);
  var withComment = await commentRes.json();
  assert.equal(withComment.comments.length, 1);
  assert.equal(withComment.comments[0].authorName, 'Alice Kamau');

  var deleteDenied = await fetch(base + '/api/tasks/' + task.id, { method: 'DELETE', headers: authed(alice) });
  assert.equal(deleteDenied.status, 403);

  var deleteRes = await fetch(base + '/api/tasks/' + task.id, { method: 'DELETE', headers: authed(isreal) });
  assert.equal(deleteRes.status, 200);
});

test('announcements: publish is permission-gated, audience scoping', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/announcements', {
    method: 'POST', headers: jsonAuthed(isreal), body: JSON.stringify({ title: 'x', body: 'y' })
  });
  assert.equal(denied.status, 403);

  var published = await fetch(base + '/api/announcements', {
    method: 'POST', headers: jsonAuthed(admin), body: JSON.stringify({ title: 'Company-wide notice', body: 'Everyone should see this.', pinned: true })
  });
  assert.equal(published.status, 201);

  var list = await (await fetch(base + '/api/announcements', { headers: authed(alice) })).json();
  assert.ok(list.some(function (a) { return a.title === 'Company-wide notice'; }));
  assert.equal(list[0].pinned, true); // pinned sorts first
});

test('announcements: publishing notifies the audience (company-wide vs. department-scoped), never the publisher', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com'); // Productions department
  var emmanuel = await login('emmanuel.chang@bplghana.com'); // I.T Department

  var depts = await (await fetch(base + '/api/departments', { headers: authed(admin) })).json();
  var production = depts.find(function (d) { return d.name === 'Productions'; });
  assert.ok(production, 'seed data must include a Productions department');

  var unique = 'Notify test ' + Date.now();
  var published = await fetch(base + '/api/announcements', {
    method: 'POST', headers: jsonAuthed(admin),
    body: JSON.stringify({ title: unique, body: 'Production-only notice.', audience: production.id })
  });
  assert.equal(published.status, 201);

  var aliceNotifs = await (await fetch(base + '/api/notifications', { headers: authed(alice) })).json();
  var match = aliceNotifs.find(function (n) { return n.title === 'New announcement' && n.body === unique; });
  assert.ok(match, 'Productions employee should be notified of a Productions-scoped announcement');
  assert.equal(match.read, false);
  assert.equal(match.link, 'announcements');

  var emmanuelNotifs = await (await fetch(base + '/api/notifications', { headers: authed(emmanuel) })).json();
  assert.ok(!emmanuelNotifs.some(function (n) { return n.body === unique; }), 'IT employee should not be notified of a Productions-only announcement');

  var adminNotifs = await (await fetch(base + '/api/notifications', { headers: authed(admin) })).json();
  assert.ok(!adminNotifs.some(function (n) { return n.body === unique; }), 'the publisher should not notify themself');

  // Mark-as-read round trip, exercised end-to-end here since this is the
  // notification the test just created.
  var markRead = await fetch(base + '/api/notifications/read', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ id: match.id })
  });
  assert.equal(markRead.status, 200);
  var afterRead = await (await fetch(base + '/api/notifications', { headers: authed(alice) })).json();
  assert.equal(afterRead.find(function (n) { return n.id === match.id; }).read, true);
});

test('documents: upload requires document.manage, visibility scoping to "all"', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');

  var denied = await fetch(base + '/api/documents', {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ title: 'x', category: 'y', fileName: 'x.pdf' })
  });
  assert.equal(denied.status, 403);

  var form = new FormData();
  form.append('title', 'Test Handbook');
  form.append('category', 'Policy');
  form.append('visibility', 'all');
  form.append('file', new Blob(['fake pdf content'], { type: 'application/pdf' }), 'handbook.pdf');
  var uploaded = await fetch(base + '/api/documents', { method: 'POST', headers: authed(admin), body: form });
  assert.equal(uploaded.status, 201);
  var doc = await uploaded.json();
  assert.equal(doc.hasFile, true);

  var list = await (await fetch(base + '/api/documents', { headers: authed(alice) })).json();
  assert.ok(list.some(function (d) { return d.title === 'Test Handbook'; }));

  var download = await fetch(base + '/api/documents/' + doc.id + '/download', { headers: authed(alice) });
  assert.equal(download.status, 200);
  assert.ok((await download.json()).url.startsWith('https://'));
});

test('messages: send, inbox, thread marks read, cannot message self', async function () {
  var admin = await login('kelvin.duho@bplghana.com');
  var alice = await login('alice.kamau@bplghana.com');
  var isreal = await login('isreal.omozuafo@bplghana.com');
  var aliceId = await employeeId(admin, 'alice.kamau@bplghana.com');
  var isrealId = await employeeId(admin, 'isreal.omozuafo@bplghana.com');

  var selfMsg = await fetch(base + '/api/messages/' + aliceId, {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ body: 'talking to myself' })
  });
  assert.equal(selfMsg.status, 400);

  var sendRes = await fetch(base + '/api/messages/' + isrealId, {
    method: 'POST', headers: jsonAuthed(alice), body: JSON.stringify({ body: 'Test message for work-comms suite' })
  });
  assert.equal(sendRes.status, 201);

  var inbox = await (await fetch(base + '/api/messages', { headers: authed(isreal) })).json();
  var thread = inbox.find(function (t) { return t.peerId === aliceId; });
  assert.ok(thread);
  assert.ok(thread.unread >= 1);

  var threadRes = await (await fetch(base + '/api/messages/' + aliceId, { headers: authed(isreal) })).json();
  assert.ok(threadRes.messages.some(function (m) { return m.body === 'Test message for work-comms suite'; }));

  var inboxAfter = await (await fetch(base + '/api/messages', { headers: authed(isreal) })).json();
  var threadAfter = inboxAfter.find(function (t) { return t.peerId === aliceId; });
  assert.equal(threadAfter.unread, 0);
});
