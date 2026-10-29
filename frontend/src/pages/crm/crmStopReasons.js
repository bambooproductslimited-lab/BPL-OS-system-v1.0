import { msg, tr } from '../../lib/i18n.jsx';

// Why someone is not a lead (crmStop.jsx), and why not to follow them up.
// A reason is stored as "code: what was typed" (crm.service.js,
// crmProfiles.service.js).

export const NOT_LEAD_REASONS = [
  { key: 'supplier', icon: '🚚', label: msg('A supplier') },
  { key: 'staff_family', icon: '👪', label: msg('Staff or family') },
  { key: 'job_seeker', icon: '💼', label: msg('Looking for a job') },
  { key: 'spam', icon: '📵', label: msg('Wrong number or spam') },
  { key: 'other_business', icon: '🤝', label: msg('A business, not buying') },
  { key: 'other', icon: '✏️', label: msg('Something else') }
];
export const NO_FOLLOW_UP_REASONS = [
  { key: 'not_interested', icon: '🙅', label: msg('Not interested') },
  { key: 'asked_to_stop', icon: '✋', label: msg('Asked us to stop') },
  { key: 'bought_elsewhere', icon: '🛒', label: msg('Bought elsewhere') },
  { key: 'unreachable', icon: '📴', label: msg('Can\'t reach them') },
  { key: 'cannot_serve', icon: '🚧', label: msg('We can\'t serve them') },
  { key: 'other', icon: '✏️', label: msg('Something else') }
];

// "supplier: sells us poles" → "🚚 A supplier · sells us poles"
export function reasonText(stored, list) {
  const s = String(stored || '');
  const at = s.indexOf(':');
  const code = at >= 0 ? s.slice(0, at) : s;
  const r = list.find((x) => x.key === code);
  if (!r) return s;
  const said = at >= 0 ? s.slice(at + 1).trim() : '';
  return r.icon + ' ' + tr(r.label) + (said ? ' · ' + said : '');
}
