var crypto = require('crypto');
var ExcelJS = require('exceljs');
var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var crm = require('./crm.service');

// Brings the sales team's spreadsheets into the CRM (migration 0102): a
// Google Sheet downloaded as .xlsx and uploaded on the CRM page. Tabs are
// recognised by their column headings, not their names:
//
//   Leads        (Customer Name, Status, Lead ID / Next Follow-Up …)  -> leads
//   Purchases    (Customer Name, Purchase Date, Value …)              -> won leads:
//                a buyer already on the Leads tab (same phone or name) is
//                marked won there rather than added twice; each sale is
//                linked to its OS invoice when exactly one invoice matches
//                the customer, amount and date
//   Site Visits  (Client, Scheduled Date for Visit, Status …)         -> site visits
//   Referral     (Referrer, Customer Referred …)                      -> referrals
//   Data Base    (Fair/Event, Prospect Name, Contact …)                -> prospects
//
// Everything imported carries a key made from its own contents, so running
// the same workbook again adds nothing twice; rows already imported are
// counted as such and left as they are (they may have been worked since).
// The other tabs (the dashboard, summary, quotations, kick-back, lists) are
// worked out by the OS itself and aren't imported — the Kick back tab is
// skipped on purpose, as its rows are Purchases rows again.

var MAX_ROWS = 5000;

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.hyperlink).replace(/^mailto:/, '');
    return '';
  }
  return String(v);
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function key(kind, parts) { return kind + ':' + crypto.createHash('sha1').update(parts.map(norm).join('|')).digest('hex').slice(0, 24); }

var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// "25-Sep-2026", "01-July-2026", "9-September-2026", "7/16/2026" (the
// sheets' US-style dates), "2026-07-16", or a real date cell.
function parseDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  var s = cellText(v).trim();
  if (!s) return null;
  var m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s))) return iso(+m[1], +m[2], +m[3]);
  if ((m = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/,]*(\d{4})$/.exec(s))) {
    var mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mo ? iso(+m[3], mo, +m[1]) : null;
  }
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return iso(+m[3], +m[1], +m[2]);
  return null;
}
function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1990 && y < 2200)) return null;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString().slice(0, 10) : null;
}
function parseMoney(v) {
  if (typeof v === 'number') return v;
  var s = cellText(v).replace(/[,\s₵]|GHS|GHC/gi, '');
  if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
  var n = Number(s);
  return s !== '' && isFinite(n) ? n : null;
}
// A number with its leading 0 lost by the spreadsheet (542195087 -> 0542195087).
function phone(v) {
  var s = cellText(v).trim();
  if (!/\d/.test(s)) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''; // a date typed in the Contact column
  return /^\d{9}$/.test(s) ? '0' + s : s;
}
function channelIn(v) {
  var s = norm(cellText(v));
  if (!s || /\d/.test(s)) return '';
  if (s.indexOf('insta') >= 0) return 'Instagram';
  if (s.indexOf('tiktok') >= 0 || s.indexOf('tik tok') >= 0) return 'TikTok';
  if (s.indexOf('facebook') >= 0 || s === 'fb') return 'Facebook';
  if (s.indexOf('whatsapp') >= 0) return 'WhatsApp';
  return '';
}
var STAGE_WORDS = [
  ['closed won', 'won'], ['won', 'won'], ['closed lost', 'lost'], ['lost', 'lost'], ['negotiation', 'negotiation'],
  ['quote sent', 'quote_sent'], ['quotation sent', 'quote_sent'], ['qualified', 'qualified'], ['follow up', 'follow_up'],
  ['contacted', 'contacted'], ['new lead', 'new'], ['new', 'new']
];
function stageOf(v) {
  var s = norm(v);
  for (var i = 0; i < STAGE_WORDS.length; i++) if (s === STAGE_WORDS[i][0] || s.indexOf(STAGE_WORDS[i][0]) === 0) return STAGE_WORDS[i][1];
  return 'new';
}
function sourceOf(v, sources) {
  var s = norm(v);
  if (!s) return '';
  for (var i = 0; i < sources.length; i++) if (norm(sources[i]) === s) return sources[i];
  if (s.indexOf('walk') === 0) return pick(sources, 'walk') || 'Walk-in';
  if (s.indexOf('phone') === 0 || s === 'call') return pick(sources, 'phone') || 'Phone call';
  return cellText(v).trim().slice(0, 40);
}
function pick(list, start) { for (var i = 0; i < list.length; i++) if (norm(list[i]).indexOf(start) === 0) return list[i]; return null; }
function clean(v, max) { var s = cellText(v).trim(); return /^(n\/?a|-|none)$/i.test(s) ? '' : s.slice(0, max || 500); }

// ── reading the workbook ─────────────────────────────────────────────

var KINDS = {
  leads: function (h) { return h['customer name'] !== undefined && h.status !== undefined && (h['lead id'] !== undefined || h['next follow up'] !== undefined || h['product interest'] !== undefined); },
  purchases: function (h) { return h['customer name'] !== undefined && h['purchase date'] !== undefined && (h['value ghs'] !== undefined || h.value !== undefined); },
  visits: function (h) { return h.client !== undefined && Object.keys(h).some(function (k) { return k.indexOf('scheduled') === 0; }); },
  referrals: function (h) { return h.referrer !== undefined && h['customer referred'] !== undefined; },
  prospects: function (h) { return h['prospect name'] !== undefined || (h['fair event'] !== undefined && h.contact !== undefined); }
};

// Each worksheet's header row (within its first rows) and data rows, as
// { normalised heading: raw cell value }.
function readSheet(ws) {
  for (var r = 1; r <= Math.min(ws.rowCount, 12); r++) {
    var vals = ws.getRow(r).values || [];
    var heads = {};
    for (var c = 1; c < vals.length; c++) { var t = norm(cellText(vals[c])); if (t && heads[t] === undefined) heads[t] = c; }
    // The Kick back tab repeats rows of Purchases (the OS works kick-backs
    // out itself): reading it would add those sales twice.
    if (heads['kick back amount'] !== undefined || heads['kick back rate'] !== undefined) return null;
    var kind = null;
    Object.keys(KINDS).forEach(function (k) { if (!kind && KINDS[k](heads)) kind = k; });
    if (!kind) continue;
    var rows = [];
    for (var rr = r + 1; rr <= Math.min(ws.rowCount, r + MAX_ROWS); rr++) {
      var v = ws.getRow(rr).values || [];
      var row = {}, any = false;
      Object.keys(heads).forEach(function (h) { row[h] = v[heads[h]]; if (cellText(v[heads[h]]).trim()) any = true; });
      if (any) rows.push(row);
    }
    return { kind: kind, name: ws.name, rows: rows };
  }
  return null;
}
function col(row, names) {
  for (var i = 0; i < names.length; i++) if (row[names[i]] !== undefined && cellText(row[names[i]]).trim() !== '') return row[names[i]];
  var keys = Object.keys(row);
  for (var j = 0; j < names.length; j++) {
    for (var k = 0; k < keys.length; k++) if (keys[k].indexOf(names[j]) === 0 && cellText(row[keys[k]]).trim() !== '') return row[keys[k]];
  }
  return undefined;
}

async function loadWorkbook(file) {
  if (!file) fail('invalid', 'Choose the .xlsx file to import.');
  var wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file.buffer); } catch (e) { fail('invalid', 'That file couldn’t be read as an Excel workbook. In Google Sheets use File → Download → Microsoft Excel (.xlsx).'); }
  var sheets = [];
  wb.eachSheet(function (ws) { var s = readSheet(ws); if (s) sheets.push(s); });
  if (!sheets.length) fail('invalid', 'No leads, purchases, site visits, referrals or prospects were found in that workbook — check it has the usual column headings.');
  return sheets;
}

// ── matching people ──────────────────────────────────────────────────

async function staffMatcher() {
  var emps = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active'")).rows;
  return function (name) {
    var n = norm(String(name || '').replace(/^\s*(mr|mrs|ms|miss|dr)\.?\s+/i, ''));
    if (!n) return null;
    var full = emps.filter(function (e) { return norm(e.first_name + ' ' + e.last_name) === n; });
    if (full.length === 1) return full[0].id;
    var first = emps.filter(function (e) { return norm(e.first_name) === n || norm(e.first_name).split(' ')[0] === n; });
    return first.length === 1 ? first[0].id : null;
  };
}
function splitNames(s) {
  return cellText(s).split(/\s*(?:,|&|\band\b|\/)\s*/i).map(function (x) { return x.trim(); }).filter(Boolean);
}

// ── turning rows into records ────────────────────────────────────────

function leadFrom(row, sources) {
  var rawPhone = col(row, ['phone', 'phone number']);
  var name = clean(col(row, ['customer name']), 120);
  if (!name) return null;
  var items = [clean(col(row, ['product interest', 'product purchased']), 100), clean(col(row, ['custom project item']), 150)].filter(Boolean);
  return {
    receivedOn: parseDate(col(row, ['date', 'purchase date'])),
    sheetRef: clean(col(row, ['lead id']), 40),
    name: name, phone: phone(rawPhone), location: clean(col(row, ['location']), 120),
    source: sourceOf(col(row, ['source']), sources) || channelIn(rawPhone),
    item: items.filter(function (x, i) { return items.indexOf(x) === i && norm(x) !== 'custom'; }).join(' — ') || items[0] || '',
    stage: stageOf(col(row, ['status'])), nextFollowUp: parseDate(col(row, ['next follow up'])),
    rep: clean(col(row, ['sales rep', 'sales representative']), 80), comments: clean(col(row, ['comments']), 4000)
  };
}

async function plan(ctx, sheets) {
  var s = await crm._settingsRow();
  var sources = s.sources || [];
  var out = { leads: [], sales: [], visits: [], referrals: [], prospects: [], tabs: sheets.map(function (x) { return { name: x.name, kind: x.kind, rows: x.rows.length }; }) };
  sheets.forEach(function (sh) {
    sh.rows.forEach(function (row) {
      if (sh.kind === 'leads') {
        var l = leadFrom(row, sources);
        if (l) { l.key = key('lead', [l.receivedOn, l.name, l.phone, l.item, l.sheetRef]); out.leads.push(l); }
      } else if (sh.kind === 'purchases') {
        var p = leadFrom(row, sources);
        if (!p) return;
        p.stage = 'won';
        p.value = parseMoney(col(row, ['value ghs', 'value']));
        p.coreTeam = clean(col(row, ['core team']), 300);
        p.kickback = /^(true|yes|1)$/i.test(cellText(col(row, ['kick back applied'])).trim());
        p.noCommission = cellText(col(row, ['commission payable'])).trim() === '';
        p.key = key('sale', [p.receivedOn, p.name, p.phone, p.item, p.value]);
        out.sales.push(p);
      } else if (sh.kind === 'visits') {
        var client = clean(col(row, ['client']), 120);
        var date = parseDate(col(row, ['scheduled date for visit', 'scheduled']));
        if (!date) return;
        var st = norm(col(row, ['status']));
        out.visits.push({
          client: client || clean(col(row, ['location']), 120), location: clean(col(row, ['location']), 120), scheduledOn: date,
          status: st.indexOf('visit') === 0 ? 'visited' : st.indexOf('cancel') === 0 ? 'cancelled' : 'scheduled',
          assessors: splitNames(col(row, ['site assessors'])), key: key('visit', [client, date, col(row, ['location'])])
        });
      } else if (sh.kind === 'referrals') {
        var referrer = clean(col(row, ['referrer']), 120);
        if (!referrer) return;
        var st2 = norm(col(row, ['status']));
        out.referrals.push({
          referrerName: referrer, referrerPhone: phone(col(row, ['phone number', 'phone'])), location: clean(col(row, ['location']), 120),
          customerReferred: clean(col(row, ['customer referred']), 120), dealValue: parseMoney(col(row, ['deal value ghs', 'deal value'])),
          status: st2 === 'paid' ? 'paid' : st2.indexOf('not') === 0 ? 'not_eligible' : 'pending',
          key: key('referral', [referrer, col(row, ['customer referred']), col(row, ['deal value ghs', 'deal value'])])
        });
      } else if (sh.kind === 'prospects') {
        var notes = clean(col(row, ['notes']), 2000);
        if (/^company name \|/i.test(notes)) return; // a heading row pasted into the list
        var company = clean(col(row, ['company']), 120), pname = clean(col(row, ['prospect name', 'name']), 120);
        if (!company && !pname) return;
        var market = norm(col(row, ['market']));
        var pr = {
          listName: clean(col(row, ['fair event', 'list', 'event']), 80), market: market.indexOf('export') === 0 || market.indexOf('inter') === 0 ? 'export' : 'local',
          company: company, name: pname, phone: phone(col(row, ['contact', 'phone'])), email: clean(col(row, ['email']), 120),
          website: clean(col(row, ['website']), 200), interest: clean(col(row, ['interest']), 200),
          notes: [notes, clean(col(row, ['others']), 500)].filter(Boolean).join(' · ')
        };
        pr.key = key('prospect', [pr.listName, pr.company, pr.name, pr.phone, pr.email]);
        out.prospects.push(pr);
      }
    });
  });
  // Rows the sheet holds twice (same contents) count once.
  ['leads', 'sales', 'visits', 'referrals', 'prospects'].forEach(function (k) {
    var seen = {};
    out[k] = out[k].filter(function (x) { if (seen[x.key]) return false; seen[x.key] = true; return true; });
  });
  return out;
}

async function existingKeys(table, keys) {
  if (!keys.length) return {};
  var res = await pool.query('SELECT external_key FROM ' + table + ' WHERE external_key = ANY($1)', [keys]);
  var m = {};
  res.rows.forEach(function (r) { m[r.external_key] = true; });
  return m;
}

// One OS invoice for a sale in the sheet: same amount (to the cedi), within
// ten days, a customer whose name shares a word with the sheet's, and not
// already a deal. Anything less certain is left for a person to link.
async function matchInvoice(db, co, sale) {
  if (sale.value === null || sale.value === undefined || !sale.receivedOn) return null;
  var args = [sale.value, sale.receivedOn];
  var res = await db.query(
    "SELECT i.id, c.name AS customer_name FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.doc_kind = 'sale' AND i.status <> 'void' " +
    'AND abs(i.grand_total - $1) < 1 AND i.issued_at BETWEEN $2::date - 10 AND $2::date + 10 AND NOT EXISTS (SELECT 1 FROM crm_deals d WHERE d.invoice_id = i.id) AND ' +
    crm._invoiceScope(co, function (v) { args.push(v); return '$' + args.length; }), args);
  var words = norm(sale.name).split(' ').filter(function (w) { return w.length > 2 && ['mr', 'mrs', 'miss', 'dr'].indexOf(w) < 0; });
  var hits = res.rows.filter(function (r) { var n = norm(r.customer_name); return words.some(function (w) { return n.split(' ').indexOf(w) >= 0; }); });
  return hits.length === 1 ? hits[0].id : null;
}

// The same customer, as the sheet writes them: the last nine digits of the
// phone, or the name without Mr/Mrs/Dr and spacing.
function phoneKey(v) { var d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }
function nameKey(v) { return norm(String(v || '').replace(/^\s*(mr|mrs|ms|miss|dr)\.?\s+/i, '')); }

// Leads to match sales against: [{ id, phone, name, received, stage, rep_id, rep_name }].
// A sale belongs to the lead with its phone, else to the one with its name
// (the latest, when the sheet has the same name more than once).
function leadFor(leads, sale) {
  var ph = phoneKey(sale.phone);
  if (ph) {
    var byPhone = leads.filter(function (l) { return phoneKey(l.phone) === ph; });
    if (byPhone.length) return latest(byPhone);
  }
  var nk = nameKey(sale.name);
  var byName = nk ? leads.filter(function (l) { return nameKey(l.name) === nk; }) : [];
  return byName.length ? latest(byName) : null;
}
function latest(list) { return list.slice().sort(function (a, b) { return String(b.received || '').localeCompare(String(a.received || '')); })[0]; }

function need(ctx) {
  if (!ctx.can('crm.manage')) fail('forbidden', 'Your role does not allow this action (crm.manage).');
}

async function summarise(ctx, p) {
  var matchRep = await staffMatcher();
  var keys = {
    leads: await existingKeys('crm_leads', p.leads.map(function (x) { return x.key; })),
    sales: Object.assign(await existingKeys('crm_leads', p.sales.map(function (x) { return x.key; })),
      await existingKeys('crm_import_keys', p.sales.map(function (x) { return x.key; }))),
    visits: await existingKeys('crm_site_visits', p.visits.map(function (x) { return x.key; })),
    referrals: await existingKeys('crm_referrals', p.referrals.map(function (x) { return x.key; })),
    prospects: await existingKeys('crm_prospects', p.prospects.map(function (x) { return x.key; }))
  };
  function count(k) { var n = p[k].filter(function (x) { return !keys[k][x.key]; }).length; return { found: p[k].length, new: n, already: p[k].length - n }; }
  var repNames = {};
  p.leads.concat(p.sales).forEach(function (l) { if (l.rep && !matchRep(l.rep)) repNames[l.rep] = true; });
  p.visits.forEach(function (v) { v.assessors.forEach(function (a) { if (!matchRep(a)) repNames[a] = true; }); });
  var stages = {};
  p.leads.forEach(function (l) { stages[l.stage] = (stages[l.stage] || 0) + 1; });
  var known = (await pool.query('SELECT id, phone, name, received_on AS received FROM crm_leads')).rows
    .concat(p.leads.filter(function (l) { return !keys.leads[l.key]; }).map(function (l) { return { phone: l.phone, name: l.name, received: l.receivedOn }; }));
  var joining = 0;
  p.sales.forEach(function (x) {
    if (keys.sales[x.key]) return;
    if (leadFor(known, x)) joining++;
    else known.push({ phone: x.phone, name: x.name, received: x.receivedOn });   // a second sale of the same buyer joins the first
  });
  return {
    tabs: p.tabs, leads: count('leads'), sales: count('sales'), visits: count('visits'), referrals: count('referrals'), prospects: count('prospects'),
    stages: stages, salesJoiningLeads: joining, unknownPeople: Object.keys(repNames).sort(), keys: keys, matchRep: matchRep
  };
}

async function preview(ctx, file) {
  need(ctx);
  var p = await plan(ctx, await loadWorkbook(file));
  var s = await summarise(ctx, p);
  delete s.keys; delete s.matchRep;
  return s;
}

async function run(ctx, file) {
  need(ctx);
  var p = await plan(ctx, await loadWorkbook(file));
  var s = await summarise(ctx, p);
  var settings = await crm._settingsRow();
  var co = await crm._salesCompany(settings);
  var meId = ctx.employee ? ctx.employee.id : null;
  var result = { leads: 0, sales: 0, joined: 0, linked: 0, unlinkedSales: [], visits: 0, referrals: 0, prospects: 0 };

  await withTransaction(async function (db) {
    async function insertLead(l, extraComment) {
      var repId = l.rep ? s.matchRep(l.rep) : null;
      var r = (await db.query(
        'INSERT INTO crm_leads (sheet_ref, received_on, name, phone, location, source, item, stage, next_follow_up, rep_id, rep_name, comments, external_key, created_by) ' +
        'VALUES ($1, coalesce($2::date, CURRENT_DATE), $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (external_key) DO NOTHING RETURNING id',
        [l.sheetRef || '', l.receivedOn, l.name, l.phone, l.location, l.source, l.item, l.stage,
          ['won', 'lost'].indexOf(l.stage) >= 0 ? null : l.nextFollowUp, repId, repId ? '' : (l.rep || ''),
          [l.comments, extraComment].filter(Boolean).join('\n'), l.key, meId])).rows[0];
      if (r) await db.query("INSERT INTO crm_lead_notes (lead_id, kind, body, to_stage, by_employee) VALUES ($1, 'stage', 'Imported from the spreadsheet.', $2, $3)", [r.id, l.stage, meId]);
      return r;
    }

    for (var i = 0; i < p.leads.length; i++) {
      if (s.keys.leads[p.leads[i].key]) continue;
      if (await insertLead(p.leads[i])) result.leads++;
    }

    for (var j = 0; j < p.sales.length; j++) {
      var sale = p.sales[j];
      if (s.keys.sales[sale.key]) continue;
      var invoiceId = await matchInvoice(db, co, sale);
      var unlinkedNote = invoiceId ? '' : 'Sale in the spreadsheet' + (sale.value !== null ? ' of GHS ' + sale.value.toFixed(2) : '') +
        (sale.receivedOn ? ' on ' + sale.receivedOn : '') + ' — no matching OS invoice was found; link it from here once the invoice is in the OS.';
      var leads = (await db.query('SELECT id, phone, name, received_on AS received, stage, rep_id, rep_name, comments FROM crm_leads')).rows;
      var lead = leadFor(leads, sale);
      if (lead) {
        // the customer is already a lead (the sheet's Leads tab, or a
        // second sale of the same buyer): the sale goes on that lead
        await db.query('INSERT INTO crm_import_keys (external_key, lead_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [sale.key, lead.id]);
        var saleRep = sale.rep ? s.matchRep(sale.rep) : null;
        await db.query(
          "UPDATE crm_leads SET stage = 'won', next_follow_up = NULL, stage_changed_at = CASE WHEN stage <> 'won' THEN now() ELSE stage_changed_at END, " +
          "rep_id = coalesce(rep_id, $2), rep_name = CASE WHEN rep_id IS NULL AND $2::uuid IS NULL AND rep_name = '' THEN $3 ELSE rep_name END, " +
          "source = CASE WHEN source = '' THEN $4 ELSE source END, location = CASE WHEN location = '' THEN $5 ELSE location END, " +
          "comments = CASE WHEN $6 = '' THEN comments WHEN comments = '' THEN $6 ELSE comments || E'\n' || $6 END, updated_at = now() WHERE id = $1",
          [lead.id, saleRep, saleRep ? '' : (sale.rep || ''), sale.source || '', sale.location || '', unlinkedNote]);
        if (lead.stage !== 'won') {
          await db.query("INSERT INTO crm_lead_notes (lead_id, kind, body, from_stage, to_stage, by_employee) VALUES ($1, 'stage', 'Imported from the spreadsheet.', $2, 'won', $3)", [lead.id, lead.stage, meId]);
        }
        result.joined++;
      } else {
        lead = await insertLead(sale, unlinkedNote);
        if (!lead) continue;
      }
      result.sales++;
      if (invoiceId) {
        var repId = sale.rep ? s.matchRep(sale.rep) : null;
        await db.query(
          'INSERT INTO crm_deals (lead_id, invoice_id, kind, rep_id, rep_name, core_team, base_rate, status, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [lead.id, invoiceId, sale.kickback ? 'kickback' : 'commission', repId, repId ? '' : (sale.rep || ''), sale.coreTeam, settings.commission_rate,
            sale.noCommission ? 'not_eligible' : 'pending', sale.noCommission ? 'No commission in the spreadsheet.' : '', meId]);
        await db.query('UPDATE crm_leads SET customer_id = (SELECT customer_id FROM invoices WHERE id = $2) WHERE id = $1', [lead.id, invoiceId]);
        result.linked++;
      } else {
        result.unlinkedSales.push({ leadId: lead.id, name: sale.name, date: sale.receivedOn, value: sale.value });
      }
    }

    // lead lookup by name for visits
    var byName = {};
    (await db.query('SELECT id, name FROM crm_leads')).rows.forEach(function (r) { var n = norm(r.name); byName[n] = byName[n] === undefined ? r.id : null; });

    for (var k = 0; k < p.visits.length; k++) {
      var v = p.visits[k];
      if (s.keys.visits[v.key]) continue;
      var ids = [], names = [];
      v.assessors.forEach(function (a) { var id = s.matchRep(a); if (id && ids.indexOf(id) < 0) ids.push(id); else if (!id) names.push(a); });
      var leadId = v.client ? byName[norm(v.client)] || null : null;
      var ins = await db.query(
        'INSERT INTO crm_site_visits (lead_id, client, location, scheduled_on, status, assessor_ids, assessors_text, external_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (external_key) DO NOTHING',
        [leadId, v.client || v.location || 'Site visit', v.location, v.scheduledOn, v.status, ids, names.join(', '), v.key, meId]);
      result.visits += ins.rowCount;
    }

    for (var r = 0; r < p.referrals.length; r++) {
      var ref = p.referrals[r];
      if (s.keys.referrals[ref.key]) continue;
      var ins2 = await db.query(
        'INSERT INTO crm_referrals (referrer_name, referrer_phone, location, customer_referred, deal_value, rate, status, external_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (external_key) DO NOTHING',
        [ref.referrerName, ref.referrerPhone, ref.location, ref.customerReferred, ref.dealValue, settings.referral_rate, ref.status, ref.key, meId]);
      result.referrals += ins2.rowCount;
    }

    for (var q = 0; q < p.prospects.length; q++) {
      var pr = p.prospects[q];
      if (s.keys.prospects[pr.key]) continue;
      var ins3 = await db.query(
        'INSERT INTO crm_prospects (list_name, market, company, name, phone, email, website, interest, notes, external_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (external_key) DO NOTHING',
        [pr.listName, pr.market, pr.company, pr.name, pr.phone, pr.email, pr.website, pr.interest, pr.notes, pr.key, meId]);
      result.prospects += ins3.rowCount;
    }

    await audit(db, ctx, 'crm.import', 'crm', null,
      'Imported from a spreadsheet: ' + result.leads + ' lead(s), ' + result.sales + ' sale(s) (' + result.joined + ' added to existing leads, ' + result.linked + ' linked to invoices), ' +
      result.visits + ' site visit(s), ' + result.referrals + ' referral(s), ' + result.prospects + ' prospect(s).');
  });
  result.unknownPeople = s.unknownPeople;
  result.skipped = { leads: s.leads.already, sales: s.sales.already, visits: s.visits.already, referrals: s.referrals.already, prospects: s.prospects.already };
  return result;
}

module.exports = { preview: preview, run: run, parseDate: parseDate, phone: phone, stageOf: stageOf };
