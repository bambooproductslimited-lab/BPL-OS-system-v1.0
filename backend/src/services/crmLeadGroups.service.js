var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var crm = require('./crm.service');
var contactRows = require('../lib/contactRows');
var leadMatch = require('./crmLeadMatch.service');

// Groups of leads (migration 0220): the people met at a fair or an event
// (GEXPO 2026), a business list, a campaign. A lead can be in several
// groups. Each group shows how far its people have got — not contacted yet,
// being worked, prospects, customers, lost — and how many follow-ups are
// late, so an event's follow-up can be seen through to the end.
//
// Contacts are put in a group three ways: from a lead's window, by picking
// leads already in the OS, or from a file (lib/contactRows.js: a
// spreadsheet, a phone's contacts, a pasted list). An import is looked at
// before anything is saved: a contact already among the leads (the same
// phone number, however written, or the same email; or the same name and
// company) is not added twice — that lead joins the group, with a note that
// they were met there too — and a contact twice in the file counts once.
// Running the same file again adds nothing.
//
// crm.read to see the groups, crm.manage to make, change and fill them.

var KINDS = ['event', 'list', 'campaign', 'other'];

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function str(v, max) { v = v == null ? '' : String(v).trim(); return max ? v.slice(0, max) : v; }
function dateOnly(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function optDate(v, label) { return v === undefined || v === null || v === '' ? null : V.date(v, label); }
function isUuid(v) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')); }
function nameKey(name, company) { return (String(name || '') + '|' + String(company || '')).toLowerCase().replace(/[^a-z0-9|]+/g, ''); }

var COUNTS =
  "count(l.id)::int AS total, " +
  "count(l.id) FILTER (WHERE l.stage = 'new')::int AS not_contacted, " +
  "count(l.id) FILTER (WHERE l.stage IN ('contacted', 'follow_up'))::int AS working, " +
  "count(l.id) FILTER (WHERE " + crm.phaseWhere('prospect') + ")::int AS prospects, " +
  "count(l.id) FILTER (WHERE " + crm.phaseWhere('customer') + ")::int AS customers, " +
  "count(l.id) FILTER (WHERE l.stage IN ('lost', 'not_lead'))::int AS lost, " +
  "count(l.id) FILTER (WHERE l.next_follow_up < CURRENT_DATE AND l.stage IN ('new', 'contacted', 'follow_up', 'qualified', 'quote_sent', 'negotiation') " +
  "AND l.no_follow_up_at IS NULL)::int AS overdue, " +
  'max(m.added_at) AS last_added';

function shape(r) {
  return {
    id: r.id, name: r.name, kind: r.kind, heldOn: dateOnly(r.held_on), place: r.place, notes: r.notes,
    createdAt: r.created_at, createdBy: r.by_first ? [r.by_first, r.by_last].filter(Boolean).join(' ') : null,
    counts: {
      total: r.total || 0, notContacted: r.not_contacted || 0, working: r.working || 0, prospects: r.prospects || 0,
      customers: r.customers || 0, lost: r.lost || 0, overdue: r.overdue || 0
    },
    lastAdded: r.last_added || null
  };
}

var SELECT = 'SELECT g.*, e.first_name AS by_first, e.last_name AS by_last, ' + COUNTS + ' ' +
  'FROM crm_lead_groups g LEFT JOIN employees e ON e.id = g.created_by ' +
  'LEFT JOIN crm_lead_group_members m ON m.group_id = g.id LEFT JOIN crm_leads l ON l.id = m.lead_id ';
var GROUP_BY = ' GROUP BY g.id, e.first_name, e.last_name';

// GET /crm/groups — every group, the newest first.
async function list(ctx) {
  need(ctx, 'crm.read');
  var rows = (await pool.query(SELECT + GROUP_BY + ' ORDER BY g.created_at DESC')).rows;
  return rows.map(shape);
}

async function loadGroup(id, db) {
  if (!isUuid(id)) fail('notfound', 'That group no longer exists.');
  var r = (await (db || pool).query(SELECT + 'WHERE g.id = $1' + GROUP_BY, [id])).rows[0];
  if (!r) fail('notfound', 'That group no longer exists.');
  return r;
}

// POST /crm/groups, PUT /crm/groups/:id { name, kind, heldOn?, place?, notes? }
async function save(ctx, id, p) {
  need(ctx, 'crm.manage');
  p = p || {};
  var was = id ? await loadGroup(id) : null;
  var name = V.text(p.name === undefined && was ? was.name : p.name, 'The group\'s name', 80);
  var kind = p.kind === undefined ? (was ? was.kind : 'event') : V.oneOf(p.kind, KINDS, 'Kind of group');
  var heldOn = p.heldOn === undefined ? (was ? dateOnly(was.held_on) : null) : optDate(p.heldOn, 'The date');
  var place = p.place === undefined ? (was ? was.place : '') : str(p.place, 120);
  var notes = p.notes === undefined ? (was ? was.notes : '') : str(p.notes, 1000);
  var row;
  try {
    row = await withTransaction(async function (db) {
      var r = was
        ? (await db.query('UPDATE crm_lead_groups SET name = $2, kind = $3, held_on = $4, place = $5, notes = $6, updated_at = now() WHERE id = $1 RETURNING id', [id, name, kind, heldOn, place, notes])).rows[0]
        : (await db.query('INSERT INTO crm_lead_groups (name, kind, held_on, place, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [name, kind, heldOn, place, notes, me(ctx)])).rows[0];
      await audit(db, ctx, was ? 'crm.group.update' : 'crm.group.create', 'crm_lead_group', r.id, (was ? 'Changed' : 'Made') + ' the lead group "' + name + '".');
      return r;
    });
  } catch (e) {
    if (e.code === '23505') fail('conflict', 'There is already a group called "' + name + '".');
    throw e;
  }
  return shape(await loadGroup(row.id));
}

// DELETE /crm/groups/:id — the group goes; its leads stay.
async function remove(ctx, id) {
  need(ctx, 'crm.manage');
  var g = await loadGroup(id);
  await withTransaction(async function (db) {
    await db.query('DELETE FROM crm_lead_groups WHERE id = $1', [id]);
    await audit(db, ctx, 'crm.group.delete', 'crm_lead_group', id, 'Deleted the lead group "' + g.name + '" (' + (g.total || 0) + ' leads, kept).');
  });
  return { ok: true };
}

function leadIdsOf(p) {
  var ids = (p && Array.isArray(p.leadIds) ? p.leadIds : []).filter(isUuid);
  if (!ids.length) fail('invalid', 'Pick the leads first.');
  if (ids.length > 2000) fail('invalid', 'Pick 2000 leads or fewer at a time.');
  return ids;
}

// POST /crm/groups/:id/leads { leadIds } — leads already in the OS join the group.
async function addLeads(ctx, id, p) {
  need(ctx, 'crm.manage');
  var g = await loadGroup(id);
  var ids = leadIdsOf(p);
  var n = await withTransaction(async function (db) {
    var r = await db.query('INSERT INTO crm_lead_group_members (group_id, lead_id, added_by) SELECT $1, l.id, $3 FROM crm_leads l WHERE l.id = ANY($2) ON CONFLICT DO NOTHING', [id, ids, me(ctx)]);
    if (r.rowCount) await audit(db, ctx, 'crm.group.add', 'crm_lead_group', id, 'Put ' + r.rowCount + ' lead(s) in the group "' + g.name + '".');
    return r.rowCount;
  });
  return { added: n, group: shape(await loadGroup(id)) };
}

// POST /crm/groups/:id/leads/remove { leadIds } — out of the group; the leads stay.
async function removeLeads(ctx, id, p) {
  need(ctx, 'crm.manage');
  var g = await loadGroup(id);
  var ids = leadIdsOf(p);
  var n = await withTransaction(async function (db) {
    var r = await db.query('DELETE FROM crm_lead_group_members WHERE group_id = $1 AND lead_id = ANY($2)', [id, ids]);
    if (r.rowCount) await audit(db, ctx, 'crm.group.remove', 'crm_lead_group', id, 'Took ' + r.rowCount + ' lead(s) out of the group "' + g.name + '".');
    return r.rowCount;
  });
  return { removed: n, group: shape(await loadGroup(id)) };
}

// ── adding contacts from a file or a pasted list ─────────────────────

// What each contact is: new, already a lead (joins the group), already in
// the group, twice in the file, or nothing to go on.
async function sortOut(db, groupId, contacts) {
  var leads = (await db.query(
    'SELECT l.id, l.ref, l.name, l.company, l.phone, l.email, l.stage, EXISTS (SELECT 1 FROM crm_lead_group_members m WHERE m.lead_id = l.id AND m.group_id = $1) AS in_group FROM crm_leads l',
    [groupId])).rows;
  var byPhone = {}, byEmail = {}, byName = {}, byNameInGroup = {};
  leads.forEach(function (l) {
    var pk = contactRows.phoneKey(l.phone);
    if (pk && !byPhone[pk]) byPhone[pk] = l;
    var em = String(l.email || '').trim().toLowerCase();
    if (em && !byEmail[em]) byEmail[em] = l;
    if (l.company) { var nk = nameKey(l.name, l.company); if (!byName[nk]) byName[nk] = l; }
    if (l.in_group) byNameInGroup[nameKey(l.name, '')] = l;
  });
  var seen = {};
  var rows = contacts.map(function (c, i) {
    var row = Object.assign({ n: i + 1 }, c);
    var pk = contactRows.phoneKey(c.phone);
    var em = c.email;
    if (!c.name && !c.company && !pk && !em) { row.status = 'empty'; return row; }
    // Twice in the file: the first one counts. A phone number or an email
    // says who it is; only with neither does the name.
    var keys = [pk && 'p:' + pk, em && 'e:' + em].filter(Boolean);
    if (!keys.length) keys.push('n:' + nameKey(c.name, c.company));
    if (keys.some(function (k) { return seen[k]; })) { row.status = 'repeat'; row.sameAs = seen[keys.find(function (k) { return seen[k]; })]; return row; }
    keys.forEach(function (k) { seen[k] = row.n; });
    var lead = (pk && byPhone[pk]) || (em && byEmail[em]) ||
      (!pk && !em && ((c.name && c.company && byName[nameKey(c.name, c.company)]) || (c.name && byNameInGroup[nameKey(c.name, '')]))) || null;
    if (lead) {
      row.status = lead.in_group ? 'in_group' : 'existing';
      row.lead = { id: lead.id, ref: lead.ref, name: lead.name, stage: lead.stage };
    } else row.status = 'new';
    if (row.status === 'new' && !pk && !em) row.warn = 'no_contact';
    if (row.status === 'new' && !c.name) row.warn = row.warn || 'no_name';
    return row;
  });
  // New ones who already write to us on WhatsApp: the lead goes on their
  // chat's profile when added (crmLeadMatch.service.js).
  var nums = {};
  rows.forEach(function (r) { if (r.status === 'new') leadMatch.numbersOf(r.phone).forEach(function (n) { nums[n] = true; }); });
  if (Object.keys(nums).length) {
    var wa = {};
    (await db.query(
      "SELECT i.value, c.name, max(cv.last_message_at) AS last_at FROM customer_identities i JOIN customers c ON c.id = i.customer_id " +
      "JOIN crm_conversations cv ON cv.customer_id = c.id AND cv.channel = 'whatsapp' AND cv.status <> 'spam' WHERE i.kind = 'phone' AND i.value = ANY($1) GROUP BY i.value, c.name",
      [Object.keys(nums)])).rows.forEach(function (x) { wa[x.value] = { name: x.name, lastAt: x.last_at }; });
    rows.forEach(function (r) {
      if (r.status !== 'new') return;
      var hit = leadMatch.numbersOf(r.phone).map(function (n) { return wa[n]; }).filter(Boolean)[0];
      if (hit) r.whatsapp = hit;
    });
  }
  return rows;
}

function tally(rows) {
  var t = { new: 0, existing: 0, inGroup: 0, repeat: 0, empty: 0, noContact: 0, onWhatsapp: 0 };
  rows.forEach(function (r) {
    if (r.status === 'new') t.new++;
    else if (r.status === 'existing') t.existing++;
    else if (r.status === 'in_group') t.inGroup++;
    else if (r.status === 'repeat') t.repeat++;
    else t.empty++;
    if (r.warn === 'no_contact') t.noContact++;
    if (r.whatsapp) t.onWhatsapp++;
  });
  return t;
}

// POST /crm/groups/:id/import/preview (a file, or text) — what the import
// would do, nothing saved.
async function importPreview(ctx, id, file, text) {
  need(ctx, 'crm.manage');
  var g = await loadGroup(id);
  var read = await contactRows.read(file, text);
  var rows = await sortOut(pool, id, read.contacts);
  return {
    group: shape(g), format: read.format, sheet: read.sheet || null, columns: read.columns,
    counts: tally(rows), rows: rows
  };
}

async function repsOf(db, ids) {
  ids = (Array.isArray(ids) ? ids : []).filter(isUuid);
  if (!ids.length) return [];
  var found = (await db.query("SELECT id FROM employees WHERE id = ANY($1) AND status = 'active'", [ids])).rows.map(function (r) { return r.id; });
  var missing = ids.filter(function (x) { return found.indexOf(x) < 0; });
  if (missing.length) fail('invalid', 'One of the sales reps picked was not found among the active staff.');
  return ids.filter(function (x, i) { return ids.indexOf(x) === i; });
}

// POST /crm/groups/:id/import (the same file or text) { options: { repIds,
// followUpOn, receivedOn, source } } — new contacts become leads at New,
// shared in turn between the reps picked (or nobody's yet), received on the
// event's day and, if a date is given, to be followed up then; contacts
// already among the leads join the group with a note.
async function importRun(ctx, id, file, text, options) {
  need(ctx, 'crm.manage');
  var g = await loadGroup(id);
  var o = options || {};
  var read = await contactRows.read(file, text);
  var receivedOn = optDate(o.receivedOn, 'Date received') || dateOnly(g.held_on) || todayISO();
  if (receivedOn > todayISO()) fail('invalid', 'The date received cannot be in the future.');
  var followUpOn = optDate(o.followUpOn, 'First follow-up');
  var source = str(o.source === undefined ? (g.kind === 'event' ? 'Fair or event' : '') : o.source, 40);
  var out = await withTransaction(async function (db) {
    var reps = await repsOf(db, o.repIds);
    var rows = await sortOut(db, id, read.contacts);
    var added = 0, joined = 0, onWhatsapp = 0, perRep = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.status === 'new') {
        var rep = reps.length ? reps[added % reps.length] : null;
        var comments = ['Met at ' + g.name + (g.held_on ? ' (' + dateOnly(g.held_on) + ')' : '') + '.', r.notes].filter(Boolean).join('\n');
        var lead = (await db.query(
          'INSERT INTO crm_leads (received_on, name, company, phone, email, location, source, item, stage, next_follow_up, rep_id, comments, created_by) ' +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new', $9, $10, $11, $12) RETURNING id, ref",
          [receivedOn, r.name || r.company || 'No name given', r.name ? r.company : '', r.phone, r.email, r.location, source, r.interest, followUpOn, rep, comments.slice(0, 4000), me(ctx)])).rows[0];
        await db.query("INSERT INTO crm_lead_notes (lead_id, kind, body, to_stage, by_employee) VALUES ($1, 'stage', $2, 'new', $3)", [lead.id, 'Added from the group "' + g.name + '".', me(ctx)]);
        await db.query('INSERT INTO crm_lead_group_members (group_id, lead_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, lead.id, me(ctx)]);
        // Already writing to us on WhatsApp: on their chat's profile.
        if (await leadMatch.linkLead(db, lead.id, me(ctx))) onWhatsapp++;
        if (rep) perRep[rep] = (perRep[rep] || 0) + 1;
        added++;
      } else if (r.status === 'existing') {
        var ins = await db.query('INSERT INTO crm_lead_group_members (group_id, lead_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, r.lead.id, me(ctx)]);
        if (ins.rowCount) {
          await db.query("INSERT INTO crm_lead_notes (lead_id, kind, body, by_employee) VALUES ($1, 'note', $2, $3)",
            [r.lead.id, 'Met again at ' + g.name + '.' + (r.notes ? ' ' + r.notes.replace(/\n/g, ' · ') : ''), me(ctx)]);
          joined++;
        }
      }
    }
    await audit(db, ctx, 'crm.group.import', 'crm_lead_group', id,
      'Added contacts to the group "' + g.name + '" (' + read.format + '): ' + added + ' new leads, ' + joined + ' leads already in the OS joined.');
    var c = tally(rows);
    return { added: added, joined: joined, linked: onWhatsapp, inGroup: c.inGroup, repeat: c.repeat, empty: c.empty, perRep: perRep };
  });
  if (Object.keys(out.perRep).length) {
    var names = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1)', [Object.keys(out.perRep)])).rows;
    out.perRep = names.map(function (e) { return { id: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' '), leads: out.perRep[e.id] }; })
      .sort(function (a, b) { return b.leads - a.leads || a.name.localeCompare(b.name); });
  } else out.perRep = [];
  out.group = shape(await loadGroup(id));
  return out;
}

module.exports = {
  KINDS: KINDS, list: list, save: save, remove: remove, addLeads: addLeads, removeLeads: removeLeads,
  importPreview: importPreview, importRun: importRun
};
