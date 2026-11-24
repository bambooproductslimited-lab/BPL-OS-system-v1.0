var { pool } = require('../db/pool');
var { internationalNumber } = require('../utils/phone');

// Knowing a lead is someone who already writes to us — on WhatsApp above
// all (crmInbox.service.js): every number that writes gets a customer
// profile with the number as an identity (customer_identities, the
// international digits). A lead with the same number, however it was typed
// ("024 412 3456", "+233 24 412 3456", "0244123456"), or the same email,
// is the same person: the lead is put on that profile, so their WhatsApp
// chat shows on the lead and the lead on the chat, with a note on the lead
// saying so. A profile nobody looks after gets the lead's rep.
//
// It happens by itself: when a lead is added or its phone or email changes
// (crm.service.js), when contacts are imported into a group
// (crmLeadGroups.service.js), when a WhatsApp message comes in from a lead's
// number (ingest), and every hour for any lead still on its own
// (jobs/crm.js). A lead already on a profile is left there. When the
// number or email belongs to more than one profile, nothing is linked — the
// lead's window still shows the chats with that number.

function str(v) { return v == null ? '' : String(v).trim(); }

// A lead's phone numbers in international digits ("0244123456 / 020…" is two).
function numbersOf(phone) {
  var out = [];
  str(phone).split(/[\/,;]|\sor\s/i).forEach(function (p) {
    var n = internationalNumber(p);
    if (n && out.indexOf(n) < 0) out.push(n);
  });
  return out;
}
function emailOf(email) {
  var e = str(email).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : '';
}

// The one profile with this lead's number or email, or null. Identities
// first (how WhatsApp, email and the other channels know people); then the
// number or email written on a profile. Where several profiles have it, the
// one with a WhatsApp chat, if only one has.
async function profileFor(db, phone, email) {
  var nums = numbersOf(phone), mail = emailOf(email);
  if (!nums.length && !mail) return null;
  var rows = (await db.query(
    "SELECT DISTINCT c.id, c.name, EXISTS (SELECT 1 FROM crm_conversations cv WHERE cv.customer_id = c.id AND cv.channel = 'whatsapp') AS on_whatsapp " +
    "FROM customers c WHERE c.status = 'active' AND (" +
    "EXISTS (SELECT 1 FROM customer_identities i WHERE i.customer_id = c.id AND ((i.kind = 'phone' AND i.value = ANY($1)) OR (i.kind = 'email' AND i.value = $2)))" +
    ")", [nums, mail || '-'])).rows;
  if (!rows.length && nums.length) {
    rows = (await db.query(
      "SELECT c.id, c.name, EXISTS (SELECT 1 FROM crm_conversations cv WHERE cv.customer_id = c.id AND cv.channel = 'whatsapp') AS on_whatsapp " +
      "FROM customers c WHERE c.status = 'active' AND length(regexp_replace(c.phone, '\\D', '', 'g')) >= 9 AND right(regexp_replace(c.phone, '\\D', '', 'g'), 9) = ANY($1)",
      [nums.map(function (n) { return n.slice(-9); })])).rows;
  }
  if (!rows.length && mail) {
    rows = (await db.query(
      "SELECT c.id, c.name, EXISTS (SELECT 1 FROM crm_conversations cv WHERE cv.customer_id = c.id AND cv.channel = 'whatsapp') AS on_whatsapp " +
      "FROM customers c WHERE c.status = 'active' AND lower(c.email) = $1", [mail])).rows;
  }
  if (rows.length === 1) return rows[0];
  var wa = rows.filter(function (r) { return r.on_whatsapp; });
  return wa.length === 1 ? wa[0] : null;
}

async function putOn(db, lead, profile, byEmployee) {
  var done = await db.query('UPDATE crm_leads SET customer_id = $2, updated_at = now() WHERE id = $1 AND customer_id IS NULL', [lead.id, profile.id]);
  if (!done.rowCount) return false;
  // The lead's rep looks after the profile if nobody does: they hear when
  // the person writes on WhatsApp.
  if (lead.rep_id) await db.query('UPDATE customers SET account_manager_id = $2 WHERE id = $1 AND account_manager_id IS NULL', [profile.id, lead.rep_id]);
  // Qualified, quoted, agreeing terms or won: the profile says Prospect too.
  if (['qualified', 'quote_sent', 'negotiation', 'won'].indexOf(lead.stage) >= 0) {
    await db.query("UPDATE customers SET category = 'prospect' WHERE id = $1 AND category = 'lead'", [profile.id]);
  }
  await db.query("INSERT INTO crm_lead_notes (lead_id, kind, body, by_employee) VALUES ($1, 'note', $2, $3)", [lead.id,
    profile.on_whatsapp
      ? 'Recognised as ' + profile.name + ' on WhatsApp (the same number): their chat now shows on this lead.'
      : 'Put on the customer profile ' + profile.name + ' (the same phone number or email).', byEmployee || null]);
  return true;
}

// One lead, if it is on no profile yet. Returns the profile it went on, or null.
async function linkLead(db, leadId, byEmployee) {
  var lead = (await db.query('SELECT id, phone, email, stage, rep_id, customer_id FROM crm_leads WHERE id = $1', [leadId])).rows[0];
  if (!lead || lead.customer_id) return null;
  var profile = await profileFor(db, lead.phone, lead.email);
  if (!profile) return null;
  return (await putOn(db, lead, profile, byEmployee)) ? profile : null;
}

// The leads on no profile with one of these identities (a WhatsApp number
// that just wrote): put on that profile. handles: [{ kind, value }] as kept
// in customer_identities.
async function linkLeadsOf(db, customerId, handles) {
  var nums = handles.filter(function (h) { return h.kind === 'phone'; }).map(function (h) { return h.value; });
  var mails = handles.filter(function (h) { return h.kind === 'email'; }).map(function (h) { return h.value; });
  if (!nums.length && !mails.length) return 0;
  var leads = (await db.query(
    "SELECT id, phone, email, stage, rep_id FROM crm_leads WHERE customer_id IS NULL AND (" +
    "(length(regexp_replace(phone, '\\D', '', 'g')) >= 9 AND right(regexp_replace(phone, '\\D', '', 'g'), 9) = ANY($1)) OR lower(email) = ANY($2) " +
    "OR phone ~ '[/,;]')", [nums.map(function (n) { return n.slice(-9); }), mails])).rows;
  var profile = (await db.query(
    "SELECT c.id, c.name, EXISTS (SELECT 1 FROM crm_conversations cv WHERE cv.customer_id = c.id AND cv.channel = 'whatsapp') AS on_whatsapp FROM customers c WHERE c.id = $1",
    [customerId])).rows[0];
  if (!profile) return 0;
  var n = 0;
  for (var i = 0; i < leads.length; i++) {
    var l = leads[i];
    var mine = numbersOf(l.phone).some(function (x) { return nums.indexOf(x) >= 0; }) || (emailOf(l.email) && mails.indexOf(emailOf(l.email)) >= 0);
    if (mine && await putOn(db, l, profile, null)) n++;
  }
  return n;
}

// Every lead still on no profile (the hourly job; after a spreadsheet import).
async function linkAll() {
  var ids = (await pool.query("SELECT id FROM crm_leads WHERE customer_id IS NULL AND (phone <> '' OR email <> '') ORDER BY created_at")).rows;
  var n = 0;
  for (var i = 0; i < ids.length; i++) { if (await linkLead(pool, ids[i].id, null)) n++; }
  return n;
}

// The conversations with this lead: those on its profile, and any with its
// number or email that are on no profile (we wrote and they never answered).
async function conversationsOf(db, lead) {
  var nums = numbersOf(lead.phone), mail = emailOf(lead.email);
  if (!lead.customer_id && !nums.length && !mail) return [];
  var rows = (await db.query(
    'SELECT id, channel, contact_name, contact_label, status, message_count, last_message_at, last_direction, last_preview, imported FROM crm_conversations ' +
    "WHERE status <> 'spam' AND (customer_id = $1 OR (customer_id IS NULL AND ((contact_kind = 'phone' AND contact_key = ANY($2)) OR (contact_kind = 'email' AND contact_key = $3)))) " +
    'ORDER BY last_message_at DESC NULLS LAST LIMIT 6', [lead.customer_id || null, nums, mail || '-'])).rows;
  return rows.map(function (r) {
    return {
      id: r.id, channel: r.channel, name: r.contact_name, label: r.contact_label, status: r.status, messages: r.message_count,
      lastAt: r.last_message_at, lastDirection: r.last_direction, lastPreview: r.last_preview, imported: r.imported,
      waiting: r.last_direction === 'in' && r.status === 'open'
    };
  });
}

module.exports = { numbersOf: numbersOf, profileFor: profileFor, linkLead: linkLead, linkLeadsOf: linkLeadsOf, linkAll: linkAll, conversationsOf: conversationsOf };
