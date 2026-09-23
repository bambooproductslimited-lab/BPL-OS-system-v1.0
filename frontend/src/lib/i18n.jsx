import { Fragment } from 'react';
import fr from '../locales/fr';
import zh from '../locales/zh';

// Interface languages for Bamboo OS.
//
// Translation keys ARE the English strings. There is no separate key
// namespace to invent, keep tidy and drift out of sync with the screens —
// tr('Mark all read') looks up 'Mark all read' and falls back to it when a
// catalogue has no entry. Two consequences worth knowing:
//
//   * An untranslated string renders as correct English rather than as a
//     raw key like people.directory.title. A half-finished catalogue is
//     shabby, not broken, which matters when translations arrive over time.
//   * Changing the English wording of a string orphans its translations.
//     tools/i18n-audit.mjs reports catalogue entries that no longer match
//     anything in the source, which is how those get caught.
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
// live. Helper functions outside any component, a label built in a switch
// statement, a toast in an event handler — all translate the same way.
// Across sixty-odd pages that difference is the difference between a
// mechanical change and a rewrite. (The one place it can't go is a
// module-level constant, which runs before any language is chosen — see
// msg() below.)
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

// Customer-facing documents — invoices, quotations, estimates, letting
// offers, receipts, waybills and the page behind a share link — are always
// written in the company's document language, whatever language the person
// preparing them has chosen for the interface. A clerk who works in French
// is still sending a Ghanaian customer an English invoice; before this, the
// preview (which is exactly what gets printed, turned into a PDF and sent
// on WhatsApp) followed the clerk's language and the customer got French.
//
// docTr() is tr() pinned to that language. The strings stay in the
// catalogues, so documents in another language later is this one constant.
// Only the document itself uses it; the buttons around a preview — Print,
// Share, Close — are interface and keep following the reader with tr().
export const DOCUMENT_LOCALE = 'en';
export const DOCUMENT_INTL_LOCALE = 'en-GB';
export function docTr(key, vars) { return translate(DOCUMENT_LOCALE, key, vars); }

// A marker for strings defined outside any component — in a module-level
// constant such as the sidebar's navModel.js. It returns its argument
// untouched, so the list still holds plain English; the point is that the
// catalogue tools can see the string is meant for translation.
//
// tr() cannot be used there: at module level it runs once, when the file
// is first loaded, and that string would stay in the language of the
// moment for good — a language switch remounts components, it does not
// reload modules. So a msg() string is translated where it is shown, with
// tr(item.label), which runs on every render.
export function msg(key) { return key; }

// tr() for a sentence with markup inside it — a name in bold, say:
// trNodes('Delete the record for {name}?', { name: <strong>{n}</strong> }).
// Splitting the sentence around the <strong> is what hands translators
// fragments they can't reorder; here the sentence stays one key and each
// element lands wherever the translation puts its placeholder.
export function trNodes(key, vars) {
  const text = translate(currentLocale, key);
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    if (!Object.prototype.hasOwnProperty.call(vars, m[1])) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(vars[m[1]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}

export function translate(locale, key, vars) {
  const catalogue = CATALOGUES[locale];
  const entry = catalogue && Object.prototype.hasOwnProperty.call(catalogue, key) ? catalogue[key] : null;
  let out = entry || key;
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
