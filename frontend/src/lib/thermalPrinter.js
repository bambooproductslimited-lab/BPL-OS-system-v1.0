import { tr } from './i18n.jsx';

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

async function connectUsbPrinter(device) {
  await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  var iface = null, endpoint = null;
  for (var i = 0; i < device.configuration.interfaces.length; i++) {
    var alt = device.configuration.interfaces[i].alternates[0];
    var out = alt.endpoints.find(function (e) { return e.direction === 'out'; });
    if (out) { iface = device.configuration.interfaces[i].interfaceNumber; endpoint = out.endpointNumber; break; }
  }
  if (iface === null) throw new Error(tr('No usable USB endpoint found on that device — is it a printer?'));
  await device.claimInterface(iface);
  return {
    kind: 'usb',
    name: device.productName || tr('USB printer'),
    write: async function (byteArray) {
      await device.transferOut(endpoint, new Uint8Array(byteArray));
    }
  };
}

// Silently reconnects to a printer the user already granted USB access to
// in an earlier session — no new pairing prompt, since the permission
// already exists (per the WebUSB spec, getDevices() only ever returns
// devices previously approved via requestDevice()).
export async function reconnectUsbPrinter() {
  if (!usbSupported()) return null;
  var devices = await navigator.usb.getDevices();
  if (!devices.length) return null;
  try { return await connectUsbPrinter(devices[0]); } catch (err) { return null; }
}

// ── WebBluetooth ────────────────────────────────────────────────────────

// Most generic BLE thermal printers (the common 58mm ones sold under many
// different rebadged names) expose this one GATT service/characteristic
// pair — there's no single BLE printer standard the way ESC/POS itself is
// a de facto USB/serial standard, so this covers a common case, not every
// Bluetooth printer model.
var BLE_PRINTER_SERVICE = 0x18f0;
var BLE_PRINTER_WRITE_CHARACTERISTIC = 0x2af1;

export function bluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export async function requestBluetoothPrinter() {
  if (!bluetoothSupported()) throw new Error(tr('This browser doesn\'t support WebBluetooth — use Chrome or Edge (desktop or Android).'));
  var device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [BLE_PRINTER_SERVICE] }],
    optionalServices: [BLE_PRINTER_SERVICE]
  });
  return connectBluetoothPrinter(device);
}

async function connectBluetoothPrinter(device) {
  var server = await device.gatt.connect();
  var service = await server.getPrimaryService(BLE_PRINTER_SERVICE);
  var characteristic = await service.getCharacteristic(BLE_PRINTER_WRITE_CHARACTERISTIC);
  return {
    kind: 'bluetooth',
    name: device.name || tr('Bluetooth printer'),
    write: async function (byteArray) {
      // BLE GATT writes are capped (typically ~20 bytes per write on
      // older stacks, more on modern ones) — chunk conservatively so a
      // full receipt doesn't silently truncate.
      var CHUNK = 180;
      for (var i = 0; i < byteArray.length; i += CHUNK) {
        await characteristic.writeValue(new Uint8Array(byteArray.slice(i, i + CHUNK)));
      }
    }
  };
}

export async function reconnectBluetoothPrinter() {
  if (!bluetoothSupported() || !navigator.bluetooth.getDevices) return null;
  var devices = await navigator.bluetooth.getDevices();
  if (!devices.length) return null;
  try { return await connectBluetoothPrinter(devices[0]); } catch (err) { return null; }
}
