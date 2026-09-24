var crypto = require('crypto');

// Time-based one-time passwords (RFC 6238) — the six-digit codes Google
// Authenticator, Microsoft Authenticator, Authy and the like show, changing
// every 30 seconds. Written out here rather than pulled in as a dependency:
// it is an HMAC over a counter, and every line of it is checkable against
// the RFC's own test vectors (see test/twoStep.test.js).

var STEP_SECONDS = 30;
var DIGITS = 6;
var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  var bits = 0, value = 0, out = '';
  for (var i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  var clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  var bits = 0, value = 0, out = [];
  for (var i = 0; i < clean.length; i++) {
    value = (value << 5) | ALPHABET.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 20 random bytes: the length the RFC recommends for HMAC-SHA1.
function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, step) {
  var counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  var hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  var offset = hmac[hmac.length - 1] & 15;
  var bin = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % Math.pow(10, DIGITS)).padStart(DIGITS, '0');
}

function currentStep(nowMs) {
  return Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000 / STEP_SECONDS);
}

// The step a code belongs to, or null. One step either side is accepted, so
// a phone clock a little off, or a code typed as it rolls over, still works.
function verify(secret, code, nowMs) {
  var c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  var now = currentStep(nowMs);
  for (var d = -1; d <= 1; d++) {
    var expected = codeAt(secret, now + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return now + d;
  }
  return null;
}

// What the authenticator app scans: otpauth://totp/Issuer:account?…
function otpauthUri(secret, account, issuer) {
  var label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=' + DIGITS + '&period=' + STEP_SECONDS;
}

module.exports = {
  newSecret: newSecret, verify: verify, codeAt: codeAt, currentStep: currentStep, otpauthUri: otpauthUri,
  base32Encode: base32Encode, base32Decode: base32Decode
};
