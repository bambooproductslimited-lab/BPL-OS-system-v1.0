/*
 * The sales team in the field: the day's site visits in the quickest order
 * by road (crmRoute.service.js, Google's Routes API stubbed), or nearest
 * first without it; placing a visit on the map; and products sent to a
 * customer on WhatsApp (crmProductSheets.service.js) — the message, the
 * customer's page and its photos, the views and the rep told once.
 */
var test = require('node:test');
var assert = require('node:assert/strict');
var app = require('../src/app');
var config = require('../src/config');
var fileStore = require('../src/lib/fileStore');
var { pool } = require('../src/db/pool');
var { buildContext } = require('../src/services/context.service');
var crm = require('../src/services/crm.service');
var route = require('../src/services/crmRoute.service');
var roads = require('../src/services/restaurantRoutes.service');
var sheets = require('../src/services/crmProductSheets.service');

var DAY = '2031-05-05';
var repA, repB, lead, v6, vReg, vOld, photoId, visits = {}, server, base, keyWas;
var POLY = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'; // Google's own example: three points

async function cleanup() {
  await pool.query("DELETE FROM crm_product_sheets WHERE to_name LIKE '%Zsf%'");
  await pool.query("DELETE FROM notifications WHERE title LIKE '%Zsf%'");
  await pool.query("DELETE FROM crm_site_visits WHERE client LIKE 'ZSF%'");
  await pool.query("DELETE FROM crm_leads WHERE name LIKE '%Zsf%'");
  await pool.query("DELETE FROM catalog_items WHERE name LIKE 'ZSF%'");
  await pool.query("DELETE FROM users WHERE email LIKE 'zsf.%@example.com'");
  await pool.query("DELETE FROM employees WHERE code LIKE 'ZSF-%'");
}
async function makeRep(code, phone) {
  var dept = (await pool.query('SELECT id FROM departments LIMIT 1')).rows[0].id;
  var e = (await pool.query("INSERT INTO employees (code, first_name, last_name, email, phone, department_id, hire_date) VALUES ($1, 'Rep', $2, $3, $4, $5, '2025-01-01') RETURNING id",
    [code, 'Zsf' + code.slice(-1), code.toLowerCase() + '@zsf.example', phone || '', dept])).rows[0].id;
  var u = (await pool.query("INSERT INTO users (employee_id, email, password_hash) VALUES ($1, $2, 'x') RETURNING id", [e, 'zsf.' + code.toLowerCase() + '@example.com'])).rows[0].id;
  await pool.query("INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'sales_rep'", [u]);
  return buildContext(u);
}
async function visit(client, place, rep, extra) {
  var id = (await pool.query(
    "INSERT INTO crm_site_visits (client, location, scheduled_on, status, assessor_ids, lat, lng, placed_by, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    [client, (extra && extra.location) || '', DAY, (extra && extra.status) || 'scheduled', [rep.employee.id], place ? place.lat : null, place ? place.lng : null, place ? 'pin' : null, rep.employee.id])).rows[0].id;
  await new Promise(function (r) { setTimeout(r, 5); }); // created_at keeps the order
  return id;
}

test.before(async function () {
  await cleanup();
  keyWas = config.googleRoutesKey;
  repA = await makeRep('ZSF-A', '024 111 0001');
  repB = await makeRep('ZSF-B');
  lead = (await pool.query("INSERT INTO crm_leads (name, phone, received_on, source, stage, rep_id) VALUES ('Ama Zsf', '024 555 0101', $1, 'WhatsApp', 'new', $2) RETURNING id", [DAY, repA.employee.id])).rows[0].id;
  var item = (await pool.query("INSERT INTO catalog_items (name, description) VALUES ('ZSF Dining set', 'Solid bamboo, oiled') RETURNING id")).rows[0].id;
  v6 = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price) VALUES ($1, '6 seater', 'ZSF-6', 'set', 12000) RETURNING id", [item])).rows[0].id;
  vReg = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price) VALUES ($1, 'Regular', 'ZSF-R', 'each', 450.5) RETURNING id", [item])).rows[0].id;
  vOld = (await pool.query("INSERT INTO catalog_item_variations (item_id, name, code, unit, unit_price, active) VALUES ($1, 'Old style', 'ZSF-O', 'set', 9000, false) RETURNING id", [item])).rows[0].id;
  var key = await fileStore.put('chair.jpg', Buffer.from('fake jpeg bytes'), 'image/jpeg');
  photoId = (await pool.query('INSERT INTO catalog_item_photos (item_id, photo_key, position) VALUES ($1, $2, 0) RETURNING id', [item, key])).rows[0].id;
  visits.a1 = await visit('ZSF Osu shop', { lat: 5.556, lng: -0.182 }, repA);
  visits.a2 = await visit('ZSF Tema office', { lat: 5.669, lng: -0.016 }, repA);
  visits.a3 = await visit('ZSF East Legon villa', null, repA, { location: 'East Legon' });
  visits.done = await visit('ZSF Done already', { lat: 5.6, lng: -0.2 }, repA, { status: 'visited' });
  visits.off = await visit('ZSF Called off', { lat: 5.6, lng: -0.2 }, repA, { status: 'cancelled' });
  visits.b1 = await visit('ZSF Rep B site', { lat: 5.7, lng: -0.3 }, repB);
  await new Promise(function (r) { server = app.listen(0, function () { base = 'http://127.0.0.1:' + server.address().port; r(); }); });
});
test.after(async function () {
  roads.setFetchForTests(null);
  config.googleRoutesKey = keyWas;
  if (server) await new Promise(function (r) { server.close(r); });
  await cleanup();
  await pool.end();
});

test('the day\'s visits in the quickest order by road, with Google reading an unplaced visit\'s location', async function () {
  config.googleRoutesKey = 'zq-server-key';
  var asked = null;
  roads.setFetchForTests(async function (url, opts) {
    asked = JSON.parse(opts.body);
    var leg = function (to) { return { duration: '600s', staticDuration: '480s', distanceMeters: 4000, polyline: { encodedPolyline: POLY }, startLocation: { latLng: { latitude: 5.5, longitude: -0.2 } }, endLocation: { latLng: to }, travelAdvisory: { speedReadingIntervals: [{ startPolylinePointIndex: 0, endPolylinePointIndex: 1, speed: 'TRAFFIC_JAM' }] } }; };
    return { ok: true, json: async function () {
      return { routes: [{ duration: '2400s', staticDuration: '1900s', distanceMeters: 16000, optimizedIntermediateWaypointIndex: [2, 0, 1],
        legs: [leg({ latitude: 5.635, longitude: -0.155 }), leg({ latitude: 5.556, longitude: -0.182 }), leg({ latitude: 5.669, longitude: -0.016 }), leg({ latitude: 5.5, longitude: -0.2 })] }] };
    } };
  });
  var d = await route.day(repA, { date: DAY, lat: 5.5, lng: -0.2 });
  assert.equal(asked.optimizeWaypointOrder, true);
  assert.equal(asked.routingPreference, 'TRAFFIC_AWARE');
  assert.deepEqual(asked.intermediates[2], { address: 'East Legon, Ghana' }, 'Google reads the location of the visit nobody placed');
  assert.equal(d.road, true);
  assert.deepEqual(d.route.map(function (s) { return s.id; }), [visits.a3, visits.a1, visits.a2], 'Google\'s order');
  assert.deepEqual(d.route.map(function (s) { return s.n; }), [1, 2, 3]);
  assert.equal(d.route[0].placedBy, 'address');
  assert.deepEqual(d.route[0].place, { lat: 5.635, lng: -0.155 });
  var kept = (await pool.query('SELECT lat, lng, placed_by FROM crm_site_visits WHERE id = $1', [visits.a3])).rows[0];
  assert.deepEqual([kept.lat, kept.lng, kept.placed_by], [5.635, -0.155, 'address'], 'and where it put it is kept');
  assert.deepEqual(d.route[0].leg.traffic, [[0, 1, 'jam']]);
  assert.deepEqual([d.totals.stops, d.totals.seconds, d.totals.freeSeconds, d.totals.meters, d.totals.estimate], [3, 1800, 1440, 12000, false], 'the way back is apart');
  assert.equal(d.back.seconds, 600);
  assert.deepEqual(d.done.map(function (s) { return s.id; }), [visits.done]);
  assert.ok(!d.route.concat(d.unplaced, d.done).some(function (s) { return s.id === visits.off || s.id === visits.b1; }), 'not the cancelled one, nor rep B\'s');
  var everyone = await route.day(repA, { date: DAY, who: 'all', lat: 5.5, lng: -0.2 });
  assert.ok(everyone.route.concat(everyone.unplaced).some(function (s) { return s.id === visits.b1; }), 'everyone\'s, asked');
});

test('without Google: the placed visits nearest first, by guess', async function () {
  config.googleRoutesKey = '';
  await pool.query('UPDATE crm_site_visits SET lat = NULL, lng = NULL, placed_by = NULL WHERE id = $1', [visits.a3]);
  var d = await route.day(repA, { date: DAY, lat: 5.67, lng: -0.02 });
  assert.equal(d.road, false);
  assert.equal(d.google, false);
  assert.deepEqual(d.route.map(function (s) { return s.id; }), [visits.a2, visits.a1], 'Tema first, from near Tema');
  assert.equal(d.route[0].leg.estimate, true);
  assert.ok(d.route[1].leg.meters > 10000);
  assert.deepEqual(d.unplaced.map(function (s) { return s.id; }), [visits.a3], 'the unplaced one waits for a pin');
  var noStart = await route.day(repA, { date: DAY });
  assert.equal(noStart.route[0].leg, null, 'the first visit is the start without a place for the rep');
});

test('a visit is placed by a pin or at the site, and a new location drops Google\'s reading', async function () {
  var r = await route.place(repA, visits.a3, { lat: 5.64, lng: -0.16, by: 'here' });
  assert.deepEqual([r.place, r.placedBy], [{ lat: 5.64, lng: -0.16 }, 'here']);
  r = await route.place(repA, visits.a3, { clear: true });
  assert.equal(r.place, null);
  await assert.rejects(route.place(repA, visits.a3, { lat: 'x' }), /Where is it/);
  await assert.rejects(route.place({ employee: repA.employee, can: function (p) { return p === 'crm.read'; } }, visits.a3, { lat: 5, lng: 0 }), /crm.manage/);
  await pool.query("UPDATE crm_site_visits SET lat = 5.6, lng = -0.15, placed_by = 'address' WHERE id = $1", [visits.a3]);
  var v = await crm.saveVisit(repA, visits.a3, { location: 'Airport Residential' });
  assert.equal(v.place, null, 'Google\'s reading of East Legon is not Airport Residential');
  await route.place(repA, visits.a3, { lat: 5.6, lng: -0.17 });
  v = await crm.saveVisit(repA, visits.a3, { location: 'Cantonments' });
  assert.deepEqual(v.place, { lat: 5.6, lng: -0.17 }, 'a pin someone placed stays');
});

test('products go to a lead on WhatsApp: the message, the link, the lead\'s history', async function () {
  var r = await sheets.create(repA, { leadId: lead, items: [{ variationId: v6, qty: 2 }, { variationId: vReg }], note: 'Delivery in Accra is free.', origin: config.corsOrigin[0] });
  assert.match(r.url, new RegExp('^' + config.corsOrigin[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/p/[A-Za-z0-9_-]{20,}$'));
  assert.match(r.message, /^Hello Ama,/);
  assert.match(r.message, /• 2 × ZSF Dining set \(6 seater\) — GHS 12,000\.00 \/ set \(GHS 24,000\.00\)/);
  assert.match(r.message, /• ZSF Dining set — GHS 450\.50\n/, 'Regular is not named, each is not said');
  assert.match(r.message, /Delivery in Accra is free\./);
  assert.ok(r.message.indexOf('Photos and details: ' + r.url) > 0);
  assert.match(r.message, /Rep ZsfA, Bamboo Products Limited$/);
  assert.ok(r.whatsappUrl.indexOf('https://wa.me/233245550101?text=') === 0, 'to the lead\'s number, in WhatsApp\'s form');
  var other = await sheets.create(repA, { leadId: lead, items: [{ variationId: v6 }], origin: 'https://not-the-os.example' });
  assert.ok(other.url.indexOf(config.appUrl + '/p/') === 0, 'a link only ever points at the OS');
  var notes = (await pool.query("SELECT body FROM crm_lead_notes WHERE lead_id = $1 AND body LIKE 'Sent %'", [lead])).rows.map(function (x) { return x.body; });
  assert.ok(notes.includes('Sent 2 products (ZSF Dining set (6 seater), ZSF Dining set) on WhatsApp.'));
  var list = await sheets.list(repA, { leadId: lead });
  assert.equal(list.length, 2);
  await assert.rejects(sheets.create(repA, { leadId: lead, items: [{ variationId: vOld }] }), /archived/);
  await assert.rejects(sheets.create(repA, { leadId: lead, items: [] }), /at least one/);
  await assert.rejects(sheets.create({ employee: repA.employee, can: function (p) { return p !== 'catalog.read'; } }, { leadId: lead, items: [{ variationId: v6 }] }), /catalog.read/);
});

test('the customer\'s page: counted, the rep told once, only what was sent, until it expires', async function () {
  var r = await sheets.create(repA, { leadId: lead, items: [{ variationId: v6 }], origin: config.corsOrigin[0] });
  var token = r.url.split('/p/')[1];
  var page = await sheets.view(token, { preview: true });
  assert.equal(page.to, 'Ama');
  assert.equal(page.items[0].name, 'ZSF Dining set (6 seater)');
  assert.equal(page.items[0].photo, '/public/products/' + token + '/photos/' + photoId);
  assert.equal(page.total, 12000);
  assert.deepEqual(page.rep, { name: 'Rep ZsfA', whatsapp: '233241110001' });
  var row = async function () { return (await pool.query('SELECT views, first_viewed_at FROM crm_product_sheets WHERE id = $1', [r.id])).rows[0]; };
  assert.equal((await row()).views, 0, 'a preview is not counted');
  await sheets.view(token);
  await sheets.view(token);
  assert.equal((await row()).views, 2);
  var told = (await pool.query('SELECT title, link FROM notifications WHERE employee_id = $1 AND title LIKE $2', [repA.employee.id, 'Ama Zsf opened%'])).rows;
  assert.equal(told.length, 1, 'told the first time only');
  assert.equal(told[0].link, '/crmleads?lead=' + lead);

  var res = await fetch(base + '/api/public/products/' + token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).items.length, 1);
  var img = await fetch(base + '/api/public/products/' + token + '/photos/' + photoId);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  var otherPhoto = await fetch(base + '/api/public/products/' + token + '/photos/00000000-0000-0000-0000-000000000000');
  assert.equal(otherPhoto.status, 404, 'only the photos of what was sent');
  assert.equal((await fetch(base + '/api/public/products/not-a-token')).status, 404);

  await pool.query("UPDATE crm_product_sheets SET expires_at = now() - interval '1 day' WHERE id = $1", [r.id]);
  await assert.rejects(sheets.view(token), /expired/);
});
