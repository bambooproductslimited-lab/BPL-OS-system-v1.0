/*
 * Financial Reports section (reports.service.js's profitAndLoss/cashFlow/
 * balanceSheet/arAging/expenseDetail + the balance-sheet manual inputs).
 * Requires `npm run migrate && npm run seed` first, same as the other test
 * files.
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

test('financial reports: read is permission-gated (report.read), manage is separately gated (report.manage)', async function () {
  var alice = await login('alice.kamau@bplghana.com'); // plain employee — no report.read
  var andy = await login('andy.chou@bplghana.com'); // executive — report.read but not report.manage
  var albert = await login('albert.awini@bplghana.com'); // finance & HR manager — both

  for (var path of ['/api/reports/pnl', '/api/reports/cashflow', '/api/reports/balance-sheet', '/api/reports/ar-aging', '/api/reports/expense-detail', '/api/reports/balance-sheet/inputs']) {
    var denied = await fetch(base + path, { headers: authed(alice) });
    assert.equal(denied.status, 403, path + ' should deny a role without report.read');
    var allowed = await fetch(base + path, { headers: authed(andy) });
    assert.equal(allowed.status, 200, path + ' should allow report.read');
  }

  var manageDenied = await fetch(base + '/api/reports/balance-sheet/inputs', {
    method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(andy)), body: JSON.stringify({ cashAndBank: 1 })
  });
  assert.equal(manageDenied.status, 403, 'report.read alone should not allow editing balance sheet inputs');

  var manageAllowed = await fetch(base + '/api/reports/balance-sheet/inputs', {
    method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(albert)), body: JSON.stringify({ cashAndBank: 1 })
  });
  assert.equal(manageAllowed.status, 200, 'report.manage should allow editing balance sheet inputs');
});

test('balance sheet: manual inputs feed into totals and the balance check reflects them', async function () {
  var albert = await login('albert.awini@bplghana.com');

  var patchRes = await fetch(base + '/api/reports/balance-sheet/inputs', {
    method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, authed(albert)),
    body: JSON.stringify({ cashAndBank: 5000, accountsPayable: 1000, loansPayable: 500, otherLiabilities: 200, ownersEquity: 2000 })
  });
  assert.equal(patchRes.status, 200);
  var saved = await patchRes.json();
  assert.equal(saved.cashAndBank, 5000);

  var bsRes = await fetch(base + '/api/reports/balance-sheet', { headers: authed(albert) });
  var bs = await bsRes.json();
  assert.equal(bs.assets.cashAndBank, 5000);
  assert.equal(bs.liabilities.total, 1000 + 500 + 200);
  assert.equal(bs.assets.total, bs.assets.cashAndBank + bs.assets.accountsReceivable + bs.assets.inventoryValue + bs.assets.fixedAssets);
  assert.equal(bs.balanceCheck, bs.assets.total - (bs.liabilities.total + bs.equity.total));
});

test('P&L, cash flow, AR aging and expense detail return well-formed shapes for the default period', async function () {
  var albert = await login('albert.awini@bplghana.com');

  var pnl = await (await fetch(base + '/api/reports/pnl', { headers: authed(albert) })).json();
  assert.ok('revenue' in pnl && 'totalExpenses' in pnl && 'payrollCost' in pnl && 'netProfit' in pnl);
  assert.equal(pnl.netProfit, pnl.revenue - pnl.totalExpenses - pnl.payrollCost);

  var cf = await (await fetch(base + '/api/reports/cashflow', { headers: authed(albert) })).json();
  assert.equal(cf.netCashFlow, cf.cashIn - cf.cashOut);
  assert.equal(cf.cashOut, cf.expensesOut + cf.payrollOut);

  var aging = await (await fetch(base + '/api/reports/ar-aging', { headers: authed(albert) })).json();
  var bucketSum = Object.values(aging.buckets).reduce(function (s, n) { return s + n; }, 0);
  assert.ok(Math.abs(bucketSum - aging.total) < 0.01);

  var detail = await (await fetch(base + '/api/reports/expense-detail', { headers: authed(albert) })).json();
  var catSum = detail.byCategory.reduce(function (s, r) { return s + r.amount; }, 0);
  assert.ok(Math.abs(catSum - detail.total) < 0.01);
});
