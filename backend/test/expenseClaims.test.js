// Expense claims: nobody decides their own claim, a reason goes with the
// decision, paying stamps who and when, and a receipt (photo or PDF) can be
// attached by the requester while pending — or by an approver until paid —
// and opened by anyone who can see the claim.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var expenses = require('../src/services/expenses.service');
var { buildContext } = require('../src/services/context.service');

var alice, isreal, made = [];
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
test.before(async function () {
  alice = await ctxFor('alice.kamau@bplghana.com');
  isreal = await ctxFor('isreal.omozuafo@bplghana.com');
});
test.after(async function () {
  for (var i = 0; i < made.length; i++) {
    var r = (await pool.query('SELECT receipt_key FROM expenses WHERE id = $1', [made[i]])).rows[0];
    if (r && r.receipt_key && r.receipt_key.startsWith('db:')) await pool.query('DELETE FROM stored_files WHERE id = $1', [r.receipt_key.slice(3)]);
    await pool.query("DELETE FROM approvals WHERE subject_type = 'expense' AND subject_id = $1", [made[i]]);
    await pool.query('DELETE FROM expenses WHERE id = $1', [made[i]]);
  }
  await pool.end();
});
var png = { originalname: 'zqx-receipt.png', mimetype: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) };

test('no deciding your own claim; reason and paid stamp recorded', async function () {
  var mine = await expenses.create(isreal, { category: 'Zqx Fuel', amount: 90, description: 'Zqx own claim' });
  made.push(mine.id);
  await assert.rejects(expenses.decide(isreal, mine.id, 'approved'), /your own claim/);

  var c = await expenses.create(alice, { category: 'Zqx Travel', amount: 120, description: 'Zqx site visit' });
  made.push(c.id);
  var d = await expenses.decide(isreal, c.id, 'approved', '  Zqx fine, within budget ');
  assert.equal(d.decisionNote, 'Zqx fine, within budget');
  var p = await expenses.markPaid(isreal, c.id);
  assert.equal(p.status, 'paid');
  assert.ok(p.paidAt);
  var row = (await expenses.list(isreal)).find(function (x) { return x.id === c.id; });
  assert.ok(row.decidedByName);
  assert.ok(row.paidByName);
});

test('receipts: requester while pending, approver until paid, visible to both', async function () {
  var c = await expenses.create(alice, { category: 'Zqx Meals', amount: 45, description: 'Zqx lunch with client' });
  made.push(c.id);
  var withR = await expenses.attachReceipt(alice, c.id, png);
  assert.equal(withR.receipt.name, 'zqx-receipt.png');
  var f = await expenses.receiptFile(isreal, c.id);
  assert.ok(f.key);
  await expenses.decide(isreal, c.id, 'approved');
  await assert.rejects(expenses.attachReceipt(alice, c.id, png), /waiting for a decision/);
  var again = await expenses.attachReceipt(isreal, c.id, Object.assign({}, png, { originalname: 'zqx-paper.png' }));
  assert.equal(again.receipt.name, 'zqx-paper.png');
  await expenses.markPaid(isreal, c.id);
  await assert.rejects(expenses.attachReceipt(isreal, c.id, png), /own claims/);
});
