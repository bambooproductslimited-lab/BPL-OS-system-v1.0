var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var marketing = require('./marketing.service');

// What the marketing department's services (mk*.service.js) share: who may
// do what, the company a request is about, and the lists of kinds.
//
// marketing.read sees the department's work; marketing.manage plans,
// spends and changes it. Two things are for everyone signed in: asking
// marketing for something (mkRequests) and the brand kit (logos, colours,
// templates), which anyone making a document needs.

function canRead(ctx) { return ctx.can('marketing.read') || ctx.can('marketing.manage'); }
function requireRead(ctx) {
  if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (marketing.read).');
}
function requireManage(ctx) {
  if (!ctx.can('marketing.manage')) fail('forbidden', 'Your role does not allow this action (marketing.manage).');
}

// The company: one of those with a social tracker (Bamboo Products and the
// restaurants), by code; Bamboo Products when none is given.
async function company(code) { return marketing.resolveCompany(code); }
async function companies(ctx) {
  if (!ctx) fail('forbidden', 'Sign in first.');
  var rows = (await pool.query(
    'SELECT co.code, co.name FROM companies co WHERE EXISTS (SELECT 1 FROM marketing_channels ch WHERE ch.company_id = co.id) ORDER BY co.name'
  )).rows;
  var bpl = rows.filter(function (r) { return r.code === 'BPL'; });
  return bpl.concat(rows.filter(function (r) { return r.code !== 'BPL'; }));
}

function num(v) { return v === null || v === undefined ? 0 : Math.round(Number(v) * 100) / 100; }
function numOrNull(v) { return v === null || v === undefined || v === '' ? null : Number(v); }
function iso(d) { return d ? (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)) : null; }
function todayIso() { return iso(new Date()); }
function text(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 2000); }
function dateOrNull(v, label) {
  if (v === null || v === undefined || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) fail('invalid', label + ' must be a date.');
  return String(v);
}
function money(v, label, opts) {
  if ((v === null || v === undefined || v === '') && opts && opts.optional) return null;
  var n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail('invalid', label + ' must be a number, 0 or more.');
  if (opts && opts.positive && n <= 0) fail('invalid', label + ' must be more than 0.');
  return Math.round(n * 100) / 100;
}
function wholeOrNull(v, label) {
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail('invalid', label + ' must be a whole number, 0 or more.');
  return n;
}
function oneOf(v, list, label, fallback) {
  var x = v === undefined || v === null || v === '' ? fallback : v;
  if (list.indexOf(x) < 0) fail('invalid', label + ' is not one of the choices.');
  return x;
}
function list(v, allowed) {
  var arr = Array.isArray(v) ? v : [];
  return Array.from(new Set(arr.map(String).filter(function (x) { return !allowed || allowed.indexOf(x) >= 0; })));
}
function employeeName(first, last) { return first ? first + (last ? ' ' + last : '') : null; }

// Everyone who can act for the department, to tell about a new request.
async function managers() {
  return (await pool.query(
    'SELECT DISTINCT e.id FROM employees e JOIN users u ON u.employee_id = e.id JOIN user_roles ur ON ur.user_id = u.id ' +
    "JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.permission_key = 'marketing.manage' WHERE e.status = 'active' AND u.status = 'active'"
  )).rows.map(function (r) { return r.id; });
}

// The channels a campaign or promotion runs on.
var CHANNELS = ['facebook', 'instagram', 'tiktok', 'whatsapp', 'youtube', 'website', 'email', 'sms', 'radio', 'tv', 'print', 'billboard', 'events', 'in_store', 'referral', 'other'];
// Where the money goes.
var SPEND_CATEGORIES = ['digital_ads', 'content', 'print', 'events', 'sponsorship', 'influencers', 'agency', 'promo_items', 'pr', 'other'];

module.exports = {
  canRead: canRead, requireRead: requireRead, requireManage: requireManage, company: company, companies: companies,
  num: num, numOrNull: numOrNull, iso: iso, todayIso: todayIso, text: text, dateOrNull: dateOrNull, money: money, wholeOrNull: wholeOrNull,
  oneOf: oneOf, list: list, employeeName: employeeName, managers: managers, CHANNELS: CHANNELS, SPEND_CATEGORIES: SPEND_CATEGORIES
};
