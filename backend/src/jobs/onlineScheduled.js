var online = require('../services/restaurantOnline.service');

// Sends website orders for later to the kitchen when their time to cook
// comes (restaurantOnline.service.js releaseDue): each becomes the open
// order on the till, in the name of whoever confirmed it, and the kitchen
// gets its ticket. The delivery screen does the same for its restaurant
// whenever it looks, so this is what keeps it on time when nobody does.
// Every few minutes too: website orders and booking deposits never paid
// online are cancelled (restaurantOnline sweepUnpaid, restaurantBookings
// sweepDeposits).
var INTERVAL_MS = 60 * 1000;
var SWEEP_EVERY = 5;
var ticks = 0;

async function runOnce() {
  try {
    var went = await online.releaseDue(null);
    if (went) console.log('Orders for later: ' + went + ' sent to the kitchen.');
  } catch (e) {
    // Tried again on the next interval; it must never take the server down.
    console.error('Orders for later failed:', e.message);
  }
  if (ticks++ % SWEEP_EVERY) return;
  try {
    var unpaid = await online.sweepUnpaid();
    var deposits = await require('../services/restaurantBookings.service').sweepDeposits();
    if (unpaid || deposits) console.log('Not paid online: ' + unpaid + ' website orders and ' + deposits + ' bookings cancelled.');
  } catch (e) {
    console.error('Unpaid website orders sweep failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 30 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
