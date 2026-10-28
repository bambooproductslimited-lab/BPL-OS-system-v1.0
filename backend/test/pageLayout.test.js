// The newer sections fill the page like the rest of the OS, Company
// settings is not squeezed by a till stylesheet any more, and a sign-in on
// this device survives a busy or waking server. Reads the frontend's files.
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, '../../frontend/src');
function read(f) { return fs.readFileSync(path.join(SRC, f), 'utf8'); }

test('the newer sections are not capped and centred: the shared stylesheet lets them fill the page', function () {
  var css = read('styles/pageHero.css');
  assert.match(css, /\.shell-content :is\(\.x7, \.bl, \.stm, \.cf, \.adv, \.veh, \.ow\) \{ max-width: none; \}/);
  assert.match(read('index.css'), /@import '\.\/styles\/pageHero\.css';/);
  // Every banner colour belongs to a group of the menu.
  assert.match(read('layout/AppShell.jsx'), /className="shell-content" data-section=/);
  ['people', 'operations', 'finance', 'governance'].forEach(function (s) { assert.ok(css.indexOf("[data-section='" + s + "']") >= 0, s); });
});

test('the till panels\' sizes stay on the till: a bare .cs squeezed Company settings to 560px', function () {
  var till = read('pages/till/till.css');
  assert.doesNotMatch(till, /^\.bk, \.gc, \.cs, \.lo \{/m);
  assert.doesNotMatch(till, /^\.cs, \.lo \{/m);
  assert.match(till, /^\.pos-panel:is\(\.bk, \.gc, \.cs, \.lo\) \{ width: min\(760px/m);
  assert.match(read('pages/CompanySettingsPage.jsx'), /<div className="dk cs">/);
});

test('signing back in on load forgets the sign-in only when the server refuses it (401)', function () {
  var auth = read('auth/AuthContext.jsx');
  assert.match(auth, /if \(err && err\.status === 401\) \{ setToken\(null\); break; \}/);
  assert.match(auth, /setReconnecting\(true\)/);
  assert.match(read('auth/ProtectedRoute.jsx'), /Reaching the server…/);
});
