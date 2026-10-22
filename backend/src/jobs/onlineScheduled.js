var online = require('../services/restaurantOnline.service');

// Sends website orders for later to the kitchen when their time to cook
// comes (restaurantOnline.service.js releaseDue): each becomes the open
// order on the till, in the name of whoever confirmed it, and the kitchen
// gets its ticket. The delivery screen does the same for its restaurant
// whenever it looks, so this is what keeps it on time when nobody does.
var INTERVAL_MS = 60 * 1000;

async function runOnce() {
  try {
    var went = await online.releaseDue(null);
    if (went) console.log('Orders for later: ' + went + ' sent to the kitchen.');
  } catch (e) {
    // Tried again on the next interval; it must never take the server down.
    console.error('Orders for later failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 30 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
