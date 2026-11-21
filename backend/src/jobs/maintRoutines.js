var mwo = require('../services/maintenanceWorkOrders.service');

// Maintenance and IT (maintenanceWorkOrders.service.js): a minute after
// start, then every half hour, each routine whose next day is close becomes
// a work order for whoever does it; then, from 06:00, the morning list goes
// to each person with jobs today (once a day each).
var EVERY_MS = 30 * 60 * 1000;

async function run() {
  try {
    var n = await mwo.runDue();
    if (n) console.log('[maint] routines made ' + n + ' work order(s)');
  } catch (err) {
    console.error('[maint] routines failed:', err.message);
  }
  try {
    var told = await mwo.morning();
    if (told) console.log('[maint] morning list sent to ' + told + ' person(s)');
  } catch (err) {
    console.error('[maint] morning list failed:', err.message);
  }
}

function start() {
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, EVERY_MS).unref();
}

module.exports = { start: start, run: run };
