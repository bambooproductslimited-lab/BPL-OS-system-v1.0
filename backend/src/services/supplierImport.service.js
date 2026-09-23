var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { parseCsvBuffer, field } = require('../lib/csvImport');
var suppliersService = require('./suppliers.service');

// Import from the sourcing team's farmer & supplier sheet ("Farmers &
// Suppliers" on Drive), same preview-then-commit shape as the tool room,
// IT device and employee imports.
//
// The sheet is a working document kept by hand for years, and three things
// about it shape everything below:
//
// 1. One person, many rows. The same farmer is on the sheet up to three
//    times — re-entered from a later field trip, sometimes under a
//    different name ("Badu Simon" and "Yakubu Badu" share a number). The
//    phone number is the one thing that reliably identifies a person, so
//    rows are merged on it. Where merged rows disagree, the first value is
//    kept and every other one is written into the supplier's notes and
//    flagged in the preview — nothing the sheet says is silently dropped.
//
// 2. Dates are month/day. Google Sheets on a US-locale account writes
//    13 May 2021 as 5/13/2021, while the shared parseDateLoose() assumes the
//    Ghana day/month order — so 7/5/2022 would quietly become 7 May instead
//    of 5 July. The order is therefore decided per FILE, from the dates that
//    can only be read one way (a part above 12), and then applied to every
//    date in it. See detectDateOrder.
//
// 3. Re-importing must be safe. The sheet will keep being updated, and
//    uploading it again should refresh the sourcing figures without
//    duplicating anyone or undoing corrections made in the OS. See commit()
//    for exactly which fields the sheet is allowed to overwrite.

var MATERIALS = 'Raw bamboo poles';
var PRICE_UNIT = 'pole';

var EMPTY_MARKERS = { 'n/a': 1, na: 1, 'n.a': 1, 'n.a.': 1, '-': 1, '—': 1, '–': 1, none: 1, nil: 1 };
function clean(v) {
  var s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return EMPTY_MARKERS[s.toLowerCase()] ? '' : s;
}

// A Ghana mobile number reduced to its ten digits, or '' when it is not
// one. Accepts the sheet's "0245 402 254", an international "+233 24…",
// and nine digits — what a spreadsheet leaves when a phone column gets
// treated as a number and loses its leading zero.
function phoneKey(p) {
  var d = String(p || '').replace(/\D/g, '');
  if (d.length === 12 && d.indexOf('233') === 0) d = '0' + d.slice(3);
  if (d.length === 9 && d[0] !== '0') d = '0' + d;
  return /^0\d{9}$/.test(d) ? d : '';
}
// Written back the way the sheet itself writes them: 0245 402 254.
function formatPhone(key) { return key.slice(0, 4) + ' ' + key.slice(4, 7) + ' ' + key.slice(7); }

function num(v) {
  var s = clean(v).replace(/,/g, '').replace(/^(ghs|gh₵|₵)\s*/i, '');
  if (!s) return null;
  var n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeAssessment(v) {
  var s = clean(v);
  if (!s) return '';
  // Negative first: "Do not meet spec" contains "meet spec".
  if (/(do(es)?\s*n[o']?t|don'?t)\s*meet/i.test(s) || /below\s*spec/i.test(s)) return 'Does not meet spec';
  if (/meets?\s*spec/i.test(s)) return 'Meets spec';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Decides month/day vs day/month for a whole column. A date with its first
// part above 12 can only be day/month; one with its second part above 12
// can only be month/day. If the column holds only the second kind it is
// month/day throughout, and vice versa. Only when nothing settles it does
// this fall back to day/month (the Ghana convention), and the preview says
// so, since that is a guess.
function detectDateOrder(values) {
  var mdy = 0, dmy = 0;
  values.forEach(function (v) {
    var m = String(v || '').trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (!m) return;
    if (Number(m[1]) > 12) dmy++;
    if (Number(m[2]) > 12) mdy++;
  });
  if (mdy && !dmy) return 'mdy';
  if (dmy && !mdy) return 'dmy';
  if (mdy && dmy) return 'mixed';
  return 'unknown';
}

function pad(n) { return String(n).padStart(2, '0'); }
function validYmd(y, m, d) {
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Returns an ISO date, or null. `order` comes from detectDateOrder.
function parseSheetDate(v, order) {
  var s = clean(v);
  if (!s) return null;
  var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validYmd(+iso[1], +iso[2], +iso[3]) ? s : null;
  // A bare spreadsheet serial (days since 1899-12-30), which is what a
  // date cell turns into when a column loses its date formatting.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    var serial = Math.floor(Number(s));
    if (serial > 20000 && serial < 80000) {
      return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
    }
  }
  var m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  var a = +m[1], b = +m[2], y = +m[3];
  var month, day;
  if (order === 'mdy') { month = a; day = b; }
  else if (order === 'dmy' || order === 'unknown') { day = a; month = b; }
  else { // mixed: each date read whichever way is actually possible
    if (a > 12) { day = a; month = b; } else { month = a; day = b; }
  }
  return validYmd(y, month, day) ? y + '-' + pad(month) + '-' + pad(day) : null;
}

// ---------------------------------------------------------------------------

var COLS = {
  index: ['index', 'no', 'sn', 'sno'],
  date: ['date', 'datefirstcontact', 'firstcontact', 'datecontacted'],
  region: ['region'],
  town: ['town', 'community', 'village', 'location'],
  district: ['district'],
  source: ['source'],
  price: ['currentpricepole', 'pricepole', 'priceperpole', 'priceghs', 'price', 'pricegh'],
  name: ['name', 'farmer', 'farmername', 'supplier', 'suppliername', 'contact'],
  phone: ['mobile', 'phone', 'mobile1', 'phone1', 'tel', 'contactnumber'],
  phone2: ['2ndmobile', 'secondmobile', 'mobile2', 'phone2', 'othermobile', 'altmobile'],
  assessment: ['assessment', 'accessment', 'assesment', 'spec', 'quality'],
  status: ['status'],
  expectedQty: ['expectedqty', 'expectedquantity', 'qty', 'quantity'],
  iou: ['iou', 'iouamount'],
  iouNotes: ['iounotes'],
  notes: ['notes', 'remarks', 'comment', 'comments']
};

function readRow(n) {
  var out = {};
  Object.keys(COLS).forEach(function (k) { out[k] = clean(field(n, COLS[k])); });
  return out;
}

function lower(s) { return String(s || '').toLowerCase(); }

// Folds every sheet row for one person into a single candidate supplier.
function mergeRows(group, order) {
  var first = group[0];
  var names = [], places = [], phones2 = [], prices = [], statuses = [], assessments = [], ious = [], qtys = [];
  var dates = [], iouNotes = [], extraNotes = [], sources = [];
  var warnings = [];

  group.forEach(function (g) {
    var r = g.row;
    if (r.name && names.indexOf(r.name) < 0) names.push(r.name);
    var place = [r.town, r.district, r.region].filter(Boolean).join(', ');
    if (place && places.indexOf(place) < 0) places.push(place);
    if (r.phone2) phones2.push(r.phone2);
    if (r.price) prices.push(r.price);
    if (r.status) statuses.push(r.status);
    if (r.assessment) assessments.push(normalizeAssessment(r.assessment));
    if (r.iou) ious.push(r.iou);
    if (r.expectedQty) qtys.push(r.expectedQty);
    if (r.iouNotes && iouNotes.indexOf(r.iouNotes) < 0) iouNotes.push(r.iouNotes);
    if (r.notes && extraNotes.indexOf(r.notes) < 0) extraNotes.push(r.notes);
    if (r.source) {
      var isSelf = [r.name, r.town, r.district].some(function (x) { return x && lower(x) === lower(r.source); });
      if (!isSelf && sources.indexOf(r.source) < 0) sources.push(r.source);
    }
    if (r.date) {
      var d = parseSheetDate(r.date, order);
      if (d) dates.push(d);
      else warnings.push('Sheet row ' + g.line + ': could not read the date "' + r.date + '" — left blank.');
    }
  });

  var notes = [];
  function distinct(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }

  // Name — the first one given; the rest are kept, not lost.
  var name = names[0] || '';
  if (!name) {
    name = 'Unnamed farmer' + (first.row.town ? ' — ' + first.row.town : '');
    warnings.push('No name on the sheet — imported as "' + name + '". Rename it once you know who this is.');
  }
  if (names.length > 1) notes.push('Also recorded on the sheet as: ' + names.slice(1).join(', ') + '.');
  if (places.length > 1) {
    notes.push('Also recorded at: ' + places.slice(1).join('; ') + '.');
    warnings.push('Listed at more than one place (' + places.join(' / ') + ') — kept the first.');
  }

  // Numbers: parse, then keep the first and note any that disagree.
  function pickNumber(raw, label, unitSuffix) {
    var parsed = distinct(raw).map(function (v) { return { raw: v, n: num(v) }; });
    var bad = parsed.filter(function (p) { return Number.isNaN(p.n); });
    bad.forEach(function (p) { warnings.push(label + ' "' + p.raw + '" is not a number — left blank.'); });
    var good = parsed.filter(function (p) { return p.n !== null && !Number.isNaN(p.n); });
    var values = distinct(good.map(function (p) { return p.n; }));
    if (values.length > 1) {
      notes.push('Sheet also gave ' + lower(label) + ': ' + values.slice(1).join(', ') + (unitSuffix || '') + '.');
      warnings.push('Different ' + lower(label) + ' figures for the same person (' + values.join(' / ') + ') — kept ' + values[0] + '.');
    }
    return values.length ? values[0] : null;
  }
  var quotedPrice = pickNumber(prices, 'Price', ' GHS per pole');
  var expectedQty = pickNumber(qtys, 'Expected quantity');
  var iouAmount = pickNumber(ious, 'IOU');

  function pickText(list, label) {
    var d = distinct(list);
    if (d.length > 1) {
      notes.push('Sheet also gave ' + lower(label) + ': ' + d.slice(1).join(', ') + '.');
      warnings.push('Different ' + lower(label) + ' entries (' + d.join(' / ') + ') — kept "' + d[0] + '".');
    }
    return d[0] || '';
  }
  var sourcingStatus = pickText(statuses, 'Status');
  var assessment = pickText(assessments, 'Assessment');

  // Second phone: the first valid one that isn't the main number.
  var mainKey = phoneKey(first.row.phone);
  var phone2 = '';
  var others = [];
  distinct(phones2).forEach(function (p) {
    var k = phoneKey(p);
    if (!k) {
      warnings.push('Second phone "' + p + '" does not look like a Ghana number — kept as written.');
      if (!phone2) phone2 = p; else others.push(p);
      return;
    }
    if (k === mainKey) return;
    if (!phone2) phone2 = formatPhone(k); else others.push(formatPhone(k));
  });
  if (others.length) notes.push('Other numbers: ' + others.join(', ') + '.');

  if (sources.length) notes.push('Source: ' + sources.join('; ') + '.');
  extraNotes.forEach(function (n) { notes.push(n); });

  // The earliest date on any of their rows is when we first recorded them.
  dates.sort();
  var lines = group.map(function (g) { return g.line; });

  return {
    name: name.slice(0, 100),
    contactPerson: name.slice(0, 60),
    phone: mainKey ? formatPhone(mainKey) : '',
    phone2: phone2,
    region: first.row.region,
    town: first.row.town,
    district: first.row.district,
    quotedPrice: quotedPrice,
    priceUnit: PRICE_UNIT,
    assessment: assessment,
    sourcingStatus: sourcingStatus,
    expectedQty: expectedQty,
    iouAmount: iouAmount,
    iouNotes: iouNotes.join('; '),
    firstContactDate: dates[0] || null,
    notes: notes.join('\n'),
    materialsSupplied: MATERIALS,
    sheetRows: lines,
    warnings: warnings
  };
}

async function loadExisting(client) {
  var res = await client.query('SELECT * FROM suppliers');
  var byPhone = {}, byNameTown = {};
  res.rows.forEach(function (r) {
    [r.phone, r.phone2].forEach(function (p) { var k = phoneKey(p); if (k && !byPhone[k]) byPhone[k] = r; });
    byNameTown[lower(r.name) + '|' + lower(r.town)] = r;
  });
  return { byPhone: byPhone, byNameTown: byNameTown };
}

function findExisting(existing, c) {
  var k = phoneKey(c.phone);
  if (k) return existing.byPhone[k] || null;
  return existing.byNameTown[lower(c.name) + '|' + lower(c.town)] || null;
}

// Which fields the sheet is allowed to change on a supplier that already
// exists in the OS — see commit() for the reasoning.
var SHEET_OWNED = ['quotedPrice', 'priceUnit', 'assessment', 'sourcingStatus', 'expectedQty', 'iouAmount', 'iouNotes'];
var FILL_IF_EMPTY = ['phone2', 'region', 'town', 'district', 'firstContactDate'];

function describeChanges(existingRow, c) {
  var cur = suppliersService.rowToSupplier(existingRow);
  var changes = [];
  var LABELS = { quotedPrice: 'Price', assessment: 'Assessment', sourcingStatus: 'Status', expectedQty: 'Expected qty',
    iouAmount: 'IOU', iouNotes: 'IOU notes', phone2: 'Second phone', region: 'Region', town: 'Town', district: 'District',
    firstContactDate: 'First contact' };
  SHEET_OWNED.forEach(function (k) {
    if (k === 'priceUnit') return;
    var v = c[k];
    if (v === null || v === undefined || v === '') return;
    if (String(cur[k] == null ? '' : cur[k]) !== String(v)) changes.push(LABELS[k] + ': ' + (cur[k] == null || cur[k] === '' ? '—' : cur[k]) + ' → ' + v);
  });
  FILL_IF_EMPTY.forEach(function (k) {
    var v = c[k];
    if ((cur[k] === null || cur[k] === '') && v) changes.push(LABELS[k] + ': — → ' + v);
  });
  return changes;
}

function group(rows, order) {
  var groups = {}, orderKeys = [];
  rows.forEach(function (r, i) {
    var row = readRow(r.norm);
    if (!row.name && !row.phone && !row.town) return; // a blank or spacer row
    var k = phoneKey(row.phone);
    var key = k ? 'p:' + k : 'n:' + lower(row.name) + '|' + lower(row.town);
    if (!groups[key]) { groups[key] = []; orderKeys.push(key); }
    // +2: the header is spreadsheet row 1, so data row i is row i + 2 —
    // the number the sourcing team will see down the side of the sheet.
    groups[key].push({ row: row, line: i + 2 });
  });
  return orderKeys.map(function (k) { return { key: k, rows: groups[k] }; });
}

async function preview(ctx, buffer) {
  if (!ctx.can('supplier.manage')) fail('forbidden', 'Your role does not allow this action (supplier.manage).');
  if (!buffer || !buffer.length) fail('invalid', 'No file uploaded.');
  var rows = parseCsvBuffer(buffer);
  if (!rows.length) fail('invalid', 'That file has no data rows.');

  var hasName = rows.some(function (r) { return field(r.norm, COLS.name) || field(r.norm, COLS.phone); });
  if (!hasName) fail('invalid', 'Could not find a Name or Mobile column. Export the "Farmers & Suppliers" tab as CSV and try again.');

  var order = detectDateOrder(rows.map(function (r) { return field(r.norm, COLS.date); }));
  var groups = group(rows, order);
  var existing = await loadExisting(pool);

  var candidates = groups.map(function (g) {
    var c = mergeRows(g.rows, order);
    var match = findExisting(existing, c);
    c.action = match ? 'update' : 'create';
    if (match) {
      c.existingName = match.name;
      c.changes = describeChanges(match, c);
      if (!c.changes.length) c.action = 'unchanged';
    }
    if (!phoneKey(c.phone)) c.warnings.push('No usable phone number — matched on name and town instead, so a later re-import may not recognise them.');
    return c;
  });

  var dateNote = order === 'mdy' ? 'Dates read as month/day (e.g. 5/13/2021 = 13 May 2021).'
    : order === 'dmy' ? 'Dates read as day/month (e.g. 13/5/2021 = 13 May 2021).'
      : order === 'mixed' ? 'This sheet mixes month/day and day/month dates — each was read whichever way it could be. Check them after import.'
        : 'No date on this sheet settles whether it is month/day or day/month — read as day/month. Check them after import.';

  return {
    sheetRows: groups.reduce(function (n, g) { return n + g.rows.length; }, 0),
    dateOrder: order,
    dateNote: dateNote,
    suppliers: candidates,
    summary: {
      create: candidates.filter(function (c) { return c.action === 'create'; }).length,
      update: candidates.filter(function (c) { return c.action === 'update'; }).length,
      unchanged: candidates.filter(function (c) { return c.action === 'unchanged'; }).length,
      merged: candidates.filter(function (c) { return c.sheetRows.length > 1; }).length,
      withWarnings: candidates.filter(function (c) { return c.warnings.length; }).length
    }
  };
}

// Writes the previewed suppliers.
//
// Nothing from the client is trusted beyond the values themselves: every
// row is re-validated with the same rules as the supplier form, and whether
// it creates or updates is decided again here against the database as it
// is now, not as it was when the preview was taken.
//
// On a supplier that already exists, the sheet is authoritative only for
// the fields it actually tracks over time — price, assessment, status,
// expected quantity and IOU — and only where it has a value. Location,
// second phone and first contact date are filled in when the OS has none,
// never overwritten. The name is never changed: the phone number is who
// someone is, and a name corrected in the OS should not revert to the
// spelling on the sheet every time it is re-uploaded. Notes are appended
// once and not again, so re-importing the same sheet is a no-op.
async function commit(ctx, suppliers) {
  if (!ctx.can('supplier.manage')) fail('forbidden', 'Your role does not allow this action (supplier.manage).');
  if (!Array.isArray(suppliers) || !suppliers.length) fail('invalid', 'Nothing to import.');
  if (suppliers.length > 2000) fail('invalid', 'That is more suppliers than one import can take — split the sheet.');

  var client = await pool.connect();
  var created = 0, updated = 0, unchanged = 0;
  try {
    await client.query('BEGIN');
    var existing = await loadExisting(client);

    for (var i = 0; i < suppliers.length; i++) {
      var c = suppliers[i] || {};
      var label = 'Supplier ' + (i + 1) + (c.name ? ' (' + c.name + ')' : '');
      var name, f;
      try {
        name = V.text(c.name, 'Supplier name', 100);
        f = suppliersService.cleanFarmerFields(c);
      } catch (e) {
        e.message = label + ': ' + e.message;
        throw e;
      }
      var phone = String(c.phone || '').trim().slice(0, 30);
      var match = findExisting(existing, { phone: phone, name: name, town: f.town });

      if (!match) {
        var ins = await client.query(
          'INSERT INTO suppliers (name, contact_person, phone, email, address, materials_supplied, payment_terms, status, ' +
          suppliersService.FARMER_COLUMNS + ") VALUES ($1,$2,$3,'','',$4,'',\'active\',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *",
          [name, (String(c.contactPerson || name).trim() || name).slice(0, 60), phone,
            String(c.materialsSupplied || MATERIALS).trim().slice(0, 200) || MATERIALS]
            .concat(suppliersService.farmerValues(f))
        );
        // Later rows in the same upload must see this one, or two
        // candidates for the same number would both be inserted.
        var k = phoneKey(phone);
        if (k) existing.byPhone[k] = ins.rows[0];
        existing.byNameTown[lower(name) + '|' + lower(f.town)] = ins.rows[0];
        created++;
        continue;
      }

      var cur = suppliersService.rowToSupplier(match);
      var next = {};
      suppliersService.FARMER_KEYS.forEach(function (key) { next[key] = cur[key]; });
      SHEET_OWNED.forEach(function (key) {
        if (f[key] !== null && f[key] !== undefined && f[key] !== '') next[key] = f[key];
      });
      FILL_IF_EMPTY.forEach(function (key) {
        if ((cur[key] === null || cur[key] === '') && f[key]) next[key] = f[key];
      });
      if (f.notes && (cur.notes || '').indexOf(f.notes) < 0) {
        next.notes = cur.notes ? cur.notes + '\n\n' + f.notes : f.notes;
      }
      var cleaned = suppliersService.cleanFarmerFields(next);
      var before = JSON.stringify(suppliersService.farmerValues(suppliersService.cleanFarmerFields(cur)));
      if (JSON.stringify(suppliersService.farmerValues(cleaned)) === before) { unchanged++; continue; }

      var upd = await client.query(
        'UPDATE suppliers SET region = $1, town = $2, district = $3, phone2 = $4, quoted_price = $5, price_unit = $6, ' +
        'assessment = $7, sourcing_status = $8, expected_qty = $9, iou_amount = $10, iou_notes = $11, first_contact_date = $12, notes = $13 ' +
        'WHERE id = $14 RETURNING *',
        suppliersService.farmerValues(cleaned).concat([match.id])
      );
      var kk = phoneKey(upd.rows[0].phone);
      if (kk) existing.byPhone[kk] = upd.rows[0];
      updated++;
    }

    await audit(client, ctx, 'supplier.import', 'supplier', 'bulk',
      'Imported the farmer & supplier sheet: ' + created + ' added, ' + updated + ' updated, ' + unchanged + ' unchanged.');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    client.release();
  }
  return { created: created, updated: updated, unchanged: unchanged };
}

module.exports = {
  preview: preview, commit: commit,
  // exported for tests
  phoneKey: phoneKey, detectDateOrder: detectDateOrder, parseSheetDate: parseSheetDate, normalizeAssessment: normalizeAssessment
};
