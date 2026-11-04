// A printed ticket drawn as a picture (PNG), for the restaurant's network
// printers (services/restaurantPrinters.service.js — Star CloudPRNT prints
// a PNG on any of its printers, whatever their letters or commands). The
// ticket comes as lines, the same shape the till reads from its own
// printer bytes (frontend lib/thermalPrinter.js readEscPos):
//   { cols, pages: [[{ t: 'line', text, align, bold, scale } | { t: 'feed', n } | { t: 'qr', data, align }]] }
// drawn 576 dots wide for 80mm paper (72mm printed at 203 dpi) or 384 for
// 58mm, in the printer's own letter size (12x24 dots; 24x48 doubled), black
// on white. One picture per page.
var sharp = require('sharp');
var QRCode = require('qrcode');
var { font } = require('./ticketFont');

var LINE_GAP = 6;     // dots between lines, as a receipt printer spaces them
var QR_DOT = 5;       // dots per square of a QR code

function widthOf(paperMm) { return Number(paperMm) === 58 ? 384 : 576; }

function chars(text) {
  return Array.from(String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, ''));
}

// The height a line takes, and how to draw it.
function measure(x) {
  if (x.t === 'feed') return Math.max(0, Number(x.n) || 0) * (24 + LINE_GAP);
  if (x.t === 'qr') {
    var n = QRCode.create(String(x.data || ' '), { errorCorrectionLevel: 'M' }).modules.size;
    return (n + 8) * QR_DOT + LINE_GAP;
  }
  var scale = Math.max(1, Math.min(4, Number(x.scale) || 1));
  return 24 * scale + LINE_GAP;
}

function drawGlyph(px, W, f, cp, left, top, mult) {
  var g = f.glyph(cp);
  for (var y = 0; y < f.h; y++) {
    for (var x = 0; x < f.w; x++) {
      if (!(g[y * f.rowBytes + (x >> 3)] & (0x80 >> (x & 7)))) continue;
      for (var dy = 0; dy < mult; dy++) {
        var row = (top + y * mult + dy) * W;
        for (var dx = 0; dx < mult; dx++) {
          var col = left + x * mult + dx;
          if (col >= 0 && col < W) px[row + col] = 0;
        }
      }
    }
  }
}

// One page of lines drawn: { width, height, px } — one byte a dot, 0 black,
// 255 white.
function drawPage(lines, opts) {
  var W = widthOf(opts.paperMm);
  var cols = Math.max(16, Math.min(Number(opts.cols) || (W === 576 ? 42 : 32), Math.floor(W / 12)));
  var left = Math.floor((W - cols * 12) / 2);
  var H = 8 + lines.reduce(function (a, x) { return a + measure(x); }, 0) + 16;
  var px = new Uint8Array(W * H).fill(255);
  var top = 8;
  lines.forEach(function (x) {
    var h = measure(x);
    if (x.t === 'qr') {
      var q = QRCode.create(String(x.data || ' '), { errorCorrectionLevel: 'M' }).modules;
      var side = (q.size + 8) * QR_DOT;
      var qx = x.align === 'left' ? left : x.align === 'right' ? left + cols * 12 - side : Math.floor((W - side) / 2);
      for (var r = 0; r < q.size; r++) {
        for (var c = 0; c < q.size; c++) {
          if (!q.get(r, c)) continue;
          for (var dy = 0; dy < QR_DOT; dy++) {
            var row = (top + (r + 4) * QR_DOT + dy) * W;
            for (var dx = 0; dx < QR_DOT; dx++) px[row + qx + (c + 4) * QR_DOT + dx] = 0;
          }
        }
      }
    } else if (x.t !== 'feed') {
      var scale = Math.max(1, Math.min(4, Number(x.scale) || 1));
      // Double size and up: the big letters, made bigger still past double.
      var f = font(!!x.bold, scale >= 2);
      var mult = scale >= 2 ? Math.max(1, Math.floor(scale / 2)) : 1;
      var cw = f.w * mult;
      var room = Math.floor((cols * 12) / cw);
      var text = chars(x.text).slice(0, room);
      var used = text.length * cw;
      var start = x.align === 'center' ? left + Math.floor((cols * 12 - used) / 2) : x.align === 'right' ? left + cols * 12 - used : left;
      // Odd sizes (3x) sit a little lower so their line keeps its height.
      var lift = Math.floor((24 * scale - f.h * mult) / 2);
      text.forEach(function (ch, i) { drawGlyph(px, W, f, ch.codePointAt(0), start + i * cw, top + Math.max(0, lift), mult); });
    }
    top += h;
  });
  return { width: W, height: H, px: px };
}

// One page of lines -> PNG.
async function renderPage(lines, opts) {
  var d = drawPage(lines, opts);
  return sharp(Buffer.from(d.px.buffer), { raw: { width: d.width, height: d.height, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
}

// One page as printer dots: each row packed 8 dots a byte, the leftmost the
// top bit, 1 for black — what a receipt printer's raster commands take
// (lib/printerBytes.js). { width, height, rowBytes, bits }.
function rasterPage(lines, opts) {
  var d = drawPage(lines, opts);
  var rowBytes = Math.ceil(d.width / 8);
  var bits = Buffer.alloc(rowBytes * d.height);
  for (var y = 0; y < d.height; y++) {
    for (var x = 0; x < d.width; x++) {
      if (d.px[y * d.width + x] < 128) bits[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width: d.width, height: d.height, rowBytes: rowBytes, bits: bits };
}
function rasterDoc(doc, opts) {
  opts = Object.assign({ cols: doc && doc.cols }, opts || {});
  return ((doc && doc.pages) || []).filter(function (p) { return p && p.length; }).map(function (p) { return rasterPage(p, opts); });
}

// Every page of a ticket, each a PNG.
async function renderDoc(doc, opts) {
  opts = Object.assign({ cols: doc && doc.cols }, opts || {});
  var pages = ((doc && doc.pages) || []).filter(function (p) { return p && p.length; });
  var out = [];
  for (var i = 0; i < pages.length; i++) out.push(await renderPage(pages[i], opts));
  return out;
}

module.exports = { renderPage: renderPage, renderDoc: renderDoc, rasterPage: rasterPage, rasterDoc: rasterDoc, widthOf: widthOf };
