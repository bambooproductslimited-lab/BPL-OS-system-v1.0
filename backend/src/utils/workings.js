// The working behind a billed line, written under it on the invoice (the
// line's notes — shown on the preview, the PDF and the share page), so a
// tenant can check the sum: the meter readings and units × rate, or the
// period and, for a part period, the days. Plain characters only (– × ÷):
// the PDF's built-in font has no arrows.

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function day(d) {
  var s = String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-');
  return Number(s[2]) + ' ' + MONTHS[Number(s[1]) - 1] + ' ' + s[0];
}
function num(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 3 }); }
function cash(n, currency) {
  return (currency || 'GHS') + ' ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }

// r: a meter reading with its meter (utility_type, measure_unit, meter_number).
function meterWorking(r, currency) {
  var unit = r.measure_unit;
  return [
    day(r.period_start) + ' – ' + day(r.period_end) + (r.meter_number ? ' · meter ' + r.meter_number : ''),
    'Reading ' + num(r.current_reading) + ' – last reading ' + num(r.previous_reading) + ' = ' + num(r.consumption) + ' ' + unit + ' used',
    num(r.consumption) + ' ' + unit + ' × ' + cash(r.rate, currency) + ' per ' + unit + ' = ' + cash(round2(Number(r.consumption) * Number(r.rate)), currency)
  ].join('\n');
}

// A recurring charge's period; a part period shows the pro rata sum.
function periodWorking(charge, pd, currency) {
  var lines = [day(pd.start) + ' – ' + day(pd.end) + ' (' + charge.frequency + ')'];
  if (pd.part) {
    lines.push('Part period: ' + pd.daysUsed + ' of ' + pd.daysFull + ' days');
    lines.push(cash(charge.amount, currency) + ' × ' + pd.daysUsed + ' ÷ ' + pd.daysFull + ' = ' + cash(pd.amount, currency));
  }
  return lines.join('\n');
}

module.exports = { meterWorking: meterWorking, periodWorking: periodWorking, day: day, cash: cash };
