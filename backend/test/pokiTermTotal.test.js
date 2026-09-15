/*
 * The lease dialog totals a whole tenancy as it is typed — rent for every
 * billing period, plus the deposit. That arithmetic lives in the browser
 * (frontend/src/lib/rentCycle.js, leaseRentTotal) while the invoices are
 * raised on the server (pokiBilling.service.js, billingPeriod), so the two
 * are separate implementations of one rule.
 *
 * A quoted total that disagreed with what the tenant is later billed would
 * be worse than showing no total at all, and the disagreement would only
 * ever surface on a real tenancy — most likely as a tenant querying their
 * final invoice. So this asserts the two agree, period by period, including
 * the pro-rated final period and the month-end clamping.
 *
 * Run with: npm test
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var billing = require('../src/services/pokiBilling.service');

// The browser module is ESM; node:test can import it directly.
var leaseRentTotalPromise = import(
  'file://' + path.resolve(__dirname, '../../frontend/src/lib/rentCycle.js')
).then(function (m) { return m.leaseRentTotal; });

// The server's own walk over a lease, as runRent does it: open a period on
// the start date, bill it (pro-rated if it overruns the lease end), then
// open the next one the day after the full period would have closed.
function serverTotal(startDate, endDate, rent, cycle) {
  if (!billing.CYCLE_MONTHS[cycle]) return Math.round(rent * 100) / 100;
  var cursor = startDate, total = 0, guard = 0;
  while (cursor <= endDate && guard++ < 600) {
    var p = billing.billingPeriod(cursor, cycle, endDate);
    total += rent * p.factor;
    cursor = billing.addDays(billing.periodEndFor(cursor, cycle), 1);
  }
  return Math.round(total * 100) / 100;
}

var CASES = [
  // the tenancy that exposed the original over-billing: 3 whole months
  // then 8 days of a 31-day period, not 4 whole months
  { label: 'monthly, ends mid-period', start: '2026-07-14', end: '2026-10-21', rent: 6019.20, cycle: 'monthly' },
  // whole number of cycles — every period full, factor exactly 1
  { label: 'monthly, exact 12 months', start: '2026-01-01', end: '2026-12-31', rent: 1500, cycle: 'monthly' },
  { label: 'quarterly, exact year', start: '2026-01-01', end: '2026-12-31', rent: 4500, cycle: 'quarterly' },
  { label: 'annual, exact year', start: '2026-01-01', end: '2026-12-31', rent: 24000, cycle: 'annual' },
  // month-end clamping: 31 Jan + 1 month must land on 28 Feb, not 3 March
  { label: 'monthly from 31 Jan', start: '2026-01-31', end: '2026-06-30', rent: 2000, cycle: 'monthly' },
  { label: 'monthly from 30 Nov across a year end', start: '2026-11-30', end: '2027-03-15', rent: 800, cycle: 'monthly' },
  // a single day, and a term shorter than one cycle
  { label: 'one day', start: '2026-05-10', end: '2026-05-10', rent: 3100, cycle: 'monthly' },
  { label: 'shorter than one cycle', start: '2026-05-10', end: '2026-05-20', rent: 3100, cycle: 'monthly' },
  // longer cycles ending mid-period
  { label: 'quarterly, ends mid-period', start: '2026-02-15', end: '2026-09-03', rent: 9000, cycle: 'quarterly' },
  { label: 'semiannual, ends mid-period', start: '2026-03-01', end: '2027-01-10', rent: 15000, cycle: 'semiannual' },
  { label: 'annual, ends mid-period', start: '2026-06-01', end: '2028-02-29', rent: 24000, cycle: 'annual' },
  // a leap day inside the term
  { label: 'monthly across 29 Feb', start: '2028-01-15', end: '2028-04-14', rent: 1200, cycle: 'monthly' }
];

test('the lease dialog total matches what the rent run will invoice', async function () {
  var leaseRentTotal = await leaseRentTotalPromise;
  var mismatches = [];

  CASES.forEach(function (c) {
    var browser = leaseRentTotal(c.start, c.end, c.rent, c.cycle);
    var server = serverTotal(c.start, c.end, c.rent, c.cycle);
    assert.ok(browser, c.label + ': the dialog returned no total for a valid lease');
    if (Math.abs(browser.rentTotal - server) > 0.01) {
      mismatches.push(c.label + ': dialog ' + browser.rentTotal + ' vs rent run ' + server);
    }
  });

  assert.deepEqual(mismatches, [],
    'The lease dialog would quote a total the invoices do not add up to:\n  ' + mismatches.join('\n  '));
});

test('the dialog shows nothing rather than a misleading zero on incomplete input', async function () {
  var leaseRentTotal = await leaseRentTotalPromise;
  assert.equal(leaseRentTotal('', '2026-12-31', 1000, 'monthly'), null, 'no start date');
  assert.equal(leaseRentTotal('2026-01-01', '', 1000, 'monthly'), null, 'no end date');
  assert.equal(leaseRentTotal('2026-01-01', '2026-12-31', 0, 'monthly'), null, 'no rent yet');
  assert.equal(leaseRentTotal('2026-01-01', '2026-12-31', '', 'monthly'), null, 'rent field empty');
  assert.equal(leaseRentTotal('2026-12-31', '2026-01-01', 1000, 'monthly'), null, 'end before start');
});

test('a one-off term is charged once, not per period', async function () {
  var leaseRentTotal = await leaseRentTotalPromise;
  var r = leaseRentTotal('2026-01-01', '2026-12-31', 50000, 'one_off');
  assert.equal(r.rentTotal, 50000, 'a one-off term is a single charge for the whole tenancy');
  assert.equal(r.periods, 1);
});

test('the pro-rated final period is charged for the days actually covered', async function () {
  var leaseRentTotal = await leaseRentTotalPromise;
  // 14 Jul -> 21 Oct: periods open 14 Jul, 14 Aug, 14 Sep, 14 Oct. The last
  // would run to 13 Nov, so it is clamped to 21 Oct — 8 days of 31.
  var r = leaseRentTotal('2026-07-14', '2026-10-21', 6019.20, 'monthly');
  assert.equal(r.fullPeriods, 3, 'three whole months');
  assert.equal(r.partialPeriod.billedDays, 8);
  assert.equal(r.partialPeriod.fullDays, 31);
  assert.equal(r.partialPeriod.amount, 1553.34);
  assert.equal(r.rentTotal, 19610.94);
  // the bug this replaced: four whole months, the last invoice covering
  // 23 days past the end of the tenancy
  assert.notEqual(r.rentTotal, Math.round(6019.20 * 4 * 100) / 100);
});
