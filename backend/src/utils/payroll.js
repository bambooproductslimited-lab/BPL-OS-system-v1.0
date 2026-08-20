// PAYE income tax: applies a graduated band table (settings.payroll.payeBands
// — see referenceData.js's defaultPayroll()) to a taxable income amount.
// Bands are stored as widths ("first 490 @0%, next 110 @5%, ...", GRA's own
// presentation), scaled by periodScale so a pay period shorter than a full
// month (e.g. biweekly) doesn't get taxed as if the whole month's bands
// applied to half a month's income — a documented approximation (prorate
// each band by period-length ÷ 30), not an official GRA period table.
function computePaye(taxableIncome, bands, periodScale) {
  var remaining = Math.max(0, Number(taxableIncome) || 0);
  var scale = periodScale > 0 ? periodScale : 1;
  var tax = 0;
  for (var i = 0; i < bands.length && remaining > 0; i++) {
    var band = bands[i];
    var width = band.width == null ? remaining : band.width * scale;
    var amountInBand = Math.min(remaining, width);
    tax += amountInBand * (band.rate / 100);
    remaining -= amountInBand;
  }
  return Math.round(tax * 100) / 100;
}

module.exports = { computePaye: computePaye };
