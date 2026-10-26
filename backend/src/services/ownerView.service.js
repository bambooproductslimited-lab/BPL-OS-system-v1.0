var { pool } = require('../db/pool');

// The owner's view (OS /owner), fifteenth batch: on top of the sales today
// (restaurantTillInsights owner), each restaurant's money — in the open
// drawers, in the safe, petty cash today — who is on shift now and who is
// late, today's events, and what needs looking at: food running out,
// checklists, disputes, website orders waiting, busy mode, equipment
// broken or due a service, bills overdue. Then Bamboo Products' day — shop
// orders, deliveries and fitting, repairs, quotes asked, money owed to it
// and by it — for those who may see it; and the list of what needs the
// owner first, across all of them.

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function today() { return new Date().toISOString().slice(0, 10); }
function hm(t) { return String(t || '').slice(0, 5); }
// First name and the last name's initial: Esi M.
function shortName(r) { return r.first_name + (r.last_name ? ' ' + r.last_name.charAt(0) + '.' : ''); }

async function moneyOf(companyId) {
  var pos = require('./restaurantPos.service'), cash = require('./restaurantCashOffice.service');
  var drawers = (await pool.query("SELECT * FROM restaurant_drawer_sessions WHERE company_id = $1 AND status = 'open'", [companyId])).rows;
  var inDrawers = 0;
  for (var i = 0; i < drawers.length; i++) inDrawers += Number((await pos.buildReport(drawers[i])).expected) || 0;
  var safe = await cash.safeOf(companyId);
  var limits = await cash.settingsOf(companyId);
  var petty = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(m.amount), 0) AS amount, count(*) FILTER (WHERE m.photo IS NULL)::int AS no_receipt FROM restaurant_drawer_movements m " +
    "JOIN restaurant_drawer_sessions s ON s.id = m.session_id WHERE s.company_id = $1 AND m.kind = 'petty' AND m.created_at >= date_trunc('day', now())", [companyId])).rows[0];
  return {
    inDrawers: round2(inDrawers), drawers: drawers.length, safe: safe.balance, safeOver: limits.safeLimit > 0 && safe.balance > limits.safeLimit,
    safeCounted: safe.lastCount ? safe.lastCount.at : null, petty: { n: petty.n, amount: round2(petty.amount), noReceipt: petty.no_receipt }
  };
}

// On shift now (clocked in, on a break); on the rota today and not in yet.
async function staffOf(companyId) {
  var on = (await pool.query(
    'SELECT a.id, a.date, a.clock_in, e.first_name, e.last_name, (SELECT 1 FROM attendance_breaks b WHERE b.attendance_id = a.id AND b.ends_at IS NULL LIMIT 1) AS on_break ' +
    'FROM attendance a JOIN employees e ON e.id = a.employee_id LEFT JOIN departments d ON d.id = e.department_id ' +
    // The restaurant's staff, as on its till: its own departments, or given a role there.
    'WHERE (d.company_id = $1 OR EXISTS (SELECT 1 FROM restaurant_till_staff t WHERE t.employee_id = e.id AND t.company_id = $1)) ' +
    "AND a.clock_in IS NOT NULL AND a.clock_out IS NULL AND a.date >= current_date - 1 ORDER BY a.date, a.clock_in", [companyId])).rows;
  var rota = (await pool.query(
    'SELECT r.employee_id, r.starts, r.ends, r.role, e.first_name, e.last_name, ' +
    '(SELECT 1 FROM attendance a WHERE a.employee_id = r.employee_id AND a.date = r.day AND a.clock_in IS NOT NULL LIMIT 1) AS came ' +
    "FROM restaurant_rota_shifts r JOIN employees e ON e.id = r.employee_id WHERE r.company_id = $1 AND r.day = current_date AND r.published ORDER BY r.starts", [companyId])).rows;
  var nowHm = new Date().toISOString().slice(11, 16);
  var late = rota.filter(function (r) {
    if (r.came || hm(r.ends) <= nowHm) return false;
    var start = Date.parse(today() + 'T' + hm(r.starts) + ':00Z');
    return Date.now() - start > 15 * 60000;
  });
  return {
    on: on.map(function (a) { return { name: shortName(a), since: new Date(String(a.date instanceof Date ? a.date.toISOString().slice(0, 10) : a.date).slice(0, 10) + 'T' + String(a.clock_in).slice(0, 8) + 'Z').toISOString(), onBreak: !!a.on_break }; }),
    planned: rota.length, late: late.map(function (r) { return { name: shortName(r), starts: hm(r.starts) }; })
  };
}

async function eventsOf(companyId) {
  var rows = (await pool.query(
    "SELECT number, name, occasion, guests, starts_at, ends_at, status FROM restaurant_events WHERE company_id = $1 AND status = 'confirmed' AND ends_at > now() AND starts_at < now() + interval '7 days' ORDER BY starts_at", [companyId])).rows;
  var asked = (await pool.query("SELECT count(*)::int AS n FROM restaurant_events WHERE company_id = $1 AND status = 'enquiry'", [companyId])).rows[0].n;
  var t = today();
  var catering = (await pool.query("SELECT count(*)::int AS n FROM restaurant_online_orders WHERE company_id = $1 AND catering AND (scheduled_for AT TIME ZONE 'UTC')::date = current_date AND status NOT IN ('cancelled', 'rejected', 'unpaid')", [companyId])).rows[0].n;
  var out = rows.map(function (e) { return { ref: 'E-' + String(e.number).padStart(4, '0'), name: e.name, occasion: e.occasion, guests: e.guests, at: e.starts_at, today: new Date(e.starts_at).toISOString().slice(0, 10) === t }; });
  return { today: out.filter(function (e) { return e.today; }), week: out.length, asked: asked, catering: catering };
}

// What needs looking at in a restaurant, the worst first.
async function alertsOf(companyId, bill, equip) {
  var out = [];
  var low = (await pool.query(
    "SELECT (SELECT count(*) FROM restaurant_ingredients WHERE company_id = $1 AND active AND reorder_level > 0 AND stock_qty <= reorder_level)::int + " +
    "(SELECT count(*) FROM restaurant_supplies WHERE company_id = $1 AND active AND reorder_level > 0 AND stock_qty <= reorder_level)::int AS n", [companyId])).rows[0].n;
  var lists = await require('./restaurantChecklists.service').todayOf(companyId, today());
  var bad = lists.reduce(function (t, l) { return t + l.bad; }, 0);
  var hour = new Date().getUTCHours();
  var notDone = lists.filter(function (l) { return !l.finished && ((l.at === 'open' && hour >= 11) || (l.at === 'close' && hour >= 23)); }).length;
  var disputes = (await pool.query("SELECT count(*)::int AS n FROM restaurant_disputes WHERE company_id = $1 AND status = 'open'", [companyId])).rows[0].n;
  var waiting = (await pool.query("SELECT count(*)::int AS n FROM restaurant_online_orders WHERE company_id = $1 AND status = 'pending' AND (scheduled_for IS NULL OR scheduled_for < now() + interval '2 hours')", [companyId])).rows[0].n;
  var busy = (await pool.query('SELECT settings FROM restaurant_delivery_settings WHERE company_id = $1', [companyId])).rows[0];
  var b = busy && busy.settings && busy.settings.busy;
  if (bad) out.push({ key: 'readings', level: 'bad', icon: '🌡️', n: bad, text: bad === 1 ? '1 checklist reading out of range' : bad + ' checklist readings out of range' });
  if (equip && equip.stopped) out.push({ key: 'stopped', level: 'bad', icon: '🛑', n: equip.stopped, text: equip.stopped === 1 ? '1 piece of equipment out of use' : equip.stopped + ' pieces of equipment out of use' });
  if (bill && bill.overdue.n) out.push({ key: 'bills', level: 'bad', icon: '🧾', n: bill.overdue.n, amount: bill.overdue.amount, text: (bill.overdue.n === 1 ? '1 bill overdue' : bill.overdue.n + ' bills overdue') });
  if (waiting) out.push({ key: 'waiting', level: 'bad', icon: '🛵', n: waiting, text: waiting === 1 ? '1 website order waiting to be accepted' : waiting + ' website orders waiting to be accepted' });
  if (disputes) out.push({ key: 'disputes', level: 'warn', icon: '⚖️', n: disputes, text: disputes === 1 ? '1 dispute open' : disputes + ' disputes open' });
  if (equip && equip.problems) out.push({ key: 'problems', level: 'warn', icon: '🔧', n: equip.problems, text: equip.problems === 1 ? '1 equipment problem reported' : equip.problems + ' equipment problems reported' });
  if (notDone) out.push({ key: 'checklists', level: 'warn', icon: '📋', n: notDone, text: notDone === 1 ? '1 checklist not finished' : notDone + ' checklists not finished' });
  if (low) out.push({ key: 'low', level: 'warn', icon: '📉', n: low, text: low === 1 ? '1 ingredient or supply running low' : low + ' ingredients and supplies running low' });
  if (equip && equip.serviceDue) out.push({ key: 'service', level: 'info', icon: '🛠️', n: equip.serviceDue, text: equip.serviceDue === 1 ? '1 service due this week' : equip.serviceDue + ' services due this week' });
  if (bill && bill.week.n) out.push({ key: 'billsWeek', level: 'info', icon: '📅', n: bill.week.n, amount: bill.week.amount, text: bill.week.n === 1 ? '1 bill due this week' : bill.week.n + ' bills due this week' });
  if (b && b.until && new Date(b.until) > new Date()) out.push({ key: 'busy', level: 'info', icon: '🔥', n: 1, text: b.mode === 'paused' ? 'Website orders paused' : 'Busy mode on the website' });
  return out;
}

// Bamboo Products' day, and what needs looking at there.
async function bplOf(ctx, bill, equip) {
  var co = (await pool.query("SELECT id, code, name FROM companies WHERE code = 'BPL'")).rows[0];
  if (!co) return null;
  var shop = (await pool.query(
    "SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND status NOT IN ('unpaid', 'cancelled'))::int AS today, " +
    "coalesce(sum(total) FILTER (WHERE created_at >= date_trunc('day', now()) AND status NOT IN ('unpaid', 'cancelled')), 0) AS today_total, " +
    "count(*) FILTER (WHERE status IN ('new', 'making'))::int AS making, count(*) FILTER (WHERE status = 'ready')::int AS ready FROM shop_orders")).rows[0];
  var visits = (await pool.query(
    "SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status IN ('on_way', 'arrived'))::int AS out, count(*) FILTER (WHERE status = 'failed')::int AS failed " +
    "FROM bpl_visits WHERE day = current_date AND status <> 'cancelled'")).rows[0];
  var repairs = (await pool.query("SELECT count(*)::int AS n FROM bpl_service_requests WHERE status = 'new'")).rows[0].n;
  var quotes = (await pool.query("SELECT count(*)::int AS n FROM shop_quote_requests WHERE status = 'new'")).rows[0].n;
  var owed = (await pool.query(
    "SELECT count(*)::int AS n, coalesce(sum(balance_due), 0) AS amount FROM invoices WHERE status <> 'paid' AND balance_due > 0 AND due_date < current_date AND (company_id = $1 OR company_id IS NULL)", [co.id])).rows[0];
  var alerts = [];
  if (owed.n) alerts.push({ key: 'owed', level: 'warn', icon: '💸', n: owed.n, amount: round2(owed.amount), text: owed.n === 1 ? '1 customer invoice overdue' : owed.n + ' customer invoices overdue' });
  if (bill && bill.overdue.n) alerts.push({ key: 'bills', level: 'bad', icon: '🧾', n: bill.overdue.n, amount: bill.overdue.amount, text: bill.overdue.n === 1 ? '1 bill overdue' : bill.overdue.n + ' bills overdue' });
  if (bill && bill.toApprove) alerts.push({ key: 'approve', level: 'warn', icon: '✍️', n: bill.toApprove, text: bill.toApprove === 1 ? '1 bill to approve' : bill.toApprove + ' bills to approve' });
  if (repairs) alerts.push({ key: 'repairs', level: 'warn', icon: '🔧', n: repairs, text: repairs === 1 ? '1 repair request to answer' : repairs + ' repair requests to answer' });
  if (visits.failed) alerts.push({ key: 'failed', level: 'bad', icon: '🚫', n: visits.failed, text: visits.failed === 1 ? '1 visit could not be done today' : visits.failed + ' visits could not be done today' });
  if (equip && equip.stopped) alerts.push({ key: 'stopped', level: 'bad', icon: '🛑', n: equip.stopped, text: equip.stopped === 1 ? '1 machine out of use' : equip.stopped + ' machines out of use' });
  if (equip && equip.problems) alerts.push({ key: 'problems', level: 'warn', icon: '🔧', n: equip.problems, text: equip.problems === 1 ? '1 equipment problem reported' : equip.problems + ' equipment problems reported' });
  if (quotes) alerts.push({ key: 'quotes', level: 'info', icon: '📐', n: quotes, text: quotes === 1 ? '1 quote asked for on the website' : quotes + ' quotes asked for on the website' });
  if (equip && equip.serviceDue) alerts.push({ key: 'service', level: 'info', icon: '🛠️', n: equip.serviceDue, text: equip.serviceDue === 1 ? '1 service due this week' : equip.serviceDue + ' services due this week' });
  void ctx;
  return {
    id: co.id, code: co.code, name: co.name,
    shop: { today: shop.today, total: round2(shop.today_total), making: shop.making, ready: shop.ready },
    visits: { n: visits.n, done: visits.done, out: visits.out, failed: visits.failed }, repairs: repairs, quotes: quotes,
    owed: { n: owed.n, amount: round2(owed.amount) }, bills: bill || null, alerts: alerts
  };
}

var LEVEL = { bad: 0, warn: 1, info: 2 };

// GET /api/restaurant/owner
async function view(ctx, restaurantIds) {
  // Every restaurant, even before its first sale of the day: its staff,
  // money and what needs looking at still count.
  var base = await require('./restaurantTillInsights.service').owner(restaurantIds, { all: true });
  var shown = base.restaurants.map(function (r) { return r.id; });
  var bplId = ctx.can('invoice.read') ? ((await pool.query("SELECT id FROM companies WHERE code = 'BPL'")).rows[0] || {}).id : null;
  var all = shown.concat(bplId ? [bplId] : []);
  var bills = ctx.can('bill.read') ? await require('./bills.service').dueOf(all) : {};
  var equip = await require('./restaurantEquipment.service').forOwner(all);
  for (var i = 0; i < base.restaurants.length; i++) {
    var r = base.restaurants[i];
    r.money = await moneyOf(r.id);
    r.staff = await staffOf(r.id);
    r.events = await eventsOf(r.id);
    r.alerts = await alertsOf(r.id, bills[r.id], equip[r.id]);
  }
  base.bpl = bplId ? await bplOf(ctx, bills[bplId], equip[bplId]) : null;
  // What needs the owner first, everywhere.
  var needs = [];
  base.restaurants.forEach(function (r) { r.alerts.forEach(function (a) { needs.push(Object.assign({ company: { id: r.id, code: r.code, name: r.name } }, a)); }); });
  if (base.bpl) base.bpl.alerts.forEach(function (a) { needs.push(Object.assign({ company: { id: base.bpl.id, code: base.bpl.code, name: base.bpl.name } }, a)); });
  base.needs = needs.filter(function (a) { return a.level !== 'info'; }).sort(function (a, b) { return LEVEL[a.level] - LEVEL[b.level] || b.n - a.n; }).slice(0, 8);
  base.total.inDrawers = round2(base.restaurants.reduce(function (t, r) { return t + r.money.inDrawers; }, 0));
  base.total.safe = round2(base.restaurants.reduce(function (t, r) { return t + r.money.safe; }, 0));
  base.total.onShift = base.restaurants.reduce(function (t, r) { return t + r.staff.on.length; }, 0);
  return base;
}

module.exports = { view: view, moneyOf: moneyOf, staffOf: staffOf, eventsOf: eventsOf, alertsOf: alertsOf, bplOf: bplOf };
