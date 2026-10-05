var app = require('./app');
var config = require('./config');
var autoClockOut = require('./jobs/autoClockOut');
var meetingReminders = require('./jobs/meetingReminders');
var morningDigest = require('./jobs/morningDigest');
var dailyAlerts = require('./jobs/dailyAlerts');
var attendanceFeeds = require('./jobs/attendanceFeeds');
var crmJobs = require('./jobs/crm');

app.listen(config.port, function () {
  console.log('Bamboo OS backend listening on port ' + config.port + ' (' + config.nodeEnv + ')');
  autoClockOut.start();
  meetingReminders.start();
  morningDigest.start();
  dailyAlerts.start();
  attendanceFeeds.start();
  crmJobs.start();
});
