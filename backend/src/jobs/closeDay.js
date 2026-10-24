var closeDay = require('../services/restaurantCloseDay.service');

// Restaurants that close the day by themselves (restaurantCloseDay.service.js
// runDue): checked every ten minutes; a day ended and not closed is closed,
// told to the managers and emailed.
var INTERVAL_MS = 10 * 60 * 1000;

async function runOnce() {
  try {
    var n = await closeDay.runDue();
    if (n) console.log('Close the day: ' + n + ' closed by themselves.');
  } catch (e) {
    // Tried again on the next round; it must never take the server down.
    console.error('Close the day failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 2 * 60 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
