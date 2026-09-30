var path = require('path');
var fs = require('fs');
var PDFDocument = require('pdfkit');
var { pool } = require('../db/pool');
var shares = require('./shares.service');

// The PDF a customer gets by email (documentEmails.service.js): an invoice,
// quotation, estimate or Poki bill, and the receipt for a payment. Made on
// the server because reminders and receipts go out on their own, with no
// browser to draw them.
//
// It follows the printed document (frontend DocPreview.jsx and the page
// behind a share link, SharePage.jsx) section by section — letterhead, the
// document number and date, the heading, the three blocks, the items with
// their discount and tax notes, the totals spelled out, payments, schedule,
// notes and terms — and the same arithmetic (lib/docItems.js, lib/packages.js).
// Documents are in English, the company's document language (docTr).

var LOGO = path.join(__dirname, '..', '..', 'assets', 'logo.png');
var PAGE = { size: 'A4', margin: 48 };
var INK = '#1d1d1b', MUTED = '#4a4a4a', FAINT = '#6b6966', LINE = '#cccccc', HAIR = '#e6e6e6', RULE = '#bbbbbb';
var LABEL = { quotation: 'Quotation', estimate: 'Estimate', invoice: 'Invoice' };

// The group's own letterhead, as on DocPreview.jsx and SharePage.jsx.
var BPL = {
  name: 'Bamboo Products Limited',
  lines: ['Poki House', '35 J K Siaw St, Community 9, Tema, Ghana', 'GT-191-1859 (GhanaPostGPS)', 'WhatsApp: 0591933925'],
  logo: true, wordmark: false
};

// ---- formatting (the document language: en-GB dates, GHS 1,234.56) ------

// The standard PDF fonts only know Western European letters; anything else
// becomes '?' rather than a wrong glyph.
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[−]/g, '-')
    .replace(/[^\u0009\u000a -~ -ÿ–—‘’“”•…€™]/g, '?');
}
function money(amount, currency) {
  var n = Number(amount) || 0;
  return (currency || 'GHS') + ' ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function docDate(value) {
  if (!value) return '—';
  var d = value instanceof Date ? value : new Date(String(value).length > 10 ? value : value + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: String(value).length > 10 || value instanceof Date ? 'Africa/Accra' : 'UTC' });
}

// ---- the arithmetic the printed document shows (lib/docItems.js) ---------

function lineGross(it) { return (Number(it.qty) || 0) * (Number(it.unitPrice) || 0); }
function lineDiscount(it) {
  var gross = lineGross(it);
  return it.discountType === 'percent' ? gross * (Number(it.discount) || 0) / 100 : Number(it.discount) || 0;
}
function displayItems(items, currency) {
  var order = [], packages = {};
  (items || []).forEach(function (it) {
    var label = String(it.packageLabel || '').trim();
    if (!label) {
      var disc = lineDiscount(it), rate = Number(it.taxRate) || 0;
      order.push({
        description: it.description, notes: it.notes || '', qty: String(Number(it.qty) || 0), unitPrice: money(it.unitPrice, currency),
        lineTotal: money(lineGross(it), currency),
        discountNote: disc ? 'Less ' + (it.discountType === 'percent' ? (Number(it.discount) || 0) + '% off' : 'discount') + ': ' + money(disc, currency) : '',
        taxNote: rate ? 'Tax ' + rate + '%: ' + money(Math.max(0, lineGross(it) - disc) * rate / 100, currency) : ''
      });
      return;
    }
    var g = packages[label];
    if (!g) { g = packages[label] = { description: label, names: [], total: 0, discount: 0, pkg: true }; order.push(g); }
    g.total += lineGross(it); g.discount += lineDiscount(it); g.names.push(it.description);
  });
  return order.map(function (g) {
    return g.pkg ? {
      description: g.description, notes: 'Includes: ' + g.names.join(', '), qty: '', unitPrice: '', lineTotal: money(g.total, currency),
      discountNote: g.discount ? 'Less discount: ' + money(g.discount, currency) : '', taxNote: ''
    } : g;
  });
}
function adjustmentRows(doc, currency) {
  var subtotal = Number(doc.subtotal) || 0, discountTotal = Number(doc.discountTotal) || 0, taxTotal = Number(doc.taxTotal) || 0;
  var dd = doc.discount || {}, ddValue = Number(dd.value) || 0, itemDiscounts, docDiscount;
  if (dd.type === 'percent' && ddValue) {
    var r = ddValue / 100;
    itemDiscounts = Math.max(0, r >= 1 ? 0 : (discountTotal - subtotal * r) / (1 - r));
    docDiscount = Math.max(0, discountTotal - itemDiscounts);
  } else {
    docDiscount = Math.min(ddValue, discountTotal);
    itemDiscounts = Math.max(0, discountTotal - docDiscount);
  }
  var discounts = [];
  if (itemDiscounts > 0.005) discounts.push({ label: 'Discount on items', value: '- ' + money(itemDiscounts, currency) });
  if (docDiscount > 0.005) discounts.push({ label: dd.type === 'percent' ? 'Discount (' + ddValue + '%)' : 'Discount', value: '- ' + money(docDiscount, currency) });
  var rate = Number(doc.taxRate) || 0;
  var taxes = taxTotal > 0.005 ? [{ label: rate ? 'Tax (' + rate + '%)' : 'Tax', value: money(taxTotal, currency) }] : [];
  return discounts.concat(taxes);
}

// ---- letterhead -----------------------------------------------------------

// Who is sending it: the group's letterhead for Bamboo Products' own
// documents, the issuing company's for a sister company's (Poki bills
// tenants as Poki Properties, under its own wordmark).
async function letterheadFor(companyId) {
  if (!companyId) return BPL;
  var c = (await pool.query(
    'SELECT code, name, legal_name, letterhead_subtitle, address, ghana_post_gps, phone, email FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!c || c.code === 'BPL') return BPL;
  return {
    name: c.legal_name || c.name, subtitle: c.letterhead_subtitle || '', logo: false, wordmark: true, email: c.email || '',
    lines: [c.address, c.ghana_post_gps ? c.ghana_post_gps + ' (GhanaPostGPS)' : '', c.phone ? 'WhatsApp: ' + c.phone : '', c.email].filter(Boolean)
  };
}

// ---- drawing --------------------------------------------------------------

function newDoc(title) {
  var doc = new PDFDocument({ size: PAGE.size, margin: PAGE.margin, bufferPages: true, info: { Title: clean(title), Author: 'Bamboo OS' } });
  var chunks = [];
  doc.on('data', function (c) { chunks.push(c); });
  var done = new Promise(function (resolve, reject) {
    doc.on('end', function () { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);
  });
  return { doc: doc, done: done };
}
function left(doc) { return doc.page.margins.left; }
function right(doc) { return doc.page.width - doc.page.margins.right; }
function width(doc) { return right(doc) - left(doc); }
function bottom(doc) { return doc.page.height - doc.page.margins.bottom; }
// Room for h more points on this page, or a new page.
function room(doc, h) { if (doc.y + h > bottom(doc)) { doc.addPage(); doc.y = doc.page.margins.top; } }

function header(doc, lh, docLabel, dateLabel, dateValue) {
  var x = left(doc), top = doc.page.margins.top, textX = x;
  if (lh.logo && fs.existsSync(LOGO)) { doc.image(LOGO, x, top, { fit: [46, 46] }); textX = x + 56; }
  var y = top;
  if (lh.wordmark) {
    doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(clean(lh.name), textX, y, { width: 300 });
    y = doc.y;
    if (lh.subtitle) { doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(clean(lh.subtitle), textX, y, { width: 300 }); y = doc.y; }
  } else {
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(clean(lh.name), textX, y, { width: 300 });
    y = doc.y;
  }
  doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
  (lh.lines || []).forEach(function (l) { doc.text(clean(l), textX, y + 2, { width: 300, lineGap: 1 }); y = doc.y - 2; });
  var leftEnd = Math.max(doc.y, top + 46);

  var rx = right(doc) - 200;
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(clean(docLabel), rx, top, { width: 200, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9.5).text(clean(dateLabel), rx, doc.y + 10, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(10.5).text(clean(dateValue), rx, doc.y + 1, { width: 200, align: 'right' });
  var rightEnd = doc.y;

  doc.y = Math.max(leftEnd, rightEnd) + 16;
  doc.rect(x, doc.y, width(doc), 5).fill(RULE);
  doc.y += 22;
}

function headingBlock(doc, heading, sub) {
  doc.font('Helvetica-Bold').fontSize(21).fillColor(INK).text(clean(heading), left(doc), doc.y, { width: width(doc) });
  doc.font('Helvetica').fontSize(10.5).fillColor(MUTED).text(clean(sub), left(doc), doc.y + 4, { width: width(doc) });
  doc.y += 18;
}

function blocks(doc, list) {
  var gap = 16, colW = (width(doc) - gap * (list.length - 1)) / list.length, top = doc.y, ends = [];
  list.forEach(function (b, i) {
    var x = left(doc) + i * (colW + gap);
    doc.moveTo(x, top).lineTo(x + colW, top).lineWidth(1.5).strokeColor(LINE).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(clean(b.title), x, top + 6, { width: colW });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED);
    b.lines.filter(function (l) { return l; }).forEach(function (l) { doc.text(clean(l), x, doc.y + 3, { width: colW }); });
    ends.push(doc.y);
  });
  doc.y = Math.max.apply(null, ends) + 22;
}

var COLS = [{ key: 'description', label: 'Items', w: 0.52 }, { key: 'qty', label: 'Quantity', w: 0.12, num: true },
  { key: 'unitPrice', label: 'Price', w: 0.18, num: true }, { key: 'lineTotal', label: 'Amount', w: 0.18, num: true }];
function tableHead(doc) {
  var x = left(doc), y = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
  COLS.forEach(function (c) {
    var w = c.w * width(doc);
    doc.text(c.label, x, y, { width: w, align: c.num ? 'right' : 'left' });
    x += w;
  });
  doc.y = y + 16;
  doc.moveTo(left(doc), doc.y).lineTo(right(doc), doc.y).lineWidth(1.5).strokeColor(LINE).stroke();
  doc.y += 7;
}
function tableRow(doc, it) {
  var descW = COLS[0].w * width(doc);
  doc.font('Helvetica').fontSize(10);
  var h = doc.heightOfString(clean(it.description), { width: descW - 8 });
  doc.fontSize(8.5);
  ['notes', 'discountNote', 'taxNote'].forEach(function (k) { if (it[k]) h += doc.heightOfString(clean(it[k]), { width: descW - 8 }) + 2; });
  if (doc.y + h + 10 > bottom(doc)) { doc.addPage(); doc.y = doc.page.margins.top; tableHead(doc); }
  var y = doc.y, x = left(doc);
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(clean(it.description), x, y, { width: descW - 8 });
  if (it.notes) doc.fontSize(8.5).fillColor(FAINT).text(clean(it.notes), x, doc.y + 2, { width: descW - 8 });
  if (it.discountNote) doc.fontSize(8.5).fillColor('#8a5a00').text(clean(it.discountNote), x, doc.y + 2, { width: descW - 8 });
  if (it.taxNote) doc.fontSize(8.5).fillColor('#8a5a00').text(clean(it.taxNote), x, doc.y + 2, { width: descW - 8 });
  var end = doc.y;
  x += descW;
  doc.font('Helvetica').fontSize(10).fillColor(MUTED);
  COLS.slice(1).forEach(function (c) {
    var w = c.w * width(doc);
    doc.text(clean(it[c.key]), x, y, { width: w, align: 'right' });
    x += w;
  });
  doc.y = end + 7;
  doc.moveTo(left(doc), doc.y).lineTo(right(doc), doc.y).lineWidth(0.75).strokeColor(HAIR).stroke();
  doc.y += 7;
}

function row(doc, label, value, opts) {
  opts = opts || {};
  var size = opts.grand ? 17 : 10;
  room(doc, size + 14);
  if (opts.grand) {
    doc.y += 4;
    doc.moveTo(left(doc), doc.y).lineTo(right(doc), doc.y).lineWidth(1).strokeColor(LINE).stroke();
    doc.y += 10;
  }
  var y = doc.y;
  doc.font(opts.grand ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(opts.grand ? INK : MUTED);
  doc.text(clean(label), left(doc), y, { width: width(doc) * 0.62 });
  var end = doc.y;
  doc.text(clean(value), left(doc) + width(doc) * 0.62, y, { width: width(doc) * 0.38, align: 'right' });
  doc.y = Math.max(end, doc.y) + (opts.grand ? 6 : 5);
}

function section(doc, label, body) {
  if (!body) return;
  doc.font('Helvetica').fontSize(9.5);
  room(doc, Math.min(120, doc.heightOfString(clean(body), { width: width(doc), lineGap: 1.5 })) + 32);
  doc.y += 12;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(clean(label), left(doc), doc.y, { width: width(doc) });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(clean(body), left(doc), doc.y + 4, { width: width(doc), lineGap: 1.5 });
}

function footer(doc, text) {
  var range = doc.bufferedPageRange();
  for (var i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Written in the bottom margin, which would otherwise start a new page.
    var keep = doc.page.margins.bottom;
    var y = doc.page.height - keep + 18;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(FAINT);
    doc.text(clean(text), left(doc), y, { width: width(doc) * 0.75, lineBreak: false });
    if (range.count > 1) doc.text('Page ' + (i + 1) + ' of ' + range.count, left(doc), y, { width: width(doc), align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
}

// ---- the documents ----------------------------------------------------------

// An invoice, quotation or estimate (Poki's bills are invoices too).
// Returns { buffer, filename, view, letterhead }.
async function documentPdf(documentType, documentId) {
  var v = await shares.documentView(documentType, documentId);
  var lh = await letterheadFor(v.companyId);
  var cur = v.currency, isInvoice = v.documentType === 'invoice', label = LABEL[v.documentType];
  var docLabel = label + ' #' + v.docNo;
  var sub = isInvoice ? 'Due ' + docDate(v.dueDate) : 'Valid until ' + docDate(v.validUntil);
  var made = newDoc(docLabel), doc = made.doc;

  header(doc, lh, docLabel, 'Issue date', docDate(v.dateValue));
  headingBlock(doc, v.title || label + ' for ' + v.customer.name, sub);
  blocks(doc, [
    { title: 'Customer', lines: [v.customer.name, v.customer.email, v.customer.phone] },
    { title: label + ' Details', lines: ['Issued ' + docDate(v.dateValue), money(v.grandTotal, cur)] },
    { title: isInvoice ? 'Payment' : 'Validity', lines: [sub, money(isInvoice ? v.balanceDue : v.grandTotal, cur)] }
  ]);
  tableHead(doc);
  displayItems(v.items, cur).forEach(function (it) { tableRow(doc, it); });
  doc.y += 2;
  row(doc, 'Subtotal', money(v.subtotal, cur));
  adjustmentRows(v, cur).forEach(function (r) { row(doc, r.label, r.value); });
  if (isInvoice) {
    (v.payments || []).forEach(function (p) {
      row(doc, 'Payment received ' + docDate(p.date) + (p.method ? ' · ' + String(p.method).replace(/_/g, ' ') : '') + (p.reference ? ' · ref ' + p.reference : ''), '- ' + money(p.amount, cur));
    });
    if (v.amountPaid > 0 && v.balanceDue > 0 && !(v.payments || []).length) row(doc, 'Amount paid', money(v.amountPaid, cur));
  }
  row(doc, isInvoice ? 'Total Due' : 'Grand Total', money(isInvoice ? v.balanceDue : v.grandTotal, cur), { grand: true });

  if ((v.paymentSchedule || []).length) {
    room(doc, 40);
    doc.y += 12;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Payment schedule', left(doc), doc.y);
    doc.y += 4;
    v.paymentSchedule.forEach(function (s) { row(doc, (s.label || '') + '   Due ' + (s.dueDate ? docDate(s.dueDate) : '—'), money(s.amount, cur)); });
  }
  if (isInvoice) section(doc, 'Payment instructions', v.bankInstructions);
  section(doc, 'Notes', v.notes);
  section(doc, 'Terms', v.terms);
  footer(doc, lh.name + ' · ' + docLabel);
  doc.end();
  return {
    buffer: await made.done, filename: label + '-' + String(v.docNo).replace(/[^A-Za-z0-9._-]+/g, '-') + '.pdf',
    view: v, letterhead: lh
  };
}

// The receipt for one payment: what was received, against which invoice,
// and what is left to pay.
async function receiptPdf(receiptId) {
  var r = (await pool.query(
    'SELECT r.*, i.invoice_no, i.currency, i.company_id, i.grand_total, c.name AS customer_name, c.email AS customer_email ' +
    'FROM receipts r JOIN invoices i ON i.id = r.invoice_id JOIN customers c ON c.id = r.customer_id WHERE r.id = $1', [receiptId])).rows[0];
  if (!r) return null;
  var lh = await letterheadFor(r.company_id);
  var cur = r.currency, balance = Number(r.balance_after);
  var docLabel = 'Receipt #' + r.receipt_no;
  var method = String(r.method || '').replace(/_/g, ' ');
  var made = newDoc(docLabel), doc = made.doc;

  header(doc, lh, docLabel, 'Payment date', docDate(r.date));
  headingBlock(doc, 'Receipt for ' + r.customer_name, 'Thank you for your payment.');
  blocks(doc, [
    { title: 'Received from', lines: [r.customer_name, r.customer_email] },
    { title: 'Payment', lines: [money(r.amount, cur), method ? 'By ' + method : '', r.reference ? 'Ref ' + r.reference : ''] },
    { title: 'For invoice', lines: ['Invoice #' + r.invoice_no, 'Invoice total ' + money(r.grand_total, cur)] }
  ]);
  row(doc, 'Amount received', money(r.amount, cur), { grand: true });
  row(doc, balance > 0.005 ? 'Still to pay on invoice #' + r.invoice_no : 'Invoice #' + r.invoice_no + ' is paid in full.', balance > 0.005 ? money(balance, cur) : '');
  footer(doc, lh.name + ' · ' + docLabel);
  doc.end();
  return {
    buffer: await made.done, filename: 'Receipt-' + String(r.receipt_no).replace(/[^A-Za-z0-9._-]+/g, '-') + '.pdf',
    receipt: r, letterhead: lh
  };
}

module.exports = { documentPdf: documentPdf, receiptPdf: receiptPdf, letterheadFor: letterheadFor, money: money, docDate: docDate, clean: clean };
