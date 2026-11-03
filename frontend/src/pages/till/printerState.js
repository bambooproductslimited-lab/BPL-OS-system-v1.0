import { tr } from '../../lib/i18n.jsx';

// How a network printer is, in words and a tone for its dot (ok, warn,
// bad, off): Till settings → Printers and the till's printer sheet.
function ago(iso) {
  if (!iso) return tr('never');
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? tr('just now') : m < 60 ? tr('{n} min ago', { n: m }) : m < 1440 ? tr('{n} h ago', { n: Math.floor(m / 60) }) : tr('{n} days ago', { n: Math.floor(m / 1440) });
}
export function printerState(p) {
  if (p.problem === 'offline') return { tone: 'off', text: p.lastSeenAt ? tr('Offline · last seen {when}', { when: ago(p.lastSeenAt) }) : tr('Offline') };
  if (p.problem === 'paper') return { tone: 'bad', text: tr('Out of paper') };
  if (p.problem === 'cover') return { tone: 'bad', text: tr('Cover open') };
  if (p.problem === 'error') return { tone: 'bad', text: tr('Not printing: {why}', { why: p.statusText || '?' }) };
  if (p.problem === 'low') return { tone: 'warn', text: tr('Paper running low') };
  return { tone: 'ok', text: tr('Online') };
}
