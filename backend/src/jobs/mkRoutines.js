var routines = require('../services/mkRoutines.service');

// Marketing request routines (mkRoutines.service.js): a minute after start,
// then every half hour, make the requests whose day has come, then send the
// reminders that are due (from 07:00).
var EVERY_MS = 30 * 60 * 1000;

async function run() {
  try {
    var n = await routines.runDue();
    if (n) console.log('[mk] routines made ' + n + ' request(s)');
  } catch (err) {
    console.error('[mk] routines failed:', err.message);
  }
  try {
    var r = await routines.remind();
    if (r.ahead || r.due) console.log('[mk] routine reminders: ' + r.ahead + ' heads-up(s), ' + r.due + ' due');
  } catch (err) {
    console.error('[mk] routine reminders failed:', err.message);
  }
}

function start() {
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, EVERY_MS).unref();
}

module.exports = { start: start, run: run };
