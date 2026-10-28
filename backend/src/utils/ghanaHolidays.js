// Ghana's statutory public holidays for a year (the Public Holidays and
// Commemorative Days Act, 2001 (Act 601), as amended in 2019 and 2025):
// the fixed days, Easter, Farmers' Day (the first Friday of December) and
// the Muslim feasts. The Eids follow the moon and the Office of the Chief
// Imam announces them each year, so they come out as estimates (the
// tabular Islamic calendar is a day or two either way) for someone to
// confirm. A holiday on a Saturday or Sunday is observed on the next
// weekday that is not already one.

var FIXED = [
  ['01-01', "New Year's Day"],
  ['01-07', 'Constitution Day'],
  ['03-06', 'Independence Day'],
  ['05-01', 'May Day'],
  ['07-01', 'Republic Day'],
  ['09-21', "Founders' Day"],
  ['12-25', 'Christmas Day'],
  ['12-26', 'Boxing Day']
];

function iso(d) { return d.toISOString().slice(0, 10); }
function utc(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
function addDays(day, n) { return iso(new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000)); }
function weekday(day) { return new Date(day + 'T00:00:00Z').getUTCDay(); }

// Easter Sunday (the anonymous Gregorian computus).
function easter(y) {
  var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(utc(y, month, day));
}

// A date of the tabular Islamic calendar as a Gregorian day.
function hijriToIso(hy, hm, hd) {
  var jd = hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 + Math.floor((3 + 11 * hy) / 30) + 1948439.5 - 1;
  return iso(new Date((jd - 2440587.5) * 86400000));
}

// Every Gregorian day in year y that is the given Hijri month and day.
function hijriInYear(y, hm, hd) {
  var approx = Math.floor((y - 622) * 33 / 32);
  var out = [];
  for (var hy = approx - 1; hy <= approx + 2; hy++) {
    var day = hijriToIso(hy, hm, hd);
    if (day.slice(0, 4) === String(y)) out.push(day);
  }
  return out;
}

function firstFridayOfDecember(y) {
  var d = utc(y, 12, 1);
  while (d.getUTCDay() !== 5) d = new Date(d.getTime() + 86400000);
  return iso(d);
}

// [{ date, name, estimated }] in date order.
function ghanaHolidays(year) {
  var y = Number(year);
  if (!(y >= 2000 && y <= 2100)) throw new Error('A year between 2000 and 2100.');
  var list = FIXED.map(function (f) { return { date: y + '-' + f[0], name: f[1], estimated: false }; });
  var e = easter(y);
  list.push({ date: addDays(e, -2), name: 'Good Friday', estimated: false });
  list.push({ date: addDays(e, 1), name: 'Easter Monday', estimated: false });
  list.push({ date: firstFridayOfDecember(y), name: "Farmers' Day", estimated: false });
  hijriInYear(y, 10, 1).forEach(function (d) {
    list.push({ date: d, name: 'Eid al-Fitr', estimated: true });
    list.push({ date: addDays(d, 1), name: 'Shaqq Day', estimated: true });
  });
  hijriInYear(y, 12, 10).forEach(function (d) { list.push({ date: d, name: 'Eid al-Adha', estimated: true }); });
  // Shaqq Day after an Eid on the 31st of December lands in the next year.
  list = list.filter(function (h) { return h.date.slice(0, 4) === String(y); });
  list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  // A weekend holiday is observed on the next free weekday.
  var taken = {};
  list.forEach(function (h) { taken[h.date] = true; });
  var moved = [];
  list.forEach(function (h) {
    var wd = weekday(h.date);
    if (wd !== 0 && wd !== 6) return;
    var d = addDays(h.date, wd === 6 ? 2 : 1);
    while (taken[d] || weekday(d) === 0 || weekday(d) === 6) d = addDays(d, 1);
    if (d.slice(0, 4) !== String(y)) return;
    taken[d] = true;
    moved.push({ date: d, name: h.name + ' (observed)', estimated: h.estimated });
  });
  return list.concat(moved).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

module.exports = { ghanaHolidays: ghanaHolidays, easter: easter, hijriInYear: hijriInYear };
