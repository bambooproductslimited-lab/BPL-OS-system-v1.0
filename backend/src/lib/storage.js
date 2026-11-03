// Real file storage for the Documents module, via Cloudflare R2 (an
// S3-compatible object store — Render's own disk is wiped on every deploy,
// so uploaded files can't live there). Configured is false until all four
// R2_* env vars are set; callers check that and fail with a clear message
// instead of the SDK throwing a confusing one.
var crypto = require('crypto');
var { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');
var { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
var config = require('../config');

var r2 = config.r2;
var client = r2.configured
  ? new S3Client({
      region: 'auto',
      endpoint: 'https://' + r2.accountId + '.r2.cloudflarestorage.com',
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey }
    })
  : null;

function buildKey(originalName) {
  var safe = String(originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
  return 'documents/' + crypto.randomUUID() + '-' + safe;
}

async function uploadFile(originalName, buffer, contentType) {
  var key = buildKey(originalName);
  await client.send(new PutObjectCommand({
    Bucket: r2.bucket, Key: key, Body: buffer, ContentType: contentType || 'application/octet-stream'
  }));
  return key;
}

// Named getDownloadUrl for history's sake (that's what every caller still
// imports), but this is a view/preview link, not a download one: inline
// disposition tells the browser to render the file (PDF/image) in the tab
// instead of triggering a save dialog, wherever the browser is able to.
// This isn't real DRM — someone already viewing the rendered file can
// still save it via the browser's own UI — it just removes the
// straightforward "click to download" path the OS itself was offering.
function getDownloadUrl(key, downloadAsFileName) {
  var command = new GetObjectCommand({
    Bucket: r2.bucket, Key: key,
    ResponseContentDisposition: 'inline; filename="' + String(downloadAsFileName || 'file').replace(/"/g, '') + '"'
  });
  return getSignedUrl(client, command, { expiresIn: 60 });
}

async function deleteFile(key) {
  await client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
}

// Streams the object straight through our own server rather than a signed
// URL — used for restaurant menu item photos (lib/storage.js's only other
// consumers, the Documents module and employee ID docs, use signed URLs
// instead because those files are sensitive and only ever opened one at a
// time from a click). A menu photo needs to work as a plain <img src>,
// rendered inline for potentially hundreds of tiles on the POS till grid,
// from both the authenticated main app and the separately-authenticated
// (PIN-token) POS till — a signed URL's 60s expiry would break mid-shift,
// and <img> tags can't attach an Authorization header at all, so this has
// to be a plain unauthenticated GET (see routes/menuPhotos.routes.js).
async function getObjectStream(key) {
  if (!api.configured) throw Object.assign(new Error('Cloudflare R2 is not set up on this server.'), { name: 'NotConfigured' });
  var res = await api.client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
  return { stream: res.Body, contentType: res.ContentType };
}
// Every object under a prefix: [{ key, lastModified }] (catalogue photo
// recovery looks for photo files no item points to any more).
async function listKeys(prefix) {
  var out = [], token;
  do {
    var res = await client.send(new ListObjectsV2Command({ Bucket: r2.bucket, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach(function (o) { out.push({ key: o.Key, lastModified: o.LastModified }); });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// What R2 said when it refused, in one word: the SDK's error name
// (InvalidAccessKeyId, AccessDenied, NoSuchBucket, NoSuchKey…), or the
// network's (ENOTFOUND, ETIMEDOUT), or the HTTP status.
function codeOf(e) {
  if (!e) return 'Unknown';
  var c = e.name && e.name !== 'Error' ? e.name : e.Code || e.code || (e.$metadata && e.$metadata.httpStatusCode ? 'HTTP ' + e.$metadata.httpStatusCode : '');
  if (c === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404 && !/bucket/i.test(String(e.name || '')))) c = c === 'NoSuchBucket' ? c : 'NoSuchKey';
  return String(c || e.message || 'Unknown').slice(0, 60);
}
// Does R2 answer, and with this server's key? A stored file (sampleKey)
// is looked at (not downloaded); without one, the bucket is listed.
// { ok: true } or { ok: false, step: 'settings'|'read'|'list', code }.
async function check(sampleKey) {
  if (!api.configured) return { ok: false, step: 'settings', code: 'NotConfigured' };
  var list = function () { return api.client.send(new ListObjectsV2Command({ Bucket: r2.bucket, MaxKeys: 1 })); };
  try {
    if (sampleKey) await api.client.send(new HeadObjectCommand({ Bucket: r2.bucket, Key: sampleKey }));
    else await list();
    return { ok: true };
  } catch (e) {
    var code = codeOf(e);
    // A look at a file answers "not found" for a missing bucket too: the
    // bucket is asked for, to tell them apart.
    if (sampleKey && code === 'NoSuchKey') {
      try { await list(); } catch (e2) { if (codeOf(e2) === 'NoSuchBucket') return { ok: false, step: 'list', code: 'NoSuchBucket' }; }
    }
    return { ok: false, step: sampleKey ? 'read' : 'list', code: code };
  }
}
// Tests stand in for R2: { configured, client: { send } }.
var api = { configured: r2.configured, client: client };
function setForTests(fake) { api = fake || { configured: r2.configured, client: client }; }

module.exports = {
  configured: r2.configured, uploadFile: uploadFile, getDownloadUrl: getDownloadUrl,
  deleteFile: deleteFile, getObjectStream: getObjectStream, listKeys: listKeys, check: check, codeOf: codeOf, setForTests: setForTests
};
