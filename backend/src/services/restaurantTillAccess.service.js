var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var pinAuth = require('../lib/pinAuth');
var { buildContext } = require('./context.service');
var activity = require('./restaurantActivity.service');
var times = require('./restaurantTillTimes.service');

// Who may do what on a restaurant's till and kitchen screen, and the
// till's other settings (migration 0155). Everyone signs in with their
// clock-in PIN; their role here (restaurant_till_staff, or the restaurant's
// default role) decides what the till lets them do — checked on the server
// for every call, the till only hides what they cannot use.
//
//   manager  everything, and the settings: takes orders and money too, on
//            their own drawer, beside the cashier on duty's
//   cashier  sells and runs a cash drawer (by default all but approving refunds)
//   waiter   keeps tables open for the cashier to charge
//   kitchen  the kitchen screen only
//   none     no access
//
// A manager's PIN opens the settings; so does the PIN of anyone whose OS
// account may manage restaurants (restaurant.manage), so a restaurant can
// never be locked out of its own till.

// Ways of paying (Alipay and WeChat Pay since migration 0157), and the
// foreign money the till can take at the manager's rate (cedis for one).
// "Other" was taken off the till (old sales paid that way keep their name).
var TILL_METHODS = ['cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou'];
// What the till offered before Alipay and WeChat: settings saved then
// did not choose about these, so they are on.
var OLD_METHODS = ['cash', 'mobile_money', 'vip', 'iou', 'other'];
var CURRENCIES = ['USD', 'CNY'];
var FULFILLMENTS = ['dine_in', 'pickup', 'delivery'];
var ROLES = ['manager', 'cashier', 'waiter', 'kitchen', 'none'];
var EDITABLE_ROLES = ['cashier', 'waiter', 'kitchen'];
// keepOpen is "send orders to the kitchen" (an order kept open to pay
// later); customItem rings up a dish that is not on the menu; stock counts
// the stock and adds what came in; delivery sends orders out with a rider
// and takes the website's orders (the delivery screen, migration 0159);
// discount gives discounts and takes the service charge off a bill, comp
// puts a dish on the house (migration 0168; anyone else asks a manager).
var PERMISSIONS = ['till', 'charge', 'keepOpen', 'customItem', 'removeTable', 'refund', 'approveRefunds', 'vipTopUp', 'iou', 'iouPaid', 'favorites', 'stock', 'delivery', 'kds', 'discount', 'comp'];
function only(keys) { var o = {}; PERMISSIONS.forEach(function (p) { o[p] = keys.indexOf(p) >= 0; }); return o; }
var ROLE_DEFAULTS = {
  cashier: only(['till', 'charge', 'keepOpen', 'customItem', 'removeTable', 'refund', 'vipTopUp', 'iou', 'iouPaid', 'favorites', 'delivery', 'kds']),
  waiter: only(['till', 'keepOpen', 'kds']),
  kitchen: only(['kds'])
};
var IDLE_CHOICES = [0, 5, 10, 15, 30, 60];
var DISCOUNT_KINDS = ['percent', 'amount'];
var DEFAULTS = {
  defaultRole: 'cashier',
  roles: ROLE_DEFAULTS,
  paymentMethods: TILL_METHODS.slice(),
  currencies: { USD: { on: false, rate: 0 }, CNY: { on: false, rate: 0 } },
  ratesSetAt: null,
  ratesSetBy: null,
  receipt: { footer: 'Thank you!', extra: '', showLogo: true },
  idleMinutes: 0,
  requireWaiter: false,
  defaultFulfillment: 'dine_in',
  kitchen: { warnAfter: 10, lateAfter: 20, printReady: false },
  // Orders from the table's QR code (restaurantTableOrders): taken at all,
  // and whether they go to the kitchen without the till accepting them.
  qrOrders: { on: true, straightToKitchen: false },
  // The bill (restaurantTillCheck.service.js): the manager's ready-made
  // discounts ([{ id, name, kind: 'percent' | 'amount', value, open }] —
  // open: anyone on the till may give it), the service charge (a
  // percentage, on the order types picked; taxed: the taxes are charged on
  // it too) and the taxes (included in the menu prices, or added on top).
  discounts: [],
  serviceCharge: { on: false, name: 'Service charge', rate: 10, types: { dine_in: true, pickup: false, delivery: false }, taxed: true },
  tax: { included: true, list: [] },
  // The clock (restaurantTillTimes.service.js): courses (the later ones
  // wait at the kitchen until called; each category's course, 0 right
  // away), menus by time of day (a category served only between two
  // times) and happy hours (a percentage off some categories at set times).
  courses: { on: false, names: ['Starters', 'Mains', 'Desserts'], categories: {} },
  hours: { categories: {} },
  happyHours: []
};
// Said when someone's role does not allow what they tried.
var REFUSED = {
  till: 'Your role does not use the till. Ask a manager.',
  charge: 'Your role on the till cannot take payments. Ask a cashier or a manager.',
  keepOpen: 'Your role on the till cannot send orders to the kitchen.',
  customItem: 'Your role on the till cannot add a dish that is not on the menu. Ask a manager.',
  removeTable: 'Your role on the till cannot remove an open table. Ask a manager.',
  refund: 'Your role on the till cannot refund sales. Ask a manager.',
  vipTopUp: 'Your role on the till cannot take VIP money. Ask a cashier or a manager.',
  iou: 'Your role on the till cannot sell on IOU. Ask a manager.',
  iouPaid: 'Your role on the till cannot take IOU payments. Ask a cashier or a manager.',
  favorites: 'Your role on the till cannot change the favourites.',
  stock: 'Your role on the till cannot change the stock. Ask a manager.',
  delivery: 'Your role does not send deliveries. Ask a manager.',
  kds: 'Your role does not use the kitchen screen. Ask a manager.',
  discount: 'Your role on the till cannot give discounts. Ask a manager.',
  comp: 'Your role on the till cannot put a dish on the house. Ask a manager.'
};

function posSession(token) { return require('./restaurantPos.service').verifyPosToken(token); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

// The restaurant's settings, the defaults filled in for anything not set.
function merged(stored) {
  var s = stored || {};
  var out = clone(DEFAULTS);
  if (ROLES.indexOf(s.defaultRole) >= 0 && s.defaultRole !== 'manager') out.defaultRole = s.defaultRole;
  EDITABLE_ROLES.forEach(function (r) {
    var given = (s.roles && s.roles[r]) || {};
    PERMISSIONS.forEach(function (p) { if (typeof given[p] === 'boolean') out.roles[r][p] = given[p]; });
  });
  if (Array.isArray(s.paymentMethods)) {
    var known = Array.isArray(s.knownMethods) ? s.knownMethods : OLD_METHODS;
    var pm = TILL_METHODS.filter(function (m) { return s.paymentMethods.indexOf(m) >= 0 || known.indexOf(m) < 0; });
    if (pm.length) out.paymentMethods = pm;
  }
  if (s.currencies) {
    CURRENCIES.forEach(function (c) {
      var x = s.currencies[c];
      if (x && Number(x.rate) > 0) out.currencies[c] = { on: x.on === true, rate: Number(x.rate) };
    });
  }
  if (s.ratesSetAt) { out.ratesSetAt = s.ratesSetAt; out.ratesSetBy = s.ratesSetBy || null; }
  if (FULFILLMENTS.indexOf(s.defaultFulfillment) >= 0 && s.defaultFulfillment !== 'delivery') out.defaultFulfillment = s.defaultFulfillment;
  if (s.receipt) {
    if (typeof s.receipt.footer === 'string') out.receipt.footer = s.receipt.footer;
    if (typeof s.receipt.extra === 'string') out.receipt.extra = s.receipt.extra;
    if (typeof s.receipt.showLogo === 'boolean') out.receipt.showLogo = s.receipt.showLogo;
  }
  if (IDLE_CHOICES.indexOf(s.idleMinutes) >= 0) out.idleMinutes = s.idleMinutes;
  if (typeof s.requireWaiter === 'boolean') out.requireWaiter = s.requireWaiter;
  if (s.kitchen && s.kitchen.warnAfter > 0 && s.kitchen.lateAfter > s.kitchen.warnAfter) {
    out.kitchen.warnAfter = s.kitchen.warnAfter; out.kitchen.lateAfter = s.kitchen.lateAfter;
  }
  if (s.kitchen && typeof s.kitchen.printReady === 'boolean') out.kitchen.printReady = s.kitchen.printReady;
  if (s.qrOrders) ['on', 'straightToKitchen'].forEach(function (k) { if (typeof s.qrOrders[k] === 'boolean') out.qrOrders[k] = s.qrOrders[k]; });
  if (Array.isArray(s.discounts)) out.discounts = s.discounts.filter(function (d) { return d && d.id && d.name && DISCOUNT_KINDS.indexOf(d.kind) >= 0 && Number(d.value) > 0; });
  if (s.serviceCharge) {
    var sc = s.serviceCharge;
    if (typeof sc.on === 'boolean') out.serviceCharge.on = sc.on;
    if (typeof sc.name === 'string' && sc.name.trim()) out.serviceCharge.name = sc.name;
    if (Number(sc.rate) > 0 && Number(sc.rate) <= 50) out.serviceCharge.rate = Number(sc.rate);
    if (sc.types) FULFILLMENTS.forEach(function (f) { if (typeof sc.types[f] === 'boolean') out.serviceCharge.types[f] = sc.types[f]; });
    if (typeof sc.taxed === 'boolean') out.serviceCharge.taxed = sc.taxed;
  }
  if (s.tax) {
    if (typeof s.tax.included === 'boolean') out.tax.included = s.tax.included;
    if (Array.isArray(s.tax.list)) out.tax.list = s.tax.list.filter(function (t) { return t && t.name && Number(t.rate) > 0; });
  }
  if (s.courses) {
    if (typeof s.courses.on === 'boolean') out.courses.on = s.courses.on;
    if (Array.isArray(s.courses.names) && s.courses.names.length) out.courses.names = s.courses.names.slice(0, times.MAX_COURSES);
    if (s.courses.categories && typeof s.courses.categories === 'object') out.courses.categories = s.courses.categories;
  }
  if (s.hours && s.hours.categories && typeof s.hours.categories === 'object') out.hours.categories = s.hours.categories;
  if (Array.isArray(s.happyHours)) out.happyHours = s.happyHours.filter(function (h) { return h && h.id && h.name && Number(h.percent) > 0; });
  return out;
}
async function settingsOf(companyId, db) {
  var row = (await (db || pool).query('SELECT settings FROM restaurant_till_settings WHERE company_id = $1', [companyId])).rows[0];
  return merged(row && row.settings);
}
function permsFor(settings, role) {
  if (role === 'manager') return only(PERMISSIONS);
  if (role === 'none' || !settings.roles[role]) return only([]);
  return Object.assign({}, settings.roles[role]);
}
async function roleOf(companyId, employeeId, settings) {
  var row = (await pool.query('SELECT role FROM restaurant_till_staff WHERE company_id = $1 AND employee_id = $2', [companyId, employeeId])).rows[0];
  return { role: row ? row.role : settings.defaultRole, assigned: !!row };
}
async function accessOf(companyId, employeeId) {
  var settings = await settingsOf(companyId);
  var r = await roleOf(companyId, employeeId, settings);
  return { role: r.role, assigned: r.assigned, can: permsFor(settings, r.role), settings: settings };
}

// The till session, if its person's role allows one of perms; refused otherwise.
async function need(token, perms) {
  var session = posSession(token);
  var list = [].concat(perms);
  var a = await accessOf(session.posCompanyId, session.posEmployeeId);
  if (!list.some(function (p) { return a.can[p]; })) fail('forbidden', REFUSED[list[0]] || REFUSED.till);
  session.access = a;
  return session;
}

// Whether someone may sign in to the till ('till'), the kitchen screen
// ('kds') or the delivery screen ('delivery'), for restaurantPos.login.
async function checkSignIn(companyId, employeeId, app) {
  var a = await accessOf(companyId, employeeId);
  var perm = app === 'kds' ? 'kds' : app === 'delivery' ? 'delivery' : 'till';
  if (!a.can[perm]) fail('forbidden', REFUSED[perm]);
  return a;
}

// What the till shows the person signed in: their role, what they may do,
// and the settings the till itself follows.
async function profile(token) {
  var session = posSession(token);
  var a = await accessOf(session.posCompanyId, session.posEmployeeId);
  return {
    role: a.role, can: a.can, cashierOnDuty: await cashierOnDuty(session.posCompanyId, session.posEmployeeId),
    settings: {
      paymentMethods: a.settings.paymentMethods, currencies: a.settings.currencies, ratesSetAt: a.settings.ratesSetAt, receipt: a.settings.receipt,
      idleMinutes: a.settings.idleMinutes, requireWaiter: a.settings.requireWaiter, defaultFulfillment: a.settings.defaultFulfillment, kitchen: a.settings.kitchen,
      discounts: a.settings.discounts, serviceCharge: a.settings.serviceCharge, tax: a.settings.tax,
      courses: a.settings.courses, hours: a.settings.hours, happyHours: a.settings.happyHours
    }
  };
}

// The cashier with the drawer open at this restaurant (one at a time; a
// manager's own drawer beside it does not count), for the till to say so
// to another cashier signing in; null when none.
var CASHIER_DRAWER = "LEFT JOIN restaurant_till_staff t ON t.company_id = s.company_id AND t.employee_id = s.cashier_id " +
  "WHERE s.company_id = $1 AND s.status = 'open' AND t.role IS DISTINCT FROM 'manager'";
async function cashierOnDuty(companyId, employeeId, db) {
  var r = (await (db || pool).query(
    "SELECT s.cashier_id, s.opened_at, e.first_name, e.last_name FROM restaurant_drawer_sessions s JOIN employees e ON e.id = s.cashier_id " +
    CASHIER_DRAWER + ' ORDER BY s.opened_at LIMIT 1', [companyId])).rows[0];
  return r ? { employeeId: r.cashier_id, name: r.first_name + ' ' + r.last_name, since: r.opened_at, me: r.cashier_id === employeeId } : null;
}

// Anyone whose OS account may manage restaurants.
async function osManager(employeeId) {
  var users = (await pool.query("SELECT id FROM users WHERE employee_id = $1 AND status = 'active'", [employeeId])).rows;
  for (var i = 0; i < users.length; i++) {
    var ctx = await buildContext(users[i].id);
    if (ctx && ctx.can('restaurant.manage')) return true;
  }
  return false;
}
async function employeeByPin(pin, ip) {
  pinAuth.checkRateLimit(ip);
  pinAuth.validatePinFormat(pin);
  var emp = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE kiosk_pin_hash = $1 AND status = 'active'", [pinAuth.hashPin(pin)])).rows[0];
  if (!emp) { pinAuth.recordFailure(ip); fail('invalid', 'Incorrect manager PIN.'); }
  pinAuth.recordSuccess(ip);
  return emp;
}
// May this person do perm at this restaurant: their till role, or an OS
// account that may manage restaurants.
async function allowedHere(companyId, employeeId, perm) {
  var a = await accessOf(companyId, employeeId);
  if (perm === 'settings' ? a.role === 'manager' : a.can[perm]) return true;
  return osManager(employeeId);
}
// A refund's approver, by their PIN (restaurantTillMoney.refundSale).
async function refundApprover(companyId, pin, ip) {
  var emp = await employeeByPin(String(pin || ''), ip);
  if (await allowedHere(companyId, emp.id, 'approveRefunds')) return emp;
  fail('forbidden', emp.first_name + ' ' + emp.last_name + ' cannot approve refunds: a restaurant manager has to.');
}

// A manager's yes for a discount, a dish on the house or the service charge
// taken off (restaurantTillCheck approval): someone whose till role may do
// it, or an OS restaurant manager, by their PIN.
async function approver(companyId, pin, ip, perm) {
  var emp = await employeeByPin(String(pin || ''), ip);
  if (await allowedHere(companyId, emp.id, perm)) return emp;
  fail('forbidden', emp.first_name + ' ' + emp.last_name + (perm === 'comp' ? ' cannot put dishes on the house' : ' cannot give discounts') + ': a restaurant manager has to.');
}

// The settings are opened by a manager: the person signed in, or a
// manager's PIN typed on the till.
async function settingsManager(token, pin, ip) {
  var session = posSession(token);
  var who;
  if (await allowedHere(session.posCompanyId, session.posEmployeeId, 'settings')) {
    who = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [session.posEmployeeId])).rows[0];
  } else {
    if (!pin) fail('forbidden', 'A manager opens the till settings: type a manager\'s PIN.');
    who = await employeeByPin(String(pin), ip);
    if (!(await allowedHere(session.posCompanyId, who.id, 'settings'))) fail('forbidden', who.first_name + ' ' + who.last_name + ' is not a manager of this restaurant.');
  }
  return { session: session, manager: who };
}

async function staffOf(companyId, db) {
  db = db || pool;
  var rows = (await db.query(
    "SELECT e.id, e.first_name, e.last_name, e.position_title, (e.kiosk_pin_hash IS NOT NULL) AS has_pin, ts.role " +
    'FROM employees e JOIN departments d ON d.id = e.department_id LEFT JOIN restaurant_till_staff ts ON ts.employee_id = e.id AND ts.company_id = $1 ' +
    "WHERE d.company_id = $1 AND e.status = 'active' ORDER BY e.first_name, e.last_name", [companyId])).rows;
  // Anyone given a role here who works elsewhere (an administrator, say).
  var others = (await db.query(
    "SELECT e.id, e.first_name, e.last_name, e.position_title, (e.kiosk_pin_hash IS NOT NULL) AS has_pin, ts.role FROM restaurant_till_staff ts JOIN employees e ON e.id = ts.employee_id " +
    "LEFT JOIN departments d ON d.id = e.department_id WHERE ts.company_id = $1 AND e.status = 'active' AND (d.company_id IS DISTINCT FROM $1) ORDER BY e.first_name", [companyId])).rows;
  return rows.concat(others).map(function (r) {
    return { id: r.id, name: r.first_name + ' ' + r.last_name, position: r.position_title || '', hasPin: r.has_pin, role: r.role || null };
  });
}

// The restaurant's tables, with where each stands on the floor map
// (left and top, in % of the map) — set in the settings.
async function tablesOf(companyId, db) {
  return (await (db || pool).query(
    "SELECT id, name, map_x, map_y, shape, seats, area FROM restaurant_tables WHERE company_id = $1 AND status = 'active' ORDER BY name", [companyId])).rows.map(tableOut);
}
function tableOut(r) {
  return { id: r.id, name: r.name, mapX: r.map_x == null ? null : Number(r.map_x), mapY: r.map_y == null ? null : Number(r.map_y), shape: r.shape, seats: r.seats, area: r.area || '' };
}
var SHAPES = ['square', 'round', 'long'];

// The menu's categories, for courses, menu hours and happy hours.
async function categoriesOf(companyId, db) {
  return (await (db || pool).query("SELECT DISTINCT coalesce(category, '') AS c FROM restaurant_menu_items WHERE company_id = $1 AND active ORDER BY 1", [companyId])).rows
    .map(function (r) { return r.c; }).filter(Boolean);
}
function settingsOut(settings, staff, companyId, tables) {
  return {
    companyId: companyId, settings: settings, staff: staff, tables: tables || [],
    choices: { roles: ROLES, editableRoles: EDITABLE_ROLES, permissions: PERMISSIONS, managerCan: PERMISSIONS, paymentMethods: TILL_METHODS, currencies: CURRENCIES, idleMinutes: IDLE_CHOICES, fulfillments: FULFILLMENTS }
  };
}

async function openSettings(token, pin, ip) {
  var m = await settingsManager(token, pin, ip);
  var company = m.session.posCompanyId;
  return Object.assign(settingsOut(await settingsOf(company), await staffOf(company), company, await tablesOf(company)), { managerName: m.manager.first_name + ' ' + m.manager.last_name, categories: await categoriesOf(company) });
}

function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }
function cleanSettings(p, base) {
  p = p || {};
  var out = clone(base || merged({}));
  if (p.defaultRole !== undefined) {
    if (['cashier', 'waiter', 'kitchen', 'none'].indexOf(p.defaultRole) < 0) fail('invalid', 'Pick the role for everyone else.');
    out.defaultRole = p.defaultRole;
  }
  EDITABLE_ROLES.forEach(function (r) {
    var given = (p.roles && p.roles[r]) || {};
    PERMISSIONS.forEach(function (k) { if (given[k] !== undefined) out.roles[r][k] = !!given[k]; });
    // Taking payments is done at the till.
    if (out.roles[r].charge || out.roles[r].keepOpen || out.roles[r].customItem || out.roles[r].removeTable || out.roles[r].refund || out.roles[r].vipTopUp || out.roles[r].iouPaid || out.roles[r].iou || out.roles[r].favorites || out.roles[r].stock || out.roles[r].discount || out.roles[r].comp) out.roles[r].till = true;
    if (out.roles[r].iou && !out.roles[r].charge) out.roles[r].iou = false;
  });
  if (p.paymentMethods !== undefined) {
    var pm = TILL_METHODS.filter(function (m) { return Array.isArray(p.paymentMethods) && p.paymentMethods.indexOf(m) >= 0; });
    if (!pm.length) fail('invalid', 'Keep at least one way of paying.');
    out.paymentMethods = pm;
  }
  if (p.currencies) {
    CURRENCIES.forEach(function (c) {
      var x = p.currencies[c];
      if (!x) return;
      var rate = Math.round(Number(x.rate) * 1000000) / 1000000;
      if (x.on && !(rate > 0)) fail('invalid', 'Set the rate for ' + (c === 'CNY' ? 'Chinese yuan (RMB)' : 'US dollars') + ' before turning it on.');
      if (x.rate !== undefined && x.rate !== null && x.rate !== '' && !(rate > 0 && rate < 100000)) fail('invalid', 'An exchange rate is how many cedis one ' + (c === 'CNY' ? 'yuan' : 'dollar') + ' is worth.');
      out.currencies[c] = { on: !!x.on && rate > 0, rate: rate > 0 ? rate : 0 };
    });
  }
  if (p.defaultFulfillment !== undefined) {
    if (['dine_in', 'pickup'].indexOf(p.defaultFulfillment) < 0) fail('invalid', 'A new order starts as dine in or pickup.');
    out.defaultFulfillment = p.defaultFulfillment;
  }
  if (p.receipt) {
    out.receipt = { footer: text(p.receipt.footer, 120), extra: text(p.receipt.extra, 200), showLogo: p.receipt.showLogo !== false };
  }
  if (p.idleMinutes !== undefined) {
    var idle = Number(p.idleMinutes);
    if (IDLE_CHOICES.indexOf(idle) < 0) fail('invalid', 'Pick when the till signs out.');
    out.idleMinutes = idle;
  }
  if (p.requireWaiter !== undefined) out.requireWaiter = !!p.requireWaiter;
  if (p.kitchen) {
    var warn = Math.round(Number(p.kitchen.warnAfter)), late = Math.round(Number(p.kitchen.lateAfter));
    if (!(warn >= 1 && warn <= 120)) fail('invalid', 'Amber after: between 1 and 120 minutes.');
    if (!(late > warn && late <= 240)) fail('invalid', 'Red after: more minutes than amber, at most 240.');
    out.kitchen = { warnAfter: warn, lateAfter: late, printReady: p.kitchen.printReady === undefined ? out.kitchen.printReady : !!p.kitchen.printReady };
  }
  if (p.qrOrders) ['on', 'straightToKitchen'].forEach(function (k) { if (p.qrOrders[k] !== undefined) out.qrOrders[k] = !!p.qrOrders[k]; });
  if (p.discounts !== undefined) {
    if (!Array.isArray(p.discounts) || p.discounts.length > 30) fail('invalid', 'Keep at most 30 discounts.');
    var names = new Set();
    out.discounts = p.discounts.map(function (d) {
      d = d || {};
      var name = text(d.name, 40);
      if (!name) fail('invalid', 'Give each discount a name, e.g. Staff meal.');
      if (names.has(name.toLowerCase())) fail('invalid', 'Two discounts are called ' + name + '.');
      names.add(name.toLowerCase());
      if (DISCOUNT_KINDS.indexOf(d.kind) < 0) fail('invalid', name + ': a percentage or an amount?');
      var value = Math.round(Number(d.value) * 100) / 100;
      if (!(value > 0) || (d.kind === 'percent' && value > 100) || value >= 1000000) fail('invalid', name + ': give it a size (a percentage up to 100, or an amount).');
      var id = /^[a-z0-9-]{4,40}$/.test(String(d.id || '')) ? d.id : require('crypto').randomUUID();
      return { id: id, name: name, kind: d.kind, value: value, open: !!d.open };
    });
  }
  if (p.serviceCharge) {
    var sc = p.serviceCharge;
    var rate = Math.round(Number(sc.rate) * 100) / 100;
    if (sc.on && !(rate > 0 && rate <= 50)) fail('invalid', 'The service charge is a percentage from 0.5 to 50.');
    var types = {};
    FULFILLMENTS.forEach(function (f) { types[f] = !!(sc.types && sc.types[f]); });
    if (sc.on && !FULFILLMENTS.some(function (f) { return types[f]; })) fail('invalid', 'Pick the orders the service charge is on.');
    out.serviceCharge = { on: !!sc.on, name: text(sc.name, 40) || 'Service charge', rate: rate > 0 ? rate : out.serviceCharge.rate, types: types, taxed: sc.taxed !== false };
  }
  if (p.tax) {
    var list = Array.isArray(p.tax.list) ? p.tax.list : [];
    if (list.length > 8) fail('invalid', 'Keep at most 8 taxes.');
    out.tax = {
      included: p.tax.included !== false,
      list: list.map(function (t) {
        t = t || {};
        var name = text(t.name, 40);
        if (!name) fail('invalid', 'Give each tax a name, e.g. VAT.');
        var r = Math.round(Number(t.rate) * 1000) / 1000;
        if (!(r > 0 && r <= 50)) fail('invalid', name + ': a rate from 0.001% to 50%.');
        return { id: /^[a-z0-9-]{4,40}$/.test(String(t.id || '')) ? t.id : require('crypto').randomUUID(), name: name, rate: r, compound: !!t.compound };
      })
    };
  }
  if (p.courses) out.courses = times.cleanCourses(p.courses, text);
  if (p.hours) out.hours = times.cleanHours(p.hours, text);
  if (p.happyHours !== undefined) out.happyHours = times.cleanHappyHours(p.happyHours, text);
  return out;
}

async function saveSettings(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var before = await settingsOf(company);
  var settings = cleanSettings(p.settings, before);
  var staffChanges = Array.isArray(p.staff) ? p.staff : [];
  var managerName = m.manager.first_name + ' ' + m.manager.last_name;
  // The rates changed: when, and by whom, for the till to show.
  if (JSON.stringify(settings.currencies) !== JSON.stringify(before.currencies)) { settings.ratesSetAt = new Date().toISOString(); settings.ratesSetBy = managerName; }
  return withTransaction(async function (client) {
    await client.query(
      'INSERT INTO restaurant_till_settings (company_id, settings, updated_by) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (company_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()',
      [company, JSON.stringify(Object.assign({ knownMethods: TILL_METHODS }, settings)), m.manager.id]);
    var tablesChanged = await saveTables(client, company, p.tables);
    var customersChanged = await saveCustomers(client, company, p.customers);
    var changed = 0;
    for (var i = 0; i < staffChanges.length; i++) {
      var c = staffChanges[i] || {};
      var emp = (await client.query(
        "SELECT e.id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1 AND e.status = 'active' AND " +
        '(d.company_id = $2 OR EXISTS (SELECT 1 FROM restaurant_till_staff ts WHERE ts.employee_id = e.id AND ts.company_id = $2))', [c.employeeId, company])).rows[0];
      if (!emp) fail('invalid', 'One of the people is not on this restaurant\'s staff.');
      if (c.role === null || c.role === '' || c.role === undefined) {
        changed += (await client.query('DELETE FROM restaurant_till_staff WHERE company_id = $1 AND employee_id = $2', [company, emp.id])).rowCount;
      } else {
        if (ROLES.indexOf(c.role) < 0) fail('invalid', 'Pick a role from the list.');
        // Nobody takes away their own management of the till.
        if (emp.id === m.manager.id && c.role !== 'manager' && !(await osManager(emp.id))) fail('invalid', 'You cannot take away your own manager role.');
        await client.query(
          'INSERT INTO restaurant_till_staff (company_id, employee_id, role) VALUES ($1, $2, $3) ' +
          'ON CONFLICT (company_id, employee_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()', [company, emp.id, c.role]);
        changed++;
      }
    }
    var parts = Object.keys(settings).filter(function (k) { return JSON.stringify(settings[k]) !== JSON.stringify(before[k]); });
    if (changed) parts.push(changed === 1 ? '1 person\'s role' : changed + ' people\'s roles');
    if (tablesChanged) parts.push('the floor map');
    if (customersChanged) parts.push(customersChanged === 1 ? '1 customer\'s IOU account' : customersChanged + ' customers\' IOU accounts');
    var who = { user: { id: null }, employee: { first_name: m.manager.first_name, last_name: m.manager.last_name } };
    await audit(client, who, 'restaurant.till.settings', 'company', company, 'Till settings changed' + (parts.length ? ': ' + parts.join(', ') : '') + '.');
    await activity.log(client, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'settings.saved',
      summary: 'Till settings changed' + (parts.length ? ': ' + parts.join(', ') : '') + '.', details: { parts: parts } });
    return Object.assign(settingsOut(settings, await staffOf(company, client), company, await tablesOf(company, client)), { managerName: managerName, categories: await categoriesOf(company, client) });
  });
}

// The floor map, saved with the settings: tables added, moved, renamed,
// or taken away (archived: past sales keep their table).
async function saveTables(client, company, list) {
  if (!Array.isArray(list) || !list.length) return 0;
  if (list.length > 200) fail('invalid', 'Too many tables at once.');
  var changed = 0;
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    if (t.id && t.remove) {
      changed += (await client.query("UPDATE restaurant_tables SET status = 'archived' WHERE id = $1 AND company_id = $2 AND status = 'active'", [t.id, company])).rowCount;
      continue;
    }
    var name = text(t.name, 40);
    if (!name) fail('invalid', 'Every table needs a name.');
    var x = t.mapX == null || t.mapX === '' ? null : Math.max(0, Math.min(100, Math.round(Number(t.mapX) * 100) / 100));
    var y = t.mapY == null || t.mapY === '' ? null : Math.max(0, Math.min(100, Math.round(Number(t.mapY) * 100) / 100));
    var shape = SHAPES.indexOf(t.shape) >= 0 ? t.shape : 'square';
    var seats = Math.max(1, Math.min(40, Math.round(Number(t.seats) || 4)));
    var area = text(t.area, 40);
    var clash = (await client.query("SELECT id FROM restaurant_tables WHERE company_id = $1 AND status = 'active' AND lower(name) = lower($2) AND id <> $3",
      [company, name, t.id || '00000000-0000-0000-0000-000000000000'])).rows[0];
    if (clash) fail('invalid', 'There is already a table called "' + name + '".');
    if (t.id) {
      var up = await client.query('UPDATE restaurant_tables SET name = $3, map_x = $4, map_y = $5, shape = $6, seats = $7, area = $8 WHERE id = $1 AND company_id = $2',
        [t.id, company, name, x, y, shape, seats, area]);
      if (!up.rowCount) fail('invalid', 'One of the tables is not this restaurant\'s.');
    } else {
      await client.query("INSERT INTO restaurant_tables (company_id, name, status, map_x, map_y, shape, seats, area) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)",
        [company, name, x, y, shape, seats, area]);
    }
    changed++;
  }
  return changed;
}

// Customers allowed to owe (an IOU account), and up to how much.
async function saveCustomers(client, company, list) {
  if (!Array.isArray(list) || !list.length) return 0;
  var changed = 0;
  for (var i = 0; i < Math.min(list.length, 500); i++) {
    var c = list[i] || {};
    var limit = c.iouLimit == null || c.iouLimit === '' ? null : Math.round(Number(c.iouLimit) * 100) / 100;
    if (limit !== null && !(limit > 0)) fail('invalid', 'An IOU limit is an amount above zero, or none.');
    var up = await client.query('UPDATE restaurant_guests SET iou_allowed = $3, iou_limit = $4, updated_at = now() WHERE id = $1 AND company_id = $2',
      [c.id, company, !!c.iouAllowed, limit]);
    if (!up.rowCount) fail('invalid', 'One of the customers is not this restaurant\'s.');
    changed++;
  }
  return changed;
}

// Customers for the settings: who has a VIP account (and its balance), who
// may owe (an IOU account) and what they owe now. A search, or the ones
// with an account.
async function settingsCustomers(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var args = [company], where = 'g.company_id = $1';
  if (p.q && String(p.q).trim()) { args.push('%' + String(p.q).trim() + '%'); where += ' AND (g.name ILIKE $2 OR g.phone ILIKE $2)'; }
  else where += ' AND (g.iou_allowed OR v.guest_id IS NOT NULL OR i.guest_id IS NOT NULL)';
  var rows = (await pool.query(
    'SELECT g.id, g.name, g.phone, g.iou_allowed, g.iou_limit, coalesce(v.balance, 0) AS vip_balance, (v.guest_id IS NOT NULL) AS vip, coalesce(i.owed, 0) AS owed, coalesce(i.n, 0) AS ious ' +
    'FROM restaurant_guests g LEFT JOIN (SELECT guest_id, sum(amount) AS balance FROM restaurant_vip_entries WHERE company_id = $1 GROUP BY guest_id) v ON v.guest_id = g.id ' +
    "LEFT JOIN (SELECT guest_id, sum(total - refunded_total) AS owed, count(*)::int AS n FROM restaurant_orders WHERE company_id = $1 AND payment_method = 'iou' AND status = 'completed' AND iou_paid_at IS NULL GROUP BY guest_id) i ON i.guest_id = g.id " +
    'WHERE ' + where + ' ORDER BY g.iou_allowed DESC, coalesce(i.owed, 0) DESC, g.name LIMIT 100', args)).rows;
  return rows.map(function (r) {
    return { id: r.id, name: r.name, phone: r.phone, vip: r.vip, vipBalance: Math.round(Number(r.vip_balance) * 100) / 100,
      iouAllowed: r.iou_allowed, iouLimit: r.iou_limit == null ? null : Number(r.iou_limit), owed: Math.round(Number(r.owed) * 100) / 100, ious: r.ious };
  });
}

// The kitchen screens (restaurantKdsScreens.service.js): { action: 'list'
// | 'claim' | 'update' | 'remove', code, id, name, stationId }. Each change
// answers with the list as it is now.
async function kitchenScreens(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var screens = require('./restaurantKdsScreens.service');
  var done = null;
  if (p.action === 'claim') done = await screens.claim(company, m.manager, p);
  else if (p.action === 'update') done = await screens.update(company, m.manager, p.id, p);
  else if (p.action === 'remove') done = await screens.remove(company, m.manager, p.id);
  // A station without a screen: the till prints its tickets when it sends an order.
  else if (p.action === 'stationPrint') {
    var st = (await pool.query('UPDATE restaurant_kds_stations SET print_tickets = $3, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING id, name', [p.id, company, !!p.printTickets])).rows[0];
    if (!st) fail('notfound', 'That station is not set up any more.');
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'settings.station',
      summary: (p.printTickets ? 'The till prints the tickets of ' : 'The till stops printing the tickets of ') + st.name + '.', refType: 'station', refId: st.id });
  }
  if (done && p.action !== 'list') {
    await activity.log(pool, { companyId: company, employeeId: m.manager.id, app: 'settings', action: 'settings.screen',
      summary: { claim: 'Set up the kitchen screen ', update: 'Changed the kitchen screen ', remove: 'Took off the kitchen screen ' }[p.action] + done.name + '.', refType: 'screen', refId: done.id });
  }
  return Object.assign(await screens.list(company, ip), { changed: done ? done.id : null });
}

// The drawers (restaurantPos.drawerHistory): { action: 'list' | 'close',
// id, actualCash, note, from, to } — a manager closes one its cashier left open.
async function drawers(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var pos = require('./restaurantPos.service');
  var closed = null;
  if (p.action === 'close') closed = await pos.closeDrawerFor(m.session.posCompanyId, m.manager, p.id, p);
  return Object.assign(await pos.drawerHistory(m.session.posCompanyId, p), { closed: closed });
}

// Disputes (restaurantDisputes.service.js): { action: 'list' | 'resolve' |
// 'reopen' | 'raise', id, resolution, note, status, kind, from, to }.
async function disputes(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var d = require('./restaurantDisputes.service');
  var company = m.session.posCompanyId;
  if (p.action === 'resolve') await d.resolve(company, m.manager, p.id, p);
  else if (p.action === 'reopen') await d.reopen(company, m.manager, p.id);
  else if (p.action === 'raise') await d.raise({ posCompanyId: company, posEmployeeId: m.manager.id }, p);
  return d.list(company, p.filter || {});
}

// The menu (restaurantTillMenu.service.js), by a manager: { action: 'list'
// | 'save' | 'remove', item, id }.
async function menu(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var tm = require('./restaurantTillMenu.service');
  var company = m.session.posCompanyId;
  var saved = null;
  if (p.action === 'save') saved = await tm.saveItem(company, m.manager, p.item);
  else if (p.action === 'remove') await tm.removeItem(company, m.manager, p.id);
  else if (p.action === 'saveGroup') saved = await tm.saveGroup(company, m.manager, p.group);
  else if (p.action === 'removeGroup') await tm.removeGroup(company, m.manager, p.id);
  return Object.assign(await tm.menu(company), { saved: saved });
}

// The stock, by a manager or anyone whose role may count it: { action:
// 'list' | 'move' | 'history', type, id, kind, qty, note }.
async function stock(token, p, ip) {
  p = p || {};
  var session = posSession(token);
  var a = await accessOf(session.posCompanyId, session.posEmployeeId);
  var by;
  if (a.can.stock) by = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [session.posEmployeeId])).rows[0];
  else by = (await settingsManager(token, p.managerPin, ip)).manager;
  var tm = require('./restaurantTillMenu.service');
  if (p.action === 'history') return tm.history(session.posCompanyId, p.type, p.id);
  var moved = p.action === 'move' ? await tm.move(session.posCompanyId, by, p) : null;
  return Object.assign(await tm.stock(session.posCompanyId), { moved: moved });
}

// What customers owe and paid back, and VIP money (restaurantTillAccounts.service.js).
async function accounts(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  return require('./restaurantTillAccounts.service').report(m.session.posCompanyId, p);
}

// Every sale and refund of some days, with the day's totals (restaurantTillSales.service.js).
async function salesReport(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  return require('./restaurantTillSales.service').report(m.session.posCompanyId, p);
}

// The monthly report (restaurantReport.service.js) for the back office: the
// month's sales by kitchen group, shift and hour, the best sellers and the
// kitchen bonus — over every sale on the books, those brought in from
// Square (restaurantSquareImport) and the till's own. Read only: its
// groups, shifts and bonus rule are set in the OS (Restaurants, Report).
async function monthlyReport(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var out = await require('./restaurantReport.service').report({ can: function (perm) { return perm === 'restaurant.read'; } }, company, { month: p.month });
  var square = (await pool.query("SELECT count(*)::int AS n, min(created_at) AS first, max(created_at) AS last FROM restaurant_orders WHERE company_id = $1 AND source = 'square' AND status = 'completed'", [company])).rows[0];
  out.square = { sales: square.n, first: square.first, last: square.last };
  return out;
}

// What happened on the till and the kitchen screen (restaurantActivity.service.js).
async function activityReport(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  return activity.list(m.session.posCompanyId, p);
}

module.exports = {
  approver: approver,
  TILL_METHODS: TILL_METHODS, CURRENCIES: CURRENCIES, FULFILLMENTS: FULFILLMENTS, ROLES: ROLES, PERMISSIONS: PERMISSIONS, DEFAULTS: DEFAULTS, cashierOnDuty: cashierOnDuty,
  settingsOf: settingsOf, accessOf: accessOf, need: need, settingsManager: settingsManager, checkSignIn: checkSignIn, profile: profile, tableOut: tableOut,
  refundApprover: refundApprover, openSettings: openSettings, saveSettings: saveSettings, cleanSettings: cleanSettings,
  settingsCustomers: settingsCustomers, activityReport: activityReport, salesReport: salesReport, monthlyReport: monthlyReport, kitchenScreens: kitchenScreens,
  drawers: drawers, disputes: disputes, accounts: accounts, menu: menu, stock: stock
};
