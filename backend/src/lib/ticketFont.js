// The letters printed on kitchen tickets, receipts and bills sent to the
// restaurant's network printers (lib/ticketImage.js draws each ticket as a
// picture). A bitmap of DejaVu Sans Mono (Bitstream Vera licence, free to
// use and embed), regular and bold, in 12x24 dots (the size of a receipt
// printer's own letters) and 24x48 (double size), made by
// scripts in development from the font itself. Packed 1 bit per dot, rows
// left to right, zlib-compressed. Letters outside the set print as '?'.
var zlib = require('zlib');

var CODE_POINTS = [32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,125,126,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255,8216,8217,8220,8221,8211,8212,8226,8230,8364,8594,10003,8373];
var DATA =
  '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';

var fonts = null;
function load() {
  if (fonts) return fonts;
  var all = zlib.inflateSync(Buffer.from(DATA, 'base64'));
  var index = new Map(CODE_POINTS.map(function (c, i) { return [c, i]; }));
  var at = 0;
  fonts = {};
  [['r12', 12, 24], ['b12', 12, 24], ['r24', 24, 48], ['b24', 24, 48]].forEach(function (f) {
    var size = Math.ceil(f[1] / 8) * f[2];
    fonts[f[0]] = { w: f[1], h: f[2], rowBytes: Math.ceil(f[1] / 8), size: size, data: all.subarray(at, at + size * CODE_POINTS.length), index: index };
    at += size * CODE_POINTS.length;
  });
  return fonts;
}
// The font for a weight and size: { w, h, glyph(codePoint) -> Buffer of rows }.
function font(bold, big) {
  var f = load()[(bold ? 'b' : 'r') + (big ? '24' : '12')];
  return {
    w: f.w, h: f.h, rowBytes: f.rowBytes,
    glyph: function (cp) {
      var i = f.index.has(cp) ? f.index.get(cp) : f.index.get(63);
      return f.data.subarray(i * f.size, (i + 1) * f.size);
    }
  };
}

module.exports = { font: font, CODE_POINTS: CODE_POINTS };
