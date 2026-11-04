// The print hub program itself (tools/print-hub/bamboo-print-hub.js): what
// it makes of a printer it found (its make and model; office printers left
// out), the printer link it takes, its stand-in for a MAC it cannot see,
// and how it reads an Epson's paper and cover (DLE EOT) — against a
// pretend printer on this computer.
var test = require('node:test');
var assert = require('node:assert/strict');
var net = require('net');
var hub = require('../../tools/print-hub/bamboo-print-hub.js');

test('what it is: make and model from what the printer says; office printers left out', function () {
  assert.deepEqual(hub.identify(['EPSON TM-T20III', ''], '02:00:c0:a8:01:32'), { make: 'epson', model: 'TM-T20III' });
  assert.deepEqual(hub.identify(['EPSON Built-in 10Base-T/100Base-TX Print Server', 'TM-m30II'], 'x'), { make: 'epson', model: 'TM-m30II' });
  assert.deepEqual(hub.identify(['Star Micronics TSP143IIILAN'], 'x'), { make: 'star', model: 'TSP143IIILAN' });
  assert.deepEqual(hub.identify(['', 'Star mC-Print3 MCP31L'], 'x'), { make: 'star', model: 'mC-Print3' });
  // Nothing said: the network card's maker, else any receipt printer.
  assert.deepEqual(hub.identify([''], '00:26:ab:11:22:33'), { make: 'epson', model: '' });
  assert.deepEqual(hub.identify([''], '00:11:62:11:22:33'), { make: 'star', model: '' });
  assert.deepEqual(hub.identify([''], '7c:2e:0d:11:22:33'), { make: 'escpos', model: '' });
  for (var office of ['HP LaserJet Pro M404dn', 'Canon iR-ADV C3530', 'Brother HL-L2350DW series', 'EPSON WF-C5790 Series', 'Kyocera ECOSYS M2540dn']) {
    assert.equal(hub.identify([office], 'x'), null, office);
  }
});

test('the printer link: as Till settings gives it, or the hub\'s own; a stand-in MAC', function () {
  assert.equal(hub.hubUrlOf('https://bamboo-os.onrender.com/api/cloudprnt/abcdefghijklmnopqrstuv'), 'https://bamboo-os.onrender.com/api/print-hub/abcdefghijklmnopqrstuv');
  assert.equal(hub.hubUrlOf(' https://x.example.com/api/print-hub/abcdefghijklmnopqrstuv/ '), 'https://x.example.com/api/print-hub/abcdefghijklmnopqrstuv');
  assert.equal(hub.hubUrlOf('https://x.example.com/api/cloudprnt/short'), '');
  assert.equal(hub.hubUrlOf('not a link'), '');
  assert.equal(hub.standInMac('192.168.1.50'), '02:00:c0:a8:01:32');
});

test('how it is: an Epson answers DLE EOT — ready, cover open, out of paper, low; one not there is offline', async function () {
  var answer = [0x12, 0x12];
  var srv = net.createServer(function (s) {
    s.on('data', function (d) { for (var i = 0; i + 2 < d.length; i++) if (d[i] === 0x10 && d[i + 1] === 0x04) s.write(Buffer.from([d[i + 2] === 4 ? answer[1] : answer[0]])); });
    s.on('error', function () {});
  });
  await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
  var p = { ip: '127.0.0.1', port: srv.address().port, make: 'epson' };
  try {
    assert.equal(await hub.checkState(p), 'ok');
    answer = [0x16, 0x12]; assert.equal(await hub.checkState(p), 'cover');
    answer = [0x12, 0x72]; assert.equal(await hub.checkState(p), 'paper');
    answer = [0x12, 0x1e]; assert.equal(await hub.checkState(p), 'low');
    // A Star printer is not asked (it would not answer): there is enough.
    assert.equal(await hub.checkState(Object.assign({}, p, { make: 'star' })), 'ok');
  } finally { await new Promise(function (r) { srv.close(r); }); }
  assert.equal(await hub.checkState(p), 'offline');
});
