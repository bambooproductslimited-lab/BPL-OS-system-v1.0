// A ticket for the restaurant's network printers (lib/ticketImage.js draws
// it as a picture with lib/ticketFont.js, which has no Chinese, Thai,
// Japanese or Korean letters): a dish named in two languages prints its
// English part, the columns where they were; a dish named only in letters
// the font lacks still shows a '?' for each, so the line is not blank.
// No database: the drawing alone.
var test = require('node:test');
var assert = require('node:assert/strict');
var ticketImage = require('../src/lib/ticketImage');
var { plainLine, textWidth } = require('../src/lib/plainText');
var { CODE_POINTS } = require('../src/lib/ticketFont');

var HAS = new Set(CODE_POINTS);
function has(cp) { return HAS.has(cp); }

test('two-language dish names keep their English part', function () {
  assert.equal(plainLine('1 x 宫保鸡丁 Kung Pao chicken', has), '1 x Kung Pao chicken');
  assert.equal(plainLine('1 x Kung Pao chicken 宫保鸡丁', has), '1 x Kung Pao chicken');
  assert.equal(plainLine('2 x 비빔밥 Bibimbap', has), '2 x Bibimbap');
  assert.equal(plainLine('[S2] 3 x 冬阴功 Tom Yum', has), '[S2] 3 x Tom Yum');
  assert.equal(plainLine('1 x ラーメン Ramen 🍜', has), '1 x Ramen');
  assert.equal(plainLine('  + 加辣 extra spicy', has), '  + extra spicy');
});

test('a name only in letters the font lacks: a ? for each letter, Thai marks adding none', function () {
  assert.equal(plainLine('1 x 宫保鸡丁', has), '1 x ????');
  assert.equal(plainLine('[S2] 3 x ต้มยำกุ้ง', has), '[S2] 3 x ??????');
});

test('accented letters and the font\'s own signs print as they are', function () {
  assert.equal(plainLine('Crème brûlée – “Merci” ₵ 20', has), 'Crème brûlée – “Merci” ₵ 20');
  assert.equal(plainLine('Café ŝ', has), 'Café s'); // a letter outside the font: its plain letter
});

test('columns stay where the till laid them out (Chinese letters two columns each)', function () {
  // twoColumn on the till: 42 columns, the name 8 + 1 + 8 wide.
  var name = '宫保鸡丁 Kung Pao', qty = '3';
  var laid = name + ' '.repeat(42 - textWidth(name) - qty.length) + qty;
  assert.equal(textWidth(laid), 42);
  var printed = plainLine(laid, has);
  assert.equal(printed.length, 42);
  assert.ok(printed.startsWith('Kung Pao  '));
  assert.ok(printed.endsWith(' 3'));
  var only = '宫保鸡丁' + ' '.repeat(42 - 8 - 2) + '12';
  assert.equal(plainLine(only, has), '????' + ' '.repeat(42 - 4 - 2) + '12');
});

test('the picture of a ticket with a two-language name is drawn like the English-only one', function () {
  function page(name) {
    return ticketImage.rasterPage([{ t: 'line', text: 'GRILL', align: 'center', bold: true, scale: 1 }, { t: 'line', text: '1 x ' + name, align: 'left', bold: true, scale: 1 }], { paperMm: 80 });
  }
  var both = page('宫保鸡丁 Kung Pao chicken'), english = page('Kung Pao chicken');
  assert.equal(both.height, english.height);
  assert.ok(both.bits.equals(english.bits));
  var question = page('宫保鸡丁'), marks = page('????');
  assert.ok(question.bits.equals(marks.bits));
  assert.ok(!both.bits.equals(question.bits));
});
