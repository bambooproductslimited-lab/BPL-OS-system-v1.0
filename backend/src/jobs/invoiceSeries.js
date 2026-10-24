var invoiceSeries = require('../services/invoiceSeries.service');

// Repeating invoices (invoiceSeries.service.js runDue): checked every half
// hour; a series whose day has come raises that day's invoice, once.
var INTERVAL_MS = 30 * 60 * 1000;

async function runOnce() {
  try {
    var n = await invoiceSeries.runDue();
    if (n) console.log('Repeating invoices: ' + n + ' raised.');
  } catch (e) {
    // Tried again on the next round; it must never take the server down.
    console.error('Repeating invoices failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 3 * 60 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
