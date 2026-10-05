var inbox = require('../services/crmInbox.service');
var email = require('../services/crmEmail.service');
var meta = require('../services/crmMeta.service');
var health = require('../services/crmHealth.service');

// The CRM's background work:
//   every 3 minutes — read new email and Facebook/Instagram messages;
//   every hour     — phone numbers on profiles become identities, and look-alike profiles are found;
//   from 8 a.m.    — sales managers are told once a day about customers with no rep.
var SYNC_MS = 3 * 60 * 1000;
var HOUR_MS = 60 * 60 * 1000;
var syncing = false;

async function syncChannels() {
  if (syncing) return;
  syncing = true;
  try {
    var e = await email.sync();
    if (e.error) console.error('[crm] email:', e.error);
    var m = await meta.sync();
    ['facebook', 'instagram'].forEach(function (k) { if (m[k] && m[k].error) console.error('[crm] ' + k + ':', m[k].error); });
  } catch (err) {
    console.error('[crm] channel sync failed:', err.message);
  } finally {
    syncing = false;
  }
}

async function hourly() {
  try {
    await inbox.backfillIdentities();
    await health.scanDuplicates();
    if (new Date().getUTCHours() >= 8) await health.raiseCoverageConcern();
  } catch (err) {
    console.error('[crm] hourly work failed:', err.message);
  }
}

function start() {
  setTimeout(syncChannels, 45 * 1000).unref();
  setInterval(syncChannels, SYNC_MS).unref();
  setTimeout(hourly, 90 * 1000).unref();
  setInterval(hourly, HOUR_MS).unref();
}

module.exports = { start: start, syncChannels: syncChannels, hourly: hourly };
