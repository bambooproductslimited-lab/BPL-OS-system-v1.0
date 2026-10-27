var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Asset depreciation and disposals (Finance → Depreciation; migration 0199):
// each asset in the register (assets.service.js) loses its value over its
// useful life — straight line, or reducing balance at a yearly rate — down to
// what it will still be worth at the end. A month's charge, the value still
// on the books at any day, each category and company; and what happens when
// one is sold, scrapped, given away or lost: the gain or loss against its
// book value. An asset without its own life uses its category's (Settings),
// else a usual one for its kind. Charged from the month after it was bought,
// for whole months; disposed of, it stops that month.

var METHODS = ['straight', 'reducing', 'none'];
var DISPOSALS = ['sold', 'scrapped', 'donated', 'lost', 'stolen'];
// Usual lives, by what the category or description says.
var USUAL = [
  { re: /comput|laptop|printer|phone|tablet|server|router|monitor|\bit\b|camera/i, kind: 'it', months: 36 },
  { re: /vehicle|\bvan\b|truck|\bcar\b|motor|bike|tricycle|forklift/i, kind: 'vehicles', months: 60 },
  { re: /build|structure|warehouse|\bshed\b|roof/i, kind: 'buildings', months: 300 },
  { re: /furnit|fitting|fixture|\bdesk|chair|shelf|shelv|cabinet/i, kind: 'furniture', months: 60 },
  { re: /machin|plant|equip|tool|generator|\bsaw\b|lathe|press|kiln|compressor|dryer|oven|fridge|freezer|cooker/i, kind: 'machinery', months: 84 }
];
var DEFAULT_MONTHS = 60, DEFAULT_RATE = 25;

function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function shift(month, n) { var d = new Date(month + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function monthsBetween(a, b) { return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)); }
function lastDay(month) { return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function canRead(ctx) { return ctx.can('asset.read') || ctx.can('report.read'); }
function canManage(ctx) { return ctx.can('asset.manage') || ctx.can('report.manage'); }
function needRead(ctx) { if (!canRead(ctx)) fail('forbidden', 'Your role does not allow this action (asset.read).'); }
function needManage(ctx) { if (!canManage(ctx)) fail('forbidden', 'Your role does not allow this action (asset.manage).'); }

async function settingsOf() {
  var s = (await pool.query('SELECT depreciation FROM settings WHERE id = 1')).rows[0];
  var d = (s && s.depreciation) || {};
  return { byCategory: d.byCategory && typeof d.byCategory === 'object' ? d.byCategory : {} };
}

// How an asset loses value: its own setting, its category's, the usual.
function policyOf(a, settings) {
  var cat = settings.byCategory[a.category] || null;
  var usual = USUAL.find(function (u) { return u.re.test(a.category || '') || u.re.test(a.description || ''); });
  var method = a.depreciation_method || (cat && cat.method) || 'straight';
  var months = a.useful_life_months || (cat && cat.months) || (usual ? usual.months : DEFAULT_MONTHS);
  var rate = a.reducing_rate != null ? Number(a.reducing_rate) : cat && cat.rate ? Number(cat.rate) : DEFAULT_RATE;
  return {
    method: method, months: months, rate: rate, residual: Math.min(Number(a.residual_value || 0), Number(a.purchase_price || 0)),
    from: dayText(a.depreciation_from || a.purchase_date), source: a.depreciation_method || a.useful_life_months ? 'asset' : cat ? 'category' : usual ? 'usual' : 'default'
  };
}
// Depreciation charged after n whole months.
function accumulated(cost, pol, n) {
  if (pol.method === 'none' || n <= 0 || cost <= 0) return 0;
  var top = Math.max(0, cost - pol.residual);
  // The yearly rate, spread so that twelve months take exactly that share.
  if (pol.method === 'reducing') return r2(Math.min(top, cost - cost * Math.pow(1 - pol.rate / 100, n / 12)));
  return r2(Math.min(top, top / pol.months * Math.min(n, pol.months)));
}
// Whole months charged by the end of a month: from the month after it was
// bought, stopping the month it went.
function monthsBy(a, pol, month) {
  if (!pol.from) return 0;
  var first = shift(pol.from.slice(0, 7), 1);
  var last = month;
  if (a.disposed_on) { var gone = shift(dayText(a.disposed_on).slice(0, 7), -1); if (gone < last) last = gone; }
  return last < first ? 0 : monthsBetween(first, last) + 1;
}
// The last whole month as at a day.
function closedMonth(day) { return day === lastDay(day.slice(0, 7)) ? day.slice(0, 7) : shift(day.slice(0, 7), -1); }

function assetOut(a, pol, asOf, year) {
  var cost = r2(a.purchase_price);
  var m = closedMonth(asOf);
  var acc = accumulated(cost, pol, monthsBy(a, pol, m));
  var startYear = accumulated(cost, pol, monthsBy(a, pol, shift(year + '-01', -1)));
  var endYear = accumulated(cost, pol, monthsBy(a, pol, year + '-12'));
  var monthly = pol.method === 'straight' ? r2(Math.max(0, cost - pol.residual) / pol.months) : null;
  var disposedOn = dayText(a.disposed_on);
  var bookAtDisposal = disposedOn ? r2(cost - accumulated(cost, pol, monthsBy(a, pol, shift(disposedOn.slice(0, 7), -1)))) : null;
  var full = pol.method !== 'none' && cost > 0 && acc >= r2(Math.max(0, cost - pol.residual)) - 0.01;
  return {
    id: a.id, assetNo: a.asset_no, description: a.description, category: a.category || '', company: a.company || '', companyId: a.company_id,
    purchaseDate: dayText(a.purchase_date), cost: cost, status: a.status, location: a.location || '',
    method: pol.method, months: pol.months, rate: pol.rate, residual: r2(pol.residual), from: pol.from, source: pol.source, monthly: monthly,
    accumulated: acc, book: disposedOn && disposedOn <= asOf ? 0 : r2(cost - acc), thisYear: r2(endYear - startYear),
    fullyDepreciated: full, noCost: !(cost > 0), noDate: !pol.from,
    endsOn: pol.method === 'straight' && pol.from ? lastDay(shift(pol.from.slice(0, 7), pol.months)) : null,
    disposal: disposedOn ? { on: disposedOn, kind: a.disposal_kind, amount: r2(a.disposal_amount), note: a.disposal_note, book: bookAtDisposal, gain: r2(Number(a.disposal_amount || 0) - bookAtDisposal) } : null
  };
}

// GET /api/depreciation?company=&asOf=&year=
async function view(ctx, q) {
  needRead(ctx);
  q = q || {};
  var asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(q.asOf || '')) && q.asOf <= today() ? q.asOf : today();
  var year = /^\d{4}$/.test(String(q.year || '')) ? String(q.year) : asOf.slice(0, 4);
  var company = uuidOr(q.company);
  var settings = await settingsOf();
  var rows = (await pool.query('SELECT a.*, c.name AS company FROM assets a LEFT JOIN companies c ON c.id = a.company_id ' + (company ? 'WHERE a.company_id = $1 ' : '') + 'ORDER BY a.asset_no', company ? [company] : [])).rows;
  // Disposed before the year: no longer on the books.
  rows = rows.filter(function (a) { return !a.disposed_on || dayText(a.disposed_on) >= year + '-01-01'; });
  var assets = rows.map(function (a) { return assetOut(a, policyOf(a, settings), asOf, year); });
  var live = assets.filter(function (a) { return !a.disposal || a.disposal.on > asOf; });
  // The year by month: the charge (to come, for months not yet closed).
  var closed = closedMonth(today());
  var months = [];
  for (var i = 1; i <= 12; i++) {
    var m = year + '-' + String(i).padStart(2, '0');
    var charge = 0;
    rows.forEach(function (a) {
      var pol = policyOf(a, settings), cost = Number(a.purchase_price);
      charge += accumulated(cost, pol, monthsBy(a, pol, m)) - accumulated(cost, pol, monthsBy(a, pol, shift(m, -1)));
    });
    months.push({ month: m, charge: r2(charge), future: m > closed });
  }
  var cats = {};
  live.forEach(function (a) {
    var k = a.category || '—';
    cats[k] = cats[k] || { category: k, count: 0, cost: 0, accumulated: 0, book: 0, thisYear: 0 };
    var c = cats[k]; c.count++; c.cost = r2(c.cost + a.cost); c.accumulated = r2(c.accumulated + a.accumulated); c.book = r2(c.book + a.book); c.thisYear = r2(c.thisYear + a.thisYear);
  });
  var disposals = assets.filter(function (a) { return a.disposal && a.disposal.on.slice(0, 4) === year; });
  var sum = function (list, k) { return r2(list.reduce(function (s, a) { return s + a[k]; }, 0)); };
  return {
    asOf: asOf, year: year, company: company || '', companies: (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows,
    assets: assets, categories: Object.keys(cats).map(function (k) { return cats[k]; }).sort(function (a, b) { return b.cost - a.cost; }),
    months: months, disposals: disposals,
    totals: {
      count: live.length, cost: sum(live, 'cost'), accumulated: sum(live, 'accumulated'), book: sum(live, 'book'),
      thisYear: r2(months.reduce(function (s, m) { return s + m.charge; }, 0)), soFar: r2(months.filter(function (m) { return !m.future; }).reduce(function (s, m) { return s + m.charge; }, 0)),
      fully: live.filter(function (a) { return a.fullyDepreciated; }).length, missing: live.filter(function (a) { return a.noCost || a.noDate; }).length,
      gain: r2(disposals.reduce(function (s, a) { return s + a.disposal.gain; }, 0))
    },
    settings: settings, methods: METHODS, disposalKinds: DISPOSALS, canManage: canManage(ctx),
    usual: USUAL.map(function (u) { return { kind: u.kind, months: u.months }; }).concat([{ kind: 'other', months: DEFAULT_MONTHS }])
  };
}

async function assetOf(id) {
  var a = (await pool.query('SELECT a.*, c.name AS company FROM assets a LEFT JOIN companies c ON c.id = a.company_id WHERE a.id = $1', [uuidOr(id)])).rows[0];
  if (!a) fail('notfound', 'That asset is gone.');
  return a;
}

// GET /api/depreciation/assets/:id — its schedule, year by year.
async function schedule(ctx, id) {
  needRead(ctx);
  var a = await assetOf(id);
  var settings = await settingsOf();
  var pol = policyOf(a, settings);
  var out = assetOut(a, pol, today(), today().slice(0, 4));
  out.years = [];
  if (pol.from && Number(a.purchase_price) > 0 && pol.method !== 'none') {
    var cost = Number(a.purchase_price);
    var y0 = Number(pol.from.slice(0, 4));
    var lastYear = a.disposed_on ? Number(dayText(a.disposed_on).slice(0, 4)) : pol.method === 'straight' ? Number(shift(pol.from.slice(0, 7), pol.months).slice(0, 4)) : y0 + 15;
    for (var y = y0; y <= lastYear && y < y0 + 40; y++) {
      var before = accumulated(cost, pol, monthsBy(a, pol, (y - 1) + '-12'));
      var after = accumulated(cost, pol, monthsBy(a, pol, y + '-12'));
      out.years.push({ year: y, opening: r2(cost - before), charge: r2(after - before), closing: r2(cost - after) });
      if (after >= cost - pol.residual - 0.01 && pol.method === 'reducing' && y > y0 + 2) break;
    }
  }
  return out;
}

// PUT /api/depreciation/assets/:id { method, months, rate, residual, from }
async function setPolicy(ctx, id, p) {
  needManage(ctx);
  p = p || {};
  var a = await assetOf(id);
  var method = p.method === '' || p.method == null ? null : METHODS.indexOf(p.method) >= 0 ? p.method : fail('invalid', 'Straight line, reducing balance or none.');
  var months = p.months === '' || p.months == null ? null : Math.round(Number(p.months));
  if (months != null && !(months >= 1 && months <= 600)) fail('invalid', 'A useful life of 1 to 600 months.');
  var rate = p.rate === '' || p.rate == null ? null : Math.round(Number(p.rate) * 100) / 100;
  if (rate != null && !(rate > 0 && rate <= 100)) fail('invalid', 'A yearly rate above 0, up to 100%.');
  var residual = p.residual === '' || p.residual == null ? 0 : r2(p.residual);
  if (!(residual >= 0) || residual > Number(a.purchase_price)) fail('invalid', 'What it is worth at the end: 0 up to what it cost.');
  var from = p.from ? (/^\d{4}-\d{2}-\d{2}$/.test(String(p.from)) ? p.from : fail('invalid', 'From which day?')) : null;
  await pool.query('UPDATE assets SET depreciation_method = $2, useful_life_months = $3, reducing_rate = $4, residual_value = $5, depreciation_from = $6, updated_at = now() WHERE id = $1', [a.id, method, months, rate, residual, from]);
  await audit(pool, ctx, 'asset.depreciation', 'asset', a.id, a.asset_no + ': ' + (method || 'the usual way') + (months ? ', ' + months + ' months' : '') + (rate ? ', ' + rate + '% a year' : '') + (residual ? ', worth ' + residual + ' at the end' : '') + '.');
  return schedule(ctx, a.id);
}

// POST /api/depreciation/assets/:id/dispose { on, kind, amount, note } —
// and /undo.
async function dispose(ctx, id, p) {
  needManage(ctx);
  p = p || {};
  var a = await assetOf(id);
  if (a.disposed_on) fail('conflict', 'It is disposed of already: undo that first.');
  var on = /^\d{4}-\d{2}-\d{2}$/.test(String(p.on || '')) && p.on <= today() ? p.on : fail('invalid', 'On which day, today or before?');
  if (a.purchase_date && on < dayText(a.purchase_date)) fail('invalid', 'Before it was bought?');
  var kind = DISPOSALS.indexOf(p.kind) >= 0 ? p.kind : fail('invalid', 'Sold, scrapped, given away, lost or stolen?');
  var amount = kind === 'sold' ? r2(p.amount) : r2(p.amount || 0);
  if (kind === 'sold' && !(amount > 0)) fail('invalid', 'For how much was it sold?');
  if (!(amount >= 0)) fail('invalid', 'An amount of 0 or more.');
  await pool.query("UPDATE assets SET disposed_on = $2, disposal_kind = $3, disposal_amount = $4, disposal_note = $5, disposed_by = $6, status = 'retired', retired_on = $2, assigned_employee_id = NULL, updated_at = now() WHERE id = $1",
    [a.id, on, kind, amount, String(p.note == null ? '' : p.note).trim().slice(0, 500), me(ctx)]);
  var out = await schedule(ctx, a.id);
  await audit(pool, ctx, 'asset.dispose', 'asset', a.id, a.asset_no + ' ' + kind + ' on ' + on + (amount ? ' for ' + amount.toFixed(2) : '') + '; book value ' + out.disposal.book.toFixed(2) + ', ' + (out.disposal.gain >= 0 ? 'gain ' : 'loss ') + Math.abs(out.disposal.gain).toFixed(2) + '.');
  return out;
}
async function undoDisposal(ctx, id) {
  needManage(ctx);
  var a = await assetOf(id);
  if (!a.disposed_on) fail('conflict', 'It was not disposed of.');
  await pool.query("UPDATE assets SET disposed_on = NULL, disposal_kind = NULL, disposal_amount = NULL, disposal_note = '', disposed_by = NULL, status = 'in_use', retired_on = NULL, updated_at = now() WHERE id = $1", [a.id]);
  await audit(pool, ctx, 'asset.dispose', 'asset', a.id, a.asset_no + ': disposal undone.');
  return schedule(ctx, a.id);
}

// PUT /api/depreciation/settings { byCategory: { name: { method, months, rate } } }
async function saveSettings(ctx, p) {
  needManage(ctx);
  var src = (p && p.byCategory) || {};
  var clean = {};
  Object.keys(src).slice(0, 60).forEach(function (k) {
    var c = src[k] || {};
    var name = String(k).trim().slice(0, 40);
    var months = Math.round(Number(c.months));
    if (!name || !(months >= 1 && months <= 600)) return;
    var rate = Number(c.rate);
    clean[name] = { method: METHODS.indexOf(c.method) >= 0 ? c.method : 'straight', months: months, rate: rate > 0 && rate <= 100 ? Math.round(rate * 100) / 100 : null };
  });
  await pool.query("UPDATE settings SET depreciation = jsonb_set(coalesce(depreciation, '{}'), '{byCategory}', $1::jsonb) WHERE id = 1", [JSON.stringify(clean)]);
  await audit(pool, ctx, 'asset.depreciation', 'settings', null, 'Useful lives by category: ' + Object.keys(clean).length + ' set.');
  return view(ctx, {});
}

// GET /api/depreciation/export?company=&asOf= — the register as CSV.
async function exportCsv(ctx, q) {
  var v = await view(ctx, q);
  var cell = function (x) { var s = String(x == null ? '' : x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  var lines = [['Asset', 'Description', 'Category', 'Company', 'Bought', 'Cost', 'Method', 'Life (months)', 'Rate %', 'Residual', 'Depreciation to date', 'Book value', 'This year', 'Disposed', 'Proceeds', 'Gain or loss'].join(',')];
  v.assets.forEach(function (a) {
    lines.push([a.assetNo, a.description, a.category, a.company, a.purchaseDate || '', a.cost.toFixed(2), a.method, a.method === 'straight' ? a.months : '', a.method === 'reducing' ? a.rate : '', a.residual.toFixed(2),
      a.accumulated.toFixed(2), a.book.toFixed(2), a.thisYear.toFixed(2), a.disposal ? a.disposal.on + ' ' + a.disposal.kind : '', a.disposal ? a.disposal.amount.toFixed(2) : '', a.disposal ? a.disposal.gain.toFixed(2) : ''].map(cell).join(','));
  });
  lines.push(['', 'Total', '', '', '', v.totals.cost.toFixed(2), '', '', '', '', v.totals.accumulated.toFixed(2), v.totals.book.toFixed(2), v.totals.thisYear.toFixed(2)].map(cell).join(','));
  return { filename: 'depreciation-' + v.asOf + '.csv', csv: lines.join('\r\n') + '\r\n' };
}

module.exports = { view: view, schedule: schedule, setPolicy: setPolicy, dispose: dispose, undoDisposal: undoDisposal, saveSettings: saveSettings, exportCsv: exportCsv, accumulated: accumulated, policyOf: policyOf };
