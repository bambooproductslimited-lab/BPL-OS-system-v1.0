import { msg } from '../../lib/i18n.jsx';

// The table's service on the till, as the server has it (backend
// restaurantTillTimes.service.js): allergens by key, courses, menus by
// time of day and happy hours. Ghana keeps GMT all year: the restaurant's
// clock is UTC.

export const ALLERGENS = [
  ['gluten', '🌾', msg('Gluten')], ['crustaceans', '🦐', msg('Crustaceans')], ['eggs', '🥚', msg('Eggs')], ['fish', '🐟', msg('Fish')],
  ['peanuts', '🥜', msg('Peanuts')], ['soy', '🫘', msg('Soy')], ['milk', '🥛', msg('Milk')], ['nuts', '🌰', msg('Tree nuts')],
  ['celery', '🥬', msg('Celery')], ['mustard', '🟡', msg('Mustard')], ['sesame', '⚪', msg('Sesame')], ['sulphites', '🍷', msg('Sulphites')],
  ['lupin', '🌼', msg('Lupin')], ['molluscs', '🦪', msg('Molluscs')]
];
const BY_KEY = new Map(ALLERGENS.map((a) => [a[0], a]));
// An allergen in words with its sign, in the reader's language: tr is lib/i18n's.
export function allergenWords(key, tr) { const a = BY_KEY.get(key); return a ? a[1] + ' ' + tr(a[2]) : key; }
export function allergenIcon(key) { const a = BY_KEY.get(key); return a ? a[1] : '⚠'; }
// What of a dish's allergens the order's alert names.
export function clashes(dishAllergens, alert) { const list = (alert && alert.list) || []; return (dishAllergens || []).filter((a) => list.includes(a)); }

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
function minutesOf(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)); }
// Whether a { from, to, days } window is on (one past midnight counts on the day it started).
export function isOn(w, at) {
  if (!w || !TIME.test(w.from || '') || !TIME.test(w.to || '')) return true;
  const d = at ? new Date(at) : new Date();
  const now = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = minutesOf(w.from), to = minutesOf(w.to), day = d.getUTCDay();
  const days = Array.isArray(w.days) && w.days.length ? w.days : null;
  if (from === to) return !days || days.includes(day);
  if (from < to) return now >= from && now < to && (!days || days.includes(day));
  if (now >= from) return !days || days.includes(day);
  if (now < to) return !days || days.includes((day + 6) % 7);
  return false;
}
const lower = (s) => String(s == null ? '' : s).trim().toLowerCase();
function byCategory(map, category) { const k = Object.keys(map || {}).find((x) => lower(x) === lower(category)); return k ? map[k] : null; }
// A menu category's hours, if it has any.
export function hoursOf(settings, category) { return byCategory(settings && settings.hours && settings.hours.categories, category); }
export function categoryOpen(settings, category, at) { const h = hoursOf(settings, category); return !h || isOn(h, at); }
// The happy hour on a category now, if any.
export function happyFor(settings, category, at) {
  return ((settings && settings.happyHours) || []).find((h) => isOn(h, at) && (!(h.categories || []).length || h.categories.some((c) => lower(c) === lower(category)))) || null;
}
// A dish's course: as set on the till, else its category's; 0 (right away) when courses are off.
export function courseOf(settings, line) {
  const c = (settings && settings.courses) || {};
  if (!c.on) return 0;
  const n = Number(line.course);
  if (line.course !== undefined && line.course !== null && n >= 0 && n <= (c.names || []).length) return n;
  const d = Number(byCategory(c.categories, line.category));
  return d >= 0 && d <= (c.names || []).length ? d : 0;
}
// The usual courses, in the reader's language when the manager kept their names.
export const COURSE_WORDS = [msg('Starters'), msg('Mains'), msg('Desserts')];
// A course's name: "Right away" for 0.
export function courseName(settings, n, tr) {
  if (!n) return tr('Right away');
  const names = (settings && settings.courses && settings.courses.names) || [];
  return names[n - 1] ? tr(names[n - 1]) : tr('Course {n}', { n });
}
