// Ported verbatim from kernel.js's V.* validators.
var { fail } = require('./errors');

var V = {
  text: function (v, label, max) {
    v = (v == null ? '' : String(v)).trim();
    if (!v) fail('invalid', label + ' is required.');
    if (max && v.length > max) fail('invalid', label + ' must be under ' + max + ' characters.');
    return v;
  },
  email: function (v) {
    v = V.text(v, 'Email');
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) fail('invalid', 'Enter a valid email address.');
    return v.toLowerCase();
  },
  date: function (v, label) {
    v = V.text(v, label);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('invalid', label + ' must be a valid date.');
    return v;
  },
  time: function (v, label) {
    v = V.text(v, label);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail('invalid', label + ' must be a valid 24-hour time (HH:MM).');
    return v;
  },
  oneOf: function (v, opts, label) {
    if (opts.indexOf(v) < 0) fail('invalid', label + ' is not a valid option.');
    return v;
  }
};

// Ported from kernel.js's businessDays(). holidayDates (optional) is a Set
// of 'YYYY-MM-DD' strings — a public holiday inside the range isn't
// charged against a leave balance, the same reasoning as Sundays already
// not being: nobody would have worked that day regardless. See
// leave.service.js's requestLeave() for where the company's holiday list
// gets loaded and passed in here.
function businessDays(a, b, holidayDates) {
  var s = new Date(a + 'T00:00'), e = new Date(b + 'T00:00'), n = 0;
  if (e < s) return 0;
  while (s <= e) {
    var iso = s.toISOString().slice(0, 10);
    if (s.getDay() !== 0 && !(holidayDates && holidayDates.has(iso))) n++;
    s = new Date(s.getTime() + 86400000);
  }
  return n;
}

module.exports = { V: V, businessDays: businessDays };
