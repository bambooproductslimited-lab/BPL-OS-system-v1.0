var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// The daily stock sheet and its monthly summary — the stores team's "BPL
// Finish Inventory" workbook, kept in the OS so it is filled in here rather
// than in a spreadsheet and imported (migration 0072).
//
// A day is one line per product, the sheet's columns exactly:
//
//   Opening stock   entered; starts as the previous day's closing
//   Received        entered; starts as the production recorded that day
//   Total stock     opening + received
//   Transferred     entered
//   Breakage        entered
//   Sold            entered
//   Expected        total − transferred − breakage − sold
//   Physical count  entered when someone counts; blank = not counted
//   Variance        expected − physical, when counted
//
// The day closes at the physical count when there is one, else at the
// expected figure — the sheet's Physical Count column is "=K" until someone
// types over it. The next day opens at that closing.
//
// Only lines someone has saved are stored. A day nobody has touched yet is
// shown with its openings worked out, ready to fill in. Saving a product's
// latest line sets the product's stock on Products & inventory.
//
// The monthly summary is not stored at all: it is the closing figure of
// every stored line in the month, read by product and day.

var NUMBER_FIELDS = ['opening', 'received', 'transferred', 'breakage', 'sold'];
var LABELS = { opening: 'Opening stock', received: 'Received', transferred: 'Transferred', breakage: 'Breakage', sold: 'Sold', physical: 'Physical count' };

function todayISO() { return new Date().toISOString().slice(0, 10); }
function n(v) { return v === null || v === undefined ? null : Number(v); }

function computed(line) {
  var total = line.opening + line.received;
  var expected = total - line.transferred - line.breakage - line.sold;
  var closing = line.physical === null ? expected : line.physical;
  return {
    total: total,
    expected: expected,
    closing: closing,
    variance: line.physical === null ? null : expected - line.physical
  };
}

function lineFromRow(r) {
  var line = {
    opening: Number(r.opening), received: Number(r.received), transferred: Number(r.transferred),
    breakage: Number(r.breakage), sold: Number(r.sold), physical: n(r.physical)
  };
  return Object.assign(line, computed(line));
}

function readDate(v) {
  var d = V.date(v, 'Date');
  if (d > todayISO()) fail('invalid', 'That date is in the future.');
  return d;
}

// Every product's line for one day: saved lines as saved, the rest worked out
// from the product's previous line (or its stock, before its first line).
async function getDay(ctx, dateArg) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var date = V.date(dateArg, 'Date');

  var products = (await pool.query(
    'SELECT p.id, p.sku, p.name, p.category, p.unit, p.current_stock, p.selling_price, p.cost_price, p.reorder_level, p.photo_key, p.photo_updated_at, ' +
    'l.opening, l.received, l.transferred, l.breakage, l.sold, ' +
    'l.physical, l.note, l.updated_at, e.first_name AS upd_first, e.last_name AS upd_last ' +
    'FROM products p LEFT JOIN stock_sheet_lines l ON l.product_id = p.id AND l.date = $1 ' +
    'LEFT JOIN employees e ON e.id = l.updated_by WHERE p.active OR l.product_id IS NOT NULL ORDER BY p.sheet_order NULLS LAST, p.sku',
    [date]
  )).rows;
  var prev = {};
  (await pool.query(
    'SELECT DISTINCT ON (product_id) product_id, date::text AS date, opening, received, transferred, breakage, sold, physical ' +
    'FROM stock_sheet_lines WHERE date < $1 ORDER BY product_id, date DESC',
    [date]
  )).rows.forEach(function (r) { prev[r.product_id] = { date: r.date, line: lineFromRow(r) }; });
  var produced = {};
  (await pool.query(
    "SELECT item_id, sum(qty) AS qty FROM inventory_tx WHERE item_type = 'product' AND type = 'production_output' AND date = $1 GROUP BY item_id",
    [date]
  )).rows.forEach(function (r) { produced[r.item_id] = Number(r.qty); });

  var lines = products.map(function (p) {
    var before = prev[p.id] || null;
    var saved = p.opening !== null;
    var line = saved ? lineFromRow(p) : (function () {
      var l = {
        opening: before ? before.line.closing : Number(p.current_stock),
        received: produced[p.id] || 0, transferred: 0, breakage: 0, sold: 0, physical: null
      };
      return Object.assign(l, computed(l));
    })();
    return Object.assign({
      productId: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit,
      sellingPrice: Number(p.selling_price), costPrice: Number(p.cost_price), reorderLevel: Number(p.reorder_level),
      photo: p.photo_key && p.photo_updated_at ? new Date(p.photo_updated_at).getTime() : null,
      saved: saved, note: p.note || '',
      previousDate: before ? before.date : null,
      previousClosing: before ? before.line.closing : null,
      producedToday: produced[p.id] || 0,
      updatedAt: p.updated_at || null,
      updatedBy: p.upd_first ? p.upd_first + ' ' + p.upd_last : null
    }, line);
  });

  var savedCount = lines.filter(function (l) { return l.saved; }).length;
  // The last day before this one that anything was entered for, so the page
  // can say when days were skipped.
  var lastBefore = (await pool.query('SELECT max(date)::text AS d FROM stock_sheet_lines WHERE date < $1', [date])).rows[0].d;
  return { date: date, isFuture: date > todayISO(), savedCount: savedCount, lastFilledBefore: lastBefore || null, lines: lines };
}

// One line's figures, checked. Blank movements are 0; a blank physical
// count means not counted.
function readLine(body) {
  var p = body || {};
  var line = {};
  NUMBER_FIELDS.forEach(function (f) {
    var v = p[f] === '' || p[f] === null || p[f] === undefined ? 0 : Number(p[f]);
    if (!Number.isFinite(v) || v < 0 || v > 1e9) fail('invalid', LABELS[f] + ' must be a number, 0 or more.');
    line[f] = Math.round(v * 100) / 100;
  });
  if (p.physical === '' || p.physical === null || p.physical === undefined) {
    line.physical = null;
  } else {
    var ph = Number(p.physical);
    if (!Number.isFinite(ph) || ph < 0 || ph > 1e9) fail('invalid', 'Physical count must be a number, 0 or more.');
    line.physical = Math.round(ph * 100) / 100;
  }
  line.note = String(p.note || '').trim().slice(0, 300);
  return line;
}

async function writeLine(client, ctx, date, productId, line) {
  await client.query(
    'INSERT INTO stock_sheet_lines (date, product_id, opening, received, transferred, breakage, sold, physical, note, updated_by, updated_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) ON CONFLICT (product_id, date) DO UPDATE SET ' +
    'opening = EXCLUDED.opening, received = EXCLUDED.received, transferred = EXCLUDED.transferred, breakage = EXCLUDED.breakage, ' +
    'sold = EXCLUDED.sold, physical = EXCLUDED.physical, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()',
    [date, productId, line.opening, line.received, line.transferred, line.breakage, line.sold, line.physical, line.note, ctx.employee ? ctx.employee.id : null]
  );
  // The product's stock follows its latest day. A correction to an older
  // day changes that day (and the summary) but not today's stock.
  var later = (await client.query('SELECT 1 FROM stock_sheet_lines WHERE product_id = $1 AND date > $2 LIMIT 1', [productId, date])).rows[0];
  if (!later) await client.query('UPDATE products SET current_stock = $1 WHERE id = $2', [Math.max(0, computed(line).closing), productId]);
  if (line.physical !== null) {
    await client.query('UPDATE products SET last_counted_on = GREATEST(last_counted_on, $1::date) WHERE id = $2', [date, productId]);
  }
}

async function inTransaction(fn) {
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function saveLine(ctx, dateArg, productId, body) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var date = readDate(dateArg);
  var product = (await pool.query('SELECT id FROM products WHERE id = $1', [productId])).rows[0];
  if (!product) fail('notfound', 'Product not found.');
  var line = readLine(body);
  await inTransaction(function (client) { return writeLine(client, ctx, date, productId, line); });
  var day = await getDay(ctx, date);
  return day.lines.filter(function (l) { return l.productId === productId; })[0];
}

// Saves several lines of one day at once — "save the rest as shown", for a
// day where most products didn't move. All or nothing.
async function saveDay(ctx, dateArg, lines) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var date = readDate(dateArg);
  if (!Array.isArray(lines) || !lines.length) fail('invalid', 'Nothing to save.');
  if (lines.length > 3000) fail('invalid', 'Too many lines at once.');
  var known = {};
  (await pool.query('SELECT id FROM products')).rows.forEach(function (r) { known[r.id] = true; });
  var checked = lines.map(function (l) {
    if (!l || !known[l.productId]) fail('notfound', 'Product not found.');
    return { productId: l.productId, line: readLine(l) };
  });
  await inTransaction(async function (client) {
    for (var i = 0; i < checked.length; i++) await writeLine(client, ctx, date, checked[i].productId, checked[i].line);
  });
  await audit(pool, ctx, 'stock.sheet', 'stock_sheet', date, 'Saved ' + checked.length + ' line(s) of the daily stock sheet for ' + date + '.');
  return getDay(ctx, date);
}

function daysIn(month) {
  var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  var count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  var out = [];
  for (var d = 1; d <= count; d++) out.push(month + '-' + String(d).padStart(2, '0'));
  return out;
}

// The monthly summary: each product's closing figure on every day of the
// month that has a line, plus the month's movements.
async function month(ctx, monthArg) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var monthStr = String(monthArg || todayISO().slice(0, 7));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr)) fail('invalid', 'Month must look like 2026-09.');
  var days = daysIn(monthStr);
  var first = days[0], last = days[days.length - 1];

  // An archived product (products.service.js) shows only in the months it has lines.
  var products = (await pool.query(
    'SELECT id, sku, name, category, unit, current_stock FROM products p WHERE p.active OR EXISTS ' +
    '(SELECT 1 FROM stock_sheet_lines l WHERE l.product_id = p.id AND l.date BETWEEN $1 AND $2) ORDER BY sheet_order NULLS LAST, sku',
    [first, last]
  )).rows;
  var lines = (await pool.query(
    'SELECT product_id, date::text AS date, opening, received, transferred, breakage, sold, physical FROM stock_sheet_lines ' +
    'WHERE date BETWEEN $1 AND $2 ORDER BY date',
    [first, last]
  )).rows;
  var byProduct = {};
  var daysWithLines = {};
  lines.forEach(function (r) {
    (byProduct[r.product_id] = byProduct[r.product_id] || []).push(r);
    daysWithLines[r.date] = true;
  });

  var rows = products.map(function (p) {
    var own = byProduct[p.id] || [];
    var cells = {};
    var totals = { received: 0, transferred: 0, breakage: 0, sold: 0 };
    var variances = 0;
    own.forEach(function (r) {
      var l = lineFromRow(r);
      cells[r.date] = { closing: l.closing, expected: l.expected, physical: l.physical, variance: l.variance };
      totals.received += l.received;
      totals.transferred += l.transferred;
      totals.breakage += l.breakage;
      totals.sold += l.sold;
      if (l.variance) variances++;
    });
    return {
      productId: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit,
      opening: own.length ? Number(own[0].opening) : null,
      closing: own.length ? cells[own[own.length - 1].date].closing : null,
      totals: totals, daysWithVariance: variances, cells: cells
    };
  });

  return {
    month: monthStr,
    days: days.map(function (d) { return { date: d, hasLines: !!daysWithLines[d] }; }),
    rows: rows
  };
}

// Every month from the first one with anything on the daily stock sheet (or
// six months back, whichever is earlier) up to this one, with how many of its days are filled in — the strip of months
// across the top of the summary, so earlier months are one click away and a
// month with gaps (a workbook not yet imported) shows as such.
async function months(ctx) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var filled = (await pool.query(
    "SELECT to_char(date, 'YYYY-MM') AS month, count(DISTINCT date)::int AS days FROM stock_sheet_lines GROUP BY 1 ORDER BY 1"
  )).rows;
  var byMonth = {};
  filled.forEach(function (r) { byMonth[r.month] = r.days; });
  var today = todayISO();
  var current = today.slice(0, 7);
  // At least the last six months, so earlier months that were never
  // imported still show — empty — rather than not at all.
  var cy = Number(current.slice(0, 4)), cm = Number(current.slice(5, 7)) - 5;
  while (cm < 1) { cm += 12; cy--; }
  var sixBack = cy + '-' + String(cm).padStart(2, '0');
  var start = filled.length && filled[0].month < sixBack ? filled[0].month : sixBack;
  var out = [];
  var y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  while (true) {
    var key = y + '-' + String(m).padStart(2, '0');
    var total = daysIn(key).length;
    out.push({
      month: key, daysFilled: byMonth[key] || 0,
      // Days that have happened so far: all of them for a past month.
      daysSoFar: key === current ? Number(today.slice(8, 10)) : total,
      daysInMonth: total
    });
    if (key >= current) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// A few days at a glance, ending on `to` (the strip of days at the top of
// the sheet): for each day how many lines were entered, how many were
// counted and did not match, and what was received and sold.
async function days(ctx, toArg, countArg) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var to = toArg ? V.date(String(toArg), 'Date') : todayISO();
  var count = Math.min(62, Math.max(1, Number(countArg) || 14));
  var rows = (await pool.query(
    "SELECT d::date::text AS date, count(l.product_id)::int AS lines, " +
    "count(l.physical)::int AS counted, " +
    "count(*) FILTER (WHERE l.physical IS NOT NULL AND l.physical <> l.opening + l.received - l.transferred - l.breakage - l.sold)::int AS variances, " +
    "coalesce(sum(l.received), 0)::float AS received, coalesce(sum(l.sold), 0)::float AS sold, " +
    "coalesce(sum(l.sold * p.selling_price), 0)::float AS sold_value " +
    "FROM generate_series($1::date - ($2::int - 1), $1::date, interval '1 day') d " +
    'LEFT JOIN stock_sheet_lines l ON l.date = d::date LEFT JOIN products p ON p.id = l.product_id ' +
    'GROUP BY d ORDER BY d',
    [to, count]
  )).rows;
  var products = (await pool.query('SELECT count(*)::int AS n FROM products WHERE active')).rows[0].n;
  return {
    products: products,
    days: rows.map(function (r) {
      return { date: r.date, lines: r.lines, counted: r.counted, variances: r.variances, received: r.received, sold: r.sold, soldValue: r.sold_value };
    })
  };
}

module.exports = { getDay: getDay, saveLine: saveLine, saveDay: saveDay, month: month, months: months, days: days, computed: computed };
