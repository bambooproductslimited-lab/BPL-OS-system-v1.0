import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { STORAGE_KEY, getInitialLocale, isKnownLocale, localeMeta, registerLocaleSetter, setCurrentLocale, translate } from '../lib/i18n.jsx';
import { I18nContext } from '../lib/i18nContext.js';

// The React half of the translation layer — kept apart from lib/i18n.jsx so
// that module exports only plain functions and this one only a component.

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(getInitialLocale);

  // Set during render, not in an effect: children render with the new
  // language on the very same pass, so there is never a frame showing the
  // old one. Assigning module state during render is normally a smell —
  // here it is the point, and it is idempotent.
  setCurrentLocale(locale);

  // Purely local: state plus the localStorage cache that makes the next
  // first paint land in the right language. Saving the choice to the
  // signed-in user's row is LanguagePicker's job, since this provider also
  // wraps screens where nobody is signed in (login, /kiosk, /pos).
  const setLocale = useCallback((next) => {
    if (!isKnownLocale(next)) return;
    setLocaleState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage blocked — won't persist on this device */ }
  }, []);

  // Lets AuthProvider, which sits above this one, apply the language saved
  // on the signed-in user's row — see lib/i18n.jsx's adoptLocale. Declared
  // after setLocale, not beside setCurrentLocale above, because a const is
  // not readable before its own declaration.
  registerLocaleSetter(setLocale);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    intlLocale: localeMeta(locale).intl,
    t: (key, vars) => translate(locale, key, vars)
  }), [locale, setLocale]);

  // key={locale} remounts everything below on a language change — see the
  // currentLocale comment above for why that is the mechanism rather than a
  // shortcoming.
  return (
    <I18nContext.Provider value={value}>
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

