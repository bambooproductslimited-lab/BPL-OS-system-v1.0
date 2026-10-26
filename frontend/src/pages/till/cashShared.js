import { msg, tr } from '../../lib/i18n.jsx';

// Petty cash: what it was for (backend restaurantCashOffice CATEGORIES).
export const PETTY = [
  ['market', '🛒', msg('Market')], ['transport', '🚕', msg('Transport')], ['gas', '🔥', msg('Gas and fuel')], ['repairs', '🔧', msg('Repairs')],
  ['cleaning', '🧽', msg('Cleaning')], ['staff', '🥤', msg('Staff food and water')], ['other', '✳️', msg('Other')]
];
export function pettyOf(key) {
  const p = PETTY.find((x) => x[0] === key) || PETTY[PETTY.length - 1];
  return { icon: p[1], label: tr(p[2]) };
}
