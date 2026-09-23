var attendanceService = require('../services/attendance.service');

// Runs the automatic clock-out (attendance.service.js's closeOverdueShifts)
// in the background, so a shift nobody clocked out of is closed at its
// limit whether or not anyone taps the kiosk — the attendance screens, the
// dashboard's "on duty" figures and payroll all read the closed row.
//
// Every tap runs the same check for that employee first, so this is not what
// the rule depends on; it is what keeps everyone else's view of the day
// right in between. The recorded clock-out is the limit itself, not the time
// this happened to run, so how often it runs changes nothing on the row.
var INTERVAL_MS = 5 * 60 * 1000;

async function runOnce() {
  try {
    var closed = await attendanceService.closeOverdueShifts(attendanceService.resolveOccurredAt(null));
    if (closed.length) console.log('Auto clock-out: closed ' + closed.length + ' shift(s) nobody clocked out of.');
  } catch (e) {
    // A failed run is retried on the next interval; it must never take the
    // server down.
    console.error('Auto clock-out failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 30 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
