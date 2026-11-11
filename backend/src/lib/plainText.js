// A ticket's line for a printer that has only some letters — a dish named
// in Chinese and English ("宫保鸡丁 Kung Pao chicken") on a printer, or in a
// picture drawn with a font (lib/ticketFont.js), that has no Chinese
// letters prints its English part ("Kung Pao chicken") rather than a row of
// '?'. The same rule as the till's (frontend lib/thermalPrinter.js
// plainLine), which lays the lines out: keep the two alike.

// How many columns a text takes on paper: Chinese, Japanese and Korean
// letters two each, marks that sit on a letter (Thai vowels and tones,
// accents) none, the rest one.
function letterWidth(cp) {
  if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x0e31 || (cp >= 0x0e34 && cp <= 0x0e3a) || (cp >= 0x0e47 && cp <= 0x0e4e) || (cp >= 0x200b && cp <= 0x200f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || cp >= 0x20000) return 2;
  return 1;
}
function textWidth(s) {
  var w = 0;
  for (var ch of String(s == null ? '' : s)) w += letterWidth(ch.codePointAt(0));
  return w;
}

// A line for a printer that has only some letters (can(codePoint)): an
// accented letter it lacks becomes its plain letter; other letters it
// lacks are left out, with the spaces around them — "1 x 宫保鸡丁 Kung Pao
// chicken" prints "1 x Kung Pao chicken". Columns (text two or more spaces
// apart, as twoColumn lays them out) stay where they were. A column left
// with no word of its own ("1 x 宫保鸡丁") keeps a '?' for each letter it
// lacks instead, as before, so the line still says something is there.
function plainColumn(s, can) {
  var t = Array.from(s).map(function (ch) {
    var cp = ch.codePointAt(0);
    if (can(cp)) return { ch: ch, ok: true };
    var base = typeof ch.normalize === 'function' ? ch.normalize('NFD').charAt(0) : '';
    var bcp = base ? base.codePointAt(0) : 0;
    if (bcp >= 0x20 && bcp !== cp && can(bcp)) return { ch: base, ok: true };
    return { ch: ch, ok: false };
  });
  if (t.every(function (x) { return x.ok; })) return t.map(function (x) { return x.ch; }).join('');
  var out = '';
  for (var i = 0; i < t.length; i++) {
    if (t[i].ok) { out += t[i].ch; continue; }
    // A run of letters it lacks, with the spaces between them.
    var e = i;
    for (var k = i + 1; k < t.length; k++) { if (!t[k].ok) e = k; else if (t[k].ch !== ' ') break; }
    var spaceBefore = out.length === 0 || out.charAt(out.length - 1) === ' ';
    i = e;
    if (spaceBefore && i + 1 < t.length && t[i + 1].ch === ' ') i += 1;
    else if (i + 1 >= t.length && out.charAt(out.length - 1) === ' ') out = out.slice(0, -1);
  }
  var words = out.replace(/^\s*(\[[^\]]*\]\s*)?\d+\s*x(\s|$)/i, '').replace(/\b(GHS|USD|RMB|CNY)\b/g, '');
  if (!/[A-Za-z\u00c0-\u00ff]{2,}/.test(words)) return t.map(function (x) { return x.ok ? x.ch : letterWidth(x.ch.codePointAt(0)) ? '?' : ''; }).join(''); // a mark on a letter (Thai) adds none
  return out;
}
function plainLine(s, can) {
  var parts = String(s == null ? '' : s).split(/( {2,})/); // even: columns, odd: the gaps between them
  for (var p = 0; p < parts.length; p += 2) {
    var was = parts[p], now = plainColumn(was, can);
    if (now === was) continue;
    parts[p] = now;
    var lost = textWidth(was) - textWidth(now);
    if (lost <= 0) continue;
    var pad = new Array(lost + 1).join(' ');
    // The gap after takes it back (the next column stays put); the last
    // column of a line takes it from the gap before (it stays at the right edge).
    if (p + 1 < parts.length && p + 2 < parts.length && parts[p + 2] !== '') parts[p + 1] += pad;
    else if (p >= 2 && parts[p - 2] !== '') parts[p - 1] += pad;
  }
  return parts.join('');
}

module.exports = { plainLine: plainLine, textWidth: textWidth, letterWidth: letterWidth };
