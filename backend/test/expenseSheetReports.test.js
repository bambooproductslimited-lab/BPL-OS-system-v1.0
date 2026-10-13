// Expense-sheet spending in the money reports: lines count as a cost in the
// P&L (by category, for the cost centre's company or the officer's), as
// money out on the cash flow on the day they were spent, and in retained
// earnings; float cash officers hold is an asset and what the company owes
// them a debt. Uses July 2022 to stay clear of other tests' data; the
// figures that are "now" rather than for a period (floats held and owed,
// the balance sheet) are checked as lower bounds and for adding up, since
// other test files run alongside and change them.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var reports = require('../src/services/reports.service');
var { buildContext } = require('../src/services/context.service');

var boss, other, sheetA, sheetB;
var P = { from: '2022-07-01', to: '2022-07-31' };
var r2 = function (n) { return Math.round(n * 100) / 100; };

async function line(sheet, seq, kind, date, amount, category, companyId) {
  await pool.query(
    'INSERT INTO expense_sheet_lines (sheet_id, kind, seq, date, amount, note, category, company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [sheet, kind, seq, date, amount, 'Zqs line ' + seq, category || '', companyId || null]);
}

test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  var list = await reports.statementCompanies(boss);
  var code = (list.find(function (c) { return c.code !== 'ALL' && c.code !== 'BPL'; }) || {}).code;
  other = code ? (await pool.query('SELECT id, code FROM companies WHERE code = $1', [code])).rows[0] : null;
});
test.after(async function () {
  if (sheetA) await pool.query('DELETE FROM expense_sheets WHERE id = $1', [sheetA]);
  if (sheetB) await pool.query('DELETE FROM expense_sheets WHERE id = $1', [sheetB]);
  await pool.end();
});

test('sheet spending counts in the P&L, cash flow, balance sheet and expense detail', async function () {
  var pnl0 = await reports.profitAndLoss(boss, P);
  var bpl0 = await reports.profitAndLoss(boss, Object.assign({ company: 'BPL' }, P));
  var oth0 = other ? await reports.profitAndLoss(boss, Object.assign({ company: other.code }, P)) : null;
  var cf0 = await reports.cashFlow(boss, P);

  var people = (await pool.query(
    "SELECT e.id FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = d.company_id " +
    "WHERE c.code = 'BPL' AND e.status = 'active' AND NOT EXISTS (SELECT 1 FROM expense_sheets s WHERE s.employee_id = e.id) ORDER BY e.id LIMIT 2")).rows;
  sheetA = (await pool.query('INSERT INTO expense_sheets (employee_id, float_limit) VALUES ($1, 500) RETURNING id', [people[0].id])).rows[0].id;
  sheetB = (await pool.query('INSERT INTO expense_sheets (employee_id, float_limit) VALUES ($1, 0) RETURNING id', [people[1].id])).rows[0].id;
  // A: given 500, spent 120 for the other company's cost centre and 80 with none (its own, BPL) → holds 300.
  await line(sheetA, 1, 'funding', '2022-07-01', 500);
  await line(sheetA, 2, 'expense', '2022-07-04', 120, 'Zqs Fuel', other ? other.id : null);
  await line(sheetA, 3, 'expense', '2022-07-05', 80, 'Zqs Fuel');
  // B: spent 300 with no float → the company owes them 300.
  await line(sheetB, 1, 'expense', '2022-07-06', 300, 'Zqs Repairs');

  var pnl = await reports.profitAndLoss(boss, P);
  assert.equal(r2(pnl.totalExpenses - pnl0.totalExpenses), 500, 'every sheet line is a cost for all companies together');
  assert.equal(r2(pnl.expenseSources.sheets - pnl0.expenseSources.sheets), 500);
  assert.equal(pnl.expenseByCategory.find(function (c) { return c.category === 'Zqs Fuel'; }).amount, 200);
  assert.equal(r2(pnl0.netProfit - pnl.netProfit), 500);

  var bpl = await reports.profitAndLoss(boss, Object.assign({ company: 'BPL' }, P));
  assert.equal(r2(bpl.totalExpenses - bpl0.totalExpenses), other ? 380 : 500, "BPL gets the lines with no cost-centre company (the officer's own)");
  if (other) {
    var oth = await reports.profitAndLoss(boss, Object.assign({ company: other.code }, P));
    assert.equal(r2(oth.totalExpenses - oth0.totalExpenses), 120, "the other company gets its cost centre's line");
  }

  var cf = await reports.cashFlow(boss, P);
  assert.equal(r2(cf.expensesOut - cf0.expensesOut), 500, 'spent float is money out on the day it was spent');
  assert.equal(r2(cf.expensesOutLines.sheets - cf0.expensesOutLines.sheets), 500);
  assert.equal(r2(cf.floats.givenInPeriod - cf0.floats.givenInPeriod), 500);
  assert.ok(cf.stillToPay.owedToOfficers >= 300, 'what the company owes officers is still to go out');
  assert.equal(cf.stillToPay.owedToOfficers, cf.floats.owedToOfficers);

  var bs = await reports.balanceSheet(boss);
  assert.ok(bs.assets.cashWithOfficers >= 300, 'float cash officers hold is an asset');
  assert.ok(bs.liabilities.owedToOfficers >= 300, 'what the company owes officers is a debt');
  assert.equal(r2(bs.assets.total), r2(bs.assets.cashAndBank + bs.assets.cashWithOfficers + bs.assets.accountsReceivable + bs.assets.inventoryValue + bs.assets.fixedAssets));
  assert.equal(r2(bs.liabilities.total), r2(bs.liabilities.accountsPayable + bs.liabilities.owedToOfficers + bs.liabilities.loansPayable + bs.liabilities.otherLiabilities));
  assert.equal(r2(bs.balanceCheck), r2(bs.assets.total - bs.liabilities.total - bs.equity.total));

  var fin = await reports.financeDashboard(boss, { company: 'BPL' });
  assert.ok(fin.floats.withOfficers >= 300);
  assert.ok(fin.floats.owedToOfficers >= 300);
  assert.ok(fin.floats.owedCount >= 1);

  var detail = await reports.expenseDetail(boss, P);
  var mine = detail.items.filter(function (i) { return i.source === 'sheet' && /^Zqs line/.test(i.description); });
  assert.equal(mine.length, 3);
  assert.equal(r2(mine.reduce(function (t, i) { return t + i.amount; }, 0)), 500);

  var sum = await reports.summary(boss, { company: 'BPL', from: P.from, to: P.to });
  assert.ok(sum.expenses.byCategory.some(function (c) { return c.category === 'Zqs Repairs' && c.amount === 300; }));
});
