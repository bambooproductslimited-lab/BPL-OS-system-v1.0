var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var fileStore = require('../lib/fileStore');

// Licences and permits (migration 0201): what the companies and their sites
// must hold to trade — the operating permit, the fire certificate, food
// hygiene, EPA, the liquor licence — with who issues it, its number, what it
// cost and a copy of it. The row is the period in force; renewing keeps the
// period before in the history. Its owner and whoever keeps the licences are
// reminded 60, 30, 14 and 7 days before it ends, and when it has (the daily
// alerts). Staff certificates (training) and vehicle papers (vehicles) are
// kept where they are, and shown here alongside.

var KINDS = ['business', 'fire', 'food', 'environment', 'building', 'liquor', 'signage', 'export', 'insurance', 'other'];
var MAX_FILE = 8 * 1024 * 1024;
var MAX_FILES = 6;

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function dayOr(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null; }
function daysTo(day) { return Math.round((Date.parse(day + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000); }
function can(ctx) { return ctx.can('licence.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (licence.manage).'); }

// A copy of a document: a PDF or a photo. Policies keep theirs the same way.
async function keepFile(dataUrl, name, prefix) {
  var m = /^data:([a-z]+\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) fail('invalid', 'That file did not come through: add it again.');
  var buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_FILE) fail('invalid', 'That file is too big (8 MB at most).');
  var isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';
  var img = require('./shopQuotes.service').photoType(buf);
  if (!isPdf && !img) fail('invalid', 'A PDF or a photo, please.');
  var type = isPdf ? 'application/pdf' : img.type;
  var key = await fileStore.put((prefix || 'licence') + '.' + (isPdf ? 'pdf' : img.ext), buf, type);
  return { key: key, type: type, name: text(name, 120) || (isPdf ? 'document.pdf' : 'photo.' + img.ext) };
}

// Where a licence stands today.
function stateOf(l) {
  if (l.status === 'closed') return 'closed';
  var exp = dayText(l.expires_on);
  if (!exp) return 'no_expiry';
  var left = daysTo(exp);
  if (left < 0) return l.status === 'renewing' ? 'renewing_late' : 'expired';
  if (l.status === 'renewing') return 'renewing';
  if (left <= Math.max(Number(l.lead_days) || 0, 14)) return 'due';
  return 'ok';
}

var SEL = 'SELECT l.*, c.name AS company, c.code AS company_code, o.first_name AS o_first, o.last_name AS o_last, ' +
  '(SELECT coalesce(sum(cost), 0) FROM licence_renewals r WHERE r.licence_id = l.id) AS past_cost, ' +
  '(SELECT count(*)::int FROM licence_renewals r WHERE r.licence_id = l.id) AS renewals ' +
  'FROM licences l LEFT JOIN companies c ON c.id = l.company_id LEFT JOIN employees o ON o.id = l.owner_id ';

function licenceOut(l) {
  var exp = dayText(l.expires_on);
  return {
    id: l.id, kind: l.kind, title: l.title, authority: l.authority, number: l.number, site: l.site,
    company: l.company_id ? { id: l.company_id, name: l.company, code: l.company_code } : null,
    issuedOn: dayText(l.issued_on), expiresOn: exp, daysLeft: exp ? daysTo(exp) : null,
    cost: Number(l.cost), spent: round2(Number(l.cost) + Number(l.past_cost || 0)), renewals: l.renewals || 0,
    owner: l.owner_id ? { id: l.owner_id, name: nameOf(l.o_first, l.o_last) } : null, leadDays: l.lead_days,
    status: l.status, state: stateOf(l), renewingSince: dayText(l.renewing_since), note: l.note,
    files: (l.files || []).map(function (f, n) { return { n: n, name: f.name, type: f.type }; }),
    updatedAt: l.updated_at
  };
}

async function licenceOf(id) {
  var l = (await pool.query(SEL + 'WHERE l.id = $1', [uuidOr(id)])).rows[0];
  if (!l) fail('notfound', 'That licence is gone.');
  return l;
}

// Staff certificates and vehicle papers ending within 60 days (or already
// ended): kept in training and vehicles, shown here so nothing is missed.
async function alsoExpiring() {
  var certs = (await pool.query(
    "SELECT s.id, s.expires_on, t.name AS type, e.id AS emp, e.first_name, e.last_name FROM staff_certs s JOIN cert_types t ON t.id = s.type_id JOIN employees e ON e.id = s.employee_id " +
    "WHERE e.status = 'active' AND s.expires_on IS NOT NULL AND s.expires_on <= current_date + 60 " +
    'AND NOT EXISTS (SELECT 1 FROM staff_certs n WHERE n.employee_id = s.employee_id AND n.type_id = s.type_id AND n.expires_on > s.expires_on) ORDER BY s.expires_on LIMIT 40')).rows;
  var vehicles = (await pool.query(
    "SELECT id, name, plate, insurance_until, roadworthy_until FROM vehicles WHERE active AND (insurance_until <= current_date + 60 OR roadworthy_until <= current_date + 60) ORDER BY least(coalesce(insurance_until, '9999-01-01'), coalesce(roadworthy_until, '9999-01-01')) LIMIT 40")).rows;
  var papers = [];
  vehicles.forEach(function (v) {
    [['insurance', v.insurance_until], ['roadworthy', v.roadworthy_until]].forEach(function (x) {
      var d = dayText(x[1]);
      if (d && daysTo(d) <= 60) papers.push({ id: v.id, what: x[0], vehicle: v.name + (v.plate ? ' · ' + v.plate : ''), expiresOn: d, daysLeft: daysTo(d) });
    });
  });
  papers.sort(function (a, b) { return a.daysLeft - b.daysLeft; });
  return {
    certs: certs.map(function (c) { var d = dayText(c.expires_on); return { id: c.id, type: c.type, person: { id: c.emp, name: nameOf(c.first_name, c.last_name) }, expiresOn: d, daysLeft: daysTo(d) }; }),
    vehicles: papers
  };
}

// GET /api/licences?status=closed
async function overview(ctx, q) {
  need(ctx);
  q = q || {};
  var rows = (await pool.query(SEL + (q.status === 'closed' ? "WHERE l.status = 'closed' " : "WHERE l.status <> 'closed' ") + 'ORDER BY l.expires_on NULLS LAST, l.title')).rows.map(licenceOut);
  var all = (await pool.query("SELECT expires_on, cost, issued_on, status FROM licences WHERE status <> 'closed'")).rows;
  var past = (await pool.query('SELECT cost, issued_on FROM licence_renewals')).rows;
  var year = today().slice(0, 4);
  var spentYear = all.concat(past).filter(function (r) { return dayText(r.issued_on) && dayText(r.issued_on).slice(0, 4) === year; }).reduce(function (a, r) { return a + Number(r.cost); }, 0);
  // The next twelve months: what ends in each.
  var months = [];
  var d = new Date(today().slice(0, 7) + '-01T12:00:00Z');
  for (var i = 0; i < 12; i++) {
    var m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1)).toISOString().slice(0, 7);
    months.push({ month: m, count: 0, cost: 0 });
  }
  all.forEach(function (r) {
    var e = dayText(r.expires_on);
    var slot = e && months.find(function (x) { return x.month === e.slice(0, 7); });
    if (slot) { slot.count++; slot.cost = round2(slot.cost + Number(r.cost)); }
  });
  var open = q.status === 'closed' ? (await pool.query(SEL + "WHERE l.status <> 'closed'")).rows.map(licenceOut) : rows;
  var also = await alsoExpiring();
  var companies = (await pool.query('SELECT id, name, code FROM companies ORDER BY name')).rows;
  var people = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name")).rows.map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name) }; });
  return {
    licences: rows, months: months, also: also, companies: companies, people: people, kinds: KINDS,
    summary: {
      held: open.length,
      expired: open.filter(function (l) { return l.state === 'expired' || l.state === 'renewing_late'; }).length,
      due: open.filter(function (l) { return l.state === 'due'; }).length,
      renewing: open.filter(function (l) { return l.state === 'renewing' || l.state === 'renewing_late'; }).length,
      spentYear: round2(spentYear),
      next: open.filter(function (l) { return l.daysLeft != null && l.daysLeft >= 0 && l.state !== 'renewing'; }).sort(function (a, b) { return a.daysLeft - b.daysLeft; })[0] || null,
      alsoSoon: also.certs.filter(function (c) { return c.daysLeft <= 30; }).length + also.vehicles.filter(function (v) { return v.daysLeft <= 30; }).length
    }
  };
}

// GET /api/licences/:id — with the periods before this one.
async function get(ctx, id) {
  need(ctx);
  var l = licenceOut(await licenceOf(id));
  l.history = (await pool.query(
    'SELECT r.*, e.first_name, e.last_name FROM licence_renewals r LEFT JOIN employees e ON e.id = r.by_id WHERE r.licence_id = $1 ORDER BY r.expires_on DESC NULLS LAST, r.at DESC', [l.id])).rows.map(function (r) {
    return { id: r.id, number: r.number, issuedOn: dayText(r.issued_on), expiresOn: dayText(r.expires_on), cost: Number(r.cost), note: r.note, by: nameOf(r.first_name, r.last_name), at: r.at,
      files: (r.files || []).map(function (f, n) { return { n: n, name: f.name, type: f.type }; }) };
  });
  return l;
}

async function newFiles(list, prefix) {
  var out = [];
  var given = Array.isArray(list) ? list.slice(0, MAX_FILES) : [];
  for (var i = 0; i < given.length; i++) if (given[i] && given[i].dataUrl) out.push(await keepFile(given[i].dataUrl, given[i].name, prefix));
  return out;
}

function cleanPeriod(p) {
  var issued = dayOr(p.issuedOn), expires = dayOr(p.expiresOn);
  if (issued && expires && expires < issued) fail('invalid', 'It cannot end before it was issued.');
  var cost = Number(p.cost);
  if (p.cost !== undefined && p.cost !== '' && !(cost >= 0 && cost < 1e9)) fail('invalid', 'What did it cost?');
  return { issued: issued, expires: expires, cost: round2(cost >= 0 ? cost : 0), number: text(p.number, 80) };
}

// POST /api/licences, PUT /api/licences/:id { kind, title, companyId,
// authority, number, site, issuedOn, expiresOn, cost, ownerId, leadDays,
// note, addFiles: [{ dataUrl, name }], removeFiles: [n] }
async function save(ctx, id, p) {
  need(ctx);
  p = p || {};
  var title = text(p.title, 140);
  if (title.length < 3) fail('invalid', 'What is it called? e.g. Business operating permit.');
  var kind = KINDS.indexOf(p.kind) >= 0 ? p.kind : 'other';
  var period = cleanPeriod(p);
  var lead = Math.max(0, Math.min(365, Math.round(Number(p.leadDays) || 30)));
  var company = uuidOr(p.companyId);
  if (company && !(await pool.query('SELECT 1 FROM companies WHERE id = $1', [company])).rows[0]) fail('invalid', 'Which company?');
  var owner = uuidOr(p.ownerId);
  var added = await newFiles(p.addFiles, 'licence');
  var row;
  if (id) {
    var cur = await licenceOf(id);
    var files = (cur.files || []).filter(function (f, n) { return (p.removeFiles || []).indexOf(n) < 0; }).concat(added);
    if (files.length > 12) fail('invalid', 'Twelve files at most.');
    row = (await pool.query(
      'UPDATE licences SET kind = $2, title = $3, company_id = $4, authority = $5, number = $6, site = $7, issued_on = $8, expires_on = $9, cost = $10, owner_id = $11, lead_days = $12, note = $13, files = $14, updated_at = now() WHERE id = $1 RETURNING id',
      [cur.id, kind, title, company, text(p.authority, 140), period.number, text(p.site, 120), period.issued, period.expires, period.cost, owner, lead, text(p.note, 2000), JSON.stringify(files)])).rows[0];
    await audit(pool, ctx, 'licence.update', 'licence', row.id, '"' + title + '" changed.');
  } else {
    row = (await pool.query(
      'INSERT INTO licences (kind, title, company_id, authority, number, site, issued_on, expires_on, cost, owner_id, lead_days, note, files, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id',
      [kind, title, company, text(p.authority, 140), period.number, text(p.site, 120), period.issued, period.expires, period.cost, owner, lead, text(p.note, 2000), JSON.stringify(added), me(ctx)])).rows[0];
    await audit(pool, ctx, 'licence.create', 'licence', row.id, '"' + title + '" added' + (period.expires ? ', ends ' + period.expires : '') + '.');
  }
  return get(ctx, row.id);
}

// POST /api/licences/:id/applied { on, note } — the renewal is in.
async function applied(ctx, id, p) {
  need(ctx);
  p = p || {};
  var l = await licenceOf(id);
  if (l.status === 'closed') fail('conflict', 'It is closed: open it again first.');
  var on = dayOr(p.on) || today();
  if (on > today()) fail('invalid', 'When did you apply? Today or before.');
  await pool.query("UPDATE licences SET status = 'renewing', renewing_since = $2, note = CASE WHEN $3 = '' THEN note ELSE $3 END, updated_at = now() WHERE id = $1", [l.id, on, text(p.note, 2000)]);
  await audit(pool, ctx, 'licence.applied', 'licence', l.id, 'Renewal of "' + l.title + '" applied for on ' + on + '.');
  return get(ctx, l.id);
}

// POST /api/licences/:id/renew { number, issuedOn, expiresOn, cost, files, note }
// — the new period: the one before goes to the history.
async function renew(ctx, id, p) {
  need(ctx);
  p = p || {};
  var l = await licenceOf(id);
  if (l.status === 'closed') fail('conflict', 'It is closed: open it again first.');
  var period = cleanPeriod(p);
  if (!period.expires) fail('invalid', 'When does the new one end?');
  if (dayText(l.expires_on) && period.expires <= dayText(l.expires_on)) fail('invalid', 'The new one should end after ' + dayText(l.expires_on) + '.');
  var files = await newFiles(p.files, 'licence');
  await withTransaction(async function (db) {
    await db.query('INSERT INTO licence_renewals (licence_id, number, issued_on, expires_on, cost, files, note, by_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [l.id, l.number, l.issued_on, l.expires_on, l.cost, JSON.stringify(l.files || []), text(p.note, 1000), me(ctx)]);
    await db.query("UPDATE licences SET number = $2, issued_on = $3, expires_on = $4, cost = $5, files = $6, status = 'active', renewing_since = NULL, updated_at = now() WHERE id = $1",
      [l.id, period.number || l.number, period.issued || today(), period.expires, period.cost, JSON.stringify(files)]);
  });
  await audit(pool, ctx, 'licence.renew', 'licence', l.id, '"' + l.title + '" renewed to ' + period.expires + (period.cost ? ' (' + period.cost.toFixed(2) + ')' : '') + '.');
  return get(ctx, l.id);
}

// POST /api/licences/:id/close { note }, /reopen
async function setClosed(ctx, id, closed, p) {
  need(ctx);
  var l = await licenceOf(id);
  if (closed && l.status === 'closed') fail('conflict', 'It is closed already.');
  if (!closed && l.status !== 'closed') fail('conflict', 'It is open.');
  var note = text(p && p.note, 500);
  if (closed && note.length < 3) fail('invalid', 'Why is it no longer needed?');
  await pool.query('UPDATE licences SET status = $2, note = CASE WHEN $3 = \'\' THEN note ELSE $3 END, updated_at = now() WHERE id = $1', [l.id, closed ? 'closed' : 'active', note]);
  await audit(pool, ctx, closed ? 'licence.close' : 'licence.reopen', 'licence', l.id, '"' + l.title + '" ' + (closed ? 'closed: ' + note : 'opened again') + '.');
  return get(ctx, l.id);
}

// GET /api/licences/:id/files/:n?renewal= — a copy, to open.
async function fileOf(ctx, id, n, renewalId) {
  need(ctx);
  var files;
  if (renewalId) {
    var r = (await pool.query('SELECT files FROM licence_renewals WHERE id = $1 AND licence_id = $2', [uuidOr(renewalId), uuidOr(id)])).rows[0];
    if (!r) fail('notfound', 'That file is gone.');
    files = r.files || [];
  } else files = (await licenceOf(id)).files || [];
  var f = files[Math.round(Number(n))];
  if (!f) fail('notfound', 'That file is gone.');
  return f;
}

// For the daily alerts: in force and ending within 60 days, or ended.
async function dueSoon() {
  return (await pool.query(SEL + "WHERE l.status <> 'closed' AND l.expires_on IS NOT NULL AND l.expires_on <= current_date + 60")).rows;
}

module.exports = { overview: overview, get: get, save: save, applied: applied, renew: renew, setClosed: setClosed, fileOf: fileOf, dueSoon: dueSoon, keepFile: keepFile, stateOf: stateOf, KINDS: KINDS };
