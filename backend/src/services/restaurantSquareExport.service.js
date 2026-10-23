var ExcelJS = require('exceljs');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// What the till downloads, in Square's own layouts (migration 0174), so a
// sheet or a habit built on Square's downloads keeps working:
//
//   The item library — Square's catalog download (an .xlsx): the sheet
//   "Items" (a blank first row, then one row per dish, or per size of a dish
//   with sizes, with columns per location: enabled, stock, stock alert,
//   price; and one Y/N column per modifier set), "Unit and Precision" and
//   "Component Inventory", headed as Square heads them.
//
//   The item sales — Square's "Items" sales download (a .csv: UTF-16 with a
//   byte-order mark, tab-separated, empty text written ""): one row per
//   dish sold (Payment) or given back (Refund, minus), newest first, with
//   the 29 columns Square writes, money as ₵1,234.56.
//
// The sales on the books brought in from Square keep their Square
// transaction id; the till's own carry the sale's number. Times are UTC
// (Ghana's).

var CATALOG_HEAD = ['Reference Handle', 'Token', 'Item Name', 'Customer-facing Name', 'Variation Name', 'Unit and Precision', 'SKU', 'Description', 'Categories',
  'Reporting Category', 'GTIN', 'Item Type', 'Weight (kg)', 'Social Media Link Title', 'Social Media Link Description', 'Price', 'Online Sale Price', 'Archived',
  'Sellable', 'Contains Alcohol', 'Stockable', 'Skip Detail Screen in POS', 'Preselect First Variation', 'Option Name 1', 'Option Value 1', 'Option Name 2',
  'Option Value 2', 'Option Name 3', 'Option Value 3'];
var PER_LOCATION = ['Enabled', 'Current Quantity', 'New Quantity', 'Stock Alert Enabled', 'Stock Alert Count', 'Price'];
var SALES_HEAD = ['Date', 'Time', 'Time Zone', 'Category', 'Item', 'Qty', 'Price Point Name', 'SKU', 'Modifiers Applied', 'Gross Sales', 'Discounts', 'Net Sales', 'Tax',
  'Transaction ID', 'Payment ID', 'Device Name', 'Notes', 'Details', 'Event Type', 'Location', 'Dining Option', 'Unit', 'Count', 'Itemization Type',
  'Fulfillment Note', 'Channel', 'Token', 'Card Brand', 'PAN Suffix'];
var DINING = { dine_in: 'For Here', pickup: 'To Go', delivery: 'Delivery' };
// The item library's item types as the sales download writes them.
var SALES_TYPE = { 'Physical good': 'Physical Good', 'Prepared food and beverage': 'Prepared Food and Beverage', Service: 'Service', Digital: 'Digital', Event: 'Event', Donation: 'Donation', Membership: 'Membership' };
var DAY = /^\d{4}-\d{2}-\d{2}$/;

function round2(n) { return Math.round(Number(n) * 100) / 100; }
// A restaurant as Square names its location: its name without "Restaurant".
function locationName(name) { return String(name || '').replace(/\s+restaurant$/i, '').trim() || String(name || ''); }
function slug(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9㐀-鿿]+/g, '-').replace(/^-+|-+$/g, ''); }
function yn(b) { return b ? 'Y' : 'N'; }
function ced(n) {
  var v = round2(n);
  var s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-₵' : '₵') + s;
}
function fileDay(d) { return d.toISOString().slice(0, 10); }

async function companiesOf(companyIds) {
  var rows = (await pool.query('SELECT id, code, name FROM companies WHERE id = ANY($1::uuid[]) ORDER BY name', [companyIds])).rows;
  if (!rows.length) fail('notfound', 'That restaurant was not found.');
  return rows;
}

// ── the item library ───────────────────────────────────────────────────

// The rows of the "Items" sheet: [header, ...rows], for one restaurant or several (each its own location).
async function catalogRows(companyIds) {
  var cos = await companiesOf(companyIds);
  var items = (await pool.query('SELECT * FROM restaurant_menu_items WHERE company_id = ANY($1::uuid[]) ORDER BY category, name', [companyIds])).rows;
  var vars = items.length ? (await pool.query('SELECT * FROM restaurant_menu_item_variations WHERE menu_item_id = ANY($1::uuid[]) ORDER BY sort_order, created_at', [items.map(function (i) { return i.id; })])).rows : [];
  var groups = (await pool.query('SELECT id, company_id, name FROM restaurant_modifier_groups WHERE company_id = ANY($1::uuid[]) AND active ORDER BY name', [companyIds])).rows;
  var links = items.length ? (await pool.query('SELECT menu_item_id, group_id FROM restaurant_menu_item_modifier_groups WHERE menu_item_id = ANY($1::uuid[])', [items.map(function (i) { return i.id; })])).rows : [];
  var setNames = Array.from(new Set(groups.map(function (g) { return g.name; }))).sort();
  var head = CATALOG_HEAD.slice();
  cos.forEach(function (c) { PER_LOCATION.forEach(function (k) { head.push(k + ' ' + locationName(c.name)); }); });
  setNames.forEach(function (n) { head.push('Modifier Set - ' + n); });
  var out = [head];
  items.forEach(function (it) {
    var sizes = vars.filter(function (v) { return v.menu_item_id === it.id; });
    var mySets = links.filter(function (l) { return l.menu_item_id === it.id; }).map(function (l) { var g = groups.find(function (x) { return x.id === l.group_id; }); return g ? g.name : null; });
    var lines = sizes.length ? sizes.map(function (v) { return { name: v.name, price: Number(v.price), sku: v.sku || '', token: v.external_id || v.id }; })
      : [{ name: 'Regular', price: Number(it.price), sku: it.sku || '', token: it.external_id || it.id }];
    lines.forEach(function (v) {
      var row = [
        '#' + slug(it.name) + (sizes.length ? '-' + slug(v.name) : ''), v.token, it.name, it.customer_name || '', v.name, '', v.sku, it.description || '', it.category || '',
        it.category || '', '', it.item_type || 'Physical good', '', '', '', v.price > 0 ? v.price : 'variable', '', 'N',
        '', it.contains_alcohol == null ? '' : yn(it.contains_alcohol), it.track_stock ? 'Y' : '', yn(!sizes.length && !mySets.length), sizes.length ? 'N' : 'Y', '', '', '', '', '', ''
      ];
      cos.forEach(function (c) {
        var here = c.id === it.company_id;
        row.push(yn(here && it.active), here && it.track_stock ? Number(it.stock_qty) : '', '', here && Number(it.low_stock) > 0 ? 'Y' : '', here && Number(it.low_stock) > 0 ? Number(it.low_stock) : '', '');
      });
      setNames.forEach(function (n) { row.push(yn(mySets.indexOf(n) >= 0)); });
      out.push(row);
    });
  });
  return out;
}

// The item library as Square's .xlsx: { filename, mime, data (base64) }.
async function catalogFile(companyIds) {
  var cos = await companiesOf(companyIds);
  var rows = await catalogRows(companyIds);
  var wb = new ExcelJS.Workbook();
  var items = wb.addWorksheet('Items');
  items.addRow([]);
  rows.forEach(function (r) { items.addRow(r); });
  items.columns.forEach(function (c) { c.width = 18; });
  var units = wb.addWorksheet('Unit and Precision');
  units.addRow([]);
  units.addRow(['Unit and Precision', 'Units cannot be created via import. You can create new units in Items > Units on Dashboard.']);
  var comp = wb.addWorksheet('Component Inventory');
  comp.addRow([]);
  comp.addRow(['Token\n(locked)', 'Item Name\n(locked)', 'Variation Name\n(locked)', 'Unit and Precision\n(locked)', 'SKU\n(locked)', 'Reference Handle', 'Stock-by Reference Handle', 'Sell-by Equivalent', 'Stock-by Equivalent']);
  var buf = await wb.xlsx.writeBuffer();
  var stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  return { filename: cos.map(function (c) { return c.code; }).join('-') + '_catalog-' + stamp.slice(0, 4) + '-' + stamp.slice(4, 6) + '-' + stamp.slice(6, 8) + '-' + stamp.slice(9, 13) + '.xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: Buffer.from(buf).toString('base64'), rows: rows.length - 1 };
}

// ── the item sales ─────────────────────────────────────────────────────

function rangeOf(q) {
  q = q || {};
  var today = new Date().toISOString().slice(0, 10);
  var from = DAY.test(q.from || '') ? q.from : today.slice(0, 8) + '01';
  var to = DAY.test(q.to || '') ? q.to : today;
  if (from > to) { var x = from; from = to; to = x; }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) fail('invalid', 'Download at most a year at a time.');
  return { from: from, to: to };
}

// The rows of the sales download: [header, ...rows], newest first.
async function itemSalesRows(companyIds, q) {
  var d = rangeOf(q);
  var cos = await companiesOf(companyIds);
  var where = "o.company_id = ANY($1::uuid[]) AND o.status = 'completed' AND o.created_at >= $2::date AND o.created_at < $3::date + 1";
  var sold = (await pool.query(
    "SELECT i.*, o.id AS order_id, o.order_no, o.created_at AS at, o.fulfillment, o.subtotal, o.tax_total, o.adjustments, o.external_id AS sq_id, o.source, o.source_name, o.receipt_token, o.company_id, " +
    "  o.delivery_address, c.name AS company_name, c.code AS company_code, m.category, m.sku AS item_sku, m.item_type, m.external_id AS item_token, m.name AS menu_name, " +
    "  v.name AS size_name, v.sku AS size_sku, v.external_id AS size_token, e.first_name AS cashier_first, " +
    '  (SELECT p.id FROM restaurant_order_payments p WHERE p.order_id = o.id ORDER BY p.sort_order LIMIT 1) AS payment_id, ' +
    '  (SELECT count(*) FROM restaurant_online_orders w WHERE w.order_id = o.id) AS from_web ' +
    'FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id JOIN companies c ON c.id = o.company_id ' +
    'LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id LEFT JOIN restaurant_menu_item_variations v ON v.id = i.variation_id LEFT JOIN employees e ON e.id = o.cashier_id ' +
    'WHERE ' + where + ' ORDER BY o.created_at DESC, i.sort_order', [companyIds, d.from, d.to])).rows;
  var back = (await pool.query(
    "SELECT ri.qty AS back_qty, ri.amount AS back_amount, r.created_at AS at, r.id AS refund_id, i.*, o.id AS order_id, o.order_no, o.fulfillment, o.subtotal, o.tax_total, o.adjustments, " +
    '  o.external_id AS sq_id, o.source, o.source_name, o.receipt_token, o.company_id, c.name AS company_name, c.code AS company_code, m.category, m.sku AS item_sku, m.item_type, ' +
    '  m.external_id AS item_token, m.name AS menu_name, v.name AS size_name, v.sku AS size_sku, v.external_id AS size_token, e.first_name AS cashier_first, 0 AS from_web ' +
    'FROM restaurant_refund_items ri JOIN restaurant_refunds r ON r.id = ri.refund_id JOIN restaurant_order_items i ON i.id = ri.order_item_id JOIN restaurant_orders o ON o.id = r.order_id ' +
    'JOIN companies c ON c.id = o.company_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id LEFT JOIN restaurant_menu_item_variations v ON v.id = i.variation_id ' +
    'LEFT JOIN employees e ON e.id = r.cashier_id WHERE r.company_id = ANY($1::uuid[]) AND r.created_at >= $2::date AND r.created_at < $3::date + 1', [companyIds, d.from, d.to])).rows;
  var siteUrl = require('./restaurantOnline.service').siteUrlFor;
  function row(r, refund) {
    var at = new Date(r.at);
    var itemName = r.menu_name || String(r.name || '').split(' — ')[0];
    var size = r.size_name || (r.custom ? '' : 'Regular');
    var qty = refund ? -Number(r.back_qty) : Number(r.qty);
    var share = Number(r.qty) > 0 ? qty / Number(r.qty) : 0;
    var gross = round2(Number(r.gross != null ? r.gross : r.line_total) * share);
    var net = round2(Number(r.line_total) * share);
    var disc = refund ? round2(net - gross) : -round2(Number(r.discount || 0));
    // Its share of the bill's taxes: those added on top, or those included in the prices.
    var taxBase = Number(r.subtotal) > 0 ? Number(r.line_total) / Number(r.subtotal) : 0;
    var taxAll = Number(r.tax_total || 0) + Number((r.adjustments && r.adjustments.taxIncluded) || 0);
    var tax = round2(taxAll * taxBase * share);
    var mods = (r.modifiers || []).map(function (m) { return (m.how && m.how !== 'add' ? m.how + ' ' : '') + m.name; }).join(', ');
    var loc = locationName(r.company_name);
    var square = r.source === 'square';
    return [
      at.toISOString().slice(0, 10), at.toISOString().slice(11, 19), 'UTC', r.category || (r.custom ? '' : 'Uncategorized'), itemName, qty.toFixed(1), size,
      r.size_sku || r.item_sku || '', mods, ced(gross), ced(disc), ced(net), ced(tax),
      square ? r.sq_id || r.order_no : r.order_no, refund ? r.refund_id : (r.payment_id || r.order_id), square ? (r.source_name || '') : 'Till' + (r.cashier_first ? ' (' + r.cashier_first + ')' : ''),
      r.note || '', r.receipt_token ? siteUrl(r.company_code) + '/receipt/' + r.receipt_token : '', refund ? 'Refund' : 'Payment', loc,
      Number(r.from_web) > 0 && r.fulfillment === 'pickup' ? 'Pickup' : DINING[r.fulfillment] || '', 'ea', String(Math.round(qty)),
      r.custom ? '' : SALES_TYPE[r.item_type] || 'Physical Good', '', square ? (r.source_name || loc) : Number(r.from_web) > 0 ? loc + ' Online' : loc,
      r.size_token || r.item_token || (r.menu_item_id || ''), '', ''
    ];
  }
  var all = sold.map(function (r) { return { at: r.at, row: row(r, false) }; }).concat(back.map(function (r) { return { at: r.at, row: row(r, true) }; }));
  all.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  return { range: d, companies: cos, rows: [SALES_HEAD].concat(all.map(function (x) { return x.row; })) };
}

// One field as Square writes it: empty as "", quoted only when it must be.
function field(v) {
  var s = v == null ? '' : String(v);
  if (s === '') return '""';
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// The item sales as Square's .csv (UTF-16LE with its byte-order mark, tabs): { filename, mime, data (base64) }.
async function itemSalesFile(companyIds, q) {
  var x = await itemSalesRows(companyIds, q);
  var text = x.rows.map(function (r, i) { return i === 0 ? r.join('\t') : r.map(field).join('\t'); }).join('\n') + '\n';
  var buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  // Square names it items-<from>-<the day after to>.csv.
  var end = new Date(Date.parse(x.range.to) + 86400000);
  return { filename: (x.companies.length === 1 ? x.companies[0].code + '-' : '') + 'items-' + x.range.from + '-' + fileDay(end) + '.csv', mime: 'text/csv', data: buf.toString('base64'), rows: x.rows.length - 1 };
}

module.exports = { catalogRows: catalogRows, catalogFile: catalogFile, itemSalesRows: itemSalesRows, itemSalesFile: itemSalesFile, CATALOG_HEAD: CATALOG_HEAD, SALES_HEAD: SALES_HEAD, locationName: locationName };
