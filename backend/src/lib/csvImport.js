var { parse } = require('csv-parse/sync');
var { fail } = require('../utils/errors');

// Shared helpers for the "import from spreadsheet" features (Tool Room, IT
// Devices, Employees). Each module's own service does the field mapping —
// this just turns an uploaded CSV into predictable, header-normalized rows.

function normHeader(h) {
  return String(h == null ? '' : h).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Parses a CSV file buffer into an array of rows, each keyed by the
// *normalized* header (lowercase, letters/digits only) so minor spelling/
// casing/punctuation differences in the sheet ("Date Recieve" vs
// "Date Received", trailing "?" in "Who/Where?") don't break field lookup.
function parseCsvBuffer(buffer) {
  var text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM (Excel/Sheets exports often add one)
  var records;
  try {
    records = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
  } catch (e) {
    fail('invalid', 'Could not read that file as CSV — export the sheet as CSV (File → Download → Comma-separated values) and try again.');
  }
  return records.map(function (raw) {
    var norm = {};
    Object.keys(raw).forEach(function (h) { norm[normHeader(h)] = raw[h]; });
    return { raw: raw, norm: norm };
  });
}

// Looks up the first present, non-empty value among several normalized
// header aliases (spreadsheets rarely spell a column the same way twice).
function field(normRow, aliases) {
  for (var i = 0; i < aliases.length; i++) {
    var v = normRow[aliases[i]];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function parseIntLoose(v, fallback) {
  var n = parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseMoneyLoose(v, fallback) {
  var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

// Accepts YYYY-MM-DD, DD/MM/YYYY and DD-MM-YYYY (the common Ghana-locale
// spreadsheet formats). Returns null (not a throw) on anything else so one
// unparseable date doesn't fail a whole import row — callers surface that
// as a per-row warning instead.
function parseDateLoose(v) {
  v = String(v == null ? '' : v).trim();
  if (!v) return null;
  var iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return v;
  var dmy = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    var d = dmy[1].padStart(2, '0'), m = dmy[2].padStart(2, '0'), y = dmy[3];
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) return y + '-' + m + '-' + d;
  }
  return null;
}

module.exports = {
  normHeader: normHeader,
  parseCsvBuffer: parseCsvBuffer,
  field: field,
  parseIntLoose: parseIntLoose,
  parseMoneyLoose: parseMoneyLoose,
  parseDateLoose: parseDateLoose
};
