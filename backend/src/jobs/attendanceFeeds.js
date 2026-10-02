var feeds = require('../services/attendanceFeeds.service');

// Sends each attendance feed's new changes to its address
// (attendanceFeeds.service.js's deliverDue) every 15 seconds; a feed whose
// site is down is skipped until its next try. The change log is trimmed
// once an hour.
var INTERVAL_MS = 15 * 1000;
var PRUNE_EVERY = 240; // runs: once an hour

var runs = 0;
async function runOnce() {
  try {
    var out = await feeds.deliverDue();
    out.filter(function (r) { return r.failed; }).forEach(function (r) { console.error('Attendance feed ' + r.feedId + ': ' + r.error); });
    if (++runs % PRUNE_EVERY === 1) await feeds.prune();
  } catch (e) {
    // Tried again on the next run; never takes the server down.
    console.error('Attendance feeds failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 20 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
