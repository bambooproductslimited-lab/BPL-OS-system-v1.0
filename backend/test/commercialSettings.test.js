// Billing settings: only known fields are saved (trimmed), day counts must
// be 1–365, tax rates 0–100%, and a tax rate can be removed only when no
// catalogue item uses it (the zero rate always stays).
var test = require('node:test');
var assert = require('node:assert/strict');
var { pool } = require('../src/db/pool');
var settings = require('../src/services/commercialSettings.service');
var catalog = require('../src/services/catalog.service');
var { buildContext } = require('../src/services/context.service');

var boss, before;
test.before(async function () {
  boss = await buildContext((await pool.query("SELECT id FROM users WHERE email = 'kelvin.duho@bplghana.com'")).rows[0].id);
  before = (await pool.query('SELECT commercial FROM settings WHERE id = 1')).rows[0].commercial;
});
test.after(async function () {
  await pool.query("DELETE FROM catalog_items WHERE name = 'Zqs Taxed Lamp'");
  // Put back only what this file changed: other test files run alongside
  // and may be adding their own tax rates to the same settings row.
  await settings.save(boss, { templates: { paymentTerms: before.templates.paymentTerms || '', validityDays: before.templates.validityDays }, paymentDetails: { bankName: before.paymentDetails.bankName || '' } });
  await pool.end();
});

test('only known fields, trimmed; day counts checked', async function () {
  var c = await settings.save(boss, { templates: { paymentTerms: '  Net 14  ', validityDays: 21, sneaky: 'x' }, paymentDetails: { bankName: ' Zqs Bank ', other: 'y' } });
  assert.equal(c.templates.paymentTerms, 'Net 14');
  assert.equal(c.templates.validityDays, 21);
  assert.equal(c.templates.sneaky, undefined);
  assert.equal(c.paymentDetails.bankName, 'Zqs Bank');
  assert.equal(c.paymentDetails.other, undefined);
  await assert.rejects(settings.save(boss, { templates: { invoiceDueDays: 0 } }), /1 to 365/);
  await assert.rejects(settings.save(boss, { templates: { validityDays: 2.5 } }), /1 to 365/);
});

test('tax rates: 0–100%, removable only when unused, zero rate stays', async function () {
  await assert.rejects(settings.addTaxRate(boss, { name: 'Zqs silly', rate: 150 }), /0 to 100/);
  var t = await settings.addTaxRate(boss, { name: 'Zqs VAT', rate: 12.5 });
  var item = await catalog.create(boss, { name: 'Zqs Taxed Lamp', code: 'ZQS-LAMP', unitPrice: 10, taxRateId: t.id });
  await assert.rejects(settings.removeTaxRate(boss, t.id), /Move them to another rate/);
  await catalog.update(boss, item.id, { name: 'Zqs Taxed Lamp', taxRateId: 'tx_zero' });
  assert.equal(await settings.removeTaxRate(boss, t.id), true);
  assert.equal((await settings.get(boss)).taxRates.some(function (x) { return x.id === t.id; }), false);
  await assert.rejects(settings.removeTaxRate(boss, 'tx_zero'), /stays/);
});
