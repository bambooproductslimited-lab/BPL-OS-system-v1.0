var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Estimates and quotations answered by the customer on their link (migration
// 0184) — Square's "customers approve estimates online": the page behind the
// share link (frontend SharePage.jsx) lets them approve it, typing their name
// and signing with a finger or the mouse; decline it, saying why if they
// like; or ask for changes. A quotation approved is accepted (declined:
// rejected), as if the rep had marked it; an estimate keeps its status and
// carries the answer, for the rep to turn into a quotation. The rep (who
// made it, and the customer's account manager) is told at once. Every answer
// is kept with when, from where and the signature; the document shows the
// latest, and its PDF and preview show who approved it and their signature.
//
// Approved or declined is final: the customer asks the rep for a new copy to
// change their mind. Asking for changes leaves it open to approve later.

var TABLE = { quotation: 'quotations', estimate: 'estimates' };
var NO = { quotation: 'quote_no', estimate: 'estimate_no' };
var LABEL = { quotation: 'quotation', estimate: 'estimate' };
var ACTIONS = ['approved', 'declined', 'changes'];
// The signature as drawn: strokes of [x, y] points in a 600 × 200 box.
var BOX_W = 600, BOX_H = 200, MAX_POINTS = 4000;

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayOf(d) { return d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null; }

// The strokes, checked and rounded; null if there is no real signature.
function cleanSignature(sig) {
  if (!Array.isArray(sig)) return null;
  var total = 0;
  var strokes = sig.slice(0, 200).map(function (s) {
    if (!Array.isArray(s)) return [];
    return s.map(function (p) {
      var x = Number(p && p[0]), y = Number(p && p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [Math.round(Math.min(BOX_W, Math.max(0, x))), Math.round(Math.min(BOX_H, Math.max(0, y)))];
    }).filter(Boolean);
  }).filter(function (s) { return s.length >= 2; });
  strokes.forEach(function (s) { total += s.length; });
  if (!strokes.length || total > MAX_POINTS) return null;
  // A dot or a tiny scratch is not a signature.
  var xs = [], ys = [];
  strokes.forEach(function (s) { s.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); }); });
  if (Math.max.apply(null, xs) - Math.min.apply(null, xs) < 30 && Math.max.apply(null, ys) - Math.min.apply(null, ys) < 15) return null;
  return strokes;
}

function answerOut(r) {
  return r ? { action: r.action, name: r.name, note: r.note, at: r.created_at, signature: r.signature || null } : null;
}
// The latest answer to a document, for its customer's page and its PDF.
async function latest(documentType, documentId, db) {
  if (!TABLE[documentType]) return null;
  return answerOut((await (db || pool).query(
    'SELECT * FROM document_responses WHERE document_type = $1 AND document_id = $2 ORDER BY created_at DESC LIMIT 1', [documentType, documentId])).rows[0]);
}
// Whether the customer may still answer it, and if not, why.
function openFor(documentType, d, last) {
  if (last && (last.action === 'approved' || last.action === 'declined')) return { open: false, why: last.action };
  if (documentType === 'quotation') {
    if (d.status === 'cancelled') return { open: false, why: 'cancelled' };
    if (d.status === 'accepted' || d.status === 'rejected') return { open: false, why: d.status === 'accepted' ? 'approved' : 'declined' };
    if (d.status === 'expired' || (d.valid_until && dayOf(d.valid_until) < today())) return { open: false, why: 'expired' };
  } else {
    if (d.status === 'archived') return { open: false, why: 'cancelled' };
    if (d.valid_until && dayOf(d.valid_until) < today()) return { open: false, why: 'expired' };
  }
  return { open: true, why: null };
}

// The share link, valid and for an estimate or a quotation.
async function shareOf(db, token) {
  var s = (await db.query('SELECT * FROM document_shares WHERE token = $1', [String(token || '')])).rows[0];
  if (!s || (s.expires_at && new Date(s.expires_at) < new Date())) fail('notfound', 'This link has expired — ask for a new one.');
  if (!TABLE[s.document_type]) fail('invalid', 'Only an estimate or a quotation is answered here.');
  return s;
}

// Who is told: whoever made it and the customer's account manager.
async function repsOf(db, documentType, d) {
  var ids = [];
  if (d.created_by) ids.push(d.created_by);
  var c = (await db.query('SELECT account_manager_id FROM customers WHERE id = $1', [d.customer_id])).rows[0];
  if (c && c.account_manager_id && ids.indexOf(c.account_manager_id) < 0) ids.push(c.account_manager_id);
  return ids;
}

// POST /api/share/:token/answer { action: approved | declined | changes,
// name, note, signature } — the customer's answer.
async function answer(token, p, ip, ua) {
  p = p || {};
  var action = ACTIONS.indexOf(p.action) >= 0 ? p.action : fail('invalid', 'Approve, decline or ask for changes?');
  var name = text(p.name, 80);
  var note = String(p.note == null ? '' : p.note).trim().slice(0, 1000);
  var signature = null;
  if (action === 'approved') {
    if (name.length < 2) fail('invalid', 'Type your full name to approve.');
    signature = cleanSignature(p.signature);
    if (!signature) fail('invalid', 'Sign in the box to approve.');
  }
  if (action === 'changes' && note.length < 3) fail('invalid', 'Say what you would like changed.');
  var done = await withTransaction(async function (db) {
    var share = await shareOf(db, token);
    var type = share.document_type;
    var d = (await db.query('SELECT * FROM ' + TABLE[type] + ' WHERE id = $1 FOR UPDATE', [share.document_id])).rows[0];
    if (!d) fail('notfound', 'This document no longer exists.');
    var last = await latest(type, d.id, db);
    var state = openFor(type, d, last);
    if (!state.open) {
      fail('conflict', state.why === 'approved' ? 'This ' + LABEL[type] + ' was approved already.' : state.why === 'declined' ? 'This ' + LABEL[type] + ' was declined already. Ask for a new one to change your mind.'
        : state.why === 'expired' ? 'This ' + LABEL[type] + ' has expired. Ask for a new one.' : 'This ' + LABEL[type] + ' was withdrawn. Ask for a new one.');
    }
    var row = (await db.query(
      'INSERT INTO document_responses (document_type, document_id, share_id, action, name, note, signature, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [type, d.id, share.id, action, name, note, signature ? JSON.stringify(signature) : null, String(ip || '').slice(0, 60), String(ua || '').slice(0, 300)])).rows[0];
    await db.query('UPDATE ' + TABLE[type] + ' SET client_answer = $2, client_answered_at = now() WHERE id = $1', [d.id, action]);
    // A quotation approved is accepted; declined, rejected — as the rep marking it would.
    if (type === 'quotation' && action !== 'changes') {
      await db.query("UPDATE quotations SET status = $2, answered_at = now(), sent_at = coalesce(sent_at, now()) WHERE id = $1", [d.id, action === 'approved' ? 'accepted' : 'rejected']);
    }
    var cust = (await db.query('SELECT name FROM customers WHERE id = $1', [d.customer_id])).rows[0];
    var who = name || (cust ? cust.name : 'The customer');
    var no = d[NO[type]];
    var said = { approved: who + ' approved ' + LABEL[type] + ' ' + no + ' online', declined: who + ' declined ' + LABEL[type] + ' ' + no, changes: who + ' asked for changes to ' + LABEL[type] + ' ' + no }[action];
    await audit(db, { user: { id: null }, employee: { first_name: who, last_name: '(customer)' } }, type + '.client_' + action, type, d.id, said + (note ? ': ' + note : '') + '.');
    var reps = await repsOf(db, type, d);
    var link = (type === 'quotation' ? '/quotations' : '/estimates') + '?open=' + d.id;
    for (var i = 0; i < reps.length; i++) {
      await notify(db, reps[i], (action === 'approved' ? '✍️ ' : action === 'declined' ? '✖ ' : '✎ ') + said, note || (cust ? cust.name : ''), link);
    }
    return { type: type, id: d.id, answer: answerOut(row) };
  });
  return done;
}

// GET /api/document-answers/:type/:id — every answer to a document, for staff.
async function list(ctx, type, id) {
  if (!TABLE[type]) fail('invalid', 'Unknown document type.');
  if (!ctx.can('quotation.read')) fail('forbidden', 'Your role does not allow this action (quotation.read).');
  return (await pool.query('SELECT * FROM document_responses WHERE document_type = $1 AND document_id = $2 ORDER BY created_at DESC', [type, id])).rows
    .map(function (r) { return Object.assign(answerOut(r), { ip: r.ip }); });
}

// Opened by the customer: the document says when it was first seen, and a
// quotation sent becomes viewed (as Square's "Viewed").
async function seen(documentType, documentId) {
  var t = { quotation: 'quotations', estimate: 'estimates', invoice: 'invoices' }[documentType];
  if (!t) return;
  await pool.query('UPDATE ' + t + ' SET viewed_at = coalesce(viewed_at, now()) WHERE id = $1', [documentId]);
  if (documentType === 'quotation') await pool.query("UPDATE quotations SET status = 'viewed' WHERE id = $1 AND status = 'sent'", [documentId]);
}

module.exports = { answer: answer, list: list, latest: latest, openFor: openFor, seen: seen, cleanSignature: cleanSignature, BOX_W: BOX_W, BOX_H: BOX_H };
