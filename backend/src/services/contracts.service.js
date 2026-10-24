var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var config = require('../config');

// Contracts signed online (migration 0189) — Square's: a contract from a
// template whose {placeholders} are filled from the customer and, when
// there is one, their quotation; edited while a draft; sent as a link to
// Bamboo Products' website (online.bplghana.com/c/<token>), where the
// customer reads it, signs it with their name and a signature (checked as a
// quotation's is: documentAnswers cleanSignature) or declines it with a
// note; then printed or kept as signed. Staff with quotation.manage make and
// send them; quotation.read sees them.

var COMPANY = 'Bamboo Products Limited';
var STATUSES = ['draft', 'sent', 'signed', 'declined', 'void'];
var PLACEHOLDERS = ['customer', 'address', 'phone', 'email', 'date', 'amount', 'quote_no', 'company', 'rep'];
// A first template to start from (Contracts page, New template).
var SAMPLE = {
  name: 'Supply and installation agreement',
  body: '# Supply and installation agreement\n\nThis agreement is made on {date} between {company} ("the Supplier") and {customer} of {address} ("the Client").\n\n' +
    '## 1. The work\nThe Supplier will make, deliver and install the bamboo products set out in quotation {quote_no}, which forms part of this agreement.\n\n' +
    '## 2. Price and payment\nThe price is {amount}. A deposit is paid before production starts; the balance is paid on completion, as the quotation\'s payment schedule says.\n\n' +
    '## 3. Timing\nProduction starts once the deposit is received. The Supplier will tell the Client the delivery and installation dates and keep them informed of any change.\n\n' +
    '## 4. Changes\nChanges after production starts are agreed in writing and may change the price and the dates.\n\n' +
    '## 5. Care and warranty\nThe Supplier repairs any defect in materials or workmanship reported within 12 months of installation. Damage from misuse, water left standing or direct weather on indoor products is not covered.\n\n' +
    '## 6. Ownership\nThe products remain the Supplier\'s until paid in full.\n\n' +
    'Signed for {company} by {rep}.'
};

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
// A contract's words keep their lines and paragraphs.
function body(v) { return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 30000); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function longDate(d) { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }); }
function urlOf(token) { return config.bplSiteUrl + '/c/' + token; }

// ── templates ──

function templateOut(r) { return { id: r.id, name: r.name, body: r.body, updatedAt: r.updated_at }; }
// GET /api/contract-templates
async function templates(ctx) {
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  var rows = (await pool.query('SELECT * FROM contract_templates ORDER BY name')).rows;
  return { templates: rows.map(templateOut), sample: SAMPLE, placeholders: PLACEHOLDERS };
}
// POST /api/contract-templates { id?, name, body } — a new one, or one changed.
async function saveTemplate(ctx, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  p = p || {};
  var name = text(p.name, 120), words = body(p.body);
  if (name.length < 2) fail('invalid', 'Give the template a name.');
  if (words.length < 20) fail('invalid', 'Write the contract\'s words (at least a sentence).');
  var row;
  if (p.id) {
    row = (await pool.query('UPDATE contract_templates SET name = $2, body = $3, updated_at = now() WHERE id = $1 RETURNING *', [p.id, name, words])).rows[0];
    if (!row) fail('notfound', 'That template is gone.');
  } else {
    row = (await pool.query('INSERT INTO contract_templates (name, body, created_by) VALUES ($1,$2,$3) RETURNING *', [name, words, ctx.employee.id])).rows[0];
  }
  await audit(pool, ctx, 'contract_template.save', 'contract_template', row.id, 'Contract template "' + name + '" saved.');
  return templateOut(row);
}
// DELETE /api/contract-templates/:id
async function deleteTemplate(ctx, id) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var row = (await pool.query('DELETE FROM contract_templates WHERE id = $1 RETURNING name', [id])).rows[0];
  if (!row) fail('notfound', 'That template is gone.');
  await audit(pool, ctx, 'contract_template.delete', 'contract_template', id, 'Contract template "' + row.name + '" deleted.');
  return { ok: true };
}

// The template's {placeholders} filled from the customer, the quotation and
// whoever makes it; one with nothing to fill it is left blank, with the
// "of", "at" or "in" before it ("of {address}" for a customer without one).
function fill(words, v) {
  PLACEHOLDERS.forEach(function (key) {
    if (!v[key]) words = words.replace(new RegExp('\\s+(?:of|at|in)\\s+\\{' + key + '\\}', 'g'), '');
  });
  return words.replace(/\{([a-z_]+)\}/g, function (all, key) { return PLACEHOLDERS.indexOf(key) >= 0 ? (v[key] || '') : all; });
}
async function valuesFor(ctx, customer, quotation) {
  return {
    customer: customer.name, address: customer.address || '', phone: customer.phone || '', email: customer.email || '', date: longDate(new Date()),
    amount: quotation ? quotation.currency + ' ' + round2(quotation.grand_total).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '',
    quote_no: quotation ? quotation.quote_no : '', company: COMPANY,
    rep: ctx.employee && ctx.employee.first_name ? (ctx.employee.first_name + ' ' + (ctx.employee.last_name || '')).trim() : ''
  };
}

// ── contracts ──

var SELECT = 'SELECT k.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, q.quote_no AS quotation_no, e.first_name AS by_first, e.last_name AS by_last ' +
  'FROM contracts k JOIN customers c ON c.id = k.customer_id LEFT JOIN quotations q ON q.id = k.quotation_id LEFT JOIN employees e ON e.id = k.created_by ';
function contractOut(r, full) {
  var o = {
    id: r.id, contractNo: r.contract_no, title: r.title, status: r.status, customer: { id: r.customer_id, name: r.customer_name, phone: r.customer_phone || '', email: r.customer_email || '' },
    quotation: r.quotation_id ? { id: r.quotation_id, quotationNo: r.quotation_no } : null, url: r.status !== 'draft' ? urlOf(r.token) : null,
    sentAt: r.sent_at, viewedAt: r.viewed_at, signedAt: r.signed_at, signerName: r.signer_name || '', declineNote: r.decline_note || '', counterName: r.counter_name || '',
    createdBy: r.by_first ? r.by_first + ' ' + r.by_last : null, createdAt: r.created_at, updatedAt: r.updated_at
  };
  if (full) { o.body = r.body; o.signature = r.signature || null; o.signedIp = r.signed_ip || ''; }
  return o;
}
async function byId(id, db) {
  var r = (await (db || pool).query(SELECT + 'WHERE k.id = $1', [id])).rows[0];
  if (!r) fail('notfound', 'That contract is gone.');
  return r;
}

// GET /api/contracts?status=&customerId=
async function list(ctx, q) {
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  q = q || {};
  var args = [], where = [];
  if (STATUSES.indexOf(q.status) >= 0) { args.push(q.status); where.push('k.status = $' + args.length); }
  if (/^[0-9a-f-]{36}$/i.test(String(q.customerId || ''))) { args.push(q.customerId); where.push('k.customer_id = $' + args.length); }
  var rows = (await pool.query(SELECT + (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') + 'ORDER BY k.created_at DESC LIMIT 300', args)).rows;
  var counts = (await pool.query('SELECT status, count(*)::int AS n FROM contracts GROUP BY status')).rows;
  var c = {}; counts.forEach(function (x) { c[x.status] = x.n; });
  return { contracts: rows.map(function (r) { return contractOut(r); }), counts: c, siteUrl: config.bplSiteUrl };
}
// GET /api/contracts/:id
async function get(ctx, id) {
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  return contractOut(await byId(id), true);
}

// POST /api/contracts { customerId, quotationId?, templateId?, title?, body? }
// — a draft: the template's words filled in, or the words given.
async function create(ctx, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  p = p || {};
  var customer = /^[0-9a-f-]{36}$/i.test(String(p.customerId || '')) ? (await pool.query('SELECT * FROM customers WHERE id = $1', [p.customerId])).rows[0] : null;
  if (!customer) fail('invalid', 'Choose the customer.');
  var quotation = null;
  if (p.quotationId) {
    quotation = (await pool.query('SELECT * FROM quotations WHERE id = $1', [p.quotationId])).rows[0];
    if (!quotation || quotation.customer_id !== customer.id) fail('invalid', 'Choose one of this customer\'s quotations, or none.');
  }
  var template = null;
  if (p.templateId) {
    template = (await pool.query('SELECT * FROM contract_templates WHERE id = $1', [p.templateId])).rows[0];
    if (!template) fail('invalid', 'That template is gone.');
  }
  var words = body(p.body) || (template ? template.body : '');
  if (words.length < 20) fail('invalid', 'Choose a template or write the contract\'s words.');
  words = fill(words, await valuesFor(ctx, customer, quotation));
  var title = text(p.title, 160) || (template ? template.name : '') || 'Contract';
  var row = (await pool.query(
    'INSERT INTO contracts (token, customer_id, quotation_id, title, body, counter_name, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, contract_no',
    [crypto.randomBytes(18).toString('base64url'), customer.id, quotation ? quotation.id : null, title, words, ((ctx.employee.first_name || '') + ' ' + (ctx.employee.last_name || '')).trim(), ctx.employee.id])).rows[0];
  await audit(pool, ctx, 'contract.create', 'contract', row.id, row.contract_no + ' "' + title + '" for ' + customer.name + (quotation ? ' (' + quotation.quote_no + ')' : '') + '.');
  return get(ctx, row.id);
}

// PATCH /api/contracts/:id { title, body } — while it is a draft.
async function update(ctx, id, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  p = p || {};
  var r = await byId(id);
  if (r.status !== 'draft') fail('conflict', 'Only a draft can be changed. Void it and make a new one.');
  var title = text(p.title, 160) || r.title, words = p.body !== undefined ? body(p.body) : r.body;
  if (words.length < 20) fail('invalid', 'Write the contract\'s words (at least a sentence).');
  await pool.query('UPDATE contracts SET title = $2, body = $3, updated_at = now() WHERE id = $1', [id, title, words]);
  return get(ctx, id);
}

// POST /api/contracts/:id/send — out to the customer: its link (to share on
// WhatsApp), and an email when they have an address. Sent again, the same link.
async function send(ctx, id) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var r = await byId(id);
  if (r.status !== 'draft' && r.status !== 'sent') fail('conflict', 'This contract is ' + r.status + '.');
  await pool.query("UPDATE contracts SET status = 'sent', sent_at = coalesce(sent_at, now()), updated_at = now() WHERE id = $1", [id]);
  var url = urlOf(r.token);
  var words = 'Hello ' + String(r.customer_name).split(' ')[0] + ', here is your contract with ' + COMPANY + ', ' + r.title + ' (' + r.contract_no + '), to read and sign: ' + url;
  var emailed = false;
  if (r.customer_email) {
    try {
      var mail = require('./mail.service');
      if (mail.configured()) {
        await mail.send({ to: r.customer_email, subject: 'Your contract ' + r.contract_no + ' from Bamboo Products', fromName: 'Bamboo Products', text: words,
          html: '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">' + mail.escapeHtml(words.replace(': ' + url, '.')) +
            '<p style="margin:18px 0"><a href="' + mail.escapeHtml(url) + '" style="display:inline-block;padding:12px 20px;border-radius:12px;background:#2f6b2c;color:#fff;text-decoration:none;font-weight:700">Read and sign</a></p></div>' });
        emailed = true;
      }
    } catch (e) { /* the link is shared by hand */ }
  }
  if (r.status === 'draft') await audit(pool, ctx, 'contract.send', 'contract', id, r.contract_no + ' sent to ' + r.customer_name + (emailed ? ' (emailed)' : '') + '.');
  return Object.assign(await get(ctx, id), { emailed: emailed, message: words });
}

// POST /api/contracts/:id/void { reason }
async function voidIt(ctx, id, p) {
  if (!ctx.can('quotation.manage')) fail('forbidden', 'Your role does not allow this action (quotation.manage).');
  var reason = text((p || {}).reason, 300);
  if (reason.length < 3) fail('invalid', 'Say why it is voided.');
  var r = await byId(id);
  if (r.status === 'void') fail('conflict', 'This contract is void already.');
  await pool.query("UPDATE contracts SET status = 'void', decline_note = CASE WHEN status = 'declined' THEN decline_note ELSE $2 END, updated_at = now() WHERE id = $1", [id, reason]);
  await audit(pool, ctx, 'contract.void', 'contract', id, r.contract_no + ' voided' + (r.status === 'signed' ? ' after it was signed' : '') + ': ' + reason);
  return get(ctx, id);
}

// ── the customer's side ──

async function byToken(token, db, lock) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) fail('notfound', 'We cannot find that contract.');
  var r = (await (db || pool).query(lock ? 'SELECT * FROM contracts WHERE token = $1 FOR UPDATE' : SELECT + 'WHERE k.token = $1', [token])).rows[0];
  if (!r || r.status === 'draft') fail('notfound', 'We cannot find that contract.');
  return r;
}
function publicOut(r) {
  return {
    contractNo: r.contract_no, title: r.title, body: r.body, status: r.status, company: COMPANY, customerName: r.customer_name, quotationNo: r.quotation_no || null,
    counterName: r.counter_name || '', sentAt: r.sent_at, signedAt: r.signed_at, signerName: r.signer_name || '', signature: r.signature || null,
    declineNote: r.status === 'declined' ? r.decline_note || '' : ''
  };
}
// GET /api/c/:token — the contract's page; the first look is noted.
async function view(token) {
  var r = await byToken(token);
  if (!r.viewed_at && r.status === 'sent') await pool.query('UPDATE contracts SET viewed_at = now() WHERE id = $1', [r.id]);
  return publicOut(r);
}
async function tellStaff(r, title, words) {
  if (r.created_by) await notify(pool, r.created_by, title, words, '/contracts?open=' + r.id);
}
// POST /api/c/:token/sign { name, signature, agree }
async function sign(token, p, ip, ua) {
  p = p || {};
  var name = text(p.name, 120);
  if (name.length < 2) fail('invalid', 'Type your full name.');
  if (!p.agree) fail('invalid', 'Tick the box to say you agree.');
  var signature = require('./documentAnswers.service').cleanSignature(p.signature);
  if (!signature) fail('invalid', 'Sign in the box.');
  var r = await withTransaction(async function (db) {
    var k = await byToken(token, db, true);
    if (k.status !== 'sent') fail('conflict', k.status === 'signed' ? 'This contract is signed already. Thank you!' : 'This contract can no longer be signed. Ask us for a new one.');
    await db.query("UPDATE contracts SET status = 'signed', signer_name = $2, signature = $3, signed_at = now(), signed_ip = $4, signed_ua = $5, viewed_at = coalesce(viewed_at, now()), updated_at = now() WHERE id = $1",
      [k.id, name, JSON.stringify(signature), String(ip || '').slice(0, 60), String(ua || '').slice(0, 300)]);
    return k;
  });
  await audit(pool, { user: { id: null }, employee: { first_name: 'Customer', last_name: '(online)' } }, 'contract.sign', 'contract', r.id, r.contract_no + ' signed online by ' + name + '.');
  await tellStaff(r, '✍️ Contract signed: ' + r.contract_no, name + ' signed "' + r.title + '".');
  return view(token);
}
// POST /api/c/:token/decline { note }
async function decline(token, p) {
  var note = text((p || {}).note, 500);
  if (note.length < 3) fail('invalid', 'Tell us why, so we can put it right.');
  var r = await withTransaction(async function (db) {
    var k = await byToken(token, db, true);
    if (k.status !== 'sent') fail('conflict', k.status === 'signed' ? 'This contract is signed already.' : 'This contract can no longer be answered.');
    await db.query("UPDATE contracts SET status = 'declined', decline_note = $2, updated_at = now() WHERE id = $1", [k.id, note]);
    return k;
  });
  await audit(pool, { user: { id: null }, employee: { first_name: 'Customer', last_name: '(online)' } }, 'contract.decline', 'contract', r.id, r.contract_no + ' declined online: ' + note);
  await tellStaff(r, '✋ Contract declined: ' + r.contract_no, note);
  return view(token);
}

module.exports = {
  templates: templates, saveTemplate: saveTemplate, deleteTemplate: deleteTemplate, list: list, get: get, create: create, update: update, send: send, voidIt: voidIt,
  view: view, sign: sign, decline: decline, fill: fill, SAMPLE: SAMPLE, PLACEHOLDERS: PLACEHOLDERS
};
