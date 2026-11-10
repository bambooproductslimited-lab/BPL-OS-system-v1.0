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

// Outage mode (1.1): on the restaurant's network, over HTTPS with the hub's
// own certificate authority; the kitchen's tickets kept a day, printed
// once, taken by the kitchen screens, said done.
test('outage mode: its own certificate, the key, tickets printed once and kept, done from a kitchen screen', async function () {
  var fs = require('fs'), os = require('os'), path = require('path'), https = require('https');
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zph-hub-'));
  var cfg = { lanKey: 'zphlankey0000000000000000000000x' };
  var got = [];
  var printer = net.createServer(function (s) { var b = []; s.on('data', function (c) { b.push(c); }); s.on('end', function () { got.push(Buffer.concat(b).toString('latin1')); }); });
  await new Promise(function (r) { printer.listen(0, '127.0.0.1', r); });
  var lan = hub.startLan({ cfg: cfg, dir: dir, port: 0, ips: [], name: 'zph-test' });
  assert.equal(await lan.ready, true);
  function call(method, p, body, key, origin) {
    return new Promise(function (resolve, reject) {
      var data = body ? JSON.stringify(body) : null;
      var headers = { 'Content-Type': 'application/json' };
      if (key) headers['X-Hub-Key'] = key;
      if (origin) headers.Origin = origin;
      var req = https.request({ host: '127.0.0.1', port: lan.port(), path: p, method: method, ca: lan.ca.cert, headers: headers }, function (res) {
        var b = ''; res.on('data', function (c) { b += c; });
        res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) { j = b; } resolve({ status: res.statusCode, headers: res.headers, body: j }); });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  try {
    // Trusted through its own authority; anyone may ask whether it is there.
    var ping = await call('GET', '/lan/ping');
    assert.equal(ping.status, 200);
    assert.equal(ping.body.ca, hub.caFingerprint(lan.ca));
    // A till's page asks first (another site, the restaurant's network).
    var pre = await call('OPTIONS', '/lan/tickets', null, null, 'https://pos.example.test');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    assert.equal(pre.headers['access-control-allow-origin'], 'https://pos.example.test');
    assert.match(pre.headers['access-control-allow-headers'], /X-Hub-Key/);
    // Without the key: nothing.
    assert.equal((await call('GET', '/lan/tickets')).status, 403);
    assert.equal((await call('GET', '/lan/tickets', null, 'wrongkey000000000000000000000000')).status, 403);
    // A ticket from a till: kept, and printed on the kitchen's printer.
    var ticket = { id: 'till-zph-0001:kitchen', stationId: 'k1', station: 'Zph Kitchen', number: 'OFF-0001', tableName: 'Zph T4', items: [{ name: 'Zph light soup', qty: 2, note: 'no pepper' }, { name: '', qty: 1 }] };
    var prints = [{ mac: '02:00:7f:00:00:01', ip: '127.0.0.1', port: printer.address().port, title: 'Zph Kitchen #OFF-0001', data: Buffer.from('ZPH TICKET\n').toString('base64') }];
    var r = await call('POST', '/lan/tickets', { ticket: ticket, prints: prints, from: 'Zph till' }, cfg.lanKey);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.results.map(function (x) { return x.ok; }), [true]);
    assert.deepEqual(r.body.ticket.items.map(function (i) { return [i.name, i.qty, i.note]; }), [['Zph light soup', 2, 'no pepper']]);
    // Sent again (no answer the first time): one ticket, printed once.
    r = await call('POST', '/lan/tickets', { ticket: ticket, prints: prints, from: 'Zph till' }, cfg.lanKey);
    assert.equal(r.body.again, true);
    await new Promise(function (res) { setTimeout(res, 400); });
    assert.deepEqual(got, ['ZPH TICKET\n']);
    // Not a ticket: refused.
    assert.equal((await call('POST', '/lan/tickets', { ticket: { id: 'x', items: [] } }, cfg.lanKey)).status, 400);
    // The kitchen screen takes them, and says done.
    var list = await call('GET', '/lan/tickets?since=0', null, cfg.lanKey);
    assert.deepEqual(list.body.tickets.map(function (t) { return [t.id, t.station, t.from, t.doneAt]; }), [['till-zph-0001:kitchen', 'Zph Kitchen', 'Zph till', null]]);
    var since = list.body.now;
    await new Promise(function (res) { setTimeout(res, 5); });
    // As a page sends it: the id encoded (':' as %3A).
    var done = await call('POST', '/lan/tickets/' + encodeURIComponent('till-zph-0001:kitchen'), { done: true }, cfg.lanKey);
    assert.ok(done.body.ticket.doneAt);
    var changed = await call('GET', '/lan/tickets?since=' + since, null, cfg.lanKey);
    assert.deepEqual(changed.body.tickets.map(function (t) { return !!t.doneAt; }), [true]);
    // The hub started again: the same authority (no device trusts it again), the tickets kept.
    var fp = lan.fingerprint;
    await lan.close();
    lan = hub.startLan({ cfg: cfg, dir: dir, port: 0, ips: [], name: 'zph-test' });
    await lan.ready;
    assert.equal(lan.fingerprint, fp);
    assert.equal((await call('GET', '/lan/tickets?since=0', null, cfg.lanKey)).body.tickets.length, 1);
    // The setup page says how to trust it.
    assert.match(hub.setupPage(lan), /Certificate Trust Settings/);
  } finally {
    await lan.close();
    await new Promise(function (r2) { printer.close(r2); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
