import { LOCALES } from '../lib/i18n.jsx';
import { useI18n } from '../lib/i18nContext.js';
import { api } from '../api/client';
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

  // Saving the choice to the signed-in user's row, so it follows them to
  // the next device. Fire-and-forget: the language has already changed
  // locally, and a failed save only means this browser keeps the choice
  // while another one doesn't — not worth an error banner over. It lives
  // here rather than in an effect because picking a language is a
  // deliberate act, and an effect keyed on the locale could not tell one
  // apart from the language simply being applied at sign-in.
  function choose(next) {
    setLocale(next);
    api.post('/me/locale', { locale: next }).catch(() => {});
  }

  return (
    <label className="lang-picker">
      <span className="sr-only">{t('Language')}</span>
      <select
        className="lang-picker-select"
        value={locale}
        onChange={(e) => choose(e.target.value)}
        title={t('Language')}
      >
        {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
      </select>
    </label>
  );
}
