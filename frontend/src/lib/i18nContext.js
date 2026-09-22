import { createContext, useContext } from 'react';
import { translate } from './i18n.jsx';

// The context object and the hooks that read it, kept out of
// components/I18nProvider.jsx so that file exports a component and nothing
// else — which is what Fast Refresh needs to reload it properly.
export const I18nContext = createContext(null);

const DEFAULT_LOCALE = 'en';

export function useI18n() {
  const ctx = useContext(I18nContext);
  // Outside a provider (a component rendered in isolation, a test) the app
  // still has to render — in English rather than crashing.
  if (!ctx) {
    return { locale: DEFAULT_LOCALE, setLocale: () => {}, intlLocale: 'en-GB', t: (k, v) => translate(DEFAULT_LOCALE, k, v) };
  }
  return ctx;
}

// For components that would rather take t from context than import it.
// Equivalent to the exported t() above in every way that matters.
export function useT() { return useI18n().t; }
