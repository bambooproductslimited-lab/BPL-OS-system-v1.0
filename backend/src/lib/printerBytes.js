// A ticket as the bytes a receipt printer takes on its network port (9100),
// for the Bamboo print hub (services/restaurantPrintHub.service.js): each
// page drawn as dots (lib/ticketImage.js rasterDoc) and sent as a picture,
// so every printer prints the same ticket whatever letters it knows.
//   escpos — Epson and nearly every other receipt printer: GS v 0 pictures,
//            then feed and cut (GS V 66); the cash drawer by ESC p.
//   star   — Star Micronics: Star raster (ESC * r A … b n1 n2 … ESC * r B),
//            as the till sends a Star printer over USB (frontend
//            lib/thermalPrinter.js escPosToStarRaster); the drawer by BEL.
var ticketImage = require('./ticketImage');

var ESC = 0x1b, GS = 0x1d;
var CHUNK_ROWS = 128; // a picture in strips: small printers have small buffers

function escpos(pages, o) {
  o = o || {};
  var parts = [Buffer.from([ESC, 0x40])]; // ESC @: start clean
  if (o.kick) parts.push(Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa])); // ESC p 0: drawer 1
  pages.forEach(function (pg) {
    for (var top = 0; top < pg.height; top += CHUNK_ROWS) {
      var rows = Math.min(CHUNK_ROWS, pg.height - top);
      parts.push(Buffer.from([GS, 0x76, 0x30, 0x00, pg.rowBytes & 0xff, (pg.rowBytes >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff]));
      parts.push(pg.bits.subarray(top * pg.rowBytes, (top + rows) * pg.rowBytes));
    }
    parts.push(Buffer.from([ESC, 0x64, 0x04])); // feed 4 lines
    parts.push(Buffer.from([GS, 0x56, 0x42, 0x00])); // feed to the cutter and cut (partial)
  });
  return Buffer.concat(parts);
}

function star(pages, o) {
  o = o || {};
  var parts = [];
  if (o.kick) parts.push(Buffer.from([0x07])); // BEL: drawer 1
  // Raster mode, endless page, cut (with feed) at each page end and at the end.
  parts.push(Buffer.from('\x1b*rA\x1b*rP0\x00\x1b*rF13\x00\x1b*rE13\x00', 'latin1'));
  pages.forEach(function (pg, n) {
    if (n > 0) parts.push(Buffer.from([ESC, 0x0c, 0x00])); // page end: feed and cut
    var head = Buffer.from([0x62, pg.rowBytes & 0xff, (pg.rowBytes >> 8) & 0xff]);
    for (var y = 0; y < pg.height; y++) {
      parts.push(head, pg.bits.subarray(y * pg.rowBytes, (y + 1) * pg.rowBytes));
    }
  });
  parts.push(Buffer.from('\x1b*rB', 'latin1'));
  return Buffer.concat(parts);
}

// The language a printer is sent: its own choice, else as its make says.
function languageOf(printer) {
  if (printer.command_set === 'star' || printer.command_set === 'escpos') return printer.command_set;
  return printer.make === 'star' ? 'star' : 'escpos';
}

// A job's ticket for one printer.
function bytesFor(printer, doc, o) {
  var pages = ticketImage.rasterDoc(doc, { paperMm: printer.paper_mm });
  return languageOf(printer) === 'star' ? star(pages, o) : escpos(pages, o);
}

module.exports = { escpos: escpos, star: star, bytesFor: bytesFor, languageOf: languageOf };
