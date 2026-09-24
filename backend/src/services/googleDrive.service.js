var crypto = require('crypto');
var config = require('../config');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var productImport = require('./productImport.service');

// "Import from Google Drive" on Products & inventory: the Finish Inventory
// workbooks read straight from Drive instead of downloaded and uploaded.
//
// Server to server with a Google Cloud service account (config.js →
// googleDrive), the same way Website analytics signs in: a short-lived JWT
// signed with the account's private key, exchanged for an access token with
// read-only Drive access. The account sees only what has been shared with
// its email — the Finish Inventory sheets, or the folder they are kept in —
// and can't change anything there. Once a sheet is fetched, it goes through
// exactly the same preview, matching and import as an uploaded .xlsx
// (productImport.service.js).

var SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
var SHEET = 'application/vnd.google-apps.spreadsheet';
var XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
var MAX_BYTES = 15 * 1024 * 1024;
var TIMEOUT_MS = 30000;

var token = null; // { value, expiresAt }

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requireManage(ctx) {
  if (!ctx.can('inventory.manage')) fail('forbidden', 'Your role does not allow this action (inventory.manage).');
}

function requireConfigured() {
  if (config.googleDrive.jsonInvalid) fail('unavailable', 'GOOGLE_SERVICE_ACCOUNT_JSON on the server isn\'t valid JSON. Paste the whole key file again, from { to }.');
  if (!config.googleDrive.configured) fail('unavailable', 'Google Drive isn\'t connected yet. An administrator adds the service account key on the server (see the steps in this window).');
}

async function timedFetch(url, opts) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
  } catch (e) {
    fail('unavailable', e && e.name === 'AbortError' ? 'Google Drive didn\'t answer in time. Try again.' : 'Couldn\'t reach Google Drive. Try again in a minute.');
  } finally {
    clearTimeout(timer);
  }
}

// A read-only Drive token for the service account, reused until shortly
// before it runs out (they last an hour).
async function accessToken() {
  requireConfigured();
  if (token && token.expiresAt > Date.now() + 60000) return token.value;
  var now = Math.floor(Date.now() / 1000);
  var header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claims = base64url(JSON.stringify({ iss: config.googleDrive.serviceAccountEmail, scope: SCOPE, aud: config.googleDrive.tokenUrl, iat: now, exp: now + 3600 }));
  var signature;
  try {
    signature = crypto.createSign('RSA-SHA256').update(header + '.' + claims).sign(config.googleDrive.privateKey, 'base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) {
    fail('unavailable', 'The Google service account key on the server can\'t be read. Paste the whole JSON key file into GOOGLE_SERVICE_ACCOUNT_JSON again.');
  }
  var res = await timedFetch(config.googleDrive.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: header + '.' + claims + '.' + signature }).toString()
  });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok || !data.access_token) {
    fail('unavailable', 'Google didn\'t accept the service account (' + (data.error_description || data.error || res.status) + '). Check the key on the server, and that the Google Drive API is turned on in that Google Cloud project.');
  }
  token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return token.value;
}

async function driveGet(path, asBuffer) {
  var res = await timedFetch(config.googleDrive.apiBase + path, { headers: { Authorization: 'Bearer ' + await accessToken() } });
  if (res.status === 404) fail('notfound', 'That file isn\'t in Google Drive any more, or it isn\'t shared with the OS.');
  if (res.status === 401) { token = null; fail('unavailable', 'Google Drive sign-in expired. Try again.'); }
  if (!res.ok) {
    var err = await res.json().catch(function () { return {}; });
    var msg = err && err.error && err.error.message ? err.error.message : String(res.status);
    if (/has not been used|is disabled/i.test(msg)) fail('unavailable', 'The Google Drive API is turned off in the Google Cloud project. Turn it on (APIs & Services → Library → Google Drive API) and try again.');
    if (/exportSizeLimitExceeded|too large/i.test(msg)) fail('invalid', 'That sheet is too big for Google to export. Download it as .xlsx and use Import count sheet instead.');
    fail('unavailable', 'Google Drive said: ' + msg);
  }
  if (!asBuffer) return res.json();
  var buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) fail('invalid', 'That workbook is over 15MB.');
  return buf;
}

// "202609 BPL Finish Inventory" → 2026-09; the April sheet, named
// "2026 BPL Finish Inventory", says its month only inside (found at preview).
function monthFromName(name) {
  var m = String(name || '').match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])(?!\d)/);
  return m ? m[1] + '-' + m[2] : null;
}

// The Finish Inventory workbooks the OS can see (or every spreadsheet, with
// all=true), newest first, each with how many of its month's days are
// already on the daily stock sheet.
async function list(ctx, opts) {
  requireManage(ctx);
  if (!config.googleDrive.configured || config.googleDrive.jsonInvalid) {
    return { configured: false, jsonInvalid: config.googleDrive.jsonInvalid, serviceAccountEmail: config.googleDrive.serviceAccountEmail || null, files: [] };
  }
  var all = !!(opts && opts.all);
  var q = "trashed = false and (mimeType = '" + SHEET + "' or mimeType = '" + XLSX + "')" + (all ? '' : " and name contains 'Finish Inventory'");
  var data = await driveGet('/drive/v3/files?' + new URLSearchParams({
    q: q, orderBy: 'modifiedTime desc', pageSize: '100',
    fields: 'files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress))',
    includeItemsFromAllDrives: 'true', supportsAllDrives: 'true', corpora: 'allDrives'
  }).toString());
  var files = (data.files || []).map(function (f) {
    return {
      id: f.id, name: f.name, modifiedTime: f.modifiedTime,
      owner: f.owners && f.owners[0] ? (f.owners[0].displayName || f.owners[0].emailAddress) : null,
      month: monthFromName(f.name)
    };
  });
  var months = files.map(function (f) { return f.month; }).filter(Boolean);
  if (months.length) {
    var counts = (await pool.query(
      "SELECT to_char(date, 'YYYY-MM') AS month, count(DISTINCT date)::int AS days FROM stock_sheet_lines WHERE to_char(date, 'YYYY-MM') = ANY($1) GROUP BY 1",
      [months]
    )).rows;
    var byMonth = {};
    counts.forEach(function (r) { byMonth[r.month] = r.days; });
    files.forEach(function (f) { f.daysInOs = f.month ? byMonth[f.month] || 0 : null; });
  }
  return { configured: true, serviceAccountEmail: config.googleDrive.serviceAccountEmail, files: files };
}

function readFileId(id) {
  var s = String(id || '');
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(s)) fail('invalid', 'That isn\'t a Google Drive file.');
  return s;
}

// The workbook as .xlsx: a Google Sheet is exported, an uploaded .xlsx is
// downloaded as it is.
async function fetchWorkbook(fileId) {
  var id = readFileId(fileId);
  var meta = await driveGet('/drive/v3/files/' + id + '?' + new URLSearchParams({ fields: 'id,name,mimeType', supportsAllDrives: 'true' }).toString());
  var buffer;
  if (meta.mimeType === SHEET) {
    buffer = await driveGet('/drive/v3/files/' + id + '/export?' + new URLSearchParams({ mimeType: XLSX }).toString(), true);
  } else if (meta.mimeType === XLSX) {
    buffer = await driveGet('/drive/v3/files/' + id + '?' + new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' }).toString(), true);
  } else {
    fail('invalid', 'That file isn\'t a spreadsheet.');
  }
  return { name: meta.name, buffer: buffer };
}

async function preview(ctx, fileId, month) {
  requireManage(ctx);
  var wb = await fetchWorkbook(fileId);
  var out = await productImport.previewWorkbook(ctx, wb.buffer, wb.name, month || null);
  out.driveFile = { id: fileId, name: wb.name };
  return out;
}

// Fetches the sheet again rather than trusting the preview: whatever is in
// Drive now is what gets imported.
async function commit(ctx, fileId, month, mappings) {
  requireManage(ctx);
  var wb = await fetchWorkbook(fileId);
  var out = await productImport.commitWorkbook(ctx, wb.buffer, wb.name, month, mappings);
  out.driveFile = { id: fileId, name: wb.name };
  return out;
}

// For the tests.
function resetToken() { token = null; }

module.exports = { list: list, preview: preview, commit: commit, monthFromName: monthFromName, resetToken: resetToken };
