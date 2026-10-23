var { fail } = require('../utils/errors');

// The till's clock rules (till settings, restaurantTillAccess):
//
//   - courses: on an open order, starters go to the kitchen first and the
//     mains wait until the waiter calls them (restaurantKitchen fire,
//     fireCourse). Each menu category has its course (0: right away, as
//     drinks); a dish's course can be changed on the till.
//   - menus by time of day: a category served only between two times
//     (breakfast 06:00–11:30) — not sold outside them, on the till, the
//     website or the table's QR menu.
//   - happy hours: a percentage off some categories on some days between
//     two times. The till puts it on a dish it adds then; the website and
//     the table's QR menu get it by themselves. It works as one of the
//     manager's ready-made discounts that anyone may give
//     (restaurantTillCheck), only while it is on.
//
// Ghana keeps GMT all year: the restaurant's clock is UTC.

var TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
var MAX_COURSES = 5;
var ALLERGENS = ['gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soy', 'milk', 'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs'];

function minutesOf(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
function norm(c) { return String(c == null ? '' : c).trim().toLowerCase(); }

// Whether a { from, to, days } window is on at this moment; one that ends
// before it starts runs past midnight (22:00–02:00). days: 0 Sunday … 6
// Saturday, none for every day.
function isOn(w, at) {
  if (!w || !TIME.test(w.from || '') || !TIME.test(w.to || '')) return true;
  var d = at ? new Date(at) : new Date();
  var now = d.getUTCHours() * 60 + d.getUTCMinutes();
  var from = minutesOf(w.from), to = minutesOf(w.to);
  var day = d.getUTCDay();
  var days = Array.isArray(w.days) && w.days.length ? w.days : null;
  if (from === to) return !days || days.indexOf(day) >= 0;
  if (from < to) return now >= from && now < to && (!days || days.indexOf(day) >= 0);
  // Past midnight: the evening part counts on its day, the small hours on the day before.
  if (now >= from) return !days || days.indexOf(day) >= 0;
  if (now < to) return !days || days.indexOf((day + 6) % 7) >= 0;
  return false;
}

function hoursOf(settings, category) {
  var all = (settings.hours && settings.hours.categories) || {};
  var c = norm(category);
  var key = Object.keys(all).find(function (k) { return norm(k) === c; });
  return key ? all[key] : null;
}
// Whether a menu category is served now (no hours set: always).
function categoryOpen(settings, category, at) {
  var h = hoursOf(settings, category);
  return !h || isOn(h, at);
}
// No new dish from a category outside its hours. lines: priced lines (with
// category); before: what an open order held already (stays, whatever the
// time). at: when it is for (a website order for later), else now.
function checkHours(settings, lines, before, at) {
  var had = new Map();
  (before || []).forEach(function (l) { if (l.menuItemId) had.set(l.menuItemId, (had.get(l.menuItemId) || 0) + Number(l.qty)); });
  var want = new Map();
  lines.forEach(function (l) { if (l.menuItemId) want.set(l.menuItemId, { qty: (want.has(l.menuItemId) ? want.get(l.menuItemId).qty : 0) + Number(l.qty), line: l }); });
  want.forEach(function (w, id) {
    if (w.qty <= (had.get(id) || 0)) return;
    var h = hoursOf(settings, w.line.category);
    if (h && !isOn(h, at)) fail('conflict', w.line.name + ' is served from ' + h.from + ' to ' + h.to + '.');
  });
}

// The happy hour on a category now, if any: the first that is on.
function happyFor(settings, category, at) {
  var c = norm(category);
  return (settings.happyHours || []).find(function (h) {
    return isOn(h, at) && (!(h.categories || []).length || h.categories.some(function (x) { return norm(x) === c; }));
  }) || null;
}
// The happy hours as the manager's ready-made discounts (anyone may give
// one, only while it is on): restaurantTillCheck cleanDiscount.
function asPresets(settings) {
  return (settings.happyHours || []).map(function (h) {
    return { id: h.id, name: h.name, kind: 'percent', value: h.percent, open: true, happy: { days: h.days || [], from: h.from, to: h.to, categories: h.categories || [] } };
  });
}
// A website or table order's dishes get the happy hour by themselves (a
// dish with no other discount).
function applyHappy(settings, lines, at) {
  lines.forEach(function (l) {
    if (l.custom || l.fee || l.discount || l.comp) return;
    var h = happyFor(settings, l.category, at);
    if (h) l.discount = { presetId: h.id };
  });
  return lines;
}

// A dish's course: as the till set it, else its category's (0 when courses
// are off or the category has none: right away).
function courseOf(settings, line) {
  var c = settings.courses || {};
  if (!c.on) return 0;
  var n = Number(line.course);
  if (line.course !== undefined && line.course !== null && n >= 0 && n <= (c.names || []).length) return n;
  var cats = c.categories || {};
  var key = Object.keys(cats).find(function (k) { return norm(k) === norm(line.category); });
  var d = key ? Number(cats[key]) : 0;
  return d >= 0 && d <= (c.names || []).length ? d : 0;
}

// Checked settings (restaurantTillAccess cleanSettings).
function cleanWindow(w, label) {
  w = w || {};
  if (!TIME.test(w.from || '') || !TIME.test(w.to || '')) fail('invalid', label + ': give the times as HH:MM, e.g. 06:00 and 11:30.');
  var days = Array.isArray(w.days) ? Array.from(new Set(w.days.map(Number).filter(function (d) { return d >= 0 && d <= 6; }))).sort() : [];
  return { from: w.from, to: w.to, days: days.length === 7 ? [] : days };
}
function cleanCourses(p, text) {
  var names = Array.isArray(p.names) ? p.names.map(function (n) { return text(n, 30); }).filter(Boolean) : [];
  if (p.on && !names.length) fail('invalid', 'Name at least one course, e.g. Starters.');
  if (names.length > MAX_COURSES) fail('invalid', 'Keep at most ' + MAX_COURSES + ' courses.');
  var categories = {};
  Object.keys(p.categories || {}).slice(0, 200).forEach(function (k) {
    var n = Math.round(Number(p.categories[k]));
    if (text(k, 120) && n >= 0 && n <= names.length) categories[text(k, 120)] = n;
  });
  return { on: !!p.on, names: names.length ? names : ['Starters', 'Mains', 'Desserts'], categories: categories };
}
function cleanHours(p, text) {
  var categories = {};
  Object.keys((p && p.categories) || {}).slice(0, 200).forEach(function (k) {
    var name = text(k, 120);
    if (name && p.categories[k]) categories[name] = cleanWindow(p.categories[k], name);
  });
  return { categories: categories };
}
function cleanHappyHours(list, text) {
  if (!Array.isArray(list)) fail('invalid', 'Happy hours are a list.');
  if (list.length > 10) fail('invalid', 'Keep at most 10 happy hours.');
  return list.map(function (h) {
    h = h || {};
    var name = text(h.name, 40);
    if (!name) fail('invalid', 'Give each happy hour a name, e.g. Happy hour.');
    var pct = Math.round(Number(h.percent) * 100) / 100;
    if (!(pct > 0 && pct <= 100)) fail('invalid', name + ': a percentage off from 1 to 100.');
    var w = cleanWindow(h, name);
    var cats = Array.isArray(h.categories) ? h.categories.map(function (c) { return text(c, 120); }).filter(Boolean).slice(0, 100) : [];
    return { id: /^[a-z0-9-]{4,40}$/.test(String(h.id || '')) ? h.id : require('crypto').randomUUID(), name: name, percent: pct, from: w.from, to: w.to, days: w.days, categories: cats };
  });
}
function cleanAllergens(list) {
  return Array.isArray(list) ? Array.from(new Set(list.filter(function (a) { return ALLERGENS.indexOf(a) >= 0; }))) : [];
}

module.exports = {
  ALLERGENS: ALLERGENS, MAX_COURSES: MAX_COURSES, isOn: isOn, categoryOpen: categoryOpen, checkHours: checkHours, happyFor: happyFor, asPresets: asPresets,
  applyHappy: applyHappy, courseOf: courseOf, cleanCourses: cleanCourses, cleanHours: cleanHours, cleanHappyHours: cleanHappyHours, cleanAllergens: cleanAllergens
};
