#!/usr/bin/env node
// Bamboo print hub — runs on one computer that stays on at the restaurant
// (Windows, Mac, Linux or a Raspberry Pi), on the same network as the
// printers. It finds the receipt printers on the network by itself — Epson,
// Star Micronics and the other receipt printers with a network cable that
// take tickets on port 9100 — tells Bamboo OS about them (they show up in
// Till settings → Printers, to be named), and prints their tickets. Nothing
// is set on the printers.
//
//   bamboo-print-hub [printer link]
//
// The printer link is the one in Till settings → Printers. Asked for the
// first time it runs, then kept in bamboo-print-hub.json next to it.
// No other files, no other programs: Node.js 18 or newer (built in to the
// Windows .exe).
//
// How it finds printers: every minute it tries port 9100 on each address of
// the network this computer is on (192.168.1.1 to .254, say); what answers is
// a printer. Then what it is: its network card's maker (from the computer's
// address table), what it says of itself over SNMP, and its web page. Office
// printers (HP, Canon, Brother…) are left out. Printers on other networks:
// add their addresses to "extraHosts" in bamboo-print-hub.json.
//
// How it prints: every few seconds it asks Bamboo OS for tickets
// (/api/print-hub/<token>); each comes as the printer's own bytes (an
// ESC/POS picture for Epson and most others, Star raster for Star), sent
// to the printer as they are; then it says printed, or why not.

'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var dgram = require('dgram');
var http = require('http');
var crypto = require('crypto');
var readline = require('readline');
var childProcess = require('child_process');

var VERSION = '1.0.0';
var PORT = 9100;
var STATUS_PORT = 9180;      // http://localhost:9180 — what the hub sees; one hub per computer
var SCAN_CONCURRENCY = 64;
var CONNECT_MS = 700;
var CHECK_EVERY_MS = 20000;  // each printer looked at again
var MAX_HOSTS = 1024;        // a big office network: only the computer's own /24 then

// ── where it keeps its settings ────────────────────────────────────────
function isSea() { try { return require('node:sea').isSea(); } catch (e) { return false; } }
var HOME_DIR = isSea() ? path.dirname(process.execPath) : __dirname;
var CONFIG = path.join(HOME_DIR, 'bamboo-print-hub.json');
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { return {}; } }
function saveConfig(c) {
  try { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)); }
  catch (e) { say('Could not save the settings in ' + CONFIG + ' (' + e.message + '). They are kept until the hub stops.'); }
}

function stamp() { var d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
function say(text) { console.log('[' + stamp() + '] ' + text); }

// ── the printer link ───────────────────────────────────────────────────
var LINK_RE = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?\/api\/(?:cloudprnt|print-hub)\/([A-Za-z0-9_-]{16,64})\/?$/;
function hubUrlOf(link) {
  var s = String(link || '').trim();
  if (!LINK_RE.test(s)) return '';
  return s.replace(/\/$/, '').replace('/api/cloudprnt/', '/api/print-hub/');
}
function ask(question) {
  return new Promise(function (resolve) {
    var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, function (a) { rl.close(); resolve(a); });
  });
}

// ── the networks this computer is on ───────────────────────────────────
function ipToInt(ip) { return ip.split('.').reduce(function (a, n) { return ((a << 8) >>> 0) + Number(n); }, 0) >>> 0; }
function intToIp(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
function networks() {
  var out = [];
  var ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (name) {
    (ifs[name] || []).forEach(function (a) {
      if (a.family !== 'IPv4' && a.family !== 4) return;
      if (a.internal || /^169\.254\./.test(a.address)) return;
      var ip = ipToInt(a.address), mask = ipToInt(a.netmask || '255.255.255.0');
      var bits = mask.toString(2).replace(/0/g, '').length;
      // A big network: only the 254 addresses around this computer.
      if (Math.pow(2, 32 - bits) > MAX_HOSTS) { bits = 24; mask = ipToInt('255.255.255.0'); }
      var base = (ip & mask) >>> 0, size = Math.pow(2, 32 - bits);
      out.push({ name: name, address: a.address, cidr: intToIp(base) + '/' + bits, first: base + 1, last: base + size - 2, self: ip });
    });
  });
  return out;
}

// ── is anything there? ─────────────────────────────────────────────────
function tryConnect(host, port, ms) {
  return new Promise(function (resolve) {
    var s = net.connect({ host: host, port: port });
    var done = function (ok) { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(ms, function () { done(false); });
    s.once('connect', function () { done(true); });
    s.once('error', function () { done(false); });
  });
}
async function pool(items, n, fn) {
  var i = 0, out = [];
  async function worker() { while (i < items.length) { var k = i++; out[k] = await fn(items[k], k); } }
  var ws = [];
  for (var w = 0; w < Math.min(n, items.length); w++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

// ── who it is: its MAC address, from this computer's address table ─────
function arpTable() {
  var table = {};
  try {
    if (process.platform === 'linux' && fs.existsSync('/proc/net/arp')) {
      fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1).forEach(function (l) {
        var p = l.trim().split(/\s+/);
        if (p.length >= 4 && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p[3]) && p[3] !== '00:00:00:00:00:00') table[p[0]] = p[3].toLowerCase();
      });
      return table;
    }
    var outp = childProcess.execFileSync('arp', ['-a'].concat(process.platform === 'win32' ? [] : ['-n']), { encoding: 'utf8', timeout: 5000, windowsHide: true });
    outp.split(/\r?\n/).forEach(function (l) {
      var ip = (l.match(/(\d{1,3}(?:\.\d{1,3}){3})/) || [])[1];
      var mac = (l.match(/([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}/i) || [])[0];
      if (!ip || !mac) return;
      mac = mac.toLowerCase().replace(/-/g, ':').split(':').map(function (x) { return ('0' + x).slice(-2); }).join(':');
      if (mac !== 'ff:ff:ff:ff:ff:ff' && mac !== '00:00:00:00:00:00') table[ip] = mac;
    });
  } catch (e) { /* no address table: a stand-in below */ }
  return table;
}
// A printer on another network (no MAC to be seen): a stand-in from its
// address, marked as made up (the 02 at the start), the same each time.
function standInMac(ip) { return '02:00:' + ip.split('.').map(function (n) { return ('0' + Number(n).toString(16)).slice(-2); }).join(':'); }

// Network cards' makers (the first half of the MAC).
var OUI = {
  '00:11:62': 'star',
  '00:00:48': 'epson', '00:26:ab': 'epson', '64:eb:8c': 'epson', '38:1a:52': 'epson', 'a4:ee:57': 'epson',
  '44:d2:44': 'epson', 'ac:18:26': 'epson', '9c:ae:d3': 'epson', 'b0:e8:92': 'epson'
};

// ── what it says of itself: SNMP (v1, community "public") ──────────────
function berLen(n) { return n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]; }
function berTlv(tag, body) { return [tag].concat(berLen(body.length), body); }
function oidBytes(oid) {
  var p = oid.split('.').map(Number), out = [40 * p[0] + p[1]];
  p.slice(2).forEach(function (v) {
    var st = [v & 127]; v = Math.floor(v / 128);
    while (v > 0) { st.unshift((v & 127) | 128); v = Math.floor(v / 128); }
    out = out.concat(st);
  });
  return out;
}
function snmpGet(host, oids, ms) {
  return new Promise(function (resolve) {
    var id = crypto.randomInt(1, 0x7fffffff);
    var vbs = [];
    oids.forEach(function (o) { vbs = vbs.concat(berTlv(0x30, berTlv(0x06, oidBytes(o)).concat([0x05, 0x00]))); });
    var idBytes = [(id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255];
    var pdu = berTlv(0xa0, berTlv(0x02, idBytes).concat([0x02, 0x01, 0x00, 0x02, 0x01, 0x00], berTlv(0x30, vbs)));
    var msg = Buffer.from(berTlv(0x30, [0x02, 0x01, 0x00].concat(berTlv(0x04, Array.from(Buffer.from('public'))), pdu)));
    var sock = dgram.createSocket('udp4');
    var timer = setTimeout(function () { try { sock.close(); } catch (e) { /* closed */ } resolve([]); }, ms);
    sock.on('error', function () { clearTimeout(timer); try { sock.close(); } catch (e) { /* closed */ } resolve([]); });
    sock.on('message', function (buf) {
      clearTimeout(timer);
      try { sock.close(); } catch (e) { /* closed */ }
      // Every OCTET STRING in the answer after the community: the values.
      var texts = [], i = 0, seenCommunity = false;
      function len(at) { var b = buf[at]; if (b < 128) return [b, 1]; var n = b & 127, v = 0; for (var k = 1; k <= n; k++) v = v * 256 + buf[at + k]; return [v, n + 1]; }
      while (i < buf.length) {
        var tag = buf[i], L = len(i + 1), start = i + 1 + L[1];
        if (tag === 0x30 || (tag & 0xe0) === 0xa0) { i = start; continue; }
        if (tag === 0x04) { if (seenCommunity) texts.push(buf.subarray(start, start + L[0]).toString('latin1')); seenCommunity = true; }
        i = start + L[0];
      }
      resolve(texts);
    });
    sock.send(msg, 161, host, function (e) { if (e) { clearTimeout(timer); try { sock.close(); } catch (x) { /* closed */ } resolve([]); } });
  });
}

// ── and its web page's title ───────────────────────────────────────────
function webTitle(host, ms) {
  return new Promise(function (resolve) {
    var req = http.get({ host: host, port: 80, path: '/', timeout: ms, headers: { 'User-Agent': 'BambooPrintHub/' + VERSION } }, function (res) {
      var body = '';
      res.setEncoding('latin1');
      res.on('data', function (c) { if (body.length < 20000) body += c; });
      res.on('end', function () {
        var t = (body.match(/<title[^>]*>([^<]{0,120})<\/title>/i) || [])[1] || '';
        resolve((t + ' ' + (res.headers.server || '')).trim());
      });
    });
    req.on('timeout', function () { req.destroy(); resolve(''); });
    req.on('error', function () { resolve(''); });
  });
}

var OFFICE = /hewlett|\bhp\b|laserjet|officejet|deskjet|designjet|canon|brother|ricoh|xerox|kyocera|lexmark|konica|minolta|sharp mx|samsung (?:ml|clx|scx|m\d)|\boki\b|pantum|e-studio|epson (?:wf|et|l\d|xp|sc-|ds-|ep-)|workforce|ecotank/i;
function identify(texts, mac) {
  var all = texts.join(' | ');
  if (OFFICE.test(all)) return null; // an office printer: not for tickets
  var make = /star micronics|\bstar\b|tsp\d|mc-print|\bsp7\d\d|\bsm-[lst]\d|\btup\d/i.test(all) ? 'star'
    : /epson|\btm-[a-z]*\d/i.test(all) ? 'epson'
      : OUI[mac.slice(0, 8)] || 'escpos';
  var model = (all.match(/\b(TM-[A-Z]*\d+[A-Z0-9-]*(?:\s?I{2,3}V?|\s?IV|\s?V)?)/i) || all.match(/\b(TSP\d+[A-Z0-9]*(?:\s?I{2,3}V?)?(?:LAN)?|mC-Print\d|SP7\d\d|SM-[LST]\d+[A-Z0-9]*|TUP\d+)/i) || [])[1] || '';
  return { make: make, model: model.replace(/\s+/g, ' ').trim().slice(0, 60) };
}

// ── how it is (Epson and most others: DLE EOT) ─────────────────────────
function talk(host, port, bytes, wantBytes, ms) {
  return new Promise(function (resolve) {
    var got = [], s = net.connect({ host: host, port: port });
    var finish = function (ok) { s.removeAllListeners(); s.destroy(); resolve({ ok: ok, data: Buffer.from(got) }); };
    s.setTimeout(ms, function () { finish(true); });
    s.once('error', function () { finish(false); });
    s.once('connect', function () { s.write(Buffer.from(bytes)); if (!wantBytes) finish(true); });
    s.on('data', function (d) { for (var i = 0; i < d.length; i++) got.push(d[i]); if (got.length >= wantBytes) finish(true); });
  });
}
async function checkState(p) {
  if (p.make === 'star') return (await tryConnect(p.ip, p.port, 1500)) ? 'ok' : 'offline';
  // DLE EOT 2 (why it stopped: cover open?) and DLE EOT 4 (the paper roll).
  var r = await talk(p.ip, p.port, [0x10, 0x04, 0x02, 0x10, 0x04, 0x04], 2, 1500);
  if (!r.ok) return 'offline';
  if (r.data.length < 2) return 'ok'; // it does not say: there and taking tickets
  var cause = r.data[0], paper = r.data[1];
  if (cause & 0x04) return 'cover';
  if ((paper & 0x60) === 0x60) return 'paper';
  if ((paper & 0x0c) === 0x0c) return 'low';
  return 'ok';
}

// ── the printers it knows ──────────────────────────────────────────────
var printers = new Map(); // mac -> { mac, ip, port, make, model, state, busy }
function chain(p, fn) {
  var next = (p.busy || Promise.resolve()).then(fn, fn);
  p.busy = next.catch(function () { /* each its own */ });
  return next;
}

async function scan(cfg) {
  var nets = networks();
  var hosts = [];
  nets.forEach(function (n) { for (var a = n.first; a <= n.last; a++) if (a !== n.self) hosts.push({ host: intToIp(a), port: PORT }); });
  (cfg.extraHosts || []).concat(String(process.env.BAMBOO_HUB_HOSTS || '').split(',')).forEach(function (h) {
    var m = String(h || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d+))?$/);
    if (m) hosts.push({ host: m[1], port: Number(m[2] || PORT), extra: true });
  });
  if (process.env.BAMBOO_HUB_ONLY_EXTRA === '1') hosts = hosts.filter(function (h) { return h.extra; });
  var open = (await pool(hosts, SCAN_CONCURRENCY, async function (h) { return (await tryConnect(h.host, h.port, CONNECT_MS)) ? h : null; })).filter(Boolean);
  var arp = arpTable();
  var found = 0;
  await pool(open, 8, async function (h) {
    var mac = arp[h.host] || standInMac(h.host);
    var known = printers.get(mac);
    if (known && known.make) { known.ip = h.host; known.port = h.port; return; }
    var who = identify((await snmpGet(h.host, ['1.3.6.1.2.1.25.3.2.1.3.1', '1.3.6.1.2.1.1.1.0'], 1200)).concat([await webTitle(h.host, 1500)]), mac);
    if (!who) return;
    printers.set(mac, { mac: mac, ip: h.host, port: h.port, make: who.make, model: who.model, state: 'ok', busy: null, checkedAt: Date.now() });
    found++;
    say('Found ' + ({ star: 'a Star printer', epson: 'an Epson printer', escpos: 'a receipt printer' })[who.make] + (who.model ? ' (' + who.model + ')' : '') + ' at ' + h.host + '.');
  });
  // One no longer answering on its old address may have a new one: offline until found again.
  printers.forEach(function (p) { if (!open.some(function (h) { return h.host === p.ip && h.port === p.port; })) p.state = 'offline'; });
  return { networks: nets.map(function (n) { return n.cidr; }).join(', '), open: open.length, found: found };
}

async function checkAll() {
  var list = Array.from(printers.values()).filter(function (p) { return Date.now() - (p.checkedAt || 0) >= CHECK_EVERY_MS; });
  await Promise.all(list.map(function (p) {
    return chain(p, async function () {
      var before = p.state;
      p.state = await checkState(p);
      p.checkedAt = Date.now();
      if (before !== p.state) say((p.model || p.ip) + ' at ' + p.ip + ': ' + ({ ok: 'ready', low: 'paper running low', paper: 'out of paper', cover: 'cover open', offline: 'not answering', error: 'not ready' })[p.state] + '.');
    });
  }));
}

// ── printing ───────────────────────────────────────────────────────────
function send(ip, port, data) {
  return new Promise(function (resolve) {
    var s = net.connect({ host: ip, port: port });
    var settled = false;
    var finish = function (err) { if (settled) return; settled = true; s.removeAllListeners(); s.destroy(); resolve(err || null); };
    s.setTimeout(15000, function () { finish('The printer did not take the ticket in time'); });
    s.once('error', function (e) { finish(e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH' || e.code === 'ETIMEDOUT' ? 'Could not reach the printer' : 'Printer: ' + e.message); });
    s.once('connect', function () {
      s.end(data, function () { setTimeout(function () { finish(null); }, 300); });
    });
  });
}
async function printJob(job, done) {
  var p = printers.get(job.mac) || { mac: job.mac, ip: job.ip, port: job.port, make: job.language === 'star' ? 'star' : 'escpos', state: 'ok' };
  if (!printers.has(job.mac)) printers.set(job.mac, p);
  await chain(p, async function () {
    var err = await send(job.ip || p.ip, job.port || p.port || PORT, Buffer.from(job.data, 'base64'));
    if (err) {
      if (/reach/.test(err)) p.state = 'offline';
      say('Not printed on ' + (p.model || p.ip) + ': ' + job.title + ' (' + err + ').');
    } else {
      say('Printed on ' + (p.model || p.ip) + ': ' + job.title + '.');
      p.checkedAt = 0; // looked at again soon: paper may have run out
    }
    done.push({ id: job.id, ok: !err, error: err || '' });
  });
}

// ── what the hub sees, on http://localhost:9180 (and: one hub at a time) ─
function statusServer(state) {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ version: VERSION, server: state.server, connected: state.connected, lastScan: state.lastScan,
        printers: Array.from(printers.values()).map(function (p) { return { ip: p.ip, port: p.port, mac: p.mac, make: p.make, model: p.model, state: p.state }; }) }, null, 2));
    });
    srv.once('error', function () { resolve(false); });
    srv.listen(STATUS_PORT, '127.0.0.1', function () { resolve(true); });
  });
}

// ── starting by itself with the computer ───────────────────────────────
function startupFile() {
  if (process.platform !== 'win32' || !process.env.APPDATA) return '';
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Bamboo print hub.cmd');
}
function installStartup() {
  var f = startupFile();
  if (!f) return false;
  var cmd = isSea() ? '"' + process.execPath + '"' : '"' + process.execPath + '" "' + __filename + '"';
  try { fs.writeFileSync(f, '@echo off\r\ncd /d "' + HOME_DIR + '"\r\nstart "Bamboo print hub" /min ' + cmd + '\r\n'); return true; } catch (e) { return false; }
}

// ── the main loop ──────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('  Bamboo print hub ' + VERSION);
  console.log('  Finds the restaurant\'s printers on this network and prints their tickets.');
  console.log('  Leave this window open (it can be minimised). Close it to stop.');
  console.log('');
  var cfg = loadConfig();
  var argLink = process.argv.slice(2).find(function (a) { return /^https?:\/\//.test(a); });
  if (argLink) cfg.link = argLink;
  while (!hubUrlOf(cfg.link)) {
    if (!process.stdin.isTTY) { say('No printer link. Start it as: bamboo-print-hub <printer link>'); process.exit(1); }
    var a = await ask('Paste the printer link from the till (Till settings > Printers > Copy link), then press Enter:\n> ');
    if (hubUrlOf(a)) cfg.link = a.trim(); else say('That is not a printer link. It looks like https://.../api/cloudprnt/...');
  }
  if (!cfg.key) cfg.key = crypto.randomBytes(12).toString('hex');
  saveConfig(cfg);
  if (process.platform === 'win32' && !cfg.askedStartup && process.stdin.isTTY) {
    var yes = await ask('Start the print hub by itself whenever this computer starts? (Y/n) ');
    cfg.askedStartup = true;
    if (!/^n/i.test(yes.trim())) say(installStartup() ? 'Done: it starts with Windows from now on.' : 'Could not set that up; start it by hand after a restart.');
    saveConfig(cfg);
  }

  var url = hubUrlOf(cfg.link);
  var state = { server: url.replace(/\/api\/print-hub\/.*/, ''), connected: false, lastScan: null };
  if (!(await statusServer(state))) { say('The print hub is running already on this computer (one is enough).'); process.exit(0); }

  var pollMs = 3000, scanMs = 60000, nextScan = 0, scanned = false, nets = '', done = [], failures = 0, saidNewer = false, scanning = null;
  say('Printing for ' + state.server + '.');
  for (;;) {
    // Looking for printers: at the start, then every minute, alongside.
    if (!scanning && Date.now() >= nextScan) {
      nextScan = Date.now() + scanMs;
      if (!state.lastScan) say('Looking for printers on this network...');
      scanning = scan(cfg).then(function (r) {
        nets = r.networks;
        if (!state.lastScan) say(printers.size ? 'Watching ' + printers.size + ' printer(s) on ' + r.networks + '.' : 'No receipt printers found yet on ' + (r.networks || 'this computer\'s network') + '. Is each one switched on, with its network cable in?');
        state.lastScan = new Date().toISOString();
        scanned = true;
      }).catch(function (e) { say('Could not look for printers: ' + e.message); }).finally(function () { scanning = null; });
    }
    await checkAll().catch(function () { /* looked at next time */ });
    try {
      var body = {
        hub: { key: cfg.key, name: os.hostname(), platform: process.platform + '/' + process.arch, version: VERSION, networks: nets, scanned: scanned },
        printers: Array.from(printers.values()).map(function (p) { return { mac: p.mac, ip: p.ip, port: p.port, make: p.make, model: p.model, state: p.state }; }),
        done: done
      };
      scanned = false;
      var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'BambooPrintHub/' + VERSION }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      if (res.status === 404) { say('Bamboo OS does not know this printer link any more. Copy it again from Till settings > Printers and start the hub with it.'); cfg.link = ''; saveConfig(cfg); process.exit(1); }
      if (!res.ok) throw new Error('Bamboo OS answered ' + res.status);
      var r = await res.json();
      done = [];
      if (!state.connected) say('Connected to Bamboo OS.');
      state.connected = true; failures = 0;
      pollMs = Math.max(1000, Math.min(30000, Number(r.pollMs) || 3000));
      scanMs = Math.max(15000, Math.min(600000, Number(r.scanMs) || 60000));
      if (r.latest && r.latest !== VERSION && !saidNewer) { saidNewer = true; say('A newer print hub (' + r.latest + ') is available: Till settings > Printers.'); }
      var jobs = Array.isArray(r.jobs) ? r.jobs : [];
      if (jobs.length) {
        var finished = [];
        await Promise.all(jobs.map(function (j) { return printJob(j, finished); }));
        done = finished;
        continue; // say so at once, and take the next
      }
    } catch (e) {
      failures++;
      if (state.connected || failures === 1) say('Cannot reach Bamboo OS (' + (e.name === 'TimeoutError' ? 'no answer' : e.message) + '). Is the internet on? Trying again...');
      state.connected = false;
    }
    await new Promise(function (r2) { setTimeout(r2, failures ? Math.min(30000, pollMs * Math.pow(2, Math.min(failures, 4))) : pollMs); });
  }
}

if (require.main === module || isSea()) {
  main().catch(function (e) { say('The print hub stopped: ' + (e && e.stack || e)); process.exitCode = 1; });
}

module.exports = { identify: identify, hubUrlOf: hubUrlOf, standInMac: standInMac, networks: networks, checkState: checkState };
