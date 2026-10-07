var crypto = require('crypto');
var config = require('../config');

// A secret kept in the database sealed (AES-256-GCM), with a key derived
// from the server's own secret and what it is for, so a copy of the
// database alone doesn't give it away. seal(text) → "iv.tag.data";
// open(blob) → the text, or null when it can't be opened.
function key(purpose) { return crypto.createHmac('sha256', config.jwt.secret).update('secret-box:' + purpose).digest(); }

function seal(purpose, text) {
  var iv = crypto.randomBytes(12);
  var c = crypto.createCipheriv('aes-256-gcm', key(purpose), iv);
  var enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function open(purpose, blob) {
  var p = String(blob || '').split('.');
  if (p.length !== 3) return null;
  try {
    var d = crypto.createDecipheriv('aes-256-gcm', key(purpose), Buffer.from(p[0], 'base64'));
    d.setAuthTag(Buffer.from(p[1], 'base64'));
    return Buffer.concat([d.update(Buffer.from(p[2], 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { seal: seal, open: open };
