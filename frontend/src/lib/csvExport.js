// Lightweight client-side CSV export — no library needed for flat tabular
// data, and CSV opens directly in Excel (the "Excel/CSV" export the
// Financial Reports section asks for) without pulling in an xlsx dependency.

// A cell starting with =, +, -, @, or a tab/CR is interpreted as a formula
// by Excel/Sheets when the CSV is opened — a security review flagged this
// as CSV/formula injection risk, since several exports here include
// free-text fields (attendance notes, expense descriptions, AI-generated
// recommendation text) that could start with one of those characters,
// intentionally or not. Prefixing with a leading apostrophe forces the
// cell to be read as plain text instead, same fix used industry-wide.
var FORMULA_TRIGGER = /^[=+\-@\t\r]/;
function csvCell(v) {
  var s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_TRIGGER.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// rows: array of arrays (one per CSV line) — freeform so a report can mix a
// "metric, value" summary section with a tabular breakdown, same shape as
// FinanceDashboardPage's own inline CSV builder.
export function rowsToCsv(rows) {
  return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
}

export function downloadCsv(filename, csvString) {
  var blob = new Blob(['﻿' + csvString], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
