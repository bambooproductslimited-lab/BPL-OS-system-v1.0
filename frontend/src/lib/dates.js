// The date format used across the document screens, in one place. Several
// pages carry an identical private copy of this; new callers use this one
// rather than adding another.
export function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
