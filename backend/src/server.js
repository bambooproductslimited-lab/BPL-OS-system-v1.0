var app = require('./app');
var config = require('./config');
var autoClockOut = require('./jobs/autoClockOut');
var meetingReminders = require('./jobs/meetingReminders');
var morningDigest = require('./jobs/morningDigest');
var dailyAlerts = require('./jobs/dailyAlerts');
var attendanceFeeds = require('./jobs/attendanceFeeds');
var crmJobs = require('./jobs/crm');
var mkRoutines = require('./jobs/mkRoutines');
var onlineScheduled = require('./jobs/onlineScheduled');
var guestCampaigns = require('./jobs/campaigns');
var closeDayJob = require('./jobs/closeDay');

app.listen(config.port, function () {
  console.log('Bamboo OS backend listening on port ' + config.port + ' (' + config.nodeEnv + ')');
  autoClockOut.start();
  meetingReminders.start();
  morningDigest.start();
  dailyAlerts.start();
  attendanceFeeds.start();
  crmJobs.start();
  mkRoutines.start();
  onlineScheduled.start();
  guestCampaigns.start();
  closeDayJob.start();
  require('./services/whatsappAccess').load();
});
