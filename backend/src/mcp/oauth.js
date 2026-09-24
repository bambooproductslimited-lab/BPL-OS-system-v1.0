var crypto = require('crypto');
var express = require('express');
var rateLimit = require('express-rate-limit');
var jwt = require('jsonwebtoken');
var config = require('../config');
var { pool } = require('../db/pool');
var { AppError } = require('../utils/errors');
var { audit } = require('../utils/audit');
var authService = require('../services/auth.service');
var twoStep = require('../services/twoStep.service');
var { buildContext } = require('../services/context.service');
var { InvalidGrantError, InvalidTokenError, InvalidRequestError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');

// Sign-in for the Claude connector: the OAuth 2.1 authorization server that
// claude.ai and the Claude apps use to act as one person in the OS.
//
// The OAuth library (@modelcontextprotocol/sdk's mcpAuthRouter, mounted in
// mcp/index.js) handles the protocol: metadata, client registration, the
// checks on /authorize, PKCE at /token. This file is what it asks of us —
// where clients, codes and tokens are kept (migration 0070) — plus the page
// the person signs in on: their usual OS email and password (same lockout
// as the login screen), and an explicit Allow.

var CODE_MINUTES = 10;
var ACCESS_TOKEN_SECONDS = 60 * 60;
var REFRESH_TOKEN_DAYS = 30;
var REQUEST_MINUTES = 15;

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }

function mcpUrl() { return config.publicUrl + '/mcp'; }

// ---- clients --------------------------------------------------------------

var clientsStore = {
  getClient: async function (clientId) {
    var row = (await pool.query('SELECT info FROM mcp_oauth_clients WHERE client_id = $1', [String(clientId)])).rows[0];
    return row ? row.info : undefined;
  },
  registerClient: async function (info) {
    await pool.query('INSERT INTO mcp_oauth_clients (client_id, info) VALUES ($1, $2)', [info.client_id, JSON.stringify(info)]);
    return info;
  }
};

// ---- the sign-in page -----------------------------------------------------

// What /authorize checked (client, redirect address, PKCE challenge, state)
// travels through the sign-in form signed, so it can't be altered between
// the page and the POST — in particular, the address the code is sent to.
// Signed with a key derived from the session secret, so it can never pass
// as a session token or the other way round.
function requestKey() { return crypto.createHmac('sha256', config.jwt.secret).update('mcp-authorize-request').digest(); }
function signRequest(r) { return jwt.sign(r, requestKey(), { expiresIn: REQUEST_MINUTES * 60 }); }
function readRequest(token) {
  try { return jwt.verify(String(token || ''), requestKey()); } catch (e) { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

// The page can only be submitted to the OS itself and then sent on to the
// address Claude registered, and can't be shown inside another site.
function setPageHeaders(res, redirectUri) {
  var origin = '';
  try { origin = new URL(redirectUri).origin; } catch (e) { /* no redirect origin */ }
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self' " + origin + "; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function page(opts) {
  var body = opts.body || (
    '<p class="lead"><strong>' + escapeHtml(opts.clientName) + '</strong> wants to use Bamboo OS as you.</p>' +
    '<ul class="what">' +
    '<li>It will see what you can see in the OS — nothing more.</li>' +
    '<li>It can do the things your role allows, such as creating tasks or requesting leave. Claude asks for your approval before each change, unless you tell Claude to always allow it.</li>' +
    '<li>You can disconnect it any time from Claude\'s connector settings. Changing your OS password also disconnects it.</li>' +
    '</ul>' +
    (opts.error ? '<p class="error" role="alert">' + escapeHtml(opts.error) + '</p>' : '') +
    '<form method="post" action="/oauth/login">' +
    '<input type="hidden" name="request" value="' + escapeHtml(opts.request) + '">' +
    '<label>Email<input name="email" type="email" autocomplete="username" required value="' + escapeHtml(opts.email) + '"></label>' +
    '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>' +
    '<div class="buttons"><button name="decision" value="allow" class="primary">Sign in and allow</button>' +
    '<button name="decision" value="deny" formnovalidate>Cancel</button></div>' +
    '</form>'
  );
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Connect Claude to Bamboo OS</title><style>' +
    ':root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#201e1d;--muted:#6b6966;--line:#e4e2df;--accent:#3f7d3b;--danger:#b3261e}' +
    '@media (prefers-color-scheme:dark){:root{--bg:#0f1523;--card:#161e30;--text:#e8e6e3;--muted:#a3a19e;--line:#2a3550;--accent:#34d399;--danger:#f2b8b5}}' +
    'body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}' +
    'main{background:var(--card);border:1px solid var(--line);max-width:420px;width:100%;padding:28px}' +
    'h1{font-size:19px;margin:0 0 4px}.brand{color:var(--accent);font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 16px}' +
    '.lead{margin:0 0 10px}.what{margin:0 0 18px;padding-left:18px;color:var(--muted);font-size:13.5px}.what li{margin-bottom:4px}' +
    'label{display:block;font-size:13px;color:var(--muted);margin-bottom:12px}input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:9px 10px;font:inherit;color:var(--text);background:transparent;border:1px solid var(--line)}' +
    '.buttons{display:flex;gap:8px;margin-top:18px}button{font:inherit;font-weight:600;padding:9px 14px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}' +
    'button.primary{background:var(--accent);border-color:var(--accent);color:#fff}@media (prefers-color-scheme:dark){button.primary{color:#0f1523}}' +
    '.error{color:var(--danger);font-size:13.5px;margin:0 0 12px}' +
    '</style></head><body><main><p class="brand">Bamboo OS</p><h1>' + escapeHtml(opts.title || 'Connect Claude') + '</h1>' + body + '</main></body></html>';
}

// The second step, for accounts with two-step sign-in on: the code from the
// authenticator app or a text message (or a backup code), before Claude is
// allowed in. smsTo (masked) is only for what the page says; sending a code
// is checked against the account itself.
function codePage(opts) {
  var hasApp = (opts.methods || []).indexOf('app') >= 0;
  var where = hasApp && opts.smsTo ? 'your authenticator app, or texted to ' + opts.smsTo + ','
    : opts.smsTo ? 'the text message sent to ' + opts.smsTo + ',' : 'your authenticator app,';
  return page({
    title: 'Enter your code',
    body: '<p class="lead">Two-step sign-in is on for this account. Enter the 6-digit code from ' + escapeHtml(where) + ' or one of your backup codes.</p>' +
      (opts.notice ? '<p class="lead" role="status">' + escapeHtml(opts.notice) + '</p>' : '') +
      (opts.error ? '<p class="error" role="alert">' + escapeHtml(opts.error) + '</p>' : '') +
      '<form method="post" action="/oauth/login">' +
      '<input type="hidden" name="request" value="' + escapeHtml(opts.request) + '">' +
      '<input type="hidden" name="challenge" value="' + escapeHtml(opts.challenge) + '">' +
      '<input type="hidden" name="methods" value="' + escapeHtml((opts.methods || []).join(',')) + '">' +
      '<input type="hidden" name="smsTo" value="' + escapeHtml(opts.smsTo || '') + '">' +
      '<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>' +
      '<div class="buttons"><button name="decision" value="allow" class="primary">Allow</button>' +
      (opts.smsTo ? '<button name="decision" value="sms" formnovalidate>' + (hasApp ? 'Text me a code' : 'Send a new code') + '</button>' : '') +
      '<button name="decision" value="deny" formnovalidate>Cancel</button></div>' +
      '</form>'
  });
}

function redirectWith(redirectUri, params) {
  var url = new URL(redirectUri);
  Object.keys(params).forEach(function (k) { if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]); });
  return url.toString();
}

// ---- the provider the OAuth library calls ---------------------------------

var provider = {
  get clientsStore() { return clientsStore; },

  // Called by /authorize once it has checked the client and redirect address.
  authorize: async function (client, params, res) {
    if (params.resource && params.resource.href.replace(/\/+$/, '') !== mcpUrl()) {
      throw new InvalidRequestError('This server only issues access to ' + mcpUrl() + '.');
    }
    var request = signRequest({ c: client.client_id, r: params.redirectUri, ch: params.codeChallenge, s: params.state || null, sc: params.scopes || [] });
    setPageHeaders(res, params.redirectUri);
    res.status(200).type('html').send(page({ clientName: client.client_name || 'Claude', request: request }));
  },

  challengeForAuthorizationCode: async function (client, code) {
    var row = (await pool.query('SELECT code_challenge FROM mcp_oauth_codes WHERE code_hash = $1 AND client_id = $2', [hash(code), client.client_id])).rows[0];
    if (!row) throw new InvalidGrantError('Unknown authorization code.');
    return row.code_challenge;
  },

  exchangeAuthorizationCode: async function (client, code, codeVerifier, redirectUri) {
    // Used once, by the client it was issued to, before it expires — claimed
    // in one statement so two exchanges can't both succeed.
    var row = (await pool.query(
      'UPDATE mcp_oauth_codes SET used_at = now() WHERE code_hash = $1 AND client_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING *',
      [hash(code), client.client_id]
    )).rows[0];
    if (!row) throw new InvalidGrantError('The authorization code is invalid, expired or already used.');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the one used to sign in.');
    return issueTokens(client.client_id, row.user_id, row.scopes);
  },

  exchangeRefreshToken: async function (client, refreshToken) {
    // Refresh tokens are single-use: each refresh revokes the one it used.
    var row = (await pool.query(
      "UPDATE mcp_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND revoked_at IS NULL AND expires_at > now() RETURNING *",
      [hash(refreshToken), client.client_id]
    )).rows[0];
    if (!row) throw new InvalidGrantError('The refresh token is invalid, expired or revoked.');
    if (!(await userCanConnect(row.user_id))) throw new InvalidGrantError('This account can no longer use the connector.');
    return issueTokens(client.client_id, row.user_id, row.scopes);
  },

  verifyAccessToken: async function (token) {
    var row = (await pool.query(
      "SELECT t.*, u.status AS user_status, u.must_change_password FROM mcp_oauth_tokens t JOIN users u ON u.id = t.user_id " +
      "WHERE t.token_hash = $1 AND t.kind = 'access'",
      [hash(token)]
    )).rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) throw new InvalidTokenError('The access token is invalid, expired or revoked.');
    if (row.user_status !== 'active' || row.must_change_password) throw new InvalidTokenError('This account can no longer use the connector.');
    return {
      token: token, clientId: row.client_id, scopes: row.scopes,
      expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      extra: { userId: row.user_id }
    };
  },

  revokeToken: async function (client, request) {
    await pool.query('UPDATE mcp_oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND client_id = $2 AND revoked_at IS NULL', [hash(request.token), client.client_id]);
  }
};

async function userCanConnect(userId) {
  var u = (await pool.query('SELECT status, must_change_password FROM users WHERE id = $1', [userId])).rows[0];
  return !!u && u.status === 'active' && !u.must_change_password;
}

async function issueTokens(clientId, userId, scopes) {
  var access = randomToken();
  var refresh = randomToken();
  await pool.query(
    "INSERT INTO mcp_oauth_tokens (token_hash, kind, client_id, user_id, scopes, expires_at) VALUES " +
    "($1,'access',$3,$4,$5, now() + make_interval(secs => $6)), ($2,'refresh',$3,$4,$5, now() + make_interval(days => $7))",
    [hash(access), hash(refresh), clientId, userId, scopes || [], ACCESS_TOKEN_SECONDS, REFRESH_TOKEN_DAYS]
  );
  var out = { access_token: access, token_type: 'bearer', expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refresh };
  if (scopes && scopes.length) out.scope = scopes.join(' ');
  return out;
}

// Disconnects Claude from someone's account everywhere — called when their
// password changes, so a new password also ends any connection made with
// the old one.
async function revokeAllForUser(db, userId) {
  await db.query('UPDATE mcp_oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
}

// ---- the sign-in form's POST ---------------------------------------------

var loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: function () { return config.nodeEnv === 'test'; },
  handler: function (req, res) {
    res.status(429).type('html').send(page({ title: 'Too many attempts', body: '<p>Too many sign-in attempts. Wait a few minutes and try again.</p>' }));
  }
});

var router = express.Router();

router.post('/oauth/login', loginLimiter, express.urlencoded({ extended: false, limit: '20kb' }), async function (req, res, next) {
  try {
    var r = readRequest(req.body.request);
    var client = r && await clientsStore.getClient(r.c);
    if (!r || !client) {
      setPageHeaders(res, null);
      return res.status(400).type('html').send(page({
        title: 'This sign-in has expired',
        body: '<p>Go back to Claude and connect Bamboo OS again.</p>'
      }));
    }
    setPageHeaders(res, r.r);
    var again = function (message) {
      return res.status(200).type('html').send(page({ clientName: client.client_name || 'Claude', request: req.body.request, email: req.body.email, error: message }));
    };

    var codeOpts = {
      request: req.body.request, challenge: req.body.challenge,
      methods: String(req.body.methods || '').split(',').filter(Boolean), smsTo: req.body.smsTo || null
    };
    if (req.body.decision === 'sms' && req.body.challenge) {
      try {
        var sent = await twoStep.sendLoginCode(req.body.challenge);
        return res.status(200).type('html').send(codePage(Object.assign(codeOpts, { notice: 'Code sent to ' + sent.sentTo + '.' })));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        return res.status(200).type('html').send(codePage(Object.assign(codeOpts, { error: err.message })));
      }
    }

    if (req.body.decision !== 'allow') {
      return res.redirect(302, redirectWith(r.r, { error: 'access_denied', error_description: 'The person cancelled.', state: r.s }));
    }

    var result;
    try {
      result = req.body.challenge
        ? await authService.verifyLogin(req.body.challenge, req.body.code, false)
        : await authService.login(req.body.email, req.body.password);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (req.body.challenge && /code is not right/.test(err.message)) {
        return res.status(200).type('html').send(codePage(Object.assign(codeOpts, { error: err.message })));
      }
      return again(err.message);
    }
    if (result.twoStepRequired) {
      return res.status(200).type('html').send(codePage({
        request: req.body.request, challenge: result.challenge, methods: result.methods, smsTo: result.smsTo,
        notice: result.codeSent ? 'Code sent to ' + result.smsTo + '.' : null, error: result.codeError || null
      }));
    }
    if (result.ctx.user.mustChangePassword) {
      return again('Sign in to Bamboo OS in your browser and set your own password first, then connect Claude.');
    }

    var code = randomToken();
    await pool.query("DELETE FROM mcp_oauth_codes WHERE expires_at < now() - interval '1 day'");
    await pool.query(
      'INSERT INTO mcp_oauth_codes (code_hash, client_id, user_id, code_challenge, redirect_uri, scopes, expires_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7))',
      [hash(code), client.client_id, result.ctx.user.id, r.ch, r.r, r.sc || [], CODE_MINUTES]
    );
    await audit(pool, result.ctx, 'mcp.connect', 'user', result.ctx.user.id, 'Connected ' + (client.client_name || 'Claude') + ' to their account.');
    res.redirect(302, redirectWith(r.r, { code: code, state: r.s }));
  } catch (e) {
    next(e);
  }
});

module.exports = {
  provider: provider, router: router, revokeAllForUser: revokeAllForUser, mcpUrl: mcpUrl,
  buildContextForToken: function (authInfo) { return buildContext(authInfo.extra.userId); }
};
