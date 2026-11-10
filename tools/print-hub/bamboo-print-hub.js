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
//
// Outage mode (1.1): when the internet is down, the tills and kitchen
// screens reach the hub over the restaurant's own network instead — the
// kitchen's tickets printed here and shown on the kitchen screens. Each
// device trusts the hub once, on its setup page: http://<this computer>:9180

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

var VERSION = '1.1.0';
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

// ── outage mode: on the restaurant's own network ───────────────────────
// When the internet is down (a power cut can keep it down for days), the
// tills and the kitchen screens still reach this computer over the
// restaurant's network (the router on the generator or a UPS):
//
//   https://<this computer>:9443   the tills send the kitchen's tickets here;
//                                  the hub prints them on the kitchen's
//                                  printers and the kitchen screens take
//                                  them from here, and say when done
//   http://<this computer>:9180    the setup page: each till and kitchen
//                                  screen trusts the hub once (its own
//                                  certificate authority, made here)
//
// The tills learn where the hub answers, and its key, from Bamboo OS while
// the internet is on (restaurantPrintHub.service.js outage). Everything but
// /lan/ping and /lan/check needs that key (X-Hub-Key).
var https = require('https');
var LAN_PORT = 9443;
var SETUP_PORT = STATUS_PORT;
var TICKET_HOURS = 24;
var MAX_TICKETS = 1500;

// DER, for the certificates (X.509) — nothing else needed.
function derLen(n) { if (n < 128) return Buffer.from([n]); var b = []; while (n > 0) { b.unshift(n & 255); n = Math.floor(n / 256); } return Buffer.from([0x80 | b.length].concat(b)); }
function der(tag, body) { body = Buffer.isBuffer(body) ? body : Buffer.concat(body); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); }
function derSeq(items) { return der(0x30, items); }
function derInt(buf) {
  var i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  buf = buf.slice(i);
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]);
  return der(0x02, buf);
}
function derOid(oid) { return der(0x06, Buffer.from(oidBytes(oid))); }
function derUtf8(s) { return der(0x0c, Buffer.from(String(s), 'utf8')); }
function derTime(d) {
  var p = function (n) { return ('0' + n).slice(-2); };
  var y = d.getUTCFullYear();
  var s = p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return y < 2050 ? der(0x17, Buffer.from(String(y).slice(2) + s)) : der(0x18, Buffer.from(String(y) + s));
}
function derName(cn) {
  return derSeq([der(0x31, [derSeq([derOid('2.5.4.10'), derUtf8('Bamboo print hub')])]), der(0x31, [derSeq([derOid('2.5.4.3'), derUtf8(cn)])])]);
}
function derExt(oid, critical, value) { return derSeq([derOid(oid)].concat(critical ? [der(0x01, Buffer.from([0xff]))] : [], [der(0x04, value)])); }
var SHA256_RSA = derSeq([derOid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00])]);
function pem(label, buf) { return '-----BEGIN ' + label + '-----\n' + buf.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n') + '-----END ' + label + '-----\n'; }
function unpem(text) { return Buffer.from(String(text).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'); }

// A certificate: o = { cn, days, publicKey, signKey, issuerCn, issuerKeyId, ca, ips, names }.
function certificate(o) {
  var spki = o.publicKey.export({ type: 'spki', format: 'der' });
  var keyId = crypto.createHash('sha1').update(spki).digest();
  var now = Date.now();
  var exts = o.ca
    ? [derExt('2.5.29.19', true, derSeq([der(0x01, Buffer.from([0xff])), derInt(Buffer.from([0]))])),
      derExt('2.5.29.15', true, der(0x03, Buffer.from([0x01, 0x86]))),          // certificates, revocation lists, signatures
      derExt('2.5.29.14', false, der(0x04, keyId))]
    : [derExt('2.5.29.19', true, derSeq([])),
      derExt('2.5.29.15', true, der(0x03, Buffer.from([0x05, 0xa0]))),          // signatures, key exchange
      derExt('2.5.29.37', false, derSeq([derOid('1.3.6.1.5.5.7.3.1')])),       // a web server
      derExt('2.5.29.17', false, derSeq((o.ips || []).map(function (ip) { return der(0x87, Buffer.from(ip.split('.').map(Number))); })
        .concat((o.names || []).map(function (n) { return der(0x82, Buffer.from(n, 'ascii')); })))),
      derExt('2.5.29.14', false, der(0x04, keyId)),
      derExt('2.5.29.35', false, derSeq([der(0x80, o.issuerKeyId)]))];
  var serial = crypto.randomBytes(16); serial[0] &= 0x7f;
  var tbs = derSeq([
    der(0xa0, [derInt(Buffer.from([2]))]), derInt(serial), SHA256_RSA, derName(o.issuerCn || o.cn),
    derSeq([derTime(new Date(now - 86400000)), derTime(new Date(now + o.days * 86400000))]),
    derName(o.cn), spki, der(0xa3, [derSeq(exts)])
  ]);
  var sig = crypto.sign('sha256', tbs, o.signKey);
  return { der: derSeq([tbs, SHA256_RSA, der(0x03, Buffer.concat([Buffer.from([0]), sig]))]), keyId: keyId };
}
function rsaKeys() { return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); }
// The hub's own certificate authority: made once, kept next to it. Each
// till and kitchen screen trusts it once (the setup page).
function makeCa(cn) {
  var k = rsaKeys();
  var c = certificate({ cn: cn || 'Bamboo print hub', days: 3650, publicKey: k.publicKey, signKey: k.privateKey, ca: true });
  return { key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', c.der) };
}
function caFingerprint(ca) { return crypto.createHash('sha256').update(unpem(ca.cert)).digest('hex'); }
// The hub's address certificate, for the addresses it has now (made again
// when they change, and well before it runs out: 397 days at most, as
// iPhones and iPads want).
function serverCert(ca, ips, names) {
  var caKey = crypto.createPrivateKey(ca.key);
  var caKeyId = crypto.createHash('sha1').update(crypto.createPublicKey(caKey).export({ type: 'spki', format: 'der' })).digest();
  var caCn = (/(?:^|\n)CN=([^\n]*)/.exec(new crypto.X509Certificate(ca.cert).subject) || [])[1] || 'Bamboo print hub';
  var k = rsaKeys();
  var c = certificate({ cn: (ips && ips[0]) || 'bamboo-print-hub', days: 397, publicKey: k.publicKey, signKey: caKey, issuerCn: caCn, issuerKeyId: caKeyId, ips: ips, names: names });
  return { key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem('CERTIFICATE', c.der) + ca.cert, made: Date.now() };
}
function lanIps() {
  return networks().map(function (n) { return n.address; }).filter(function (ip) { return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip); }).slice(0, 4);
}

// The kitchen's tickets sent here while the internet was down: kept a day,
// on disk too (the hub restarting keeps them).
function ticketStore(file) {
  var list = new Map();
  try { (JSON.parse(fs.readFileSync(file, 'utf8')) || []).forEach(function (t) { if (t && t.id) list.set(t.id, t); }); } catch (e) { /* none yet */ }
  var timer = null;
  function prune() {
    var cut = Date.now() - TICKET_HOURS * 3600000;
    list.forEach(function (t, id) { if (t.updatedAt < cut) list.delete(id); });
    while (list.size > MAX_TICKETS) list.delete(list.keys().next().value);
  }
  function save() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      try { fs.writeFileSync(file, JSON.stringify(Array.from(list.values()))); } catch (e) { say('Could not keep the kitchen tickets on disk (' + e.message + ').'); }
    }, 300);
  }
  prune();
  return {
    get: function (id) { return list.get(id) || null; },
    put: function (t) { prune(); list.set(t.id, t); save(); return t; },
    since: function (ms) { prune(); return Array.from(list.values()).filter(function (t) { return t.updatedAt > ms; }); },
    flush: function () { if (timer) { clearTimeout(timer); timer = null; } try { fs.writeFileSync(file, JSON.stringify(Array.from(list.values()))); } catch (e) { /* kept in memory */ } }
  };
}
function clip(v, n) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); }
function cleanTicket(t, from) {
  t = t || {};
  var id = clip(t.id, 80);
  if (!/^[A-Za-z0-9:_.-]{6,80}$/.test(id)) return null;
  var items = (Array.isArray(t.items) ? t.items : []).slice(0, 80).map(function (it) {
    it = it || {};
    return { name: clip(it.name, 80), qty: Math.max(0, Math.min(999, Number(it.qty) || 0)), note: clip(it.note, 160), seat: it.seat ? Math.min(99, Math.round(Number(it.seat)) || 0) || null : null,
      mods: (Array.isArray(it.mods) ? it.mods : []).slice(0, 12).map(function (m) { return { how: clip(m && m.how, 10), name: clip(m && m.name, 60) }; }),
      allergens: (Array.isArray(it.allergens) ? it.allergens : []).slice(0, 14).map(function (a) { return clip(a, 20); }) };
  }).filter(function (it) { return it.name && it.qty > 0; });
  if (!items.length) return null;
  var now = Date.now();
  return {
    id: id, stationId: clip(t.stationId, 40), station: clip(t.station, 60), number: clip(t.number, 20), label: clip(t.label, 60), tableName: clip(t.tableName, 60),
    waiterName: clip(t.waiterName, 60), guestName: clip(t.guestName, 60), fulfillment: clip(t.fulfillment, 12), guests: Math.min(99, Math.round(Number(t.guests)) || 0) || null,
    allergy: clip(t.allergy, 200), allergens: (Array.isArray(t.allergens) ? t.allergens : []).slice(0, 14).map(function (a) { return clip(a, 20); }), note: clip(t.note, 200),
    course: clip(t.course, 40), waits: !!t.waits, items: items, from: clip(from, 60), sentAt: Number(new Date(t.sentAt)) || now, createdAt: now, updatedAt: now, doneAt: null
  };
}
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    var chunks = [], size = 0;
    req.on('data', function (c) { size += c.length; if (size > limit) { reject(Object.assign(new Error('Too big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', function () { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Not JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function sameKey(a, b) { var x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); }
// Printed now on the printers named (by MAC: the hub knows where each is).
async function printLan(prints) {
  var out = [];
  await Promise.all((Array.isArray(prints) ? prints : []).slice(0, 16).map(async function (pr) {
    pr = pr || {};
    var mac = String(pr.mac || '').toLowerCase();
    var p = printers.get(mac);
    var ip = p ? p.ip : /^(\d{1,3}\.){3}\d{1,3}$/.test(String(pr.ip || '')) ? String(pr.ip) : '';
    if (!ip || typeof pr.data !== 'string') { out.push({ mac: mac, ok: false, error: 'The hub does not know this printer' }); return; }
    if (!p) { p = { mac: mac, ip: ip, port: Number(pr.port) || PORT, make: 'escpos', model: '', state: 'ok', busy: null }; printers.set(mac, p); }
    await chain(p, async function () {
      var err = await send(p.ip, p.port || PORT, Buffer.from(pr.data, 'base64'));
      say((err ? 'Not printed on ' : 'Printed on ') + (p.model || p.ip) + ' (no internet): ' + clip(pr.title, 60) + (err ? ' (' + err + ').' : '.'));
      out.push({ mac: mac, ok: !err, error: err || '' });
    });
  }));
  return out;
}

// o = { cfg, dir, port, setupPort, name } → { info(), refresh(), close() }
function startLan(o) {
  var cfg = o.cfg, dir = o.dir || HOME_DIR;
  var caFile = path.join(dir, 'bamboo-print-hub-ca.json');
  var ca = null;
  try { ca = JSON.parse(fs.readFileSync(caFile, 'utf8')); crypto.createPrivateKey(ca.key); unpem(ca.cert); } catch (e) { ca = null; }
  if (!ca) {
    ca = makeCa('Bamboo print hub ' + (o.name || os.hostname()).slice(0, 30));
    try { fs.writeFileSync(caFile, JSON.stringify(ca), { mode: 384 }); } catch (e) { say('Could not keep the hub\'s certificate (' + e.message + '): each till would have to trust it again after a restart.'); }
  }
  var fingerprint = caFingerprint(ca);
  var store = ticketStore(path.join(dir, 'bamboo-print-hub-tickets.json'));
  var ips = o.ips || lanIps();
  var names = ['localhost', os.hostname().toLowerCase().replace(/[^a-z0-9.-]/g, '')].filter(Boolean);
  if (names[1] && names[1].indexOf('.') < 0) names.push(names[1] + '.local');
  var cert = serverCert(ca, ips.concat(['127.0.0.1']), names);
  var port = o.port == null ? LAN_PORT : o.port;

  function json(res, code, body) { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); }
  var srv = https.createServer({ key: cert.key, cert: cert.cert }, async function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Hub-Key');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    var url = new URL(req.url, 'https://hub');
    try {
      if (url.pathname === '/lan/ping') return json(res, 200, { ok: true, name: os.hostname(), version: VERSION, ca: fingerprint });
      if (url.pathname === '/lan/check' || url.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(page('This device trusts the print hub', '<p class="ok">&#10003; This device trusts the print hub. When the internet is down, its orders still reach the kitchen.</p><p>You can close this page.</p>'));
        return;
      }
      if (!sameKey(req.headers['x-hub-key'], cfg.lanKey)) return json(res, 403, { error: 'Not this restaurant\'s till' });
      if (url.pathname === '/lan/printers' && req.method === 'GET') {
        return json(res, 200, { printers: Array.from(printers.values()).map(function (p) { return { mac: p.mac, ip: p.ip, port: p.port, make: p.make, model: p.model, state: p.state }; }) });
      }
      if (url.pathname === '/lan/print' && req.method === 'POST') {
        var b = await readBody(req, 4 * 1024 * 1024);
        return json(res, 200, { results: await printLan(b.prints) });
      }
      if (url.pathname === '/lan/tickets' && req.method === 'GET') {
        var since = Math.max(0, Number(url.searchParams.get('since')) || 0);
        return json(res, 200, { now: Date.now(), tickets: store.since(since) });
      }
      if (url.pathname === '/lan/tickets' && req.method === 'POST') {
        var body = await readBody(req, 4 * 1024 * 1024);
        var t = cleanTicket(body.ticket, body.from);
        if (!t) return json(res, 400, { error: 'Not a kitchen ticket' });
        // Sent again (no answer the first time): kept once, printed once.
        var had = store.get(t.id);
        if (had) return json(res, 200, { ok: true, again: true, ticket: had, results: [] });
        store.put(t);
        say('Kitchen ticket ' + t.number + ' for ' + (t.station || 'the kitchen') + ' (no internet) from ' + (t.from || 'a till') + '.');
        return json(res, 200, { ok: true, ticket: t, results: await printLan(body.prints) });
      }
      // The ticket's id as the page sent it (encodeURIComponent: ':' as %3A).
      var m = /^\/lan\/tickets\/([^/]{6,240})$/.exec(url.pathname);
      var tid = null;
      try { tid = m ? decodeURIComponent(m[1]) : null; } catch (e) { tid = null; }
      if (tid && /^[A-Za-z0-9:_.-]{6,80}$/.test(tid) && req.method === 'POST') {
        var bd = await readBody(req, 64 * 1024);
        var tk = store.get(tid);
        if (!tk) return json(res, 404, { error: 'No such ticket' });
        tk.doneAt = bd.done === false ? null : Date.now();
        tk.updatedAt = Date.now();
        store.put(tk);
        return json(res, 200, { ok: true, ticket: tk });
      }
      json(res, 404, { error: 'Not here' });
    } catch (e) { json(res, e.status || 500, { error: e.message }); }
  });
  srv.on('tlsClientError', function () { /* a device that does not trust the hub yet */ });
  var ready = new Promise(function (resolve) {
    srv.once('error', function (e) { say('Outage mode is off: port ' + port + ' is taken (' + e.code + ').'); resolve(false); });
    srv.listen(port, '0.0.0.0', function () { resolve(true); });
  });
  return {
    ready: ready,
    port: function () { var a = srv.address(); return a ? a.port : port; },
    ca: ca,
    fingerprint: fingerprint,
    store: store,
    info: function () { return { ips: ips, port: this.port(), setupPort: o.setupPort || SETUP_PORT, key: cfg.lanKey, ca: fingerprint }; },
    // The addresses changed (another router, a new address): a new certificate for them.
    refresh: function () {
      var now = lanIps();
      if (now.join(',') === ips.join(',') && Date.now() - cert.made < 300 * 86400000) return false;
      ips = now;
      cert = serverCert(ca, ips.concat(['127.0.0.1']), names);
      srv.setSecureContext({ key: cert.key, cert: cert.cert });
      if (ips.length) say('Outage mode: the tills reach this computer at https://' + ips[0] + ':' + this.port() + ' now.');
      return true;
    },
    close: function () { store.flush(); return new Promise(function (r) { srv.close(function () { r(); }); }); }
  };
}

// The setup page (http://<this computer>:9180): each till and kitchen
// screen trusts the hub here, once.
function page(title, body) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title>' +
    '<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f7f2;color:#17301f}main{max-width:720px;margin:0 auto;padding:24px 16px 48px}' +
    'h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}.lead{color:#47604f;margin:0 0 18px}.card{background:#fff;border-radius:16px;padding:16px 18px;box-shadow:0 6px 24px rgba(23,48,31,.08);margin:12px 0}' +
    'a.btn{display:inline-block;background:#1f7a46;color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:12px;margin:6px 8px 6px 0}a.btn.alt{background:#e7efe9;color:#17301f}' +
    'ol{padding-left:22px;margin:6px 0}li{margin:4px 0}code{background:#eef3ef;padding:1px 6px;border-radius:6px}.ok{font-size:20px;color:#1f7a46;font-weight:600}.muted{color:#5d7465;font-size:14px}</style></head><body><main>' +
    body + '</main></body></html>';
}
function setupPage(lan) {
  var info = lan.info();
  var at = info.ips[0] || 'this computer';
  var check = 'https://' + at + ':' + info.port + '/lan/check';
  return page('Bamboo print hub: set up this device',
    '<h1>Set up this device for outage mode</h1><p class="lead">Do this once on each till and kitchen screen, while it is on the restaurant\'s Wi-Fi. Then, when the internet is down, orders still reach the kitchen through this print hub.</p>' +
    '<div class="card"><a class="btn" href="/bamboo-print-hub.crt">1. Download the hub\'s certificate</a><a class="btn alt" href="' + check + '">2. Check this device</a>' +
    '<p class="muted">Certificate fingerprint (SHA-256): <code>' + lan.fingerprint.match(/.{2}/g).join(':').toUpperCase().slice(0, 47) + '…</code></p></div>' +
    '<h2>iPad or iPhone</h2><div class="card"><ol><li>Open this page in <b>Safari</b> and tap <b>Download the hub\'s certificate</b>, then <b>Allow</b>.</li><li>Open <b>Settings</b>, tap <b>Profile Downloaded</b> near the top, then <b>Install</b> (enter the passcode) and <b>Install</b> again.</li>' +
    '<li>Go to <b>Settings → General → About → Certificate Trust Settings</b> and switch on <b>Bamboo print hub</b>.</li><li>Back here, tap <b>Check this device</b>.</li></ol></div>' +
    '<h2>Android</h2><div class="card"><ol><li>Tap <b>Download the hub\'s certificate</b>.</li><li>Open <b>Settings</b>, search for <b>CA certificate</b> (Security → More security settings → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b>), tap <b>Install anyway</b> and pick <b>bamboo-print-hub.crt</b> from Downloads.</li>' +
    '<li>Back here, tap <b>Check this device</b>.</li></ol></div>' +
    '<h2>Windows</h2><div class="card"><ol><li>Download the certificate and open it, then <b>Install Certificate…</b></li><li>Choose <b>Local Machine</b>, then <b>Place all certificates in the following store</b> → <b>Trusted Root Certification Authorities</b> → Finish.</li><li>Restart the browser and tap <b>Check this device</b>.</li></ol></div>' +
    '<h2>Mac</h2><div class="card"><ol><li>Download the certificate and open it: it goes into <b>Keychain Access</b>.</li><li>Double-click <b>Bamboo print hub</b>, open <b>Trust</b> and set <b>When using this certificate</b> to <b>Always Trust</b>.</li><li>Tap <b>Check this device</b>.</li></ol></div>' +
    '<p class="muted">If <b>Check this device</b> shows a warning instead of a green tick, the certificate is not trusted yet: go through the steps again. The hub answers at <code>' + check.replace('/lan/check', '') + '</code>.</p>');
}

// ── what the hub sees, on http://localhost:9180 (and: one hub at a time) ─
// On this computer: what it sees. From a till or kitchen screen on the
// network: the setup page, and the hub's certificate to trust.
function isLocal(req) { return /^(::ffff:)?127\.|^::1$/.test(req.socket.remoteAddress || ''); }
function statusServer(state) {
  return new Promise(function (resolve) {
    var srv = http.createServer(function (req, res) {
      var url = (req.url || '/').split('?')[0];
      if (url === '/bamboo-print-hub.crt' && state.lan) {
        res.setHeader('Content-Type', 'application/x-x509-ca-cert');
        res.setHeader('Content-Disposition', 'attachment; filename="bamboo-print-hub.crt"');
        res.end(unpem(state.lan.ca.cert));
        return;
      }
      if (url === '/status' || (url === '/' && isLocal(req) && !/text\/html/.test(req.headers.accept || ''))) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (!isLocal(req)) { res.statusCode = 403; res.end('{}'); return; }
        res.end(JSON.stringify({ version: VERSION, server: state.server, connected: state.connected, lastScan: state.lastScan, outage: state.lan ? state.lan.info().ips.map(function (ip) { return 'https://' + ip + ':' + state.lan.port(); }) : [],
          printers: Array.from(printers.values()).map(function (p) { return { ip: p.ip, port: p.port, mac: p.mac, make: p.make, model: p.model, state: p.state }; }) }, null, 2));
        return;
      }
      if (url === '/' && state.lan) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(setupPage(state.lan)); return; }
      res.statusCode = 404; res.end('Not here');
    });
    srv.once('error', function () { resolve(false); });
    srv.listen(STATUS_PORT, '0.0.0.0', function () { resolve(true); });
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
  if (!/^[A-Za-z0-9_-]{24,64}$/.test(cfg.lanKey || '')) cfg.lanKey = crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
  // Outage mode: the tills and kitchen screens reach it over the network.
  var lan = startLan({ cfg: cfg, name: os.hostname() });
  if (await lan.ready) {
    state.lan = lan;
    var at = lan.info().ips[0];
    say(at ? 'Outage mode is on: each till and kitchen screen trusts this hub once at http://' + at + ':' + STATUS_PORT + ' (Till settings > Printers > Outage mode).' : 'Outage mode: this computer is on no restaurant network yet.');
  }

  var pollMs = 3000, scanMs = 60000, nextScan = 0, scanned = false, nets = '', done = [], failures = 0, saidNewer = false, scanning = null;
  say('Printing for ' + state.server + '.');
  for (;;) {
    // Looking for printers: at the start, then every minute, alongside.
    if (!scanning && Date.now() >= nextScan) {
      nextScan = Date.now() + scanMs;
      if (!state.lastScan) say('Looking for printers on this network...');
      scanning = scan(cfg).then(function (r) {
        nets = r.networks;
        if (state.lan) state.lan.refresh();
        if (!state.lastScan) say(printers.size ? 'Watching ' + printers.size + ' printer(s) on ' + r.networks + '.' : 'No receipt printers found yet on ' + (r.networks || 'this computer\'s network') + '. Is each one switched on, with its network cable in?');
        state.lastScan = new Date().toISOString();
        scanned = true;
      }).catch(function (e) { say('Could not look for printers: ' + e.message); }).finally(function () { scanning = null; });
    }
    await checkAll().catch(function () { /* looked at next time */ });
    try {
      var body = {
        hub: { key: cfg.key, name: os.hostname(), platform: process.platform + '/' + process.arch, version: VERSION, networks: nets, scanned: scanned, lan: state.lan ? state.lan.info() : undefined },
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

module.exports = {
  identify: identify, hubUrlOf: hubUrlOf, standInMac: standInMac, networks: networks, checkState: checkState,
  makeCa: makeCa, serverCert: serverCert, caFingerprint: caFingerprint, startLan: startLan, cleanTicket: cleanTicket, setupPage: setupPage, printers: printers
};
