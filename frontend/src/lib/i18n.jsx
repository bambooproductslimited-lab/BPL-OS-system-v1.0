import fr from '../locales/fr';
import zh from '../locales/zh';

// Interface languages for Bamboo OS.
//
// Translation keys ARE the English strings. There is no separate key
// namespace to invent, keep tidy and drift out of sync with the screens —
// t('Mark all read') looks up 'Mark all read' and falls back to it when a
// catalogue has no entry. Two consequences worth knowing:
//
//   * An untranslated string renders as correct English rather than as a
//     raw key like people.directory.title. A half-finished catalogue is
//     shabby, not broken, which matters when translations arrive over time.
//   * Changing the English wording of a string orphans its translations.
//     tools/i18n-audit.mjs reports catalogue entries that no longer match
//     anything in the source, which is how those get caught.
//
// Where the same English word needs different translations in different
// places, the key carries a context suffix after a pipe — t('Open|status')
// — and only the part before the pipe is ever shown. See stripContext().
//
// Dates and numbers are NOT translated string-by-string; they go through
// Intl with the locale's `intl` tag below (lib/dates.js, lib/format.js).

export const LOCALES = [
  { code: 'en', label: 'English', intl: 'en-GB' },
  { code: 'fr', label: 'Français', intl: 'fr-FR' },
  { code: 'zh', label: '中文（简体）', intl: 'zh-CN' }
];

const CATALOGUES = { fr: fr, zh: zh };
export const STORAGE_KEY = 'bamboo-os-locale';
const DEFAULT_LOCALE = 'en';

export function isKnownLocale(code) {
  return LOCALES.some((l) => l.code === code);
}

export function localeMeta(code) {
  return LOCALES.find((l) => l.code === code) || LOCALES[0];
}

function stripContext(key) {
  const bar = key.indexOf('|');
  return bar === -1 ? key : key.slice(0, bar);
}

// Read before React mounts so the first paint is already in the right
// language — waiting for GET /api/me would show a flash of English.
export function getInitialLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isKnownLocale(stored)) return stored;
  } catch { /* storage blocked — fall through to the default */ }
  return DEFAULT_LOCALE;
}

// The active locale, mirrored outside React.
//
// This is what makes t() below a plain function instead of a hook, and that
// is the single most important decision in this file: it means translating
// a screen is only ever "wrap this string in t()", with no component to
// find, no hook to place legally, and no rule about where a string may
// live. Column definitions in module-level arrays, helper functions outside
// any component, a label built in a switch statement — all translate the
// same way. Across sixty-odd pages that difference is the difference
// between a mechanical change and a rewrite.
//
// The cost is that changing this value doesn't re-render anything by
// itself. I18nProvider pays it by remounting its subtree on a language
// change (see the key= below), which is both simple and complete: every
// string is read again, with nothing left behind in a stale closure.
// Switching language is a deliberate, rare act, so throwing away in-page
// state at that moment is the right trade.
let currentLocale = getInitialLocale();
let currentIntlTag = localeMeta(currentLocale).intl;
export function activeLocale() { return currentLocale; }
export function activeIntlLocale() { return currentIntlTag; }

// The workhorse: tr('Save'), or tr('Showing {n} of {total}', { n: 5, total: 40 }).
//
// Named tr rather than the conventional t because `t` is already a local in
// 52 of the 59 page files — overwhelmingly as `(t) =>` in a .map() or
// .filter() callback, exactly the kind of place that then renders JSX. An
// import called `t` would be silently shadowed inside those callbacks and
// the translation would call the array element instead. `tr` is bound
// nowhere in the codebase, so it means one thing everywhere.
export function tr(key, vars) { return translate(currentLocale, key, vars); }

export function translate(locale, key, vars) {
  const catalogue = CATALOGUES[locale];
  const entry = catalogue && Object.prototype.hasOwnProperty.call(catalogue, key) ? catalogue[key] : null;
  let out = entry || stripContext(key);
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (whole, name) =>
      (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
  }
  return out;
}

// Applying a locale from outside React's tree.
//
// The user's saved language arrives with their session, and AuthProvider —
// which is deliberately mounted ABOVE this provider, so that a language
// switch never tears the session down — has no way to reach a hook in
// here. It calls adoptLocale() instead. Registering rather than exporting
// setLocale directly keeps the state in one place: there is still only one
// setter, and it still writes the localStorage cache.
let applyLocale = null;
export function adoptLocale(code) {
  if (isKnownLocale(code) && applyLocale) applyLocale(code);
}
// components/I18nProvider.jsx hands its setter over on mount.
export function registerLocaleSetter(fn) { applyLocale = fn; }

// Also called by that provider, during render, so the module-level locale
// these plain functions read is in step on the very same pass that renders
// the new language — never a frame behind.
export function setCurrentLocale(code) {
  currentLocale = code;
  currentIntlTag = localeMeta(code).intl;
}
