var app = require('./app');
var config = require('./config');
var autoClockOut = require('./jobs/autoClockOut');
var morningDigest = require('./jobs/morningDigest');
var dailyAlerts = require('./jobs/dailyAlerts');

app.listen(config.port, function () {
  console.log('Bamboo OS backend listening on port ' + config.port + ' (' + config.nodeEnv + ')');
  autoClockOut.start();
  morningDigest.start();
  dailyAlerts.start();
});
