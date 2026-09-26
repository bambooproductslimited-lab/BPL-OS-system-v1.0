var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// The restaurant report: the monthly analysis the restaurant used to build
// by hand from Square exports in a spreadsheet.
//
//   - sales and items sold by kitchen group (Bar, BBQ, Chinese, Thai…)
//     month by month, with the change on the month before and each group's
//     share of the whole;
//   - sales by shift and by hour;
//   - the month's items ranked by how many sold, within each group;
//   - the kitchen bonus: the month's best-selling dishes from the kitchens
//     that earn one, ranked by gross sales, the top ones earning a
//     percentage of what they sold, added up per kitchen.
//
// A menu item's kitchen group comes from its category (Square's category on
// imported items). The restaurant can set the group of each category; a
// category it hasn't set is guessed from its name. Shifts and the bonus
// rule are set per restaurant too. Sales are what was taken (after
// discounts); the item ranking and the bonus use gross sales (before
// discounts), as the spreadsheet did. Months and hours are UTC — Ghana time.

var WINDOW = 12;
var DEFAULT_SHIFTS = [{ name: 'Breakfast', start: 6 }, { name: 'Lunch', start: 11 }, { name: 'Dinner', start: 17 }, { name: 'Night cap', start: 22 }];
var DEFAULT_BONUS = { enabled: true, groups: ['Chinese', 'Thai'], top: 10, rate: 10 };
var GROUPS = ['Bar', 'BBQ', 'Breakfast', 'Chinese', 'Thai', 'Japanese', 'Korean', 'Service', 'Other'];
var NOT_ON_MENU = 'Not on the menu';

// first match wins: drinks named after a cuisine ("Thai Drinks") stay with
// that cuisine's kitchen
var GUESS = [
  [/service|服务/i, 'Service'],
  [/breakfast|早餐/i, 'Breakfast'],
  [/bbq|barbecue|烧烤/i, 'BBQ'],
  [/thai|泰/i, 'Thai'],
  [/japan|sushi|filipino|日式|日本/i, 'Japanese'],
  [/korea|韩/i, 'Korean'],
  [/\bbar\b|beer|alcohol|wine|whisk|cocktail|mocktail|drink|smoothie|juice|cigarette|啤酒|酒|饮料|饮品|烟|吧台|冰沙/i, 'Bar'],
  [/chinese|中式|广东|粤|hot dish|main dish|soup|congee|porridge|cold dish|vege|pot dish|special|快餐|热菜|主食|汤|粥|凉拌|青菜|干锅|特色/i, 'Chinese']
];
function guessGroup(category) {
  if (!category) return 'Other';
  for (var i = 0; i < GUESS.length; i++) if (GUESS[i][0].test(category)) return GUESS[i][1];
  return 'Other';
}

function num(v) { return Math.round(Number(v || 0) * 100) / 100; }
function monthKey(d) { return d.toISOString().slice(0, 7); }
function addMonths(key, n) {
  var d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + n, 1));
  return monthKey(d);
}
function monthStart(key) { return key + '-01T00:00:00Z'; }

function shiftOf(shifts, hour) {
  var pick = shifts[shifts.length - 1];
  for (var i = 0; i < shifts.length; i++) if (shifts[i].start <= hour) pick = shifts[i];
  return pick;
}
// the hours of each shift in the order they happen, from its start round
// to the next shift's start (the last one runs past midnight)
function shiftHours(shifts) {
  return shifts.map(function (s, i) {
    var end = shifts[(i + 1) % shifts.length].start;
    var hours = [];
    for (var h = s.start; hours.length < 24; h = (h + 1) % 24) {
      if (hours.length && h === end) break;
      hours.push(h);
    }
    return hours;
  });
}

async function loadSettings(companyId) {
  var row = (await pool.query('SELECT * FROM restaurant_report_settings WHERE company_id = $1', [companyId])).rows[0];
  var shifts = row && Array.isArray(row.shifts) && row.shifts.length ? row.shifts : DEFAULT_SHIFTS;
  return {
    groups: (row && row.groups) || {},
    shifts: shifts.slice().sort(function (a, b) { return a.start - b.start; }),
    bonus: Object.assign({}, DEFAULT_BONUS, (row && row.bonus) || {}),
    updatedAt: row ? row.updated_at : null,
    saved: !!row
  };
}

async function company(ctx, companyId, perm) {
  if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').');
  if (!companyId) fail('invalid', 'Choose a restaurant.');
  var co = (await pool.query('SELECT id, name FROM companies WHERE id = $1', [companyId])).rows[0];
  if (!co) fail('notfound', 'Company not found.');
  return co;
}

async function report(ctx, companyId, opts) {
  opts = opts || {};
  await company(ctx, companyId, 'restaurant.read');
  var settings = await loadSettings(companyId);
  var groupOf = function (category) {
    if (category === null || category === undefined) return NOT_ON_MENU;
    return settings.groups[category] || guessGroup(category);
  };

  var DONE = "o.company_id = $1 AND o.status = 'completed'";
  var span = (await pool.query("SELECT min(o.created_at) AS first, max(o.created_at) AS last FROM restaurant_orders o WHERE " + DONE, [companyId])).rows[0];
  var nowKey = monthKey(new Date());
  var lastKey = span.last ? monthKey(new Date(span.last)) : nowKey;
  if (lastKey > nowKey) lastKey = nowKey;
  var month = /^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month || '') ? opts.month : lastKey;
  var months = [];
  for (var i = WINDOW - 1; i >= 0; i--) months.push(addMonths(month, -i));
  // a year back too, for the same month last year
  var lastYear = addMonths(month, -12);
  var from = monthStart(lastYear);
  var to = monthStart(addMonths(month, 1));
  var selFrom = monthStart(month);

  var MON = "to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM')";
  var GROSS = 'coalesce(i.gross, greatest(i.line_total, i.unit_price * i.qty))';
  var q = await Promise.all([
    pool.query(
      'SELECT ' + MON + ' AS mon, m.category, sum(i.qty) AS qty, sum(i.line_total) AS net, sum(' + GROSS + ') AS gross ' +
      'FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id ' +
      'WHERE ' + DONE + ' AND o.created_at >= $2 AND o.created_at < $3 GROUP BY 1, 2', [companyId, from, to]),
    pool.query(
      'SELECT ' + MON + " AS mon, extract(hour FROM o.created_at AT TIME ZONE 'UTC')::int AS hour, count(*) AS orders, sum(o.total) AS net " +
      'FROM restaurant_orders o WHERE ' + DONE + ' AND o.created_at >= $2 AND o.created_at < $3 GROUP BY 1, 2', [companyId, from, to]),
    pool.query(
      "SELECT coalesce(i.menu_item_id::text, 'name:' || i.name) AS key, coalesce(m.name, i.name) AS name, m.category, " +
      '  sum(i.qty) AS qty, sum(i.line_total) AS net, sum(' + GROSS + ') AS gross ' +
      'FROM restaurant_order_items i JOIN restaurant_orders o ON o.id = i.order_id LEFT JOIN restaurant_menu_items m ON m.id = i.menu_item_id ' +
      'WHERE ' + DONE + ' AND o.created_at >= $2 AND o.created_at < $3 GROUP BY 1, 2, 3', [companyId, selFrom, to]),
    pool.query(
      "SELECT category, count(*) FILTER (WHERE active) AS active, count(*) AS n FROM restaurant_menu_items WHERE company_id = $1 GROUP BY 1 ORDER BY 1", [companyId])
  ]);

  // ── by kitchen group, month by month ──
  var groups = {};
  var totals = {};
  [lastYear].concat(months).forEach(function (k) { totals[k] = { net: 0, qty: 0, orders: 0, lines: 0 }; });
  q[0].rows.forEach(function (r) {
    var g = groupOf(r.category);
    if (!groups[g]) groups[g] = { group: g, byMonth: {}, net: 0, qty: 0 };
    var cell = groups[g].byMonth[r.mon] || (groups[g].byMonth[r.mon] = { net: 0, qty: 0 });
    cell.net += Number(r.net); cell.qty += Number(r.qty);
    groups[g].net += Number(r.net); groups[g].qty += Number(r.qty);
    totals[r.mon].qty += Number(r.qty);
    totals[r.mon].lines += Number(r.net);
  });
  var groupList = Object.keys(groups).map(function (g) {
    var x = groups[g];
    Object.keys(x.byMonth).forEach(function (k) { x.byMonth[k] = { net: num(x.byMonth[k].net), qty: num(x.byMonth[k].qty) }; });
    return { group: x.group, byMonth: x.byMonth, net: num(x.net), qty: num(x.qty) };
  }).sort(function (a, b) { return (b.byMonth[month] || { net: 0 }).net - (a.byMonth[month] || { net: 0 }).net || b.net - a.net; });

  // ── shifts and hours (order totals, so a sale is counted once) ──
  var hoursOf = shiftHours(settings.shifts);
  var shifts = settings.shifts.map(function (s, idx) { return { name: s.name, start: s.start, hours: hoursOf[idx].map(function (h) { return { hour: h, net: 0, orders: 0 }; }), byMonth: {} }; });
  q[1].rows.forEach(function (r) {
    totals[r.mon].net += Number(r.net);
    totals[r.mon].orders += Number(r.orders);
    var s = shifts[settings.shifts.indexOf(shiftOf(settings.shifts, r.hour))];
    var cell = s.byMonth[r.mon] || (s.byMonth[r.mon] = { net: 0, orders: 0 });
    cell.net += Number(r.net); cell.orders += Number(r.orders);
    if (r.mon === month) {
      var h = s.hours.find(function (x) { return x.hour === r.hour; });
      h.net += Number(r.net); h.orders += Number(r.orders);
    }
  });
  shifts.forEach(function (s) {
    s.hours.forEach(function (h) { h.net = num(h.net); });
    Object.keys(s.byMonth).forEach(function (k) { s.byMonth[k].net = num(s.byMonth[k].net); });
  });
  Object.keys(totals).forEach(function (k) { totals[k].net = num(totals[k].net); totals[k].qty = num(totals[k].qty); totals[k].lines = num(totals[k].lines); });

  // ── the month's items ──
  var items = q[2].rows.map(function (r) {
    return { key: r.key, name: r.name, category: r.category || null, group: groupOf(r.category), qty: num(r.qty), net: num(r.net), gross: num(r.gross) };
  }).sort(function (a, b) { return b.qty - a.qty || b.gross - a.gross; });

  // ── the kitchen bonus ──
  var rule = settings.bonus;
  var enabled = rule.enabled !== false;
  var inBonus = enabled ? (rule.groups || []) : [];
  var ranked = items.filter(function (it) { return inBonus.indexOf(it.group) >= 0 && it.gross > 0; })
    .sort(function (a, b) { return b.gross - a.gross; });
  var bonusRows = ranked.slice(0, rule.top + 5).map(function (it, idx) {
    var rate = idx < rule.top ? Number(rule.rate) : 0;
    return { rank: idx + 1, key: it.key, name: it.name, kitchen: it.category || it.group, group: it.group, qty: it.qty, gross: it.gross, rate: rate, bonus: num(it.gross * rate / 100) };
  });
  var kitchens = {};
  bonusRows.forEach(function (r) {
    if (!r.bonus) return;
    var k = kitchens[r.kitchen] || (kitchens[r.kitchen] = { kitchen: r.kitchen, group: r.group, items: 0, gross: 0, bonus: 0 });
    k.items += 1; k.gross += r.gross; k.bonus += r.bonus;
  });
  var kitchenList = Object.keys(kitchens).map(function (k) { var x = kitchens[k]; return { kitchen: x.kitchen, group: x.group, items: x.items, gross: num(x.gross), bonus: num(x.bonus) }; })
    .sort(function (a, b) { return b.bonus - a.bonus; });

  var categories = q[3].rows.map(function (r) {
    return { category: r.category, group: groupOf(r.category), set: !!settings.groups[r.category], guess: guessGroup(r.category), items: Number(r.n), active: Number(r.active) };
  });

  return {
    companyId: companyId, month: month, months: months, lastYear: lastYear,
    first: span.first ? monthKey(new Date(span.first)) : null, last: span.last ? lastKey : null,
    totals: totals, groups: groupList, shifts: shifts, items: items,
    bonus: {
      rule: { enabled: enabled, groups: enabled ? inBonus : (rule.groups || []), top: rule.top, rate: Number(rule.rate) },
      rows: bonusRows, kitchens: kitchenList,
      total: num(kitchenList.reduce(function (s, k) { return s + k.bonus; }, 0))
    },
    settings: { groups: settings.groups, shifts: settings.shifts, bonus: rule, updatedAt: settings.updatedAt, saved: settings.saved },
    categories: categories, knownGroups: GROUPS, notOnMenu: NOT_ON_MENU
  };
}

function cleanText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

async function saveSettings(ctx, companyId, body) {
  var co = await company(ctx, companyId, 'restaurant.manage');
  body = body || {};
  var groups = {};
  Object.keys(body.groups || {}).forEach(function (cat) {
    var g = cleanText(body.groups[cat], 40);
    if (g && cat.length <= 120) groups[cat] = g;
  });
  var shifts = Array.isArray(body.shifts) ? body.shifts.map(function (s) {
    return { name: cleanText(s && s.name, 40), start: Number(s && s.start) };
  }) : DEFAULT_SHIFTS;
  if (!shifts.length || shifts.length > 8) fail('invalid', 'Have between 1 and 8 shifts.');
  shifts.forEach(function (s) {
    if (!s.name) fail('invalid', 'Give every shift a name.');
    if (!Number.isInteger(s.start) || s.start < 0 || s.start > 23) fail('invalid', 'A shift starts on the hour, from 0 to 23.');
  });
  if (new Set(shifts.map(function (s) { return s.start; })).size !== shifts.length) fail('invalid', 'Two shifts cannot start at the same hour.');
  shifts.sort(function (a, b) { return a.start - b.start; });
  var b = body.bonus || {};
  var bonus = {
    enabled: b.enabled !== false,
    groups: Array.isArray(b.groups) ? b.groups.map(function (g) { return cleanText(g, 40); }).filter(Boolean) : DEFAULT_BONUS.groups,
    top: Number(b.top === undefined ? DEFAULT_BONUS.top : b.top),
    rate: Number(b.rate === undefined ? DEFAULT_BONUS.rate : b.rate)
  };
  if (!Number.isInteger(bonus.top) || bonus.top < 1 || bonus.top > 100) fail('invalid', 'The number of dishes that earn a bonus is from 1 to 100.');
  if (!(bonus.rate >= 0 && bonus.rate <= 100)) fail('invalid', 'The bonus rate is a percentage from 0 to 100.');

  await pool.query(
    'INSERT INTO restaurant_report_settings (company_id, groups, shifts, bonus, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, now()) ' +
    'ON CONFLICT (company_id) DO UPDATE SET groups = EXCLUDED.groups, shifts = EXCLUDED.shifts, bonus = EXCLUDED.bonus, updated_by = EXCLUDED.updated_by, updated_at = now()',
    [companyId, JSON.stringify(groups), JSON.stringify(shifts), JSON.stringify(bonus), ctx.employee ? ctx.employee.id : null]);
  await audit(pool, ctx, 'restaurant.report.settings', 'company', companyId,
    'Report settings for ' + co.name + ': ' + Object.keys(groups).length + ' categories grouped, shifts ' +
    shifts.map(function (s) { return s.name + ' from ' + s.start + ':00'; }).join(', ') +
    (bonus.enabled ? '; bonus ' : '; no kitchen bonus (rule kept: ') + bonus.rate + '% on the top ' + bonus.top + ' dishes from ' + (bonus.groups.join(', ') || 'no kitchen') + (bonus.enabled ? '.' : ').'));
  return loadSettings(companyId);
}

module.exports = { report: report, saveSettings: saveSettings, guessGroup: guessGroup, shiftHours: shiftHours };
