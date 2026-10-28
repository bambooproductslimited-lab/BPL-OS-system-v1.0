import { Icon } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';

// What the till's screens share (RestaurantPosPage.jsx, its dialogs, the
// settings and the kitchen screen): the ways of paying, the currencies, dine
// in / pickup / delivery, and the tag that says where an order's food is.
// Backend: restaurantPos.service.js, restaurantTillMoney.service.js.

// Alipay and WeChat Pay drawn plainly (a letter, a chat bubble), not their logos.
export function MethodGlyph({ method }) {
  if (method === 'alipay') return <span className="tl-glyph is-alipay" aria-hidden="true">支</span>;
  if (method === 'gift_card') return <span className="tl-glyph is-gift" aria-hidden="true">🎁</span>;
  if (method === 'app') return <span className="tl-glyph is-app" aria-hidden="true">🛵</span>;
  if (method === 'paystack') return <span className="tl-glyph is-paystack" aria-hidden="true">📲</span>;
  if (method === 'wechat') {
    return (
      <svg className="dk-icon tl-glyph is-wechat" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.5 4.5c-3.9 0-7 2.6-7 5.8 0 1.8 1 3.4 2.6 4.5l-.6 2.2 2.5-1.3c.8.2 1.6.3 2.5.3" /><path d="M14.8 9.6c3.6 0 6.7 2.3 6.7 5.2 0 1.6-.9 3-2.3 4l.5 1.9-2.2-1.1c-.8.2-1.7.4-2.7.4-3.7 0-6.7-2.3-6.7-5.2s3-5.2 6.7-5.2z" />
      </svg>
    );
  }
  return <Icon name={{ cash: 'cash', mobile_money: 'phone', vip: 'spark', iou: 'owed', other: 'info', split: 'layers', card: 'card' }[method] || 'cash'} />;
}
export const METHOD_LABEL = {
  cash: msg('Cash'), mobile_money: msg('Mobile Money'), alipay: msg('Alipay'), wechat: msg('WeChat Pay'),
  vip: msg('VIP'), iou: msg('IOU'), other: msg('Other'), split: msg('Split payment'), gift_card: msg('Gift card'),
  // Sales brought in from Square (the OS's Square import) were paid these ways too.
  card: msg('Card'), bank_transfer: msg('Bank transfer'),
  // A delivery app's order, paid on the app (backend restaurantApps); a card or
  // Mobile Money paid on the customer's phone through Paystack.
  app: msg('Paid on the app'), paystack: msg('Pay by phone')
};
export function methodName(m) { return METHOD_LABEL[m] ? tr(METHOD_LABEL[m]) : m; }

// Cedis, and the foreign money a manager can turn on (CNY is shown as RMB).
// A drawer's money in or out for a customer's account (backend
// restaurantTillMoney accountMoves), in words: VIP money put down or given
// back, an IOU paid back, cash lent on an IOU account.
export function moveLabel(m) {
  const who = m.customer || tr('a customer');
  if (m.account === 'vip') return m.direction === 'in' ? tr('VIP money from {name}', { name: who }) : tr('VIP money given back to {name}', { name: who });
  if (m.account === 'iou') return (m.direction === 'in' ? tr('IOU paid back by {name}', { name: who }) : tr('Cash lent to {name}', { name: who })) + (m.ref ? ' (' + m.ref + ')' : '');
  if (m.account === 'gift') return (m.direction === 'in' ? tr('Gift card sold') : tr('Gift card cancelled: cash given back')) + (m.customer ? ' · ' + m.customer : '') + (m.ref ? ' (' + m.ref + ')' : '');
  return m.direction === 'in' ? tr('Paid in') : tr('Paid out');
}
export const CURRENCY_LABEL = { GHS: 'GHS', USD: 'USD', CNY: 'RMB' };
export const CURRENCY_NAME = { GHS: msg('Ghana cedis'), USD: msg('US dollars'), CNY: msg('Chinese yuan (RMB)') };
export function fmt(n, currency) {
  if (!currency || currency === 'GHS') return money(n);
  return CURRENCY_LABEL[currency] + ' ' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// The currencies the till takes now: cedis, and each one a manager turned on with a rate.
export function liveCurrencies(settings) {
  const out = [{ code: 'GHS', rate: 1 }];
  const c = (settings && settings.currencies) || {};
  ['USD', 'CNY'].forEach((k) => { if (c[k] && c[k].on && c[k].rate > 0) out.push({ code: k, rate: c[k].rate }); });
  return out;
}
export function round2(n) { return Math.round(Number(n) * 100) / 100; }
// The money each way of paying takes, as the server holds it
// (restaurantTillMoney METHOD_CURRENCIES): Alipay and WeChat Pay in RMB
// only, Mobile Money in cedis only, cash in cedis or US dollars; VIP and IOU
// in cedis. Of those, the ones the till takes now (live: liveCurrencies).
export const METHOD_CURRENCIES = { cash: ['GHS', 'USD'], mobile_money: ['GHS'], alipay: ['CNY'], wechat: ['CNY'], vip: ['GHS'], iou: ['GHS'], gift_card: ['GHS'], card: ['GHS'], app: ['GHS'], paystack: ['GHS'] };
export function methodCurrencies(method, live) {
  const ok = METHOD_CURRENCIES[method] || ['GHS'];
  return live.filter((c) => ok.includes(c.code));
}

// Dine in, to go (bought at the counter, packed to take away), pickup
// (ordered ahead: who and a phone) or delivery.
export const FULFILLMENT = [
  { key: 'dine_in', label: msg('Dine in'), icon: 'table' },
  { key: 'togo', label: msg('To go'), icon: 'cup' },
  { key: 'pickup', label: msg('Pickup'), icon: 'bag' },
  { key: 'delivery', label: msg('Delivery'), icon: 'send' }
];
export function fulfillmentName(k) { const f = FULFILLMENT.find((x) => x.key === k); return f ? tr(f.label) : ''; }
const TABLE_PATH = <path d="M3 9h18M6 9v10M18 9v10M4.5 9 7 5h10l2.5 4" />;
// A takeaway cup with its lid and straw.
const CUP_PATH = <path d="M6 8h12M7 8l1.2 12.2a1 1 0 0 0 1 .8h5.6a1 1 0 0 0 1-.8L17 8M6.5 8l.6-2.4A1 1 0 0 1 8.1 5h7.8a1 1 0 0 1 1 .6L17.5 8M13 5l1.2-3M8 13h8" />;
export function FulfillmentIcon({ kind }) {
  if (kind === 'dine_in') return <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TABLE_PATH}</svg>;
  if (kind === 'togo') return <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{CUP_PATH}</svg>;
  return <Icon name={kind === 'delivery' ? 'send' : 'bag'} />;
}

// Where an order's food stands in the kitchen (restaurantKitchen.statusOf):
// cooking, ready to take out, or served.
export function KitchenTag({ kitchen, compact }) {
  if (!kitchen || !kitchen.state) return null;
  const label = kitchen.state === 'served' ? tr('Food served') : kitchen.state === 'ready' ? tr('Food ready') : kitchen.state === 'held' ? tr('Waiting to be called') : tr('Cooking');
  const title = kitchen.state === 'served' ? tr('The kitchen\'s food for this order has been served.')
    : kitchen.state === 'ready' ? tr('The kitchen marked the food ready: take it out.') : kitchen.state === 'held' ? tr('The next course waits at the kitchen until you call it.') : tr('The kitchen is cooking it.');
  const waiting = (kitchen.held || []).length;
  return (
    <span className={'tl-ktag is-' + kitchen.state + (compact ? ' is-compact' : '')} title={title}>
      <i aria-hidden="true">{kitchen.state === 'served' ? '✓' : kitchen.state === 'ready' ? '●' : kitchen.state === 'held' ? '⏸' : '◔'}</i>{label}
      {kitchen.state === 'cooking' && kitchen.served > 0 && <small>{tr('{n} served', { n: kitchen.served })}</small>}
      {kitchen.state !== 'held' && waiting > 0 && <small>{waiting === 1 ? tr('1 course waits') : tr('{n} courses wait', { n: waiting })}</small>}
    </span>
  );
}

// A line on an order: the dish (or one not on the menu, by its name), its
// add-ons, its note, and its discount or "on the house" — the same dish with
// other add-ons, another note or another discount is another line.
function modsKey(mods) { return (mods || []).map((m) => (m.how || 'add') + ':' + m.id).sort().join(','); }
function offKey(l) { return l.comp ? 'comp:' + l.comp.reason : l.discountSpec ? 'd:' + l.discountSpec.kind + ':' + l.discountSpec.value + ':' + (l.discountSpec.presetId || '') : ''; }
export function lineKey(l) {
  return (l.custom ? 'c:' + String(l.custom.name || l.name).toLowerCase() + ':' + l.price : l.menuItemId + '::' + (l.variationId || '')) + '::' + modsKey(l.modifiers) + '::' + String(l.note || '').trim().toLowerCase() + '::' + offKey(l) + '::s' + (l.seat || '');
}
// The same, as the kitchen sees it: a discount does not change what is cooked.
export function kitchenKey(l) { return lineKey({ ...l, comp: null, discountSpec: null }); }
// What the server needs for a line: the add-ons by id and how, the
// discount or "on the house" as asked (with a manager's approval, if one
// was needed). A delivery fee line (custom.fee) stays one: charged, never cooked.
export function lineBody(l) {
  const off = { ...(l.comp ? { comp: l.comp } : l.discountSpec ? { discount: l.discountSpec } : {}), ...(l.seat ? { seat: l.seat } : {}), ...(l.course !== undefined && l.course !== null ? { course: l.course } : {}) };
  return l.custom
    ? { custom: { name: l.custom.name, price: l.custom.price, category: l.custom.category || '', ...(l.custom.fee ? { fee: true } : {}) }, qty: l.qty, note: l.note || undefined, ...off }
    : { menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty, note: l.note || undefined, modifiers: (l.modifiers || []).map((m) => (m.how && m.how !== 'add' ? { id: m.id, how: m.how } : { id: m.id })), ...off };
}
// A line kept on an open order (restaurantPos lineOut), back on the till.
export function lineFromTab(l) {
  const off = { discountSpec: l.discountSpec || null, comp: l.comp || null, seat: l.seat || null, course: l.course !== undefined ? l.course : null, category: l.category || '', allergens: l.allergens || [] };
  return l.custom
    ? { menuItemId: null, variationId: null, name: l.name, price: l.unitPrice, qty: l.qty, note: l.note || '', modifiers: [], custom: { name: l.name, price: l.unitPrice, category: l.category || '', ...(l.fee ? { fee: true } : {}) }, ...off }
    : { menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, price: l.unitPrice, qty: l.qty, note: l.note || '', modifiers: l.modifiers || [], ...off };
}

// Quick notes a cashier taps instead of typing.
export const QUICK_NOTES = [msg('No pepper'), msg('Less spicy'), msg('Extra spicy'), msg('No onions'), msg('No salt'), msg('Well done'), msg('Sauce on the side'), msg('Takeaway pack')];
