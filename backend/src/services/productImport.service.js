var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');
var { parseCsvBuffer, field } = require('../lib/csvImport');

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

var COLS = {
  // Later tabs lost the first header ("Items/Description" became blank),
  // which a CSV export turns into an empty column name.
  item: ['itemsdescription', 'itemdescription', 'items', 'item', 'description', ''],
  category: ['category'],
  variation: ['variation', 'variant'],
  unit: ['uom', 'unit', 'unitofmeasure'],
  physical: ['physicalcount', 'physical', 'count', 'counted'],
  expected: ['expectedclosing', 'closingstock', 'closing']
};

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
  var res = await db.query('SELECT id, sku, name, category, unit, current_stock FROM products');
  var bySku = {}, byName = {};
  res.rows.forEach(function (r) {
    bySku[r.sku.toUpperCase()] = r;
    byName[r.name.trim().toLowerCase()] = byName[r.name.trim().toLowerCase()] || r;
  });
  return { bySku: bySku, byName: byName };
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
      warnings: warnings
    });
  });
  return lines;
}

async function preview(ctx, buffer, fileName) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (!buffer || !buffer.length) fail('invalid', 'No file uploaded.');
  var rows = parseCsvBuffer(buffer);
  if (!rows.length) fail('invalid', 'That file has no data rows.');

  var headers = Object.keys(rows[0].norm);
  var hasCount = headers.some(function (h) { return COLS.physical.indexOf(h) >= 0 || COLS.expected.indexOf(h) >= 0; });
  if (!hasCount) {
    // The monthly summary tab has a column per date and no count column.
    var looksLikeSummary = Object.keys(rows[0].raw).some(function (h) { return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(h.trim()); });
    fail('invalid', looksLikeSummary
      ? 'That is the monthly summary tab. Download one day\'s count tab instead (the tabs named 1, 2, 3 …) — it has the Physical Count column.'
      : 'Could not find a Physical Count column. Download one day\'s count tab from the Finish Inventory sheet as CSV and try again.');
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

  return { lines: lines, summary: summary, countDate: countDateFromFileName(fileName) };
}

// Re-reads each line rather than trusting the preview: the browser sends
// back what it was shown, and this is where it is checked.
async function commit(ctx, lines, countDate) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  if (!Array.isArray(lines) || !lines.length) fail('invalid', 'Nothing to import.');
  if (lines.length > 3000) fail('invalid', 'That is more lines than one import can take — split the sheet.');
  var date = V.date(countDate, 'Count date');

  var client = await pool.connect();
  var created = 0, updated = 0, unchanged = 0;
  try {
    await client.query('BEGIN');
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
          'INSERT INTO products (sku, name, category, unit, current_stock) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [line.sku, line.name, line.category, line.unit, line.stock]
        );
        await client.query(
          "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,'stock_count',$2,$3,$4,$5,'Opening stock from the count sheet.')",
          [ins.rows[0].id, line.stock, date, ctx.employee ? ctx.employee.id : null, reference]
        );
        existing.bySku[line.sku] = { id: ins.rows[0].id, sku: line.sku, name: line.name, current_stock: line.stock };
        created++;
        continue;
      }
      var diff = line.stock - Number(match.current_stock);
      if (diff === 0) { unchanged++; continue; }
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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { created: created, updated: updated, unchanged: unchanged };
}

module.exports = {
  preview: preview,
  commit: commit,
  // exported for the tests
  splitCode: splitCode,
  splitCategory: splitCategory,
  tidyVariation: tidyVariation,
  assignSkus: assignSkus,
  countDateFromFileName: countDateFromFileName
};
