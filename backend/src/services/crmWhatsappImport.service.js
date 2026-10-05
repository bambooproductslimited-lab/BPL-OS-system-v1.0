/*
 * Bringing a customer's WhatsApp history into the CRM from WhatsApp's own
 * "Export chat" (More → Export chat), sent as the .txt or the .zip it makes.
 *
 * The WhatsApp Business API only sees messages from the day it is
 * connected; an export brings everything before. Both kinds of export are
 * read: Android ("12/03/2024, 14:05 - Ama Mensah: Hello") and iPhone
 * ("[12/03/2024, 14:05:33] Ama Mensah: Hello"), 24-hour or am/pm, and the
 * day and month either way round (Ghana's day/month unless the file shows
 * otherwise). Lines without a time continue the message above. WhatsApp's
 * own notes ("Messages and calls are end-to-end encrypted") are left out.
 *
 * preview() reads the file and says who is in it; run() needs to know which
 * of them are the company (the phone the chat was exported from) — the other
 * one is the customer. The customer's phone number, when the name isn't one,
 * links the history to their profile and to their live WhatsApp chat.
 * Importing the same chat again adds only what is new.
 */
var crypto = require('crypto');
var yauzl = require('yauzl');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { pool } = require('../db/pool');
var { internationalNumber } = require('../utils/phone');
var inbox = require('./crmInbox.service');

var MAX_BYTES = 20 * 1024 * 1024;
var LINE = /^‎?\[?(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-|–)?\s*([^:]{1,80}?):\s([\s\S]*)$/;
var SYSTEM = /^‎?\[?\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{2,4},?\s+\d{1,2}[:.]\d{2}/;
var MEDIA = /^(<Media omitted>|<attached: .*>|image omitted|video omitted|audio omitted|sticker omitted|document omitted|GIF omitted|.* \(file attached\))$/i;

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }

// The text of the chat: the file itself, or the .txt inside the .zip.
function readText(file) {
  if (!file || !file.buffer) fail('invalid', 'Choose the exported chat (.txt or .zip).');
  if (file.size > MAX_BYTES) fail('invalid', 'That file is over 20 MB. Export the chat "without media" — the words are all the CRM keeps.');
  var buf = file.buffer;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return new Promise(function (resolve, reject) {
      yauzl.fromBuffer(buf, { lazyEntries: true }, function (err, zip) {
        if (err) return reject(new Error('That .zip couldn\'t be opened.'));
        var found = false;
        zip.readEntry();
        zip.on('entry', function (entry) {
          if (!found && /\.txt$/i.test(entry.fileName) && !/__MACOSX/.test(entry.fileName)) {
            found = true;
            zip.openReadStream(entry, function (e2, stream) {
              if (e2) return reject(e2);
              var chunks = [];
              stream.on('data', function (c) { chunks.push(c); });
              stream.on('end', function () { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
            });
          } else zip.readEntry();
        });
        zip.on('end', function () { if (!found) reject(new Error('There is no chat (.txt) inside that .zip.')); });
      });
    }).catch(function (e) { fail('invalid', e.message); });
  }
  return Promise.resolve(buf.toString('utf8'));
}

// The messages, with their date order worked out.
function parse(text) {
  var raw = [];
  String(text).replace(/\r\n?/g, '\n').split('\n').forEach(function (line) {
    var m = LINE.exec(line);
    if (m) {
      raw.push({ a: Number(m[1]), b: Number(m[2]), y: m[3], h: Number(m[4]), min: Number(m[5]), s: Number(m[6] || 0), ampm: m[7] || '', author: m[8].replace(/^‎|‎$/g, '').trim(), body: m[9] });
    } else if (SYSTEM.test(line)) {
      raw.push(null); // WhatsApp's own note: ends the message above
    } else if (raw.length && raw[raw.length - 1]) {
      raw[raw.length - 1].body += '\n' + line;
    }
  });
  var msgs = raw.filter(Boolean);
  // Day/month or month/day: whichever can't be a month gives it away.
  var dayFirst = true;
  if (msgs.some(function (m) { return m.b > 12; }) && !msgs.some(function (m) { return m.a > 12; })) dayFirst = false;
  var yearFirst = msgs.some(function (m) { return m.a > 31; });
  return msgs.map(function (m) {
    var y = Number(yearFirst ? m.a : m.y); if (y < 100) y += 2000;
    var mo = yearFirst ? m.b : dayFirst ? m.b : m.a;
    var d = yearFirst ? Number(m.y) : dayFirst ? m.a : m.b;
    var h = m.h;
    var pm = /^p/i.test(m.ampm), am = /^a/i.test(m.ampm);
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
    // WhatsApp exports in the phone's time; Ghana's is GMT.
    var at = new Date(Date.UTC(y, mo - 1, d, h, m.min, m.s));
    var body = m.body.replace(/‎/g, '').trim();
    var media = MEDIA.test(body);
    return { at: at, author: m.author, body: media ? '' : body, media: media ? body : null };
  }).filter(function (m) { return !isNaN(m.at.getTime()); });
}

function guessFromName(fileName) {
  var m = /WhatsApp Chat (?:with|-)\s*(.+?)(?:\.txt|\.zip)?$/i.exec(String(fileName || ''));
  return m ? m[1].trim() : '';
}

async function preview(ctx, file) {
  need(ctx, 'crm.manage');
  var msgs = parse(await readText(file));
  if (!msgs.length) fail('invalid', 'No messages were found. Is this a chat exported from WhatsApp (More → Export chat)?');
  var people = {};
  msgs.forEach(function (m) { people[m.author] = (people[m.author] || 0) + 1; });
  var names = Object.keys(people).sort(function (a, b) { return people[b] - people[a]; });
  var fromFile = guessFromName(file.originalname);
  var customer = names.find(function (n) { return n === fromFile; }) || names.find(function (n) { return internationalNumber(n); }) || null;
  return {
    messages: msgs.length, from: msgs[0].at, to: msgs[msgs.length - 1].at,
    people: names.map(function (n) { return { name: n, messages: people[n], phone: internationalNumber(n) ? inbox.phoneLabel(internationalNumber(n)) : null }; }),
    guessCustomer: customer, sample: msgs.slice(-3).map(function (m) { return { author: m.author, body: m.body || m.media, at: m.at }; })
  };
}

// p: { ourNames: [...], phone?, customerId? }
async function run(ctx, file, p) {
  need(ctx, 'crm.manage');
  var msgs = parse(await readText(file));
  if (!msgs.length) fail('invalid', 'No messages were found in that file.');
  var ours = new Set((p.ourNames || []).map(String));
  if (!ours.size) fail('invalid', 'Say which name in the chat is Bamboo Products (the phone it was exported from).');
  var others = Array.from(new Set(msgs.map(function (m) { return m.author; }).filter(function (a) { return !ours.has(a); })));
  if (!others.length) fail('invalid', 'Everyone in that chat is marked as Bamboo Products; the customer has to be one of them.');
  if (others.length > 1) fail('invalid', 'This looks like a group chat (' + others.slice(0, 4).join(', ') + '). Import one-to-one chats with a customer.');
  var them = others[0];
  var digits = internationalNumber(p.phone) || internationalNumber(them);
  if (p.phone && !internationalNumber(p.phone)) fail('invalid', 'That phone number isn\'t right.');
  var customerId = p.customerId || null;
  if (customerId && !(await pool.query('SELECT 1 FROM customers WHERE id = $1', [customerId])).rows[0]) fail('notfound', 'Customer not found.');
  if (!digits && !customerId) fail('invalid', 'Give the customer\'s WhatsApp number (or choose their profile), so the chat lands on the right customer.');
  var threadId = digits || 'export:' + customerId;
  var out = await inbox.ingest({
    channel: 'whatsapp', threadId: threadId, imported: true, customerId: customerId || undefined,
    contact: { name: internationalNumber(them) ? '' : them, handles: digits ? [{ kind: 'phone', value: digits }] : [] },
    messages: msgs.map(function (m) {
      var mine = ours.has(m.author);
      var body = m.body || '[' + m.media.replace(/[<>]/g, '') + ']';
      return {
        // The same line imported twice is the same message.
        externalId: 'wx:' + crypto.createHash('sha1').update(m.at.toISOString() + '|' + m.author + '|' + body).digest('hex'),
        direction: mine ? 'out' : 'in', author: m.author, body: body, sentAt: m.at,
        attachments: m.media ? [{ name: m.media.replace(/[<>]/g, ''), type: 'media' }] : []
      };
    })
  });
  await audit(pool, ctx, 'crm.import.whatsapp', 'crm_conversation', out.conversationId,
    'Imported a WhatsApp chat with ' + them + ': ' + out.added + ' new message(s) of ' + msgs.length + (out.customerCreated ? ', new customer profile' : '') + '.');
  return Object.assign(out, { total: msgs.length, customerName: them });
}

module.exports = { parse: parse, preview: preview, run: run };
