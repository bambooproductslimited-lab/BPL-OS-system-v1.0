// Company settings: only what is sent changes and the audit log says what
// changed; the default currency must be enabled and can't be removed while
// it is the default; currency codes are three letters; times and dates are
// checked; the page gets the grace history, counts of what is set up
// elsewhere, the approval chain by name, and the latest changes.
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var settings = require('../src/services/settings.service');
var { buildContext } = require('../src/services/context.service');

var kelvin, alice, before;
async function ctxFor(email) { return buildContext((await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id); }
test.before(async function () {
  kelvin = await ctxFor('kelvin.duho@bplghana.com');
  alice = await ctxFor('alice.kamau@bplghana.com');
  before = (await pool.query('SELECT short_name, work_week, fiscal_year_start, standard_hours, currency, commercial FROM settings WHERE id = 1')).rows[0];
});
test.after(async function () {
  await pool.query('UPDATE settings SET short_name = $1, work_week = $2, fiscal_year_start = $3, standard_hours = $4, currency = $5, commercial = $6 WHERE id = 1',
    [before.short_name, before.work_week, before.fiscal_year_start, before.standard_hours, before.currency, JSON.stringify(before.commercial)]);
  await pool.query("DELETE FROM audit_logs WHERE entity = 'settings' AND summary LIKE '%Zqs%'");
  await pool.end();
});

test('what changed is recorded, and the values are checked', async function () {
  var s = await settings.save(kelvin, { shortName: 'Zqs BPL', workWeek: before.work_week, standardHours: 9, fiscalYearStart: '04-01' });
  assert.equal(s.shortName, 'Zqs BPL');
  assert.equal(Number(s.standardHours), 9);
  assert.equal(s.fiscalYearStart, '04-01');
  var ch = await settings.changes(kelvin);
  assert.match(ch[0].summary, /^Short name .* → Zqs BPL; fiscal year start .* → 04-01; standard hours .* → 9\.$/);
  assert.doesNotMatch(ch[0].summary, /work week/);

  var n = (await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'settings.save'")).rows[0].n;
  await settings.save(kelvin, { shortName: 'Zqs BPL' });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'settings.save'")).rows[0].n, n);

  await assert.rejects(settings.save(kelvin, { lateAfter: '7.10' }), /time like 07:10/);
  await assert.rejects(settings.save(kelvin, { fiscalYearStart: '13-01' }), /month and day/);
  await assert.rejects(settings.save(kelvin, { standardHours: 20 }), /1 to 12/);
  await assert.rejects(settings.save(alice, { shortName: 'x' }), /settings.manage/);
  await assert.rejects(settings.changes(alice), /settings.manage/);
});

test('currencies: three letters, the default stays enabled', async function () {
  var cur = before.currency;
  var list = (before.commercial.currencies || [cur]).slice();
  await assert.rejects(settings.save(kelvin, { currencies: list.concat('US') }), /three letters/);
  var s = await settings.save(kelvin, { currencies: list.concat('XAF') });
  assert.ok(s.commercial.currencies.includes('XAF'));
  assert.match((await settings.changes(kelvin))[0].summary, /^Added currency XAF\.$/);
  await assert.rejects(settings.save(kelvin, { currencies: ['XAF'] }), new RegExp(cur + ' is the default currency'));
  await assert.rejects(settings.save(kelvin, { currency: 'JPY' }), /must be one of the enabled/);
  s = await settings.save(kelvin, { currency: 'XAF' });
  assert.equal(s.currency, 'XAF');
  s = await settings.save(kelvin, { currency: cur, currencies: list });
  assert.equal(s.currency, cur);
  assert.ok(!s.commercial.currencies.includes('XAF'));
});

test('the page gets history, counts and the approval chain by name', async function () {
  var s = await settings.get(alice);
  assert.ok(Array.isArray(s.lateGraceHistory));
  assert.ok(s.structure.companies >= 1 && s.structure.departments >= 1);
  assert.equal(s.leaveApprovalNames.length, (s.leaveApprovalChain || []).length);
  assert.ok(s.leaveApprovalNames.every(function (n) { return !/_/.test(n); }));
});
