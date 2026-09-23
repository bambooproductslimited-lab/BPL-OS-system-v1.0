var app = require('./app');
var config = require('./config');
var autoClockOut = require('./jobs/autoClockOut');

app.listen(config.port, function () {
  console.log('Bamboo OS backend listening on port ' + config.port + ' (' + config.nodeEnv + ')');
  autoClockOut.start();
});
