import { useI18n, LOCALES } from '../lib/i18n.jsx';
import './LanguagePicker.css';

// The header's language chooser. A native <select> on purpose rather than a
// custom menu: it is the one control every platform already renders as a
// proper, reachable picker — a full-screen wheel on the iPads used around
// the site, a normal listbox on a desktop — and it needs no portal to
// escape the header's clipping context the way RowMenu did.
//
// Each language is written in itself (Français, not "French"), since the
// person who needs to find it is by definition the one who can't yet read
// the current language.
export default function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return (
    <label className="lang-picker">
      <span className="sr-only">{t('Language')}</span>
      <select
        className="lang-picker-select"
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        title={t('Language')}
      >
        {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  );
}
