var campaigns = require('../services/restaurantCampaigns.service');

// Texts and emails to restaurant guests (restaurantCampaigns.service.js):
// campaigns whose time has come, any left over from yesterday's limit, and
// the automatic ones (we miss you, happy birthday, thank you for coming),
// every ten minutes within each restaurant's hours.
var INTERVAL_MS = 10 * 60 * 1000;

async function runOnce() {
  try {
    var r = await campaigns.runDue();
    if (r.automatic) console.log('Guest messages: ' + r.automatic + ' automatic sent.');
  } catch (e) {
    // Tried again on the next round; it must never take the server down.
    console.error('Guest messages failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 90 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
