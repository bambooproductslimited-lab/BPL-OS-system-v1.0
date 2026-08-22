// Lightweight client-side CSV export — no library needed for flat tabular
// data, and CSV opens directly in Excel (the "Excel/CSV" export the
// Financial Reports section asks for) without pulling in an xlsx dependency.

function csvCell(v) {
  var s = v === null || v === undefined ? '' : String(v);
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
