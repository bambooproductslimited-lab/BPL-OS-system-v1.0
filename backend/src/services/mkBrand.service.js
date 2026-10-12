var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');
var S = require('./mkShared');

// The brand kit and what marketing knows about the market.
//
// Brand kit — for everyone signed in (anyone making a quotation cover, a
// sign or a post needs the logo and the colours): the tagline, the tone of
// voice, the colours (name and hex), the fonts, do's and don'ts, and the
// files — logos, guidelines, templates, photos, videos, fonts, print-ready
// artwork — each with what it is, tags and, for bought photos or fonts,
// when its licence runs out. Marketing (marketing.manage) keeps it.
//
// Market — competitors (where they are, how their prices sit against ours,
// their strengths and weaknesses) and a running log of what was seen: a
// price (with ours beside it), a promotion, a new product, news, reviews.

var ASSET_KINDS = ['logo', 'guideline', 'template', 'photo', 'video', 'font', 'print', 'other'];
var INTEL_KINDS = ['price', 'promotion', 'product', 'news', 'review', 'other'];
var POSITIONS = ['lower', 'similar', 'higher', 'unknown'];

function signedIn(ctx) { if (!ctx || !ctx.employee) fail('forbidden', 'Sign in first.'); }

// GET /api/mk/brand?company= — the brand and its files.
async function brand(ctx, opts) {
  signedIn(ctx);
  var co = await S.company(opts && opts.company);
  var q = await Promise.all([
    pool.query('SELECT * FROM marketing_brand WHERE company_id = $1', [co.id]),
    pool.query('SELECT a.*, e.first_name, e.last_name FROM marketing_assets a JOIN employees e ON e.id = a.uploaded_by WHERE a.company_id = $1 ORDER BY a.kind, a.created_at DESC', [co.id])
  ]);
  var b = q[0].rows[0] || {};
  var today = S.todayIso();
  return {
    company: { code: co.code, name: co.name }, canManage: ctx.can('marketing.manage'),
    brand: {
      tagline: b.tagline || '', voice: b.voice || '', colours: b.colours || [], fonts: b.fonts || '', dos: b.dos || '', donts: b.donts || '',
      updatedAt: b.updated_at || null
    },
    assets: q[1].rows.map(function (a) {
      return {
        id: a.id, kind: a.kind, name: a.name, description: a.description, fileName: a.file_name, mime: a.mime, size: a.size_bytes, tags: a.tags || [],
        licenceUntil: a.licence_until, licenceExpired: !!(a.licence_until && a.licence_until < today), downloads: a.downloads,
        isImage: /^image\//.test(a.mime || ''), by: S.employeeName(a.first_name, a.last_name), createdAt: a.created_at
      };
    })
  };
}

// PUT /api/mk/brand { company, tagline, voice, colours: [{ name, hex }], fonts, dos, donts }
async function updateBrand(ctx, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var colours = (Array.isArray(p.colours) ? p.colours : []).slice(0, 16).map(function (c) {
    var hex = String(c && c.hex || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) fail('invalid', 'Each colour needs a hex code like #3f7d3b.');
    return { name: S.text(c.name, 40) || hex, hex: hex.toLowerCase() };
  });
  await pool.query(
    'INSERT INTO marketing_brand (company_id, tagline, voice, colours, fonts, dos, donts, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) ' +
    'ON CONFLICT (company_id) DO UPDATE SET tagline = $2, voice = $3, colours = $4, fonts = $5, dos = $6, donts = $7, updated_by = $8, updated_at = now()',
    [co.id, S.text(p.tagline, 200), S.text(p.voice, 2000), JSON.stringify(colours), S.text(p.fonts, 500), S.text(p.dos, 2000), S.text(p.donts, 2000), ctx.employee.id]);
  await audit(pool, ctx, 'marketing.brand.update', 'company', co.id, 'Updated the ' + co.name + ' brand kit.');
  return brand(ctx, { company: co.code });
}

// POST /api/mk/assets (multipart: file, company, kind, name, description, tags, licenceUntil)
async function addAsset(ctx, p, file) {
  S.requireManage(ctx);
  if (!file) fail('invalid', 'Pick a file.');
  var co = await S.company(p.company);
  var name = S.text(p.name, 160) || file.originalname;
  var tags = String(p.tags || '').split(',').map(function (t) { return t.trim().toLowerCase(); }).filter(Boolean).slice(0, 12);
  var key = await fileStore.put(file.originalname, file.buffer, file.mimetype);
  var r = (await pool.query(
    'INSERT INTO marketing_assets (company_id, kind, name, description, file_key, file_name, mime, size_bytes, tags, licence_until, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
    [co.id, S.oneOf(p.kind, ASSET_KINDS, 'Kind', 'other'), name, S.text(p.description, 500), key, file.originalname, file.mimetype || '',
      file.size || (file.buffer ? file.buffer.length : 0), tags, S.dateOrNull(p.licenceUntil, 'Licence until'), ctx.employee.id])).rows[0];
  await audit(pool, ctx, 'marketing.asset.add', 'marketing_asset', r.id, 'Added ' + name + ' to the ' + co.name + ' brand kit.');
  return brand(ctx, { company: co.code });
}

// PATCH /api/mk/assets/:id { name, kind, description, tags, licenceUntil }
async function updateAsset(ctx, id, p) {
  S.requireManage(ctx);
  var a = (await pool.query('SELECT a.*, co.code FROM marketing_assets a JOIN companies co ON co.id = a.company_id WHERE a.id = $1', [id])).rows[0];
  if (!a) fail('notfound', 'File not found.');
  var tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',');
  await pool.query('UPDATE marketing_assets SET name = $2, kind = $3, description = $4, tags = $5, licence_until = $6 WHERE id = $1',
    [id, S.text(p.name, 160) || a.name, S.oneOf(p.kind, ASSET_KINDS, 'Kind', a.kind), S.text(p.description, 500),
      tags.map(function (t) { return String(t).trim().toLowerCase(); }).filter(Boolean).slice(0, 12), S.dateOrNull(p.licenceUntil, 'Licence until')]);
  return brand(ctx, { company: a.code });
}

// DELETE /api/mk/assets/:id
async function removeAsset(ctx, id) {
  S.requireManage(ctx);
  var a = (await pool.query('SELECT a.*, co.code FROM marketing_assets a JOIN companies co ON co.id = a.company_id WHERE a.id = $1', [id])).rows[0];
  if (!a) fail('notfound', 'File not found.');
  await pool.query('DELETE FROM marketing_assets WHERE id = $1', [id]);
  await fileStore.del(a.file_key).catch(function () {});
  await audit(pool, ctx, 'marketing.asset.delete', 'marketing_asset', id, 'Removed ' + a.name + ' from the brand kit.');
  return brand(ctx, { company: a.code });
}

// The file, for GET /api/mk/assets/:id/file (?download=1 counts a download).
async function assetFile(ctx, id, download) {
  signedIn(ctx);
  var a = (await pool.query('SELECT file_key, file_name FROM marketing_assets WHERE id = $1', [id])).rows[0];
  if (!a) fail('notfound', 'File not found.');
  if (download) await pool.query('UPDATE marketing_assets SET downloads = downloads + 1 WHERE id = $1', [id]);
  return { key: a.file_key, fileName: a.file_name };
}

// ── the market ────────────────────────────────────────────────────────
// GET /api/mk/market?company= — competitors (with how many sightings and
// the latest) and the log, newest first.
async function market(ctx, opts) {
  S.requireRead(ctx);
  var co = await S.company(opts && opts.company);
  var q = await Promise.all([
    pool.query('SELECT m.*, (SELECT count(*) FROM marketing_intel i WHERE i.competitor_id = m.id)::int AS sightings, ' +
      '(SELECT max(seen_on) FROM marketing_intel i WHERE i.competitor_id = m.id) AS last_seen FROM marketing_competitors m WHERE m.company_id = $1 ORDER BY m.name', [co.id]),
    pool.query('SELECT i.*, m.name AS competitor_name, e.first_name, e.last_name FROM marketing_intel i LEFT JOIN marketing_competitors m ON m.id = i.competitor_id ' +
      'JOIN employees e ON e.id = i.created_by WHERE i.company_id = $1 ORDER BY i.seen_on DESC, i.created_at DESC LIMIT 300', [co.id])
  ]);
  var intel = q[1].rows.map(function (i) {
    return {
      id: i.id, kind: i.kind, body: i.body, product: i.product, price: i.price === null ? null : S.num(i.price), ourPrice: i.our_price === null ? null : S.num(i.our_price),
      gap: i.price !== null && i.our_price !== null && Number(i.our_price) > 0 ? Math.round(((Number(i.price) - Number(i.our_price)) / Number(i.our_price)) * 100) : null,
      seenOn: i.seen_on, source: i.source, competitor: i.competitor_id ? { id: i.competitor_id, name: i.competitor_name } : null, by: S.employeeName(i.first_name, i.last_name),
      mine: i.created_by === ctx.employee.id
    };
  });
  var priced = intel.filter(function (i) { return i.gap !== null; });
  return {
    company: { code: co.code, name: co.name }, canManage: ctx.can('marketing.manage'),
    competitors: q[0].rows.map(function (m) {
      var mine = priced.filter(function (i) { return i.competitor && i.competitor.id === m.id; });
      return {
        id: m.id, name: m.name, website: m.website, location: m.location, pricePosition: m.price_position, strengths: m.strengths, weaknesses: m.weaknesses,
        notes: m.notes, sightings: m.sightings, lastSeen: m.last_seen,
        averageGap: mine.length ? Math.round(mine.reduce(function (s, i) { return s + i.gap; }, 0) / mine.length) : null
      };
    }),
    intel: intel,
    totals: { competitors: q[0].rows.length, sightings30: intel.filter(function (i) { return i.seenOn >= S.iso(new Date(Date.now() - 30 * 86400000)); }).length,
      averageGap: priced.length ? Math.round(priced.reduce(function (s, i) { return s + i.gap; }, 0) / priced.length) : null }
  };
}

function competitorFields(p) {
  var name = S.text(p.name, 160);
  if (!name) fail('invalid', 'Give the competitor\'s name.');
  return {
    name: name, website: S.text(p.website, 200), location: S.text(p.location, 200), pricePosition: S.oneOf(p.pricePosition, POSITIONS, 'Prices', 'unknown'),
    strengths: S.text(p.strengths, 2000), weaknesses: S.text(p.weaknesses, 2000), notes: S.text(p.notes, 2000)
  };
}
async function addCompetitor(ctx, p) {
  S.requireManage(ctx);
  var co = await S.company(p.company);
  var f = competitorFields(p);
  await pool.query('INSERT INTO marketing_competitors (company_id, name, website, location, price_position, strengths, weaknesses, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [co.id, f.name, f.website, f.location, f.pricePosition, f.strengths, f.weaknesses, f.notes, ctx.employee.id]);
  return market(ctx, { company: co.code });
}
async function competitorCompany(id) {
  var m = (await pool.query('SELECT m.company_id, co.code FROM marketing_competitors m JOIN companies co ON co.id = m.company_id WHERE m.id = $1', [id])).rows[0];
  if (!m) fail('notfound', 'Competitor not found.');
  return m;
}
async function updateCompetitor(ctx, id, p) {
  S.requireManage(ctx);
  var m = await competitorCompany(id);
  var f = competitorFields(p);
  await pool.query('UPDATE marketing_competitors SET name = $2, website = $3, location = $4, price_position = $5, strengths = $6, weaknesses = $7, notes = $8, updated_at = now() WHERE id = $1',
    [id, f.name, f.website, f.location, f.pricePosition, f.strengths, f.weaknesses, f.notes]);
  return market(ctx, { company: m.code });
}
async function removeCompetitor(ctx, id) {
  S.requireManage(ctx);
  var m = await competitorCompany(id);
  await pool.query('DELETE FROM marketing_competitors WHERE id = $1', [id]);
  return market(ctx, { company: m.code });
}

// POST /api/mk/intel { company, competitorId?, kind, body, product, price, ourPrice, seenOn, source }
// — anyone in marketing can log what they saw.
async function addIntel(ctx, p) {
  S.requireRead(ctx);
  var co = await S.company(p.company);
  var body = S.text(p.body, 2000);
  if (!body) fail('invalid', 'Say what was seen.');
  if (p.competitorId) {
    var m = await competitorCompany(p.competitorId);
    if (m.company_id !== co.id) fail('invalid', 'That competitor is not this company\'s.');
  }
  var seenOn = S.dateOrNull(p.seenOn, 'Date') || S.todayIso();
  if (seenOn > S.todayIso()) fail('invalid', 'That date has not come yet.');
  await pool.query('INSERT INTO marketing_intel (company_id, competitor_id, kind, body, product, price, our_price, seen_on, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [co.id, p.competitorId || null, S.oneOf(p.kind, INTEL_KINDS, 'Kind', 'other'), body, S.text(p.product, 160),
      S.money(p.price, 'Their price', { optional: true }), S.money(p.ourPrice, 'Our price', { optional: true }), seenOn, S.text(p.source, 200), ctx.employee.id]);
  return market(ctx, { company: co.code });
}
async function removeIntel(ctx, id) {
  S.requireRead(ctx);
  var i = (await pool.query('SELECT i.created_by, co.code FROM marketing_intel i JOIN companies co ON co.id = i.company_id WHERE i.id = $1', [id])).rows[0];
  if (!i) fail('notfound', 'Entry not found.');
  if (i.created_by !== ctx.employee.id && !ctx.can('marketing.manage')) fail('forbidden', 'Only whoever logged it, or marketing, can remove it.');
  await pool.query('DELETE FROM marketing_intel WHERE id = $1', [id]);
  return market(ctx, { company: i.code });
}

module.exports = {
  brand: brand, updateBrand: updateBrand, addAsset: addAsset, updateAsset: updateAsset, removeAsset: removeAsset, assetFile: assetFile,
  market: market, addCompetitor: addCompetitor, updateCompetitor: updateCompetitor, removeCompetitor: removeCompetitor, addIntel: addIntel, removeIntel: removeIntel,
  ASSET_KINDS: ASSET_KINDS, INTEL_KINDS: INTEL_KINDS
};
