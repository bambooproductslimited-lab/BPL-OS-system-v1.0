var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var crypto = require('crypto');

// kernel.js: handlers['commercialSettings.get']
async function get(ctx) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  return res.rows[0].commercial;
}

// kernel.js: handlers['commercialSettings.save']
async function save(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var c = res.rows[0].commercial;
  if (p.templates) Object.assign(c.templates, p.templates);
  if (p.paymentDetails) Object.assign(c.paymentDetails, p.paymentDetails);
  await pool.query('UPDATE settings SET commercial = $1, updated_at = now() WHERE id = 1', [JSON.stringify(c)]);
  await audit(pool, ctx, 'commercialSettings.save', 'settings', 'commercial', 'Updated quotations & invoicing settings.');
  return c;
}

// kernel.js: handlers['commercialSettings.addTaxRate']
async function addTaxRate(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var name = V.text(p.name, 'Tax name', 40);
  var rate = Math.max(0, Number(p.rate) || 0);
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var c = res.rows[0].commercial;
  var taxRate = { id: 'tx_' + crypto.randomUUID().slice(0, 8), name: name, rate: rate };
  c.taxRates.push(taxRate);
  await pool.query('UPDATE settings SET commercial = $1, updated_at = now() WHERE id = 1', [JSON.stringify(c)]);
  await audit(pool, ctx, 'commercialSettings.taxRate', 'settings', 'commercial', 'Added tax rate ' + name + ' (' + rate + '%).');
  return taxRate;
}

module.exports = { get: get, save: save, addTaxRate: addTaxRate };
