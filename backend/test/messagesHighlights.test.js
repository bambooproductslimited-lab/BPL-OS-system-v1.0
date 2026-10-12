// Messages with no chat open: the reader's week in messages, who they talk
// to most, the busiest chat, what was shared, reactions to their messages
// and who is online. On throwaway employees of its own; only the reader's
// own chats count.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var messages = require('../src/services/messages.service');
var { buildContext } = require('../src/services/context.service');

var a, b, c, ctxA, ctxB, ctxC, convId;
function as(base, emp) {
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, { employee: Object.assign({}, base.employee, emp) });
}

test.before(async function () {
  var kelvin = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var dept = (await pool.query('SELECT department_id FROM employees WHERE id = $1', [kelvin.employee.id])).rows[0].department_id;
  async function person(code, first) {
    return (await pool.query(
      "INSERT INTO employees (code, first_name, last_name, email, department_id, position_title, employment_type, hire_date, status) VALUES ($1,'Zq',$2,$3,$4,'Tester','permanent',CURRENT_DATE,'active') RETURNING id",
      [code, first, code.toLowerCase() + '@example.com', dept])).rows[0].id;
  }
  a = await person('ZQH-1', 'Ama'); b = await person('ZQH-2', 'Kofi'); c = await person('ZQH-3', 'Esi');
  ctxA = as(kelvin, { id: a, first_name: 'Zq', last_name: 'Ama' });
  ctxB = as(kelvin, { id: b, first_name: 'Zq', last_name: 'Kofi' });
  ctxC = as(kelvin, { id: c, first_name: 'Zq', last_name: 'Esi' });
  var first = await messages.sendDirect(ctxA, b, 'Morning Kofi', []);
  convId = first.conversationId;
  await messages.sendDirect(ctxA, b, 'The stools are ready', []);
  var reply = await messages.sendToConversation(ctxB, convId, 'Great, thanks', []);
  await messages.react(ctxB, first.id, '🔥');
  await pool.query("INSERT INTO message_attachments (message_id, file_name, content_type, size, kind, storage_key) VALUES ($1, 'zq.png', 'image/png', 10, 'image', 'zq-none')", [reply.id]);
  await pool.query("UPDATE employees SET last_seen_at = now() WHERE id = ANY($1)", [[a, b]]);
});
test.after(async function () {
  await pool.query('DELETE FROM conversations WHERE id = $1', [convId]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [[a, b, c]]);
  await pool.end();
});

test('the week in messages, who you talk to most, the busiest chat and what was shared', async function () {
  var h = await messages.highlights(ctxA);
  assert.equal(h.week.length, 7);
  assert.equal(h.week[6].date, new Date().toISOString().slice(0, 10));
  assert.deepEqual([h.week[6].sent, h.week[6].received], [2, 1]);
  assert.deepEqual([h.sentThisWeek, h.receivedThisWeek], [2, 1]);
  assert.deepEqual(h.topPeople.map(function (p) { return [p.id, p.conversationId, p.count]; }), [[b, convId, 3]]);
  assert.deepEqual([h.busiest.conversationId, h.busiest.kind, h.busiest.id, h.busiest.count], [convId, 'direct', b, 3]);
  assert.deepEqual(h.shared, { photos: 1, files: 0, records: 0 });
  assert.deepEqual(h.reactions, { count: 1, top: [{ emoji: '🔥', count: 1 }] });
});

test('online is everyone else with the OS open; someone outside the chat sees none of it', async function () {
  var h = await messages.highlights(ctxA);
  assert.ok(h.online.people.some(function (p) { return p.id === b; }));
  assert.ok(h.online.people.every(function (p) { return p.id !== a; }), 'not yourself');
  var other = await messages.highlights(ctxC);
  assert.equal(other.sentThisWeek + other.receivedThisWeek, 0);
  assert.equal(other.topPeople.length, 0);
  assert.equal(other.busiest, null);
  assert.deepEqual(other.shared, { photos: 0, files: 0, records: 0 });
  assert.ok(other.online.people.some(function (p) { return p.id === a; }));
});
