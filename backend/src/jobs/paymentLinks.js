var links = require('../services/paymentLinks.service');

// Payment links (paymentLinks.service.js sweep): invoices raised from a link
// and left unpaid, voided after three days; checked every hour.
var INTERVAL_MS = 60 * 60 * 1000;

async function runOnce() {
  try {
    var n = await links.sweep();
    if (n) console.log('Payment links: ' + n + ' unpaid invoices voided.');
  } catch (e) {
    // Tried again on the next round; it must never take the server down.
    console.error('Payment links sweep failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 5 * 60 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
