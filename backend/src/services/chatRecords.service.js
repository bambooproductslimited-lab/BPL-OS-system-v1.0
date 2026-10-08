var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var tasks = require('./tasks.service');

// OS records that can be shared in a chat as a card (messages.service.js,
// migration 0110): a work order, invoice, quotation, client, lead or leave
// request. Sharing needs the same permission as seeing the record; the card
// keeps a snapshot of what it said then ({ type, id, title, sub, amount,
// currency, status, date }), and opening it goes through that page's own
// permissions, so a card never shows anyone more than its title.

var TYPES = {
  task: { perm: 'task.read' },
  invoice: { perm: 'invoice.read' },
  quotation: { perm: 'quotation.read' },
  customer: { perm: 'customer.read' },
  lead: { perm: 'crm.read' },
  leave: { perm: null } // your own requests, or everyone's with leave.approve
};

function allowedTypes(ctx) {
  return Object.keys(TYPES).filter(function (t) { return !TYPES[t].perm || ctx.can(TYPES[t].perm); });
}
function need(ctx, type) {
  if (!TYPES[type]) fail('invalid', 'That can\'t be shared in a chat.');
  if (TYPES[type].perm && !ctx.can(TYPES[type].perm)) fail('forbidden', 'Your role does not allow this action (' + TYPES[type].perm + ').');
}
function like(q) { return '%' + String(q || '').trim().replace(/[\\%_]/g, '\\$&') + '%'; }
function day(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function num(v) { return v == null ? null : Number(v); }

// What each row becomes on a card.
var shape = {
  task: function (r) { return { type: 'task', id: r.id, title: (r.number ? r.number + ' · ' : '') + r.title, sub: [r.requestedFor, r.projectName && r.projectName !== '—' ? r.projectName : ''].filter(Boolean).join(' · '), status: r.status, date: day(r.dueDate) }; },
  invoice: function (r) { return { type: 'invoice', id: r.id, title: r.invoice_no, sub: r.customer, amount: num(r.grand_total), currency: r.currency, status: r.status, date: day(r.issued_at) }; },
  quotation: function (r) { return { type: 'quotation', id: r.id, title: r.quote_no, sub: [r.customer, r.title].filter(Boolean).join(' · '), amount: num(r.grand_total), currency: r.currency, status: r.status, date: day(r.created_at) }; },
  customer: function (r) { return { type: 'customer', id: r.id, title: r.name, sub: [r.contact_person, r.phone].filter(Boolean).join(' · '), status: r.status }; },
  lead: function (r) { return { type: 'lead', id: r.id, title: r.name, sub: [r.item, r.location].filter(Boolean).join(' · '), status: r.stage, date: day(r.received_on) }; },
  leave: function (r) { return { type: 'leave', id: r.id, title: r.employee + ' · ' + r.leave_type, sub: day(r.start_date) + ' – ' + day(r.end_date), amount: num(r.days), status: r.status, date: day(r.start_date) }; }
};

var LEAVE_SQL =
  'SELECT lr.id, lr.start_date, lr.end_date, lr.days, lr.status, lt.name AS leave_type, e.first_name || \' \' || e.last_name AS employee ' +
  'FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id JOIN employees e ON e.id = lr.employee_id ';

async function rows(ctx, type, q, id) {
  var byId = !!id;
  var args = [byId ? id : like(q)];
  if (type === 'task') {
    if (byId) return [shape.task(await tasks.get(ctx, id))];
    return (await tasks.list(ctx, { scope: 'all', q: q })).slice(0, 20).map(shape.task);
  }
  var sql;
  if (type === 'invoice') {
    sql = 'SELECT i.id, i.invoice_no, i.grand_total, i.currency, i.status, i.issued_at, c.name AS customer FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE ' +
      (byId ? 'i.id = $1' : "(i.invoice_no ILIKE $1 OR c.name ILIKE $1) AND i.status <> 'void'") + ' ORDER BY i.issued_at DESC LIMIT 20';
  } else if (type === 'quotation') {
    sql = 'SELECT q.id, q.quote_no, q.title, q.grand_total, q.currency, q.status, q.created_at, c.name AS customer FROM quotations q LEFT JOIN customers c ON c.id = q.customer_id WHERE ' +
      (byId ? 'q.id = $1' : '(q.quote_no ILIKE $1 OR q.title ILIKE $1 OR c.name ILIKE $1)') + ' ORDER BY q.created_at DESC LIMIT 20';
  } else if (type === 'customer') {
    sql = 'SELECT id, name, contact_person, phone, status FROM customers WHERE ' + (byId ? 'id = $1' : '(name ILIKE $1 OR contact_person ILIKE $1 OR phone ILIKE $1)') + ' ORDER BY name LIMIT 20';
  } else if (type === 'lead') {
    sql = 'SELECT id, name, item, location, stage, received_on FROM crm_leads WHERE ' + (byId ? 'id = $1' : '(name ILIKE $1 OR item ILIKE $1 OR phone ILIKE $1)') + ' ORDER BY received_on DESC LIMIT 20';
  } else if (type === 'leave') {
    args.push(ctx.employee.id, ctx.can('leave.approve'));
    sql = LEAVE_SQL + 'WHERE ' + (byId ? 'lr.id = $1' : "(e.first_name || ' ' || e.last_name ILIKE $1 OR lt.name ILIKE $1)") +
      ' AND (lr.employee_id = $2 OR $3) ORDER BY lr.start_date DESC LIMIT 20';
  }
  if (byId && !/^[0-9a-f-]{36}$/i.test(String(id))) return [];
  return (await pool.query(sql, args)).rows.map(shape[type]);
}

// GET /api/messages/records?type=&q= — what you can share, for the picker.
async function search(ctx, type, q) {
  if (!type) return { types: allowedTypes(ctx) };
  need(ctx, type);
  return { types: allowedTypes(ctx), items: await rows(ctx, type, q || '', null) };
}

// The card for one record, checked as it is shared.
async function snapshot(ctx, record) {
  if (!record || typeof record !== 'object') fail('invalid', 'Choose something to share.');
  need(ctx, record.type);
  var found;
  try { found = (await rows(ctx, record.type, null, record.id))[0]; } catch (e) { found = null; }
  if (!found) fail('notfound', 'That record isn\'t there, or you can\'t see it.');
  return found;
}

module.exports = { search: search, snapshot: snapshot, TYPES: Object.keys(TYPES) };
