var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var ExcelJS = require('exceljs');
var { parseCsvBuffer, field, normHeader } = require('../lib/csvImport');

// Import from the stores team's finished-goods count sheet ("BPL Finish
// Inventory", one workbook a month) into Products & inventory, with the
// same preview-then-commit shape as the other sheet imports.
//
// The workbook has one tab per counting day ("1", "2" … "22"), each a full
// count of the store — opening stock, received, transferred, breakage,
// sold, expected closing and the physical count — plus a monthly summary
// tab and a PO log. One day's tab is what gets uploaded, and its Physical
// Count is what lands in the OS: it is the figure somebody actually
// counted on the shelf.
//
// What the sheet looks like, and what that means here:
//
// 1. A stock line is an item AND a variation. "001 Bamboo Slats" is five
//    lines (4' A, 8' A, 8' Bc, 4', 8' Sanded), and each is its own product
//    here with its own SKU and stock figure.
//
// 2. The leading code is not unique on its own. "E02" is both Double Socket
//    and Single Socket; "002 Bamboo Poles, 2.7m poles" appears twice, once
//    under the category "Bamboo [for slats]". SKUs are built from the code
//    and the variation, and only where that collides is something from the
//    name added to tell the lines apart — see assignSkus.
//
// 3. Re-uploading is how counts get updated. A later day's tab should move
//    the stock figures and nothing else: prices, reorder levels and any
//    renaming done in the OS are left alone, and every stock change is
//    written to the stock history as a count adjustment dated to the count.
//
// The monthly summary tab ("2026 Sept") can be uploaded too. It has a column
// per day with each line's closing figure, so one upload brings in the whole
// month: the latest day's figure becomes the stock, and every day's change
// goes into the stock history. But it is not a count — its figures are the
// day tabs' Expected Closing, and its UOM column is a copy of one value down
// the whole sheet — so:
//
// - a product physically counted on or after the summary's latest day keeps
//   its count (products.last_counted_on, set by day-tab imports);
// - history is only added for days after the product's latest history entry,
//   so uploading the summary again, or after a day tab, adds nothing twice;
// - the UOM is ignored, and there is no category column: a new product takes
//   the category of another product with the same code, or "Other";
// - the summary can't tell apart two identical lines that its day tabs tell
//   apart by category ("2.7m poles" twice, once "[for slats]"), so the
//   second such line is matched to the day-tab product with the same code
//   and variation that the first line didn't take.

var COLS = {
  // Later tabs lost the first header ("Items/Description" became blank),
  // which a CSV export turns into an empty column name.
  item: ['itemsdescription', 'itemdescription', 'items', 'item', 'description', ''],
  category: ['category'],
  variation: ['variation', 'variant'],
  unit: ['uom', 'unit', 'unitofmeasure'],
  physical: ['physicalcount', 'physical', 'count', 'counted'],
  expected: ['expectedclosing', 'closingstock', 'closing'],
  // The rest of the day's columns, kept as that day's line on the daily
  // stock sheet (stockSheet.service.js).
  opening: ['openingstock', 'opening'],
  received: ['received'],
  transferred: ['transfered', 'transferred', 'transfer', 'transfers'],
  breakage: ['breakage', 'breakages'],
  sold: ['soldsquare', 'sold']
};

var MOVEMENTS = ['opening', 'received', 'transferred', 'breakage', 'sold'];

// Spellings the sheet uses for its categories, written properly once here
// so the OS doesn't show them on every product.
var CATEGORY_SPELLING = { plumbering: 'Plumbing', capentory: 'Carpentry', carpentory: 'Carpentry', electricals: 'Electricals' };

function clean(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function num(v) {
  var s = clean(v).replace(/,/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

// "001 Bamboo Slats" -> { code: '001', name: 'Bamboo Slats' }. Codes on the
// sheet are three characters or so: 001, B02, P09, S093.
function splitCode(item) {
  var s = clean(item).replace(/\\+/g, '/');
  var m = s.match(/^([A-Za-z]?\d{2,3})\s+(.+)$/);
  return m ? { code: m[1].toUpperCase(), name: m[2].trim() } : { code: '', name: s };
}

// "Bamboo [for slats]" -> { category: 'Bamboo', note: 'for slats' }
function splitCategory(raw) {
  var s = clean(raw);
  var note = '';
  var m = s.match(/^(.*?)\s*\[(.+?)\]\s*$/);
  if (m) { s = m[1].trim(); note = m[2].trim(); }
  var fixed = CATEGORY_SPELLING[s.toLowerCase()];
  return { category: fixed || s, note: note };
}

// Inches typed as two apostrophes (3/4'') become a proper inch mark, and a
// backslash typed for a slash (3\4'') becomes the slash it meant.
function tidyVariation(v) {
  return clean(v).replace(/\\+/g, '/').replace(/''/g, '"');
}

function productName(parts) {
  var name = parts.name + (parts.note ? ' (' + parts.note + ')' : '');
  if (parts.variation && parts.variation.toLowerCase() !== 'regular') name += ' — ' + parts.variation;
  return name.slice(0, 80);
}

function slug(s) {
  return String(s || '').toUpperCase()
    .replace(/"/g, 'IN').replace(/'/g, 'FT').replace(/\//g, '-')
    .replace(/[^A-Z0-9.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function initials(name) {
  return name.split(/\s+/).map(function (w) { return w[0] || ''; }).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function baseSku(line) {
  var head = line.code || initials(line.itemName) || 'ITEM';
  var tail = line.variation && line.variation.toLowerCase() !== 'regular' ? slug(line.variation) : '';
  return (tail ? head + '-' + tail : head).slice(0, 30).replace(/-$/, '');
}

// Gives every line a SKU that is unique within the file and the same each
// time the sheet is uploaded, so a later count finds the products an
// earlier one created. Where two lines share a code and variation, the part
// of the name that differs is added (E02-13A-DOUBLE / E02-13A-SINGLE), or
// the category note when the names are identical (002-2.7M-POLES-FOR-SLATS).
function assignSkus(lines) {
  var byBase = {};
  lines.forEach(function (l) { l.sku = baseSku(l); (byBase[l.sku] = byBase[l.sku] || []).push(l); });
  Object.keys(byBase).forEach(function (base) {
    var group = byBase[base];
    if (group.length < 2) return;
    var wordSets = group.map(function (l) { return l.itemName.toUpperCase().split(/\s+/); });
    group.forEach(function (l, i) {
      var own = wordSets[i].filter(function (w) { return !wordSets.every(function (ws) { return ws.indexOf(w) >= 0; }); });
      var qualifier = l.note ? slug(l.note) : slug(own.join(' '));
      if (qualifier) l.sku = (base.slice(0, 29 - Math.min(qualifier.length, 12)) + '-' + qualifier.slice(0, 12)).replace(/-+/g, '-');
    });
  });
  // Anything still sharing a SKU (identical lines entered twice) is numbered
  // in sheet order.
  var seen = {};
  lines.forEach(function (l) {
    if (!seen[l.sku]) { seen[l.sku] = 1; return; }
    seen[l.sku] += 1;
    var n = '-' + seen[l.sku];
    l.sku = l.sku.slice(0, 30 - n.length) + n;
  });
}

// The summary tab's date columns, e.g. "9/1/2026" … "9/30/2026". Whether
// that is month/day or day/month depends on the sheet's locale; one month's
// columns tell it apart, as the part that stays the same is the month.
function readDateColumns(headers) {
  var cols = [];
  headers.forEach(function (h) {
    var t = String(h).trim();
    var iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    var sl = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (iso) cols.push({ header: h, y: +iso[1], a: +iso[2], b: +iso[3], iso: true });
    else if (sl) cols.push({ header: h, y: +sl[3], a: +sl[1], b: +sl[2] });
  });
  if (!cols.length) return [];
  var slashed = cols.filter(function (c) { return !c.iso; });
  var dayFirst = slashed.length > 1
    ? slashed.every(function (c) { return c.b === slashed[0].b; }) && !slashed.every(function (c) { return c.a === slashed[0].a; })
    : slashed.some(function (c) { return c.a > 12; });
  return cols.map(function (c) {
    var m = c.iso || !dayFirst ? c.a : c.b, d = c.iso || !dayFirst ? c.b : c.a;
    var dt = new Date(Date.UTC(c.y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return { header: c.header, date: c.y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') };
  }).filter(Boolean).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
}

// "202609 BPL Finish Inventory - 22.csv", as Google Sheets names a
// downloaded tab, is the count of 22 September 2026.
function countDateFromFileName(name) {
  var m = String(name || '').match(/(20\d{2})(\d{2})\D.*-\s*(\d{1,2})\s*\.csv$/i);
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return m[1] + '-' + m[2] + '-' + String(d).padStart(2, '0');
}

async function loadExisting(db) {
  var res = await db.query(
    "SELECT p.id, p.sku, p.name, p.category, p.unit, p.current_stock, p.last_counted_on, " +
    "(SELECT max(t.date) FROM inventory_tx t WHERE t.item_type = 'product' AND t.item_id = p.id) AS last_history FROM products p"
  );
  var bySku = {}, byName = {};
  res.rows.forEach(function (r) {
    bySku[r.sku.toUpperCase()] = r;
    byName[r.name.trim().toLowerCase()] = byName[r.name.trim().toLowerCase()] || r;
  });
  return { bySku: bySku, byName: byName, all: res.rows };
}

function matchExisting(existing, line) {
  return existing.bySku[line.sku.toUpperCase()] || existing.byName[line.name.trim().toLowerCase()] || null;
}

function readLines(rows) {
  var lines = [];
  rows.forEach(function (row, idx) {
    var n = row.norm;
    var item = field(n, COLS.item);
    if (!item) return; // blank rows and the counter's initials under the table
    var parts = splitCode(item);
    var cat = splitCategory(field(n, COLS.category));
    var variation = tidyVariation(field(n, COLS.variation));
    var physical = num(field(n, COLS.physical));
    var expected = num(field(n, COLS.expected));
    var warnings = [];
    var stock = physical;
    if (stock === null && expected !== null) {
      stock = expected;
      warnings.push({ code: 'no_count', expected: expected });
    } else if (stock !== null && expected !== null && stock !== expected) {
      warnings.push({ code: 'variance', counted: stock, expected: expected });
    }
    if (stock !== null && stock < 0) { warnings.push({ code: 'negative', counted: stock }); stock = 0; }
    var movements = {};
    MOVEMENTS.forEach(function (m) { movements[m] = Math.max(0, num(field(n, COLS[m])) || 0); });
    // The sheet's Physical Count copies Expected Closing until someone types
    // over it. From a workbook we can see which cells were typed over
    // (row.typedPhysical); from a CSV only that the figure differs.
    var counted = row.typedPhysical === undefined ? physical !== expected : row.typedPhysical;
    movements.physical = physical !== null && counted ? Math.max(0, physical) : null;
    lines.push({
      sheetRow: idx + 2,
      code: parts.code,
      itemName: parts.name,
      note: cat.note,
      variation: variation,
      name: productName({ name: parts.name, note: cat.note, variation: variation }),
      category: (cat.category || 'Other').slice(0, 40),
      unit: clean(field(n, COLS.unit)).slice(0, 20),
      stock: stock,
      movements: movements,
      warnings: warnings
    });
  });
  return lines;
}

// ---- the monthly summary tab ----------------------------------------------

var SUMMARY_ITEM = ['item', 'items', 'itemsdescription', 'itemdescription', 'description'];

function readSummaryLines(rows, dateCols) {
  // The latest day any line has a figure for (later days are #REF! until
  // their tab exists).
  var latest = null;
  dateCols.forEach(function (dc) {
    if (rows.some(function (r) { return num(r.raw[dc.header]) !== null; })) latest = dc.date;
  });
  if (!latest) fail('invalid', 'The summary has no figures in any of its date columns.');
  var lines = [];
  rows.forEach(function (row, idx) {
    var item = field(row.norm, SUMMARY_ITEM);
    if (!item) return;
    var parts = splitCode(item);
    var variation = tidyVariation(field(row.norm, COLS.variation));
    var warnings = [];
    var history = [];
    dateCols.forEach(function (dc) {
      var v = num(row.raw[dc.header]);
      if (v === null || dc.date > latest) return;
      history.push({ date: dc.date, stock: Math.max(0, v) });
    });
    var last = history.length && history[history.length - 1].date === latest ? history[history.length - 1].stock : null;
    var raw = num(row.raw[dateCols.filter(function (dc) { return dc.date === latest; })[0].header]);
    if (raw !== null && raw < 0) warnings.push({ code: 'negative', counted: raw });
    lines.push({
      sheetRow: idx + 2, code: parts.code, itemName: parts.name, note: '', variation: variation,
      name: productName({ name: parts.name, note: '', variation: variation }),
      category: 'Other', unit: 'each', stock: last, history: history, warnings: warnings
    });
  });
  return { lines: lines, countDate: latest };
}

// Changes after the product's latest history entry, as signed quantities
// chained from its current stock: what the summary adds to the history.
function historyChanges(history, fromStock, after) {
  var prev = fromStock;
  var out = [];
  history.forEach(function (h) {
    if (after && h.date <= after) return;
    if (prev === null) { out.push({ date: h.date, qty: h.stock, stock: h.stock, opening: true }); prev = h.stock; return; }
    if (h.stock !== prev) out.push({ date: h.date, qty: h.stock - prev, stock: h.stock });
    prev = h.stock;
  });
  return out;
}

function dateText(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : (d ? String(d).slice(0, 10) : null); }

// Matches summary lines to products, each product at most once — see the
// module comment on identical lines.
function matchSummaryLines(existing, lines) {
  var claimed = {};
  var byCodeCategory = {};
  existing.all.forEach(function (p) {
    var code = p.sku.split('-')[0];
    if (!byCodeCategory[code] && p.category) byCodeCategory[code] = p.category;
  });
  lines.forEach(function (l) {
    var base = baseSku(l).toUpperCase();
    var m = existing.bySku[l.sku.toUpperCase()];
    if (m && claimed[m.id]) m = null;
    if (!m) {
      var byName = existing.byName[l.name.trim().toLowerCase()];
      if (byName && !claimed[byName.id]) m = byName;
    }
    if (!m) {
      m = existing.all.filter(function (p) { return !claimed[p.id] && p.sku.toUpperCase().indexOf(base + '-') === 0; })
        .sort(function (a, b) { return a.sku < b.sku ? -1 : 1; })[0] || null;
    }
    if (m) {
      claimed[m.id] = true;
      l.match = m;
    } else if (l.code && byCodeCategory[l.code]) {
      l.category = byCodeCategory[l.code];
    }
  });
}

function planSummaryLine(l, countDate) {
  var m = l.match;
  delete l.match;
  if (l.stock === null) { l.action = 'skip'; l.warnings.push({ code: 'no_stock' }); return; }
  if (!m) { l.action = 'create'; l.historyDays = l.history.length; return; }
  l.productId = m.id;
  l.sku = m.sku;
  l.existingSku = m.sku;
  l.name = m.name;
  l.category = m.category;
  l.unit = m.unit;
  l.previousStock = Number(m.current_stock);
  var counted = dateText(m.last_counted_on);
  if (counted && counted >= countDate) {
    // Counted since: the count stays. Worth a look only where the summary's
    // figure for that day differs from what was counted.
    l.action = 'kept';
    l.countedOn = counted;
    if (counted === countDate && l.stock !== l.previousStock) l.warnings.push({ code: 'count_differs', figure: l.stock, counted: l.previousStock });
    l.stock = l.previousStock;
    return;
  }
  var changes = historyChanges(l.history, l.previousStock, dateText(m.last_history));
  l.historyDays = changes.length;
  l.action = changes.length || l.stock !== l.previousStock ? 'update' : 'unchanged';
}

async function previewSummary(rows, dateCols) {
  var read = readSummaryLines(rows, dateCols);
  var lines = read.lines;
  if (!lines.length) fail('invalid', 'Found no items in that file.');
  assignSkus(lines);
  var existing = await loadExisting(pool);
  matchSummaryLines(existing, lines);
  var summary = { create: 0, update: 0, unchanged: 0, kept: 0, skipped: 0, withWarnings: 0 };
  lines.forEach(function (l) {
    planSummaryLine(l, read.countDate);
    summary[l.action === 'skip' ? 'skipped' : l.action] += 1;
    if (l.warnings.length) summary.withWarnings += 1;
  });
  return { source: 'summary', lines: lines, summary: summary, countDate: read.countDate, firstDate: dateCols[0].date };
}

async function preview(ctx, buffer, fileName) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (!buffer || !buffer.length) fail('invalid', 'No file uploaded.');
  var rows = parseCsvBuffer(buffer);
  if (!rows.length) fail('invalid', 'That file has no data rows.');

  var headers = Object.keys(rows[0].norm);
  var hasCount = headers.some(function (h) { return COLS.physical.indexOf(h) >= 0 || COLS.expected.indexOf(h) >= 0; });
  if (!hasCount) {
    // The monthly summary tab: a column per date and no count column.
    var dateCols = readDateColumns(Object.keys(rows[0].raw));
    if (dateCols.length) return previewSummary(rows, dateCols);
    fail('invalid', 'Could not find a Physical Count column or date columns. Download a day\'s tab (1, 2, 3 …) or the monthly summary tab from the Finish Inventory sheet as CSV and try again.');
  }

  var lines = readLines(rows);
  if (!lines.length) fail('invalid', 'Found no items in that file.');
  assignSkus(lines);
  var existing = await loadExisting(pool);

  var summary = { create: 0, update: 0, unchanged: 0, skipped: 0, withWarnings: 0 };
  lines.forEach(function (l) {
    var match = matchExisting(existing, l);
    if (l.stock === null) {
      l.action = 'skip';
      l.warnings.push({ code: 'no_stock' });
    } else if (!match) {
      l.action = 'create';
    } else {
      l.productId = match.id;
      l.existingSku = match.sku;
      l.previousStock = Number(match.current_stock);
      l.action = l.previousStock !== l.stock ? 'update' : 'unchanged';
    }
    summary[l.action === 'skip' ? 'skipped' : l.action] += 1;
    if (l.warnings.length) summary.withWarnings += 1;
  });

  return { source: 'count', lines: lines, summary: summary, countDate: countDateFromFileName(fileName) };
}

// A summary line's daily figures, checked: real dates up to the import's
// date, in order, each a stock of 0 or more.
function readHistory(raw, date, name) {
  if (!Array.isArray(raw) || raw.length > 62) fail('invalid', 'The daily figures for ' + name + ' are not readable.');
  var prev = '';
  return raw.map(function (h) {
    var d = V.date(h && h.date, 'Date');
    var n = Number(h && h.stock);
    if (d > date || d <= prev || !Number.isFinite(n) || n < 0) fail('invalid', 'The daily figures for ' + name + ' are not readable.');
    prev = d;
    return { date: d, stock: n };
  });
}

// Keeps the imported day as that day's line on the daily stock sheet, with
// the sheet's own columns, so imported days read the same as days entered
// in the OS — and the monthly summary covers them.
async function writeSheetLine(client, ctx, date, productId, p, stock) {
  var m = p.movements || {};
  var v = {};
  MOVEMENTS.forEach(function (f) {
    var x = m[f] === undefined || m[f] === null ? (f === 'opening' ? stock : 0) : Number(m[f]);
    if (!Number.isFinite(x) || x < 0) fail('invalid', 'The ' + f + ' figure for ' + p.name + ' is not a number of 0 or more.');
    v[f] = x;
  });
  var physical = m.physical === undefined || m.physical === null ? null : Number(m.physical);
  if (physical !== null && (!Number.isFinite(physical) || physical < 0)) fail('invalid', 'The physical count for ' + p.name + ' is not a number of 0 or more.');
  // The day must close at the stock the import sets, even where the sheet's
  // own columns don't add up to it.
  var expected = v.opening + v.received - v.transferred - v.breakage - v.sold;
  if (physical === null && expected !== stock) physical = stock;
  await client.query(
    'INSERT INTO stock_sheet_lines (date, product_id, opening, received, transferred, breakage, sold, physical, updated_by, updated_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) ON CONFLICT (product_id, date) DO UPDATE SET opening = EXCLUDED.opening, ' +
    'received = EXCLUDED.received, transferred = EXCLUDED.transferred, breakage = EXCLUDED.breakage, sold = EXCLUDED.sold, ' +
    'physical = EXCLUDED.physical, updated_by = EXCLUDED.updated_by, updated_at = now()',
    [date, productId, v.opening, v.received, v.transferred, v.breakage, v.sold, physical, ctx.employee ? ctx.employee.id : null]
  );
  var row = Number(p.sheetRow);
  if (Number.isInteger(row) && row > 0 && row < 100000) await client.query('UPDATE products SET sheet_order = $1 WHERE id = $2', [row, productId]);
}

// Re-reads each line rather than trusting the preview: the browser sends
// back what it was shown, and this is where it is checked.
async function commit(ctx, lines, countDate, source) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (!Array.isArray(lines) || !lines.length) fail('invalid', 'Nothing to import.');
  if (lines.length > 3000) fail('invalid', 'That is more lines than one import can take — split the sheet.');
  var date = V.date(countDate, 'Count date');
  if (source === 'summary') return commitSummary(ctx, lines, date);

  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var counts = await commitCountLines(client, ctx, lines, date);
    await client.query('COMMIT');
    return counts;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// One day's count, inside the caller's transaction — a single day tab, or
// every day of a workbook in turn (see commitWorkbook).
async function commitCountLines(client, ctx, lines, date) {
  var created = 0, updated = 0, unchanged = 0;
  var existing = await loadExisting(client);
  var seenSku = {};
  for (var i = 0; i < lines.length; i++) {
    var p = lines[i] || {};
    if (p.action === 'skip') continue;
    var line = {
      sku: V.text(p.sku, 'SKU', 30).toUpperCase(),
      name: V.text(p.name, 'Product name', 80),
      category: V.text(p.category, 'Category', 40),
      unit: clean(p.unit).slice(0, 20) || 'each',
      stock: Number(p.stock)
    };
    if (!Number.isFinite(line.stock) || line.stock < 0) fail('invalid', 'Stock for ' + line.name + ' must be 0 or more.');
    if (seenSku[line.sku]) fail('invalid', 'SKU ' + line.sku + ' appears twice in this import.');
    seenSku[line.sku] = true;

    var match = matchExisting(existing, line);
    var reference = 'Stock count ' + date;
    if (!match) {
      var ins = await client.query(
        'INSERT INTO products (sku, name, category, unit, current_stock, last_counted_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [line.sku, line.name, line.category, line.unit, line.stock, date]
      );
      await client.query(
        "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,'stock_count',$2,$3,$4,$5,'Opening stock from the count sheet.')",
        [ins.rows[0].id, line.stock, date, ctx.employee ? ctx.employee.id : null, reference]
      );
      existing.bySku[line.sku] = { id: ins.rows[0].id, sku: line.sku, name: line.name, current_stock: line.stock };
      await writeSheetLine(client, ctx, date, ins.rows[0].id, Object.assign({}, p, { name: line.name }), line.stock);
      created++;
      continue;
    }
    await writeSheetLine(client, ctx, date, match.id, Object.assign({}, p, { name: line.name }), line.stock);
    // Counted on this day, even when the count matches what the OS had —
    // so a monthly summary uploaded later won't replace it.
    await client.query('UPDATE products SET last_counted_on = GREATEST(last_counted_on, $1::date) WHERE id = $2', [date, match.id]);
    // An older day's tab (filling in past days) goes on the daily sheet but
    // leaves today's stock alone when a later day is already there.
    var later = (await client.query('SELECT 1 FROM stock_sheet_lines WHERE product_id = $1 AND date > $2 LIMIT 1', [match.id, date])).rows[0];
    var diff = line.stock - Number(match.current_stock);
    if (diff === 0 || later) { unchanged++; continue; }
    // Stock only. A blank category or unit is filled in; anything already
    // set in the OS — including prices, reorder level and the name — is
    // left as it is.
    await client.query(
      "UPDATE products SET current_stock = $1, category = CASE WHEN category = '' THEN $2 ELSE category END, " +
      "unit = CASE WHEN unit IN ('', 'unit') THEN $3 ELSE unit END WHERE id = $4",
      [line.stock, line.category, line.unit, match.id]
    );
    await client.query(
      "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,'stock_count',$2,$3,$4,$5,$6)",
      [match.id, diff, date, ctx.employee ? ctx.employee.id : null, reference, 'Counted ' + line.stock + ', was ' + Number(match.current_stock) + '.']
    );
    updated++;
  }
  await audit(client, ctx, 'product.import', 'product', 'bulk',
    'Imported the stock count of ' + date + ': ' + created + ' product(s) added, ' + updated + ' stock figure(s) changed, ' + unchanged + ' unchanged.');
  return { created: created, updated: updated, unchanged: unchanged };
}

// The monthly summary: see the module comment. Everything is re-derived
// from the database here — which products were counted since, and where
// each one's history ends — not taken from the preview.
async function commitSummary(ctx, lines, date) {
  var client = await pool.connect();
  var created = 0, updated = 0, unchanged = 0, kept = 0;
  var who = ctx.employee ? ctx.employee.id : null;
  try {
    await client.query('BEGIN');
    var existing = await loadExisting(client);
    var seenSku = {};
    var addHistory = async function (productId, changes) {
      for (var j = 0; j < changes.length; j++) {
        var c = changes[j];
        await client.query(
          "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,'sheet_closing',$2,$3,$4,$5,$6)",
          [productId, c.qty, c.date, who, 'Monthly summary ' + c.date,
            c.opening ? 'Opening figure from the monthly summary.' : 'Closing figure on the sheet: ' + c.stock + '.']
        );
      }
    };
    for (var i = 0; i < lines.length; i++) {
      var p = lines[i] || {};
      if (p.action === 'skip') continue;
      var line = {
        sku: V.text(p.sku, 'SKU', 30).toUpperCase(),
        name: V.text(p.name, 'Product name', 80),
        category: V.text(p.category, 'Category', 40),
        unit: clean(p.unit).slice(0, 20) || 'each',
        stock: Number(p.stock)
      };
      if (!Number.isFinite(line.stock) || line.stock < 0) fail('invalid', 'Stock for ' + line.name + ' must be 0 or more.');
      if (seenSku[line.sku]) fail('invalid', 'SKU ' + line.sku + ' appears twice in this import.');
      seenSku[line.sku] = true;
      var history = readHistory(p.history, date, line.name);
      if (!history.length || history[history.length - 1].date !== date || history[history.length - 1].stock !== line.stock) {
        history.push({ date: date, stock: line.stock });
      }

      var match = existing.bySku[line.sku];
      if (!match) {
        var ins = await client.query(
          'INSERT INTO products (sku, name, category, unit, current_stock) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [line.sku, line.name, line.category, line.unit, line.stock]
        );
        await addHistory(ins.rows[0].id, historyChanges(history, null, null));
        existing.bySku[line.sku] = { id: ins.rows[0].id, sku: line.sku };
        created++;
        continue;
      }
      var counted = dateText(match.last_counted_on);
      if (counted && counted >= date) { kept++; continue; }
      var changes = historyChanges(history, Number(match.current_stock), dateText(match.last_history));
      if (!changes.length && line.stock === Number(match.current_stock)) { unchanged++; continue; }
      await client.query('UPDATE products SET current_stock = $1 WHERE id = $2', [line.stock, match.id]);
      await addHistory(match.id, changes);
      updated++;
    }
    await audit(client, ctx, 'product.import', 'product', 'bulk',
      'Imported the monthly summary up to ' + date + ': ' + created + ' product(s) added, ' + updated + ' updated, ' +
      unchanged + ' unchanged, ' + kept + ' kept at a later physical count.');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { created: created, updated: updated, unchanged: unchanged, kept: kept };
}

// ---- the whole workbook -----------------------------------------------------
//
// The .xlsx of a month's Finish Inventory workbook, as Google Sheets
// downloads it (File → Download → Microsoft Excel): every day tab ("1", "2"
// … "22") is imported as that day, oldest first, all in one transaction —
// so a month's history arrives in one upload, and the stock ends at the
// latest day. The monthly summary tab and the PO tab are left out: the OS
// works the summary out from the days (Stock summary).
//
// A workbook tells us something a CSV can't: which Physical Count cells were
// typed over and which are still the "=K" formula. Only typed ones are
// counts.

var WORKBOOK_MAX_DAYS = 31;

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    // Google Sheets' .xlsx leaves out a formula's stored result when it is
    // 0 (e.g. a line with 45 received and 45 transferred).
    if (v.formula || v.sharedFormula) return '0';
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    if ('error' in v) return String(v.error);
    return '';
  }
  return String(v);
}

function isTypedNumber(v) {
  return typeof v === 'number' || (typeof v === 'string' && num(v) !== null);
}

// A worksheet as the rows parseCsvBuffer would give for its CSV, plus
// whether each row's Physical Count was typed in.
function worksheetRows(ws) {
  var headerValues = ws.getRow(1).values || [];
  var headers = [];
  var physicalCol = null;
  for (var c = 1; c < headerValues.length; c++) {
    var h = cellValue(headerValues[c]).trim();
    headers[c] = h;
    if (COLS.physical.indexOf(normHeader(h)) >= 0 && physicalCol === null) physicalCol = c;
  }
  var rows = [];
  for (var r = 2; r <= ws.rowCount; r++) {
    var values = ws.getRow(r).values || [];
    var raw = {}, norm = {}, any = false;
    for (var col = 1; col < Math.max(values.length, headers.length); col++) {
      if (headers[col] === undefined) continue;
      var text = cellValue(values[col]).trim();
      if (text) any = true;
      if (!(headers[col] in raw)) raw[headers[col]] = text;
      var key = normHeader(headers[col]);
      if (!(key in norm) || (norm[key] === '' && text)) norm[key] = text;
    }
    if (!any) continue;
    var row = { raw: raw, norm: norm };
    if (physicalCol !== null) row.typedPhysical = isTypedNumber(values[physicalCol]);
    rows.push(row);
  }
  return { headers: headers.filter(function (h) { return h !== undefined; }), rows: rows };
}

async function loadWorkbook(buffer) {
  var wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (e) {
    fail('invalid', 'Could not read that file as an Excel workbook. In Google Sheets use File → Download → Microsoft Excel (.xlsx).');
  }
  return wb;
}

// "202609 BPL Finish Inventory.xlsx" is September 2026; failing that, the
// summary tab's first date column says which month it is.
function workbookMonth(wb, fileName) {
  var m = String(fileName || '').match(/(20\d{2})(0[1-9]|1[0-2])/);
  if (m) return m[1] + '-' + m[2];
  for (var i = 0; i < wb.worksheets.length; i++) {
    var values = wb.worksheets[i].getRow(1).values || [];
    for (var c = 1; c < values.length; c++) {
      if (values[c] instanceof Date) return values[c].toISOString().slice(0, 7);
    }
  }
  return null;
}

// The day tabs, oldest first, as { date, sheet, rows }; every other tab is
// listed with the reason it is left out.
function workbookDays(wb, month) {
  var days = [], skipped = [];
  wb.worksheets.forEach(function (ws) {
    var name = String(ws.name).trim();
    if (!/^\d{1,2}$/.test(name)) { skipped.push({ sheet: name, reason: 'not_a_day' }); return; }
    var sheet = worksheetRows(ws);
    var hasCount = sheet.headers.some(function (h) { var k = normHeader(h); return COLS.physical.indexOf(k) >= 0 || COLS.expected.indexOf(k) >= 0; });
    if (!hasCount) { skipped.push({ sheet: name, reason: 'no_count_column' }); return; }
    if (!month) { days.push({ date: null, sheet: name, rows: sheet.rows }); return; }
    var d = Number(name);
    var dt = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, d));
    if (d < 1 || dt.getUTCMonth() !== Number(month.slice(5, 7)) - 1) { skipped.push({ sheet: name, reason: 'no_such_day' }); return; }
    var date = month + '-' + String(d).padStart(2, '0');
    if (date > new Date().toISOString().slice(0, 10)) { skipped.push({ sheet: name, reason: 'future' }); return; }
    days.push({ date: date, sheet: name, rows: sheet.rows });
  });
  days.sort(function (a, b) { return Number(a.sheet) - Number(b.sheet); });
  if (days.length > WORKBOOK_MAX_DAYS) fail('invalid', 'That workbook has more day tabs than a month has days.');
  return { days: days, skipped: skipped };
}

function dayLines(rows) {
  var lines = readLines(rows);
  assignSkus(lines);
  lines.forEach(function (l) { l.action = l.stock === null ? 'skip' : 'import'; });
  return lines;
}

async function previewWorkbook(ctx, buffer, fileName, monthArg) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (!buffer || !buffer.length) fail('invalid', 'No file uploaded.');
  var wb = await loadWorkbook(buffer);
  var month = monthArg ? readMonth(monthArg) : workbookMonth(wb, fileName);
  var found = workbookDays(wb, month);
  if (!found.days.length) fail('invalid', 'Found no day tabs (1, 2, 3 …) with a Physical Count column in that workbook.');
  if (!month) return { source: 'workbook', month: null, days: found.days.map(function (d) { return { sheet: d.sheet }; }), skippedTabs: found.skipped };

  var existing = await loadExisting(pool);
  var inOs = {};
  (await pool.query(
    'SELECT date::text AS date, count(*)::int AS n FROM stock_sheet_lines WHERE date BETWEEN $1 AND $2 GROUP BY date',
    [found.days[0].date, found.days[found.days.length - 1].date]
  )).rows.forEach(function (r) { inOs[r.date] = r.n; });

  var newSkus = {};
  var days = found.days.map(function (d) {
    var lines = dayLines(d.rows);
    var items = lines.filter(function (l) { return l.action !== 'skip'; });
    items.forEach(function (l) { if (!matchExisting(existing, l)) newSkus[l.sku] = l.name; });
    return {
      date: d.date, sheet: d.sheet, items: items.length,
      counted: items.filter(function (l) { return l.movements.physical !== null; }).length,
      differences: items.filter(function (l) { return l.movements.physical !== null && l.warnings.some(function (w) { return w.code === 'variance'; }); }).length,
      skipped: lines.length - items.length,
      alreadyInOs: inOs[d.date] || 0,
      lines: lines
    };
  });

  // Where stock ends up: the latest day's figures, unless the OS already has
  // a later day of its own.
  var last = days[days.length - 1];
  var laterInOs = (await pool.query('SELECT max(date)::text AS d FROM stock_sheet_lines WHERE date > $1', [last.date])).rows[0].d;
  var stockChanges = laterInOs ? 0 : last.lines.filter(function (l) {
    if (l.action === 'skip') return false;
    var m = matchExisting(existing, l);
    return !m || Number(m.current_stock) !== l.stock;
  }).length;

  return {
    source: 'workbook', month: month,
    days: days.map(function (d) { var out = Object.assign({}, d); delete out.lines; return out; }),
    skippedTabs: found.skipped,
    newProducts: Object.keys(newSkus).length,
    newProductNames: Object.keys(newSkus).slice(0, 8).map(function (k) { return newSkus[k]; }),
    lastDate: last.date,
    laterInOs: laterInOs,
    stockChanges: stockChanges
  };
}

function readMonth(v) {
  var m = String(v || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) fail('invalid', 'Month must look like 2026-09.');
  return m;
}

// Reads the file again rather than trusting a preview sent back: the
// workbook itself is the record. Every day or none.
async function commitWorkbook(ctx, buffer, fileName, monthArg) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (!buffer || !buffer.length) fail('invalid', 'No file uploaded.');
  var month = readMonth(monthArg);
  var wb = await loadWorkbook(buffer);
  var found = workbookDays(wb, month);
  if (!found.days.length) fail('invalid', 'Found no day tabs (1, 2, 3 …) with a Physical Count column in that workbook.');

  var client = await pool.connect();
  var totals = { days: 0, created: 0, updated: 0, unchanged: 0 };
  try {
    await client.query('BEGIN');
    for (var i = 0; i < found.days.length; i++) {
      var d = found.days[i];
      var counts = await commitCountLines(client, ctx, dayLines(d.rows), d.date);
      totals.days++;
      totals.created += counts.created;
      totals.updated += counts.updated;
      totals.unchanged += counts.unchanged;
    }
    await audit(client, ctx, 'product.import', 'product', 'bulk',
      'Imported the Finish Inventory workbook for ' + month + ': ' + totals.days + ' day(s), ' + totals.created + ' product(s) added.');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return totals;
}

module.exports = {
  preview: preview,
  commit: commit,
  // exported for the tests
  splitCode: splitCode,
  splitCategory: splitCategory,
  tidyVariation: tidyVariation,
  assignSkus: assignSkus,
  countDateFromFileName: countDateFromFileName,
  readDateColumns: readDateColumns,
  previewWorkbook: previewWorkbook,
  commitWorkbook: commitWorkbook
};
