// Real file storage for the Documents module, via Cloudflare R2 (an
// S3-compatible object store — Render's own disk is wiped on every deploy,
// so uploaded files can't live there). Configured is false until all four
// R2_* env vars are set; callers check that and fail with a clear message
// instead of the SDK throwing a confusing one.
var crypto = require('crypto');
var { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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
  var res = await client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
  return { stream: res.Body, contentType: res.ContentType };
}

module.exports = {
  configured: r2.configured, uploadFile: uploadFile, getDownloadUrl: getDownloadUrl,
  deleteFile: deleteFile, getObjectStream: getObjectStream
};
