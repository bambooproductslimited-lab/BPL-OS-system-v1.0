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
// Only the known fields are taken, text is trimmed and kept to a sensible
// length, and the two day counts must be whole days between 1 and 365 —
// they set every new quotation's valid-until and invoice's due date.
var TEMPLATE_TEXT = { quotationIntro: 2000, quotationFooter: 2000, invoiceFooter: 2000, paymentTerms: 200, termsAndConditions: 8000 };
var PAYMENT_TEXT = { bankName: 120, accountName: 120, accountNumber: 60, branch: 120, swift: 20, momoProvider: 60, momoNumber: 30, instructions: 1000 };
function cleanDays(v, label) {
  var n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) fail('invalid', label + ' must be a whole number of days from 1 to 365.');
  return n;
}
function pickText(src, spec, dest) {
  Object.keys(spec).forEach(function (k) {
    if (src[k] === undefined) return;
    var t = String(src[k] == null ? '' : src[k]).trim();
    if (t.length > spec[k]) fail('invalid', 'That text is too long (' + k + ', at most ' + spec[k] + ' characters).');
    dest[k] = t;
  });
}
async function save(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var c = res.rows[0].commercial;
  c.templates = c.templates || {};
  c.paymentDetails = c.paymentDetails || {};
  if (p.templates) {
    pickText(p.templates, TEMPLATE_TEXT, c.templates);
    if (p.templates.validityDays !== undefined) c.templates.validityDays = cleanDays(p.templates.validityDays, 'Quotation validity');
    if (p.templates.invoiceDueDays !== undefined) c.templates.invoiceDueDays = cleanDays(p.templates.invoiceDueDays, 'Invoice due period');
  }
  if (p.paymentDetails) pickText(p.paymentDetails, PAYMENT_TEXT, c.paymentDetails);
  await pool.query('UPDATE settings SET commercial = $1, updated_at = now() WHERE id = 1', [JSON.stringify(c)]);
  await audit(pool, ctx, 'commercialSettings.save', 'settings', 'commercial', 'Updated quotations & invoicing settings.');
  return c;
}

// kernel.js: handlers['commercialSettings.addTaxRate']
async function addTaxRate(ctx, p) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  var name = V.text(p.name, 'Tax name', 40);
  var rate = Number(p.rate);
  if (!(rate >= 0 && rate <= 100)) fail('invalid', 'A tax rate is a percentage from 0 to 100.');
  rate = Math.round(rate * 100) / 100;
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var c = res.rows[0].commercial;
  var taxRate = { id: 'tx_' + crypto.randomUUID().slice(0, 8), name: name, rate: rate };
  c.taxRates.push(taxRate);
  await pool.query('UPDATE settings SET commercial = $1, updated_at = now() WHERE id = 1', [JSON.stringify(c)]);
  await audit(pool, ctx, 'commercialSettings.taxRate', 'settings', 'commercial', 'Added tax rate ' + name + ' (' + rate + '%).');
  return taxRate;
}

// A tax rate can go once no catalogue item uses it; the zero rate every
// item falls back to always stays.
async function removeTaxRate(ctx, id) {
  if (!ctx.can('settings.manage')) fail('forbidden', 'Your role does not allow this action (settings.manage).');
  if (id === 'tx_zero') fail('conflict', 'The zero rate is the default for every item and stays.');
  var res = await pool.query('SELECT commercial FROM settings WHERE id = 1');
  var c = res.rows[0].commercial;
  var t = (c.taxRates || []).filter(function (x) { return x.id === id; })[0];
  if (!t) fail('notfound', 'Tax rate not found.');
  var used = await pool.query('SELECT count(*)::int AS n FROM catalog_items WHERE tax_rate_id = $1', [id]);
  if (used.rows[0].n) fail('conflict', used.rows[0].n + ' catalogue item(s) use ' + t.name + '. Move them to another rate first.');
  c.taxRates = c.taxRates.filter(function (x) { return x.id !== id; });
  await pool.query('UPDATE settings SET commercial = $1, updated_at = now() WHERE id = 1', [JSON.stringify(c)]);
  await audit(pool, ctx, 'commercialSettings.taxRate', 'settings', 'commercial', 'Removed tax rate ' + t.name + ' (' + t.rate + '%).');
  return true;
}

module.exports = { get: get, save: save, addTaxRate: addTaxRate, removeTaxRate: removeTaxRate };
