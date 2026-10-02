var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');
var storage = require('../lib/storage');

// Photos lost when the Square import used to delete and re-create its
// catalogue items: the item went, and its photo rows with it (ON DELETE
// CASCADE), but the picture files stayed in storage. This finds those
// files and the item each belonged to, for a person to check and put back.
//
// A lost photo is a catalogue picture file that nothing points to any more:
//  - in Cloudflare R2, a key "documents/<uuid>-catalog-<item-slug>.jpg"
//    (catalog.service addPhotos names them so), slug = the item's name;
//  - in the database (stored_files, when R2 isn't set up), the image saved
//    in the moments before an activity-log entry "Added a photo of <item>"
//    whose item no longer exists.
// Any file still referenced anywhere (another photo, a document, an
// attachment…) is never offered. Nothing is put back until a person picks.

var MAX_PHOTOS = 12;
var REFERENCED_SQL =
  'SELECT photo_key AS k FROM catalog_item_photos UNION SELECT photo_key FROM conversations WHERE photo_key IS NOT NULL ' +
  'UNION SELECT object_key FROM documents WHERE object_key IS NOT NULL UNION SELECT object_key FROM employee_documents WHERE object_key IS NOT NULL ' +
  'UNION SELECT photo_key FROM employees WHERE photo_key IS NOT NULL UNION SELECT receipt_key FROM expenses WHERE receipt_key IS NOT NULL ' +
  'UNION SELECT storage_key FROM message_attachments WHERE storage_key IS NOT NULL UNION SELECT photo_key FROM products WHERE photo_key IS NOT NULL ' +
  'UNION SELECT photo_object_key FROM restaurant_menu_items WHERE photo_object_key IS NOT NULL';

function slugOf(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}

// Tests stand in for R2's listing.
var lister = function (prefix) { return storage.listKeys(prefix); };
var r2On = function () { return storage.configured; };
function setR2ForTests(fn) { lister = fn || function (prefix) { return storage.listKeys(prefix); }; r2On = fn ? function () { return true; } : function () { return storage.configured; }; }

function canManage(ctx) {
  if (!ctx.can('catalog.manage')) fail('forbidden', 'Your role does not allow this action (catalog.manage).');
}

// "Added a photo of Bamboo tray." / "Added 3 photos of Bamboo tray."
function parseAdded(summary) {
  var m = /^Added (a photo|(\d+) photos) of (.+)\.$/.exec(String(summary || ''));
  return m ? { n: m[2] ? Number(m[2]) : 1, name: m[3] } : null;
}

async function findLost() {
  var referenced = new Set((await pool.query(REFERENCED_SQL)).rows.map(function (r) { return r.k; }));
  var items = (await pool.query(
    'SELECT i.id, i.name, i.active, i.source, (SELECT count(*)::int FROM catalog_item_photos p WHERE p.item_id = i.id) AS photos FROM catalog_items i')).rows;
  function matchesFor(test) {
    return items.filter(test)
      .sort(function (a, b) { return (b.active - a.active) || (b.source === 'square') - (a.source === 'square'); })
      .map(function (i) { return { id: i.id, name: i.name, active: i.active, photos: i.photos }; });
  }
  // What the activity log says was added to items that are gone.
  var adds = (await pool.query(
    "SELECT a.at, a.summary, a.entity_id FROM audit_logs a WHERE a.action = 'catalog.photo.add' " +
    'AND NOT EXISTS (SELECT 1 FROM catalog_items i WHERE i.id::text = a.entity_id) ORDER BY a.at')).rows
    .map(function (a) { var p = parseAdded(a.summary); return p ? { at: a.at, n: p.n, name: p.name } : null; })
    .filter(Boolean);

  var out = [];
  if (r2On()) {
    var objects = await lister('documents/');
    objects.forEach(function (o) {
      var m = /^documents\/[0-9a-f-]{36}-catalog-(.+)\.jpg$/.exec(o.key);
      if (!m || referenced.has(o.key)) return;
      var slug = m[1];
      var named = adds.filter(function (a) { return slugOf(a.name) === slug; }).pop();
      out.push({
        ref: o.key, itemName: named ? named.name : slug.replace(/-/g, ' '), uploadedAt: o.lastModified || (named && named.at) || null,
        matches: matchesFor(function (i) { return slugOf(i.name) === slug; })
      });
    });
  }
  // Database-stored pictures: the images saved just before each log entry.
  for (var i = 0; i < adds.length; i++) {
    var a = adds[i];
    var files = (await pool.query(
      "SELECT id, created_at FROM stored_files WHERE content_type LIKE 'image/%' " +
      // The file is saved just before its log entry, never after.
      "AND created_at BETWEEN $1::timestamptz - interval '2 minutes' AND $1::timestamptz ORDER BY created_at DESC", [a.at])).rows
      .filter(function (f) { return !referenced.has('db:' + f.id) && !out.some(function (o) { return o.ref === 'db:' + f.id; }); })
      .slice(0, a.n);
    files.forEach(function (f) {
      out.push({
        ref: 'db:' + f.id, itemName: a.name, uploadedAt: f.created_at,
        matches: matchesFor(function (it) { return it.name.trim().toLowerCase() === a.name.trim().toLowerCase(); })
      });
    });
  }
  out.sort(function (x, y) { return String(x.itemName).localeCompare(String(y.itemName)) || String(x.uploadedAt).localeCompare(String(y.uploadedAt)); });
  return out;
}

// The last list, for a minute: the review shows a thumbnail of each lost
// photo, and listing R2 again for every thumbnail would be slow.
var recent = { at: 0, refs: new Set() };
async function list(ctx) {
  canManage(ctx);
  var lost = await findLost();
  recent = { at: Date.now(), refs: new Set(lost.map(function (l) { return l.ref; })) };
  return lost;
}

// The picture itself, to check before putting it back. Only a lost one.
async function preview(ctx, ref) {
  canManage(ctx);
  if (Date.now() - recent.at > 60000) await list(ctx);
  if (!recent.refs.has(ref)) fail('notfound', 'That photo is not one of the lost ones.');
  return ref;
}

// photos: [{ ref, itemId }]
async function restore(ctx, p) {
  canManage(ctx);
  var picks = (p && Array.isArray(p.photos)) ? p.photos.filter(function (x) { return x && x.ref && x.itemId; }) : [];
  if (!picks.length) fail('invalid', 'Tick the photos to put back and the item each belongs to.');
  var lost = new Set((await findLost()).map(function (l) { return l.ref; }));
  var done = 0, full = [];
  for (var i = 0; i < picks.length; i++) {
    var pick = picks[i];
    if (!lost.has(pick.ref)) fail('conflict', 'One of those photos is no longer a lost one — it may have been put back already. Reload and try again.');
    var item = (await pool.query('SELECT id, name FROM catalog_items WHERE id = $1', [pick.itemId])).rows[0];
    if (!item) fail('invalid', 'One of those items no longer exists. Reload and try again.');
    var have = (await pool.query('SELECT count(*)::int AS n, coalesce(max(position), -1) AS top FROM catalog_item_photos WHERE item_id = $1', [item.id])).rows[0];
    if (have.n >= MAX_PHOTOS) { full.push(item.name); continue; }
    await pool.query('INSERT INTO catalog_item_photos (item_id, photo_key, position, created_by) VALUES ($1, $2, $3, $4)',
      [item.id, pick.ref, have.top + 1, ctx.employee ? ctx.employee.id : null]);
    lost.delete(pick.ref);
    recent.refs.delete(pick.ref);
    done++;
  }
  if (done) await audit(pool, ctx, 'catalog.photo.recover', 'catalog_item', picks[0].itemId, 'Put back ' + done + ' lost catalogue photo(s).');
  return { restored: done, full: full };
}

module.exports = { list: list, preview: preview, restore: restore, setR2ForTests: setR2ForTests, fileStore: fileStore, slugOf: slugOf };
