var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var sms = require('./sms.service');
var stockSheet = require('./stockSheet.service');

// Workshop work orders that make items kept on the daily stock sheet
// (migration 0226). The WO form asks whether the work is for items on the
// stock sheet; if so, the items and how many are picked from the sheet's
// own list (task_stock_items).
//
// When the work order is completed (with its photo — tasks.service.js),
// each item goes onto that day's stock sheet line as Received (and onto a
// physical count already made that day, so the count still holds), the
// product's stock follows, a movement is kept (inventory_tx
// 'work_order_output', referenced by the WO number), and the people chosen
// on the stock sheet page (settings.stock_sheet.textIds — the stores team's
// Hayford to begin with) get a text and a notification. Reopening a
// completed work order takes the same back off the day it went on, and
// the days after it until the next count, and they are told so.

function todayISO() { return new Date().toISOString().slice(0, 10); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function isUuid(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')); }
function qtyText(n) { return String(round2(n)).replace(/\.0+$/, ''); }

// ── picking the items ──────────────────────────────────────────────────

// The items a work order may make: the stock sheet's products, in its order.
async function products() {
  return (await pool.query(
    'SELECT id, sku, name, category, unit, current_stock, photo_key, photo_updated_at FROM products WHERE active ORDER BY sheet_order NULLS LAST, sku'
  )).rows.map(function (p) {
    return {
      id: p.id, sku: p.sku, name: p.name, category: p.category || '', unit: p.unit || '', stock: Number(p.current_stock),
      photo: p.photo_key && p.photo_updated_at ? new Date(p.photo_updated_at).getTime() : null
    };
  });
}

// The items given with a work order, checked: [{ productId, qty }], each
// product once, a quantity over 0. `given` undefined = not given (leave as is).
async function readItems(given) {
  if (given === undefined || given === null) return null;
  if (!Array.isArray(given)) fail('invalid', 'Choose the stock sheet items again.');
  if (given.length > 50) fail('invalid', 'At most 50 items on one work order.');
  var seen = {}, out = [];
  for (var i = 0; i < given.length; i++) {
    var g = given[i] || {};
    if (!isUuid(g.productId)) fail('invalid', 'One of the stock sheet items was not found.');
    var qty = Number(g.qty);
    if (!isFinite(qty) || qty <= 0 || qty > 1e6) fail('invalid', 'Say how many of each stock sheet item the work order makes (more than 0).');
    if (seen[g.productId]) fail('invalid', 'An item is chosen twice: put the whole quantity on one line.');
    seen[g.productId] = true;
    out.push({ productId: g.productId, qty: round2(qty) });
  }
  if (out.length) {
    var found = (await pool.query('SELECT id, name, active FROM products WHERE id = ANY($1)', [out.map(function (x) { return x.productId; })])).rows;
    if (found.length !== out.length) fail('invalid', 'One of the stock sheet items was not found.');
  }
  return out;
}

// Puts a work order's items in place of what it had (create and edit). Not
// once they are on the stock sheet: it has to be reopened first.
async function setItems(client, taskId, items) {
  if (items === null) return;
  var added = (await client.query('SELECT 1 FROM task_stock_items WHERE task_id = $1 AND added_on IS NOT NULL LIMIT 1', [taskId])).rows[0];
  if (added) {
    var now = (await client.query('SELECT product_id, qty FROM task_stock_items WHERE task_id = $1 ORDER BY product_id', [taskId])).rows;
    var same = now.length === items.length && items.slice().sort(function (a, b) { return a.productId < b.productId ? -1 : 1; })
      .every(function (x, i) { return x.productId === now[i].product_id && round2(x.qty) === round2(now[i].qty); });
    if (same) return;
    fail('conflict', 'These items are already on the stock sheet. Reopen the work order first to change them.');
  }
  await client.query('DELETE FROM task_stock_items WHERE task_id = $1', [taskId]);
  for (var i = 0; i < items.length; i++) {
    await client.query('INSERT INTO task_stock_items (task_id, product_id, qty) VALUES ($1, $2, $3)', [taskId, items[i].productId, items[i].qty]);
  }
}

// ── onto the stock sheet, and back off ─────────────────────────────────

var FG_WAREHOUSE = "(SELECT id FROM warehouses WHERE code = 'WH-FG' LIMIT 1)";

// On completion: every item not yet on the sheet goes onto today's line.
// Returns what went on, for the text: [{ name, unit, qty }].
async function addToSheet(client, ctx, task) {
  var items = (await client.query(
    'SELECT si.product_id, si.qty, p.name, p.unit FROM task_stock_items si JOIN products p ON p.id = si.product_id ' +
    'WHERE si.task_id = $1 AND si.added_on IS NULL ORDER BY p.sheet_order NULLS LAST, p.sku', [task.id])).rows;
  if (!items.length) return [];
  var date = todayISO(), ref = task.number;
  var dayLine = require('./inventorySales.service').dayLine;
  for (var i = 0; i < items.length; i++) {
    var it = items[i], qty = Number(it.qty);
    // One change to a product's line at a time (as invoices do).
    await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
    var line = await dayLine(client, it.product_id, date);
    line.received = round2(line.received + qty);
    if (line.physical !== null) line.physical = round2(line.physical + qty);
    line.note = noteWith(line.note, ref + ' +' + qtyText(qty));
    await stockSheet.writeLine(client, ctx, date, it.product_id, line);
    await client.query(
      "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference, notes) VALUES ('product', $1, " + FG_WAREHOUSE + ", 'work_order_output', $2, $3, $4, $5, $6)",
      [it.product_id, qty, date, ctx.employee ? ctx.employee.id : null, ref, 'Work order ' + ref + ' completed: ' + task.title]);
    await client.query('UPDATE task_stock_items SET added_on = $3, added_qty = $4 WHERE task_id = $1 AND product_id = $2', [task.id, it.product_id, date, qty]);
  }
  await audit(client, ctx, 'stock.work_order', 'task', task.id, ref + ' completed: put on the stock sheet for ' + date + ': ' + listText(items) + '.');
  return items.map(function (x) { return { name: x.name, unit: x.unit, qty: Number(x.qty) }; });
}

// On reopening a completed work order: what it put on comes back off the
// day it went on. The days after that open lower too, up to and including
// the next day with a physical count (whose closing is the count itself);
// the product's stock follows its latest day.
async function takeOffSheet(client, ctx, task) {
  var items = (await client.query(
    'SELECT si.product_id, si.added_on::text AS added_on, si.added_qty, p.name, p.unit FROM task_stock_items si JOIN products p ON p.id = si.product_id ' +
    'WHERE si.task_id = $1 AND si.added_on IS NOT NULL ORDER BY p.sheet_order NULLS LAST, p.sku', [task.id])).rows;
  if (!items.length) return [];
  var ref = task.number;
  for (var i = 0; i < items.length; i++) {
    var it = items[i], qty = Number(it.added_qty);
    await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [it.product_id]);
    var saved = (await client.query('SELECT * FROM stock_sheet_lines WHERE product_id = $1 AND date = $2', [it.product_id, it.added_on])).rows[0];
    if (saved) {
      var line = stockSheet.lineFromRow(saved);
      line.received = Math.max(0, round2(line.received - qty));
      if (line.physical !== null) line.physical = Math.max(0, round2(line.physical - qty));
      line.note = noteWith(saved.note || '', ref + ' reopened −' + qtyText(qty));
      await stockSheet.writeLine(client, ctx, it.added_on, it.product_id, line);
      if (line.physical === null) {
        var later = (await client.query('SELECT date::text AS date, physical FROM stock_sheet_lines WHERE product_id = $1 AND date > $2 ORDER BY date', [it.product_id, it.added_on])).rows;
        for (var j = 0; j < later.length; j++) {
          await client.query('UPDATE stock_sheet_lines SET opening = greatest(0, opening - $3) WHERE product_id = $1 AND date = $2', [it.product_id, later[j].date, qty]);
          if (later[j].physical !== null) break;
        }
        var last = (await client.query('SELECT * FROM stock_sheet_lines WHERE product_id = $1 ORDER BY date DESC LIMIT 1', [it.product_id])).rows[0];
        if (last) await client.query('UPDATE products SET current_stock = $2 WHERE id = $1', [it.product_id, Math.max(0, stockSheet.lineFromRow(last).closing)]);
      }
    } else {
      await client.query('UPDATE products SET current_stock = greatest(0, current_stock - $2) WHERE id = $1', [it.product_id, qty]);
    }
    await client.query(
      "INSERT INTO inventory_tx (item_type, item_id, warehouse_id, type, qty, date, user_id, reference, notes) VALUES ('product', $1, " + FG_WAREHOUSE + ", 'work_order_output', $2, $3, $4, $5, $6)",
      [it.product_id, -qty, todayISO(), ctx.employee ? ctx.employee.id : null, ref, 'Work order ' + ref + ' reopened: taken back off the stock sheet of ' + it.added_on]);
    await client.query('UPDATE task_stock_items SET added_on = NULL, added_qty = NULL WHERE task_id = $1 AND product_id = $2', [task.id, it.product_id]);
  }
  await audit(client, ctx, 'stock.work_order', 'task', task.id, ref + ' reopened: taken back off the stock sheet: ' +
    items.map(function (x) { return qtyText(x.added_qty) + ' × ' + x.name + ' (' + x.added_on + ')'; }).join(', ') + '.');
  return items.map(function (x) { return { name: x.name, unit: x.unit, qty: Number(x.added_qty) }; });
}

function noteWith(note, bit) {
  var n = String(note || '').trim();
  return ((n ? n + '; ' : '') + bit).slice(0, 300);
}
function listText(items) {
  return items.map(function (x) { return qtyText(x.qty) + ' × ' + x.name; }).join(', ');
}

// ── who is told ────────────────────────────────────────────────────────

async function textIds(db) {
  var r = (await (db || pool).query('SELECT stock_sheet FROM settings WHERE id = 1')).rows[0];
  var ids = r && r.stock_sheet && Array.isArray(r.stock_sheet.textIds) ? r.stock_sheet.textIds : [];
  return ids.filter(isUuid);
}

// The bell, inside the work order's transaction.
async function notifyTold(client, ctx, task, items, kind) {
  var ids = await textIds(client);
  var title = kind === 'added' ? 'Stock sheet: ' + task.number + ' completed' : 'Stock sheet: ' + task.number + ' reopened';
  var body = (kind === 'added' ? 'Added to today\'s stock sheet: ' : 'Taken back off the stock sheet: ') + listText(items) + '.';
  for (var i = 0; i < ids.length; i++) {
    if (ctx.employee && ids[i] === ctx.employee.id) continue;
    await notify(client, ids[i], title, body, 'tasks:' + task.id);
  }
}

// The text, after the work order's change is saved: a text that can't go
// never undoes it. Says what happened, for the screen: { sent, noPhone,
// failed, off, nobody }.
async function textTold(ctx, task, items, kind) {
  var out = { sent: 0, noPhone: 0, failed: 0, off: false, nobody: false, to: [] };
  if (!items.length) return out;
  var ids = await textIds();
  if (!ids.length) { out.nobody = true; return out; }
  if (!sms.configured()) { out.off = true; return out; }
  var who = ctx.employee ? (ctx.employee.first_name || '').trim() : '';
  var message = kind === 'added'
    ? 'Bamboo OS: ' + task.number + ' completed' + (who ? ' by ' + who : '') + '. Added to today\'s stock sheet: ' + listText(items) + '.'
    : 'Bamboo OS: ' + task.number + ' was reopened' + (who ? ' by ' + who : '') + '. Taken back off the stock sheet: ' + listText(items) + '.';
  var people = (await pool.query("SELECT id, first_name, last_name, phone FROM employees WHERE id = ANY($1) AND status = 'active' ORDER BY first_name", [ids])).rows;
  for (var i = 0; i < people.length; i++) {
    var e = people[i];
    if (!sms.smsNumber(e.phone)) { out.noPhone++; continue; }
    if ((await sms.autoSentToday()) >= sms.AUTO_DAILY_LIMIT) { out.failed++; continue; }
    try {
      var r = await sms.send({ to: e.phone, message: message, purpose: 'auto_stock_sheet', refId: task.id, sentBy: ctx.employee ? ctx.employee.id : null });
      if (r && r.skipped) out.failed++; else { out.sent++; out.to.push(e.first_name + ' ' + e.last_name); }
    } catch (err) {
      console.error('Stock sheet text not sent:', err.message);
      out.failed++;
    }
  }
  return out;
}

// ── the stock sheet page's setting ─────────────────────────────────────

// GET /api/stock-sheet/texts — who is texted, with their phones' state.
async function getTexts(ctx) {
  if (!ctx.can('inventory.read')) fail('forbidden', 'Your role does not allow this action (inventory.read).');
  var ids = await textIds();
  var people = ids.length ? (await pool.query(
    "SELECT id, first_name, last_name, phone, position_title, status FROM employees WHERE id = ANY($1) ORDER BY first_name", [ids])).rows : [];
  return {
    people: people.map(function (e) {
      return { id: e.id, name: e.first_name + ' ' + e.last_name, position: e.position_title || '', hasPhone: !!sms.smsNumber(e.phone), active: e.status === 'active' };
    }),
    smsReady: sms.configured(),
    canManage: ctx.can('inventory.manage')
  };
}

// PUT /api/stock-sheet/texts { employeeIds } — inventory.manage.
async function setTexts(ctx, body) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
  var ids = Array.isArray(body && body.employeeIds) ? body.employeeIds.filter(isUuid) : null;
  if (!ids) fail('invalid', 'Choose who gets the texts.');
  ids = Array.from(new Set(ids)).slice(0, 10);
  if (ids.length) {
    var found = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1)', [ids])).rows;
    if (found.length !== ids.length) fail('invalid', 'Someone chosen is not on the staff list.');
  }
  await pool.query("UPDATE settings SET stock_sheet = coalesce(stock_sheet, '{}'::jsonb) || jsonb_build_object('textIds', $1::jsonb) WHERE id = 1", [JSON.stringify(ids)]);
  var names = ids.length ? (await pool.query('SELECT first_name, last_name FROM employees WHERE id = ANY($1) ORDER BY first_name', [ids])).rows.map(function (e) { return e.first_name + ' ' + e.last_name; }) : [];
  await audit(pool, ctx, 'stock.texts', 'settings', 'stock_sheet', names.length ? 'Work orders that add to the stock sheet now text ' + names.join(', ') + '.' : 'Work orders that add to the stock sheet text nobody now.');
  return getTexts(ctx);
}

module.exports = {
  products: products, readItems: readItems, setItems: setItems, addToSheet: addToSheet, takeOffSheet: takeOffSheet,
  notifyTold: notifyTold, textTold: textTold, getTexts: getTexts, setTexts: setTexts, textIds: textIds
};
