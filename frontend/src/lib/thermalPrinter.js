import { tr, msg } from './i18n.jsx';

// What this file PRINTS stays in English, whatever language the till's
// screen is in: text is sent as one Latin-1 byte per character (see
// textBytes), so Chinese would come out as garbage and French accents
// depend on the printer's code page. Receipts are also customer documents
// (see docTr in i18n.jsx). Only the messages shown on screen — a browser
// that cannot reach a printer — follow the reader, with tr().
// Restaurant module, Phase 3: direct ESC/POS thermal-printer output for
// the POS receipt, over WebUSB or WebBluetooth — no driver, no OS print
// dialog, straight bytes to the printer. This is a real, deliberate
// hardware constraint, not an oversight: WebUSB and WebBluetooth are
// Chromium-only APIs (Chrome/Edge/Android Chrome/desktop) — Safari never
// implements either on any platform, and every browser on iOS/iPadOS is
// required to use Safari's WebKit engine underneath regardless of its
// name, so neither works on an iPad in any browser. If the till runs on
// the same iPads as the clock-in kiosk, this feature is simply inert
// there — RestaurantPosPage.jsx's existing window.print() button (works
// through the OS print dialog with any printer already set up on the
// device) is the fallback for that case, not replaced by this.
//
// ESC/POS itself has no single owner, but the command set Epson
// originated is the de facto standard nearly every thermal printer
// (including generic/no-name 58mm/80mm printers common outside the big
// brands) implements a compatible subset of — the commands below stick to
// that common baseline (init, alignment, bold, cut, cash-drawer kick)
// rather than any vendor-specific extension.

var ESC = 0x1B;
var GS = 0x1D;

function bytes() {
  return Array.prototype.concat.apply([], arguments);
}
function textBytes(s) {
  // Plain Latin-1/ASCII bytes — most thermal printers' default codepage
  // doesn't reliably render UTF-8 multi-byte sequences, and nothing this
  // receipt prints (names, GHS amounts) needs anything outside that range.
  var out = [];
  var str = String(s == null ? '' : s);
  for (var i = 0; i < str.length; i++) out.push(str.charCodeAt(i) & 0xff);
  return out;
}
function line(s) { return bytes(textBytes(s), [0x0a]); }

var ALIGN_LEFT = bytes([ESC, 0x61, 0]);
var ALIGN_CENTER = bytes([ESC, 0x61, 1]);
var BOLD_ON = bytes([ESC, 0x45, 1]);
var BOLD_OFF = bytes([ESC, 0x45, 0]);
var DOUBLE_ON = bytes([GS, 0x21, 0x11]); // double height + width
var DOUBLE_OFF = bytes([GS, 0x21, 0x00]);
var INIT = bytes([ESC, 0x40]);
var CUT = bytes([GS, 0x56, 65, 0]); // full cut, Epson-compatible
var FEED = function (n) { return bytes([ESC, 0x64, n]); };
var CASH_DRAWER_KICK = bytes([ESC, 0x70, 0x00, 0x19, 0xfa]);

var LINE_WIDTH_58MM = 32; // characters per line on a 58mm printer, standard font
function twoColumn(left, right, width) {
  width = width || LINE_WIDTH_58MM;
  var l = String(left), r = String(right);
  var gap = Math.max(1, width - l.length - r.length);
  return l + new Array(gap + 1).join(' ') + r;
}

// buildReceiptBytes(order, companyName, cashierName, opts) -> plain array
// of byte values (0-255) ready to send to a printer's bulk/write endpoint.
// opts.cutAfter (default true), opts.kickDrawer (default false — only
// relevant for a cash sale, left to the caller to decide).
export function buildReceiptBytes(order, companyName, cashierName, opts) {
  opts = opts || {};
  var width = opts.lineWidth || LINE_WIDTH_58MM;
  var out = [];
  out = out.concat(INIT);
  out = out.concat(ALIGN_CENTER, BOLD_ON, DOUBLE_ON);
  out = out.concat(line(companyName || ''));
  out = out.concat(DOUBLE_OFF, BOLD_OFF);
  if (opts.extra) out = out.concat(line(opts.extra));
  out = out.concat(line('Order ' + order.orderNo + (order.fulfillment ? ' - ' + FULFILLMENT_EN[order.fulfillment] : '')));
  out = out.concat(line(new Date(order.createdAt).toLocaleString()));
  // Served by the waiter who looked after the table; the cashier who took
  // the money under it. Without a waiter, the cashier served.
  out = out.concat(line('Served by ' + (order.waiterName || cashierName || '') + (order.tableName ? ' at ' + order.tableName : '')));
  if (order.waiterName && cashierName) out = out.concat(line('Cashier: ' + cashierName));
  if (order.guestName || order.customerName) out = out.concat(line('Customer: ' + (order.guestName || order.customerName)));
  if (order.fulfillment === 'delivery') {
    out = out.concat(line('Deliver to: ' + (order.deliveryAddress || '')));
    if (order.customerPhone) out = out.concat(line('Phone: ' + order.customerPhone));
  }
  out = out.concat(ALIGN_LEFT);
  out = out.concat(line(new Array(width + 1).join('-')));
  (order.items || []).forEach(function (it) {
    out = out.concat(line(it.qty + ' x ' + it.name));
    if (it.modifiers && it.modifiers.length) out = out.concat(line('   + ' + modsEn(it.modifiers)));
    if (it.note) out = out.concat(line('   * ' + it.note));
    if (it.compReason) out = out.concat(line('   On the house: ' + it.compReason));
    else if (it.discount > 0 && it.discountName) out = out.concat(line('   ' + it.discountName + ' -' + Number(it.discount).toFixed(2)));
    out = out.concat(line(twoColumn('', money2(it.lineTotal), width)));
  });
  out = out.concat(line(new Array(width + 1).join('-')));
  // The dishes, their discounts, the service charge and taxes added on top.
  if (order.discountTotal > 0 || order.serviceCharge > 0 || (order.taxes || []).some(function (t) { return !t.included; })) {
    out = out.concat(line(twoColumn('Dishes', money2(order.itemsGross != null ? order.itemsGross : order.subtotal), width)));
    if (order.discountTotal > 0) out = out.concat(line(twoColumn('Discounts', '-' + money2(order.discountTotal), width)));
    if (order.serviceCharge > 0) out = out.concat(line(twoColumn((order.serviceName || 'Service charge') + (order.serviceRate ? ' ' + order.serviceRate + '%' : ''), money2(order.serviceCharge), width)));
    (order.taxes || []).filter(function (t) { return !t.included; }).forEach(function (t) { out = out.concat(line(twoColumn(t.name + ' ' + t.rate + '%', money2(t.amount), width))); });
  }
  out = out.concat(BOLD_ON);
  out = out.concat(line(twoColumn('TOTAL', money2(order.total), width)));
  out = out.concat(BOLD_OFF);
  (order.taxes || []).filter(function (t) { return t.included; }).forEach(function (t) { out = out.concat(line(twoColumn('incl. ' + t.name + ' ' + t.rate + '%', money2(t.amount), width))); });
  (order.refunds || []).forEach(function (r) {
    out = out.concat(line(twoColumn('Refunded ' + new Date(r.createdAt).toLocaleDateString(), '-' + money2(r.amount), width)));
  });
  if (order.refunds && order.refunds.length) out = out.concat(line(twoColumn('After refunds', money2(order.total - order.refunded), width)));
  if (order.paymentMethod === 'vip') out = out.concat(line('Paid from VIP balance' + (order.guestName ? ': ' + order.guestName : '')));
  else if (order.paymentMethod === 'iou') out = out.concat(line(order.iouPaidAt ? 'IOU, paid ' + new Date(order.iouPaidAt).toLocaleDateString() : 'IOU: owed by ' + (order.guestName || 'the guest')));
  else if (order.payments && order.payments.length && (order.payments.length > 1 || order.payments[0].currency !== 'GHS' || order.payments[0].tendered != null)) {
    // Each way it was paid; foreign money with its rate; change in cedis.
    order.payments.forEach(function (p) {
      out = out.concat(line(twoColumn(METHOD_EN[p.method] || p.method, money2(p.amount), width)));
      if (p.currency !== 'GHS') out = out.concat(line('  ' + (p.currency === 'CNY' ? 'RMB' : p.currency) + ' ' + Number(p.foreignAmount).toFixed(2) + ' @ ' + p.rate));
      if (p.tendered != null) out = out.concat(line('  Received ' + (p.currency === 'GHS' ? 'GHS' : p.currency === 'CNY' ? 'RMB' : p.currency) + ' ' + Number(p.tendered).toFixed(2)));
    });
    if (order.change > 0) out = out.concat(line(twoColumn('Change', money2(order.change), width)));
  } else out = out.concat(line('Paid by ' + (METHOD_EN[order.paymentMethod] || String(order.paymentMethod || '').replace('_', ' '))));
  if (order.vipBalance != null) out = out.concat(line(twoColumn('VIP balance left', money2(order.vipBalance), width)));
  if (order.cashTendered != null && !(order.payments && order.payments.length > 1)) {
    out = out.concat(line(twoColumn('Cash', money2(order.cashTendered), width)));
    out = out.concat(line(twoColumn('Change', money2(order.change), width)));
  }
  out = out.concat(ALIGN_CENTER);
  out = out.concat(line(''));
  out = out.concat(line(opts.footer === undefined ? 'Thank you!' : opts.footer));
  out = out.concat(FEED(3));
  if (opts.kickDrawer) out = out.concat(CASH_DRAWER_KICK);
  if (opts.cutAfter !== false) out = out.concat(CUT);
  return out;
}
function money2(n) { return 'GHS ' + Number(n || 0).toFixed(2); }
// A dish's add-ons in English, as printers print them (no other script).
function modsEn(mods) {
  return mods.map(function (m) { return m.how === 'no' ? 'No ' + m.name : m.how === 'extra' ? 'Extra ' + m.name : m.how === 'side' ? m.name + ' on the side' : m.name; }).join(', ');
}
var FULFILLMENT_EN = { dine_in: 'Dine in', pickup: 'Pickup', delivery: 'Delivery' };
var METHOD_EN = { cash: 'Cash', mobile_money: 'Mobile Money', alipay: 'Alipay', wechat: 'WeChat Pay', vip: 'VIP', iou: 'IOU', other: 'Other', split: 'Split payment', card: 'Card', app: 'Paid on the app', gift_card: 'Gift card' };

// A QR code (ESC/POS GS ( k: model 2, module size, error correction M,
// stored then printed) — the printers that cannot print one skip it.
function qrBytes(data, size) {
  var d = textBytes(data);
  var len = d.length + 3;
  return bytes(
    [GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00],
    [GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size || 6],
    [GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31],
    [GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30], d,
    [GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]);
}

// buildBillBytes(tab, companyName, opts) -> the bill for a table's open
// order (not a receipt): its dishes, the service charge and taxes, what
// guests paid from their phones already, what is left; and opts.payUrl's
// QR code to pay it from a phone (restaurantTablePay).
export function buildBillBytes(tab, companyName, opts) {
  opts = opts || {};
  var width = opts.lineWidth || LINE_WIDTH_58MM;
  var bill = tab.bill || {};
  var out = [].concat(INIT, ALIGN_CENTER, BOLD_ON, DOUBLE_ON, line(companyName || ''), DOUBLE_OFF);
  out = out.concat(line('BILL - ' + (tab.tableName || tab.label || '')), BOLD_OFF);
  out = out.concat(line(new Date().toLocaleString()));
  if (tab.waiterName) out = out.concat(line('Served by ' + tab.waiterName));
  out = out.concat(ALIGN_LEFT, line(new Array(width + 1).join('-')));
  (tab.lines || []).forEach(function (it) {
    out = out.concat(line(it.qty + ' x ' + it.name));
    if (it.modifiers && it.modifiers.length) out = out.concat(line('   + ' + modsEn(it.modifiers)));
    if (it.compReason) out = out.concat(line('   On the house'));
    else if (it.discount > 0) out = out.concat(line('   ' + (it.discountName || 'Discount') + ' -' + Number(it.discount).toFixed(2)));
    out = out.concat(line(twoColumn('', money2(it.lineTotal), width)));
  });
  out = out.concat(line(new Array(width + 1).join('-')));
  if (bill.serviceCharge > 0) out = out.concat(line(twoColumn((bill.serviceName || 'Service charge') + (bill.serviceRate ? ' ' + bill.serviceRate + '%' : ''), money2(bill.serviceCharge), width)));
  (bill.taxes || []).filter(function (t) { return !t.included; }).forEach(function (t) { out = out.concat(line(twoColumn(t.name + ' ' + t.rate + '%', money2(t.amount), width))); });
  out = out.concat(BOLD_ON, line(twoColumn('TOTAL', money2(tab.total), width)), BOLD_OFF);
  (bill.taxes || []).filter(function (t) { return t.included; }).forEach(function (t) { out = out.concat(line(twoColumn('incl. ' + t.name + ' ' + t.rate + '%', money2(t.amount), width))); });
  var paid = (tab.paidAtTable || []).reduce(function (a, p) { return a + p.amount - (p.tip || 0); }, 0);
  if (paid > 0) {
    out = out.concat(line(twoColumn('Paid from phones', '-' + money2(paid), width)));
    out = out.concat(BOLD_ON, line(twoColumn('LEFT TO PAY', money2(Math.max(0, tab.total - paid)), width)), BOLD_OFF);
  }
  out = out.concat(ALIGN_CENTER, line(''));
  if (opts.payUrl) {
    out = out.concat(BOLD_ON, line('Scan to pay: card or MoMo'), BOLD_OFF, line('Split it, add a tip'));
    out = out.concat(qrBytes(opts.payUrl, 6), line(''));
  }
  out = out.concat(line('This is not a receipt.'));
  out = out.concat(FEED(3));
  if (opts.cutAfter !== false) out = out.concat(CUT);
  return out;
}

// buildRunnerTicketBytes(ticket, companyName) -> the ticket the kitchen
// prints when an order's food is done (pages/KdsPage.jsx): big number, who
// it is for and where it goes (the table, the counter, or a delivery's
// address and phone), and every dish with its note.
export function buildRunnerTicketBytes(ticket, companyName, opts) {
  opts = opts || {};
  var width = opts.lineWidth || LINE_WIDTH_58MM;
  var rule = new Array(width + 1).join('-');
  var out = [].concat(INIT, ALIGN_CENTER);
  if (companyName) out = out.concat(line(companyName));
  out = out.concat(BOLD_ON, DOUBLE_ON, line('#' + ticket.number + ' READY'), DOUBLE_OFF);
  var kind = FULFILLMENT_EN[ticket.fulfillment] || '';
  var where = ticket.fulfillment === 'pickup' ? 'COUNTER' : ticket.fulfillment === 'delivery' ? 'DELIVERY' : (ticket.tableName || ticket.label || 'COUNTER');
  out = out.concat(DOUBLE_ON, line(where.toUpperCase().slice(0, 16)), DOUBLE_OFF, BOLD_OFF);
  if (kind && ticket.fulfillment === 'dine_in') out = out.concat(line(kind));
  out = out.concat(ALIGN_LEFT, line(rule));
  if (ticket.guestName || ticket.label) out = out.concat(BOLD_ON, line('For: ' + (ticket.guestName || ticket.label)), BOLD_OFF);
  if (ticket.fulfillment === 'delivery') {
    out = out.concat(line('To: ' + (ticket.deliveryAddress || '')));
    if (ticket.customerPhone) out = out.concat(line('Phone: ' + ticket.customerPhone));
  }
  if (ticket.waiterName) out = out.concat(line('Waiter: ' + ticket.waiterName));
  out = out.concat(line(rule));
  (ticket.items || []).forEach(function (it) {
    out = out.concat(BOLD_ON, line(it.qty + ' x ' + it.name), BOLD_OFF);
    if (it.mods && it.mods.length) out = out.concat(line('   + ' + modsEn(it.mods)));
    if (it.note) out = out.concat(line('   * ' + it.note));
  });
  if (ticket.note) out = out.concat(line(rule), line('Note: ' + ticket.note));
  out = out.concat(line(rule));
  out = out.concat(line('Sent ' + new Date(ticket.createdAt).toLocaleTimeString() + (ticket.sentBy ? ' by ' + ticket.sentBy : '')));
  out = out.concat(line('Ready ' + new Date().toLocaleTimeString()));
  out = out.concat(FEED(3), CUT);
  return out;
}

// buildKitchenChitBytes(chit, companyName, opts) -> a station's ticket,
// printed at the till when an order is sent or a course is called, for a
// station with no screen (backend restaurantKitchen chitsFor): the
// station, the number and the table in big letters, the course, any
// allergy alert, and each dish with its seat, add-ons and note.
var ALLERGEN_EN = { gluten: 'gluten', crustaceans: 'crustaceans', eggs: 'eggs', fish: 'fish', peanuts: 'peanuts', soy: 'soy', milk: 'milk', nuts: 'tree nuts', celery: 'celery', mustard: 'mustard', sesame: 'sesame', sulphites: 'sulphites', lupin: 'lupin', molluscs: 'molluscs' };
export function buildKitchenChitBytes(chit, companyName, opts) {
  opts = opts || {};
  var width = opts.lineWidth || LINE_WIDTH_58MM;
  var rule = new Array(width + 1).join('-');
  var out = [].concat(INIT, ALIGN_CENTER);
  out = out.concat(BOLD_ON, line(String(chit.station || 'Kitchen').toUpperCase()), BOLD_OFF);
  out = out.concat(BOLD_ON, DOUBLE_ON, line('#' + chit.number), DOUBLE_OFF);
  var where = chit.fulfillment === 'pickup' ? 'COUNTER' : chit.fulfillment === 'delivery' ? 'DELIVERY' : (chit.tableName || chit.label || 'COUNTER');
  out = out.concat(DOUBLE_ON, line(where.toUpperCase().slice(0, 16)), DOUBLE_OFF, BOLD_OFF);
  if (opts.courseName) out = out.concat(BOLD_ON, line('** ' + opts.courseName.toUpperCase() + ' **'), BOLD_OFF);
  out = out.concat(ALIGN_LEFT, line(rule));
  if (chit.allergens && chit.allergens.length || chit.allergy) {
    out = out.concat(BOLD_ON, line('!! ALLERGY: ' + (chit.allergens || []).map(function (a) { return ALLERGEN_EN[a] || a; }).join(', ')), BOLD_OFF);
    if (chit.allergy) out = out.concat(line('   ' + chit.allergy));
    out = out.concat(line(rule));
  }
  if (chit.guests) out = out.concat(line('Guests: ' + chit.guests));
  if (chit.waiterName) out = out.concat(line('Waiter: ' + chit.waiterName));
  (chit.items || []).forEach(function (it) {
    var clash = (it.allergens || []).filter(function (a) { return (chit.allergens || []).indexOf(a) >= 0; });
    out = out.concat(BOLD_ON, line((it.seat ? '[S' + it.seat + '] ' : '') + it.qty + ' x ' + it.name), BOLD_OFF);
    if (it.mods && it.mods.length) out = out.concat(line('   + ' + modsEn(it.mods)));
    if (it.note) out = out.concat(line('   * ' + it.note));
    if (clash.length) out = out.concat(line('   !! has ' + clash.map(function (a) { return ALLERGEN_EN[a] || a; }).join(', ')));
  });
  if (chit.note) out = out.concat(line(rule), line('Note: ' + chit.note));
  out = out.concat(line(rule), line('Sent ' + new Date(chit.sentAt || Date.now()).toLocaleTimeString()));
  out = out.concat(FEED(3), CUT);
  return out;
}

// buildDrawerReportBytes(report, companyName, cashierName) -> same shape
// as the reference "Drawer Report" receipt this was built to match:
// header, Starting/Cash Sales/Refunds/Paid In-Out/Expected/Actual/
// Difference block, then the individual Paid In/Out log lines.
export function buildDrawerReportBytes(report, companyName, cashierName, opts) {
  opts = opts || {};
  var width = opts.lineWidth || LINE_WIDTH_58MM;
  var out = [];
  out = out.concat(INIT);
  out = out.concat(ALIGN_LEFT, BOLD_ON);
  out = out.concat(line('Drawer Report: ' + (cashierName || '')));
  out = out.concat(BOLD_OFF);
  var opened = new Date(report.session.openedAt);
  var closed = report.session.closedAt ? new Date(report.session.closedAt) : null;
  out = out.concat(line(opened.toLocaleString() + (closed ? ' -' : '')));
  if (closed) out = out.concat(line(closed.toLocaleString()));
  out = out.concat(line(companyName || ''));
  out = out.concat(line(new Array(width + 1).join('-')));
  out = out.concat(line(twoColumn('Starting Cash', money2(report.startingCash), width)));
  out = out.concat(line(twoColumn('Cash Sales', money2(report.cashSales), width)));
  if (report.iouPaidCash > 0) out = out.concat(line(twoColumn('IOUs paid in cash', money2(report.iouPaidCash), width)));
  if (report.vipTopUpsCash > 0) out = out.concat(line(twoColumn('VIP money in cash', money2(report.vipTopUpsCash), width)));
  out = out.concat(line(twoColumn('Cash Refunds', money2(report.cashRefunds), width)));
  out = out.concat(line(twoColumn('Paid In/Out', (report.netPaidInOut < 0 ? '-' : '') + money2(Math.abs(report.netPaidInOut)), width)));
  if (report.safeDrops > 0) out = out.concat(line(twoColumn('Into the safe', '-' + money2(report.safeDrops), width)));
  if (report.pettyCash > 0) out = out.concat(line(twoColumn('Petty cash', '-' + money2(report.pettyCash), width)));
  out = out.concat(line(twoColumn('Expected in Drawer', money2(report.expected), width)));
  out = out.concat(line(twoColumn('Actual in Drawer', report.actual == null ? '' : money2(report.actual), width)));
  out = out.concat(line(twoColumn('Difference', report.difference == null ? '' : ((report.difference < 0 ? '-' : '') + money2(Math.abs(report.difference))), width)));
  out = out.concat(line(new Array(width + 1).join('-')));
  if (report.movements.length) {
    out = out.concat(BOLD_ON, line('PAID IN/OUT'), BOLD_OFF);
    report.movements.forEach(function (m) {
      var label = (m.direction === 'in' ? 'Paid in at ' : 'Paid out at ') + new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      out = out.concat(line(label));
      if (m.note) out = out.concat(line(m.note));
      out = out.concat(line(twoColumn('', (m.direction === 'out' ? '-' : '') + money2(m.amount), width)));
    });
    out = out.concat(line(twoColumn('Total Paid In/Out', (report.netPaidInOut < 0 ? '-' : '') + money2(Math.abs(report.netPaidInOut)), width)));
  }
  out = out.concat(FEED(3));
  if (opts.cutAfter !== false) out = out.concat(CUT);
  return out;
}

// ── WebUSB ──────────────────────────────────────────────────────────────

export function usbSupported() {
  return typeof navigator !== 'undefined' && !!navigator.usb;
}

// No vendor/product filter — thermal printers span dozens of USB VID/PIDs
// (Epson, Star, and a long tail of unbranded 58/80mm printers), and many
// generic ones use a vendor-specific interface class rather than the
// standard USB Printer class (0x07), so filtering would hide real
// candidates more often than it narrows a genuinely long list.
export async function requestUsbPrinter() {
  if (!usbSupported()) throw new Error(tr('This browser doesn\'t support WebUSB — use Chrome or Edge.'));
  var device = await navigator.usb.requestDevice({ filters: [] });
  return connectUsbPrinter(device);
}

// USB classes Chrome never lets a web page claim: audio, HID (barcode
// scanners, keyboards), mass storage, smart cards, video, audio/video,
// wireless. A device with only these is not a printer.
var PROTECTED_CLASSES = [0x01, 0x03, 0x08, 0x0b, 0x0e, 0x10, 0xe0];

// The interfaces on a device worth trying to print through, the USB printer
// class (0x07) first, then vendor-specific ones (most unbranded ESC/POS
// printers), then anything else with a way in: a printer with a built-in
// serial port or scanner may list another interface first.
function printerInterfaces(device) {
  var list = [];
  device.configuration.interfaces.forEach(function (itf) {
    itf.alternates.forEach(function (alt) {
      if (PROTECTED_CLASSES.indexOf(alt.interfaceClass) >= 0) return;
      var out = alt.endpoints.find(function (e) { return e.direction === 'out' && e.type === 'bulk'; }) || alt.endpoints.find(function (e) { return e.direction === 'out'; });
      if (!out) return;
      list.push({ iface: itf.interfaceNumber, alt: alt.alternateSetting, endpoint: out.endpointNumber, rank: alt.interfaceClass === 0x07 ? 0 : alt.interfaceClass === 0xff ? 1 : 2 });
    });
  });
  return list.sort(function (a, b) { return a.rank - b.rank; });
}

async function connectUsbPrinter(device) {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  var list = printerInterfaces(device);
  if (!list.length) {
    var onlyProtected = device.configuration.interfaces.some(function (itf) { return PROTECTED_CLASSES.indexOf(itf.alternates[0].interfaceClass) >= 0; });
    try { await device.close(); } catch { /* closing is best-effort */ }
    throw new Error(onlyProtected ? tr('That is not a printer: it looks like a scanner, keyboard or card reader. Pair again and pick the printer.') : tr('No usable USB endpoint found on that device — is it a printer?'));
  }
  // "Unable to claim interface" means something else holds it: another tab
  // or app on this device, or the system's own printer driver. Try each way
  // in before giving up, and let go of the device so the next try is clean.
  var picked = null;
  for (var i = 0; i < list.length && !picked; i++) {
    try {
      await device.claimInterface(list[i].iface);
      if (list[i].alt) await device.selectAlternateInterface(list[i].iface, list[i].alt);
      picked = list[i];
    } catch { /* try the next interface */ }
  }
  if (!picked) {
    try { await device.close(); } catch { /* closing is best-effort */ }
    throw new Error(tr('The printer is busy: another app or browser tab is using it. Close any other tab with the till or the kitchen screen; if the tablet asked which app should open the printer, clear that choice; then unplug the printer, plug it back in and pair it again.'));
  }
  // Let go when the page goes away, so a reload, the kitchen screen or
  // another app can claim the printer without unplugging it.
  if (typeof window !== 'undefined' && !device.__releaseOnHide) {
    device.__releaseOnHide = true;
    window.addEventListener('pagehide', function () { if (device.opened) device.close().catch(function () { /* the page is going */ }); });
  }
  return {
    kind: 'usb',
    name: device.productName || tr('USB printer'),
    write: async function (byteArray) {
      // Back from the background cache with the device let go: take it again.
      if (!device.opened) {
        await device.open();
        await device.claimInterface(picked.iface);
      }
      await device.transferOut(picked.endpoint, new Uint8Array(byteArray));
    }
  };
}

// Silently reconnects to a printer the user already granted USB access to
// in an earlier session — no new pairing prompt, since the permission
// already exists (per the WebUSB spec, getDevices() only ever returns
// devices previously approved via requestDevice()). Every approved device
// is tried: the first may be a scanner picked by mistake.
export async function reconnectUsbPrinter() {
  if (!usbSupported()) return null;
  var devices = await navigator.usb.getDevices();
  for (var i = 0; i < devices.length; i++) {
    try { return await connectUsbPrinter(devices[i]); } catch { /* try the next one */ }
  }
  return null;
}

// ── WebBluetooth ────────────────────────────────────────────────────────

// A browser only reaches Bluetooth Low Energy printers. There is no single
// BLE printing standard, so these are the services the common receipt
// printers expose (the 0x18f0 one, the "e7810a71" one most unbranded 58/80mm
// printers use, Microchip's transparent UART, and the HM-10-style ones), and
// the characteristic each one writes to. A printer that only speaks classic
// Bluetooth (SPP) cannot be reached from a web page at all.
var BLE_PRINTER_SERVICES = [0x18f0, 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 0xff00, 0xffe0, 0xfff0, 0xae30, 0xfee7];
var BLE_WRITE_CHARACTERISTICS = [0x2af1, 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', '49535343-8841-43f4-a8d4-ecbe34729bb3', 0xff02, 0xffe1, 0xfff2, 0xae01];

function bleUuid(v) {
  return typeof v === 'number' ? '0000' + v.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb' : String(v).toLowerCase();
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (err) { clearTimeout(timer); reject(err); });
  });
}

function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

export function bluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

var BT_CLASSIC = msg('This printer has no Bluetooth Low Energy printing the browser can use: it probably only speaks classic Bluetooth, which web pages cannot reach. Connect it with its USB cable instead, or use a printer that supports Bluetooth LE.');
var BT_NO_CONNECT = msg('Could not connect to the printer. Switch it off and on, keep it close, make sure no other phone, tablet or printer app is connected to it, then pair again.');

// Every nearby device is listed: many printers do not announce what they
// can do until they are connected, so a filter would hide them.
export async function requestBluetoothPrinter() {
  if (!bluetoothSupported()) throw new Error(tr('This browser doesn\'t support WebBluetooth — use Chrome or Edge (desktop or Android).'));
  if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
    throw new Error(tr('Bluetooth is off or not allowed. Turn Bluetooth on, and allow Chrome to find nearby devices (Android settings → Apps → Chrome → Permissions → Nearby devices, and Location on older tablets), then try again.'));
  }
  var device;
  try {
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_PRINTER_SERVICES });
  } catch (err) {
    if (err && err.name === 'NotFoundError') throw new Error(tr('No printer was picked. If yours is not in the list, it is probably a classic Bluetooth printer, which web pages cannot reach: connect it with its USB cable instead.'));
    throw err;
  }
  return connectBluetoothPrinter(device);
}

// The first writable characteristic on a known printer service, the known
// write characteristics first.
async function findBleWriter(server) {
  var services = [];
  try { services = await server.getPrimaryServices(); } catch { services = []; }
  var rank = function (svc) { var n = BLE_PRINTER_SERVICES.map(bleUuid).indexOf(String(svc.uuid).toLowerCase()); return n < 0 ? 99 : n; };
  services.sort(function (a, b) { return rank(a) - rank(b); });
  var known = BLE_WRITE_CHARACTERISTICS.map(bleUuid);
  var fallback = null;
  for (var i = 0; i < services.length; i++) {
    var chars = [];
    try { chars = await services[i].getCharacteristics(); } catch { chars = []; }
    for (var j = 0; j < chars.length; j++) {
      var c = chars[j];
      if (!(c.properties && (c.properties.write || c.properties.writeWithoutResponse))) continue;
      if (known.indexOf(String(c.uuid).toLowerCase()) >= 0) return c;
      if (!fallback) fallback = c;
    }
  }
  return fallback;
}

async function connectBluetoothPrinter(device) {
  var server;
  try { server = await withTimeout(device.gatt.connect(), 15000); } catch { throw new Error(tr(BT_NO_CONNECT)); }
  var ch = await findBleWriter(server);
  if (!ch) {
    try { device.gatt.disconnect(); } catch { /* closing is best-effort */ }
    throw new Error(tr(BT_CLASSIC));
  }
  // Writes are capped by the link's packet size: start large, and drop to
  // the 20 bytes every BLE link takes if the printer refuses the first one.
  var size = 180;
  return {
    kind: 'bluetooth',
    name: device.name || tr('Bluetooth printer'),
    write: async function (byteArray) {
      // Printers drop the link when idle or switched off and on: connect again.
      if (!device.gatt.connected) {
        try { ch = await findBleWriter(await withTimeout(device.gatt.connect(), 15000)); } catch { ch = null; }
        if (!ch) throw new Error(tr(BT_NO_CONNECT));
      }
      var withResponse = !!ch.properties.write;
      var bytes = new Uint8Array(byteArray);
      var i = 0;
      while (i < bytes.length) {
        var part = bytes.slice(i, i + size);
        try {
          if (withResponse) await (ch.writeValueWithResponse ? ch.writeValueWithResponse(part) : ch.writeValue(part));
          else await (ch.writeValueWithoutResponse ? ch.writeValueWithoutResponse(part) : ch.writeValue(part));
        } catch (err) {
          if (i === 0 && size > 20) { size = 20; continue; }
          throw err;
        }
        i += part.length;
        // Without an answer from the printer, give its buffer time to drain.
        if (!withResponse) await pause(12);
      }
    }
  };
}

export async function reconnectBluetoothPrinter() {
  if (!bluetoothSupported() || !navigator.bluetooth.getDevices) return null;
  var devices = await navigator.bluetooth.getDevices();
  for (var i = 0; i < devices.length; i++) {
    try { return await connectBluetoothPrinter(devices[i]); } catch { /* try the next one */ }
  }
  return null;
}
