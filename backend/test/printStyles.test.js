// Printing from the OS came out blank — every page, every theme — because a
// few stylesheets carried a bare `@media print { body * { visibility:
// hidden } … }` to print their own sheet. Vite loads every stylesheet on
// every page, so each one hid everything else the OS printed. A print rule
// that reaches the whole page has to wait for its own sheet: a class on
// <body> (body.kds-printing, body.has-print-layer) or a :has() (the
// .print-solo sheets, styles/theme.css). This keeps it that way.
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, '../../frontend/src');

function cssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(function (e) {
    var p = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return /\.css$/.test(e.name) ? [p] : [];
  });
}

// The inside of each `@media print { … }`, comments taken out.
function printBlocks(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  var out = [];
  var re = /@media\s+print\s*\{/g;
  var m;
  while ((m = re.exec(css))) {
    var depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

test('no print stylesheet hides the whole page unless its own sheet is being printed', function () {
  var files = cssFiles(SRC);
  assert.ok(files.length > 50, 'the stylesheets were found');
  var bad = [];
  files.forEach(function (f) {
    printBlocks(fs.readFileSync(f, 'utf8')).forEach(function (block) {
      // `body *` or `body > *` with nothing on body to say whose print it is.
      if (/(^|[\s,{}])body\s*(>\s*)?\*/.test(block)) bad.push(path.relative(SRC, f));
      // A whole-screen shell that hides its children on paper must say when:
      // `.pos-shell > *:not(#pos-receipt)` hid the till's table bill.
      if (/(^|[\s,{}])\.pos-shell\s*>\s*\*/.test(block)) bad.push(path.relative(SRC, f) + ' (.pos-shell)');
    });
  });
  assert.deepEqual(bad, []);
});

test('the sheets printed in place are marked to print alone, and the rule for them is scoped', function () {
  var theme = fs.readFileSync(path.join(SRC, 'styles/theme.css'), 'utf8');
  var block = printBlocks(theme).join('\n');
  assert.match(block, /body:has\(\.print-solo\) \*:not\(\.print-solo, \.print-solo \*, :has\(\.print-solo\)\)/);
  [['pages/till/Prep.jsx', 'dialog prp print-solo'], ['pages/till/TableBill.jsx', 'tbill-sheet print-solo'],
    ['pages/DisciplinePage.jsx', 'vz-print dc-letter print-solo'], ['pages/VisitorsPage.jsx', 'vz-print print-solo']].forEach(function (pair) {
    assert.ok(fs.readFileSync(path.join(SRC, pair[0]), 'utf8').includes(pair[1]), pair[0]);
  });
  // The ID cards print from the print layer, where the OS behind is already gone.
  assert.match(fs.readFileSync(path.join(SRC, 'pages/StaffCardsPage.jsx'), 'utf8'), /<PrintLayer onClose=\{onClose\}><div className="idc-print">/);
});

test('every theme prints as the light one, on every site that has a theme', function () {
  var theme = fs.readFileSync(path.join(SRC, 'lib/theme.js'), 'utf8');
  assert.match(theme, /addEventListener\('beforeprint'/);
  assert.match(theme, /addEventListener\('afterprint'/);
  ['main.jsx', 'sites/mountSite.jsx', 'sites/sales.jsx', 'sites/bpl.jsx'].forEach(function (f) {
    assert.match(fs.readFileSync(path.join(SRC, f), 'utf8'), /installPrintTheme\(\)/, f);
  });
});
