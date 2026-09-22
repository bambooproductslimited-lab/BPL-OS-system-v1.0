// The date format used across the document screens, in one place. Several
// pages carry an identical private copy of this; new callers use this one
// rather than adding another.
//
// Formatted through the signed-in user's language rather than a fixed
// en-GB, so a date reads the way that reader expects it to — 19 Sept 2026
// in English, 19 sept. 2026 in French, 2026年9月19日 in Chinese. The em
// dash for "no date" is deliberately not translated: it is punctuation,
// and it means the same thing in all three.
import { activeIntlLocale } from './i18n.jsx';

export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
