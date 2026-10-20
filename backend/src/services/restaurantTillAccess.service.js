var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var pinAuth = require('../lib/pinAuth');
var { buildContext } = require('./context.service');

// Who may do what on a restaurant's till and kitchen screen, and the
// till's other settings (migration 0155). Everyone signs in with their
// clock-in PIN; their role here (restaurant_till_staff, or the restaurant's
// default role) decides what the till lets them do — checked on the server
// for every call, the till only hides what they cannot use.
//
//   manager  everything, and the settings
//   cashier  sells and runs a cash drawer (by default all but approving refunds)
//   waiter   keeps tables open for the cashier to charge
//   kitchen  the kitchen screen only
//   none     no access
//
// A manager's PIN opens the settings; so does the PIN of anyone whose OS
// account may manage restaurants (restaurant.manage), so a restaurant can
// never be locked out of its own till.

var TILL_METHODS = ['cash', 'mobile_money', 'vip', 'iou', 'other'];
var ROLES = ['manager', 'cashier', 'waiter', 'kitchen', 'none'];
var EDITABLE_ROLES = ['cashier', 'waiter', 'kitchen'];
var PERMISSIONS = ['till', 'charge', 'keepOpen', 'removeTable', 'refund', 'approveRefunds', 'vipTopUp', 'iou', 'iouPaid', 'favorites', 'kds'];
function only(keys) { var o = {}; PERMISSIONS.forEach(function (p) { o[p] = keys.indexOf(p) >= 0; }); return o; }
var ROLE_DEFAULTS = {
  cashier: only(['till', 'charge', 'keepOpen', 'removeTable', 'refund', 'vipTopUp', 'iou', 'iouPaid', 'favorites', 'kds']),
  waiter: only(['till', 'keepOpen', 'kds']),
  kitchen: only(['kds'])
};
var IDLE_CHOICES = [0, 5, 10, 15, 30, 60];
var DEFAULTS = {
  defaultRole: 'cashier',
  roles: ROLE_DEFAULTS,
  paymentMethods: TILL_METHODS.slice(),
  receipt: { footer: 'Thank you!', extra: '', showLogo: true },
  idleMinutes: 0,
  requireWaiter: false,
  kitchen: { warnAfter: 10, lateAfter: 20 }
};
// Said when someone's role does not allow what they tried.
var REFUSED = {
  till: 'Your role does not use the till. Ask a manager.',
  charge: 'Your role on the till cannot take payments. Ask a cashier or a manager.',
  keepOpen: 'Your role on the till cannot keep tables open.',
  removeTable: 'Your role on the till cannot remove an open table. Ask a manager.',
  refund: 'Your role on the till cannot refund sales. Ask a manager.',
  vipTopUp: 'Your role on the till cannot take VIP money. Ask a cashier or a manager.',
  iou: 'Your role on the till cannot sell on IOU. Ask a manager.',
  iouPaid: 'Your role on the till cannot take IOU payments. Ask a cashier or a manager.',
  favorites: 'Your role on the till cannot change the favourites.',
  kds: 'Your role does not use the kitchen screen. Ask a manager.'
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
    var pm = TILL_METHODS.filter(function (m) { return s.paymentMethods.indexOf(m) >= 0; });
    if (pm.length) out.paymentMethods = pm;
  }
  if (s.receipt) {
    if (typeof s.receipt.footer === 'string') out.receipt.footer = s.receipt.footer;
    if (typeof s.receipt.extra === 'string') out.receipt.extra = s.receipt.extra;
    if (typeof s.receipt.showLogo === 'boolean') out.receipt.showLogo = s.receipt.showLogo;
  }
  if (IDLE_CHOICES.indexOf(s.idleMinutes) >= 0) out.idleMinutes = s.idleMinutes;
  if (typeof s.requireWaiter === 'boolean') out.requireWaiter = s.requireWaiter;
  if (s.kitchen && s.kitchen.warnAfter > 0 && s.kitchen.lateAfter > s.kitchen.warnAfter) {
    out.kitchen = { warnAfter: s.kitchen.warnAfter, lateAfter: s.kitchen.lateAfter };
  }
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

// Whether someone may sign in to the till ('till') or the kitchen screen
// ('kds'), for restaurantPos.login.
async function checkSignIn(companyId, employeeId, app) {
  var a = await accessOf(companyId, employeeId);
  var perm = app === 'kds' ? 'kds' : 'till';
  if (!a.can[perm]) fail('forbidden', REFUSED[perm]);
  return a;
}

// What the till shows the person signed in: their role, what they may do,
// and the settings the till itself follows.
async function profile(token) {
  var session = posSession(token);
  var a = await accessOf(session.posCompanyId, session.posEmployeeId);
  return {
    role: a.role, can: a.can,
    settings: { paymentMethods: a.settings.paymentMethods, receipt: a.settings.receipt, idleMinutes: a.settings.idleMinutes, requireWaiter: a.settings.requireWaiter, kitchen: a.settings.kitchen }
  };
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

function settingsOut(settings, staff, companyId) {
  return {
    companyId: companyId, settings: settings, staff: staff,
    choices: { roles: ROLES, editableRoles: EDITABLE_ROLES, permissions: PERMISSIONS, paymentMethods: TILL_METHODS, idleMinutes: IDLE_CHOICES }
  };
}

async function openSettings(token, pin, ip) {
  var m = await settingsManager(token, pin, ip);
  var company = m.session.posCompanyId;
  return Object.assign(settingsOut(await settingsOf(company), await staffOf(company), company), { managerName: m.manager.first_name + ' ' + m.manager.last_name });
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
    if (out.roles[r].charge || out.roles[r].keepOpen || out.roles[r].removeTable || out.roles[r].refund || out.roles[r].vipTopUp || out.roles[r].iouPaid || out.roles[r].iou || out.roles[r].favorites) out.roles[r].till = true;
    if (out.roles[r].iou && !out.roles[r].charge) out.roles[r].iou = false;
  });
  if (p.paymentMethods !== undefined) {
    var pm = TILL_METHODS.filter(function (m) { return Array.isArray(p.paymentMethods) && p.paymentMethods.indexOf(m) >= 0; });
    if (!pm.length) fail('invalid', 'Keep at least one way of paying.');
    out.paymentMethods = pm;
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
    out.kitchen = { warnAfter: warn, lateAfter: late };
  }
  return out;
}

async function saveSettings(token, p, ip) {
  p = p || {};
  var m = await settingsManager(token, p.managerPin, ip);
  var company = m.session.posCompanyId;
  var before = await settingsOf(company);
  var settings = cleanSettings(p.settings, before);
  var staffChanges = Array.isArray(p.staff) ? p.staff : [];
  return withTransaction(async function (client) {
    await client.query(
      'INSERT INTO restaurant_till_settings (company_id, settings, updated_by) VALUES ($1, $2, $3) ' +
      'ON CONFLICT (company_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()',
      [company, JSON.stringify(settings), m.manager.id]);
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
    var who = { user: { id: null }, employee: { first_name: m.manager.first_name, last_name: m.manager.last_name } };
    await audit(client, who, 'restaurant.till.settings', 'company', company, 'Till settings changed' + (parts.length ? ': ' + parts.join(', ') : '') + '.');
    return Object.assign(settingsOut(settings, await staffOf(company, client), company), { managerName: m.manager.first_name + ' ' + m.manager.last_name });
  });
}

module.exports = {
  TILL_METHODS: TILL_METHODS, ROLES: ROLES, PERMISSIONS: PERMISSIONS, DEFAULTS: DEFAULTS,
  settingsOf: settingsOf, accessOf: accessOf, need: need, checkSignIn: checkSignIn, profile: profile,
  refundApprover: refundApprover, openSettings: openSettings, saveSettings: saveSettings, cleanSettings: cleanSettings
};
