var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var access = require('./restaurantTillAccess.service');
var activity = require('./restaurantActivity.service');

// Paying at the table (migration 0178; Square's "Scan to pay", but with
// splitting): a guest scans the table's QR code — on the table, or on the
// bill the till prints — and pays the bill, or their share of it, with a
// tip, by card or Mobile Money through Paystack (when the server has its
// key and the restaurant turned it on: till settings tablePay). What is
// paid waits on the table's open order; the till closes the order with it
// (restaurantPos tabRows paidAtTable → the pay screen), the rest of the
// bill taken as usual. Several guests can each pay their part.

var MIN_PART = 1;
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function clean(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function pos() { return require('./restaurantPos.service'); }
function paystack() { return require('./restaurantPaystack.service'); }
function tables() { return require('./restaurantTableOrders.service'); }
function kiosk() { return require('./restaurantKiosk.service'); }

function onFor(settings) { return !!(settings.tablePay && settings.tablePay.on) && paystack().configured(); }

// What has been paid toward an open order from the table, not used by a sale yet.
async function paidFor(db, tabId) {
  return (await db.query(
    "SELECT * FROM restaurant_paystack_payments WHERE tab_id = $1 AND purpose = 'table' AND status = 'success' AND used_by_order IS NULL ORDER BY paid_at", [tabId])).rows;
}
function paymentOut(r) {
  return { reference: r.reference, amount: round2(r.amount), tip: round2(r.tip), bill: round2(r.amount - r.tip), payer: r.payer || '', channel: r.channel || '',
    cardBrand: r.card_brand || null, cardLast4: r.card_last4 || null, paidAt: r.paid_at };
}

// GET /api/pos/table/:code/pay — the table's bill as it stands: what has
// been paid at the table, what is left, the tips to tap.
async function info(code) {
  var t = await tables().tableOf(code);
  var on = onFor(t.settings);
  var tab = (await pos().tabRows(t.company_id, ' AND t.table_id = $2', [t.id]))[0];
  var base = { on: on, restaurant: { code: t.company_code, name: t.company_name }, table: { name: t.name }, tips: t.settings.tips.on ? t.settings.tips.percents : [] };
  if (!tab) return Object.assign(base, { open: false, total: 0, paid: 0, left: 0, items: [], payments: [] });
  var paid = (await paidFor(pool, tab.id)).map(paymentOut);
  var paidBill = round2(paid.reduce(function (a, p) { return a + p.bill; }, 0));
  return Object.assign(base, {
    open: true, total: round2(tab.total), paid: paidBill, left: Math.max(0, round2(tab.total - paidBill)),
    items: tab.lines.map(function (l) { return { name: l.name, qty: l.qty, lineTotal: l.lineTotal }; }),
    serviceCharge: tab.bill ? tab.bill.serviceCharge : 0, serviceName: tab.bill ? tab.bill.serviceName : null, taxes: tab.bill ? tab.bill.taxes : [],
    payments: paid.map(function (p) { return { amount: p.bill, tip: p.tip, payer: p.payer ? p.payer.split(' ')[0] : '', paidAt: p.paidAt }; })
  });
}

// POST /api/pos/table/:code/pay { amount, tip, name, back } — a part of the
// bill (all that is left, a share, or an amount) and a tip: Paystack's page
// to pay on, back to the table's page after.
async function start(code, p, ip) {
  p = p || {};
  var t = await tables().tableOf(code);
  if (!onFor(t.settings)) fail('conflict', 'Paying from the table is not on here. Ask for the bill.');
  var tab = (await pos().tabRows(t.company_id, ' AND t.table_id = $2', [t.id]))[0];
  if (!tab) fail('conflict', 'There is no bill for this table yet.');
  var paid = round2((await paidFor(pool, tab.id)).reduce(function (a, r) { return a + Number(r.amount) - Number(r.tip); }, 0));
  var left = round2(tab.total - paid);
  if (!(left >= 0.01)) fail('conflict', 'This bill is paid already. Thank you!');
  var amount = round2(p.amount);
  if (!(amount >= Math.min(MIN_PART, left))) fail('invalid', 'Pay at least GHS ' + MIN_PART.toFixed(2) + '.');
  if (amount > left + 0.009) fail('invalid', 'That is more than is left to pay (' + left.toFixed(2) + ').');
  var tip = round2(p.tip || 0);
  if (tip < 0 || (tip > 0 && !t.settings.tips.on)) fail('invalid', 'Tips are not taken here.');
  if (tip > Math.max(amount, 50)) fail('invalid', 'A tip is at most the amount you pay.');
  tables().throttle(ip);
  var pay = await paystack().begin(t.company_id, round2(amount + tip), 'table', null, null, kiosk().backUrl(p.back) || require('./restaurantOnline.service').siteUrlFor(t.company_code) + '/q/' + code, { tabId: tab.id, tip: tip, payer: clean(p.name, 60) });
  await activity.log(pool, { companyId: t.company_id, employeeId: null, app: 'table', action: 'table.pay_started',
    summary: t.name + ': a guest' + (p.name ? ' (' + clean(p.name, 60) + ')' : '') + ' is paying ' + amount.toFixed(2) + (tip ? ' and a tip of ' + tip.toFixed(2) : '') + ' from the table.',
    amount: amount, refType: 'tab', refId: tab.id });
  return { reference: pay.reference, url: pay.url };
}

// GET /api/pos/table/:code/pay/:reference — after Paystack: paid or not, and the bill now.
async function status(code, reference) {
  var t = await tables().tableOf(code);
  var row = (await pool.query("SELECT * FROM restaurant_paystack_payments WHERE reference = $1 AND company_id = $2 AND purpose = 'table'", [String(reference || ''), t.company_id])).rows[0];
  if (!row) fail('notfound', 'That payment is not this table\'s.');
  var before = row.status;
  row = await paystack().check(row, true);
  if (row.status === 'success' && before !== 'success') {
    await activity.log(pool, { companyId: t.company_id, employeeId: null, app: 'table', action: 'table.paid',
      summary: t.name + ': paid ' + round2(row.amount - row.tip).toFixed(2) + (Number(row.tip) ? ' and a tip of ' + round2(row.tip).toFixed(2) : '') + ' from the table (' + (row.channel === 'mobile_money' ? 'Mobile Money' : 'card') + ').',
      amount: round2(row.amount), refType: 'tab', refId: row.tab_id });
  }
  return { payment: { status: row.status, amount: round2(row.amount - row.tip), tip: round2(row.tip), channel: row.channel || '' }, bill: await info(code) };
}

// GET /api/pos/table-pay/link?tabId= — the till: the table's page to pay on
// (for the printed bill's QR code and the bill shown on the till).
async function link(token, tabId) {
  var session = await access.need(token, 'till');
  var r = (await pool.query('SELECT t.qr_token, t.name FROM restaurant_open_tabs o JOIN restaurant_tables t ON t.id = o.table_id WHERE o.id = $1 AND o.company_id = $2', [String(tabId || ''), session.posCompanyId])).rows[0];
  if (!r) fail('notfound', 'Only a table\'s open order has a page to pay on.');
  var code = (await pool.query('SELECT code FROM companies WHERE id = $1', [session.posCompanyId])).rows[0].code;
  return { url: require('./restaurantOnline.service').siteUrlFor(code) + '/q/' + r.qr_token + '?pay=1', table: r.name, on: onFor(session.access.settings) };
}

module.exports = { onFor: onFor, paidFor: paidFor, paymentOut: paymentOut, info: info, start: start, status: status, link: link };
