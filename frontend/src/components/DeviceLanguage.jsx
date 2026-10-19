import { LOCALES } from '../lib/i18n.jsx';
import { useI18n } from '../lib/i18nContext.js';

// The language of a shared device opened with a staff PIN (the till, the
// kitchen screen): kept on this device, since there is no account to save
// it on (LanguagePicker saves it on the signed-in user). Each language is
// written in itself, so whoever needs it can find it.
export default function DeviceLanguage({ className }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className={className}>
      <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label={t('Language')} title={t('Language')}>
        {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  );
}
