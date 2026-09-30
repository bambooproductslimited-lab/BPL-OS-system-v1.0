var calls = require('../services/calls.service');
var sms = require('../services/sms.service');

// Every minute: meetings starting in the next 15 minutes are announced to
// everyone in their chat, in the OS and (when texts are set up) by SMS; and
// calls everyone has left without hanging up are ended (calls.service.js).
var INTERVAL_MS = 60 * 1000;

async function runOnce() {
  try {
    var r = await calls.remindDue(sms.configured() ? sms.send : null);
    if (r.meetings) console.log('Meeting reminders: ' + r.meetings + ' meeting(s), ' + r.notified + ' notified, ' + r.texted + ' texted.');
    await calls.sweep();
  } catch (e) {
    console.error('Meeting reminders failed:', e.message);
  }
}

function start() {
  setTimeout(runOnce, 20 * 1000).unref();
  setInterval(runOnce, INTERVAL_MS).unref();
}

module.exports = { start: start, runOnce: runOnce };
