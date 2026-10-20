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
  if (method === 'wechat') {
    return (
      <svg className="dk-icon tl-glyph is-wechat" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.5 4.5c-3.9 0-7 2.6-7 5.8 0 1.8 1 3.4 2.6 4.5l-.6 2.2 2.5-1.3c.8.2 1.6.3 2.5.3" /><path d="M14.8 9.6c3.6 0 6.7 2.3 6.7 5.2 0 1.6-.9 3-2.3 4l.5 1.9-2.2-1.1c-.8.2-1.7.4-2.7.4-3.7 0-6.7-2.3-6.7-5.2s3-5.2 6.7-5.2z" />
      </svg>
    );
  }
  return <Icon name={{ cash: 'cash', mobile_money: 'phone', vip: 'spark', iou: 'owed', other: 'info', split: 'layers' }[method] || 'cash'} />;
}
export const METHOD_LABEL = {
  cash: msg('Cash'), mobile_money: msg('Mobile Money'), alipay: msg('Alipay'), wechat: msg('WeChat Pay'),
  vip: msg('VIP'), iou: msg('IOU'), other: msg('Other'), split: msg('Split payment')
};
export function methodName(m) { return METHOD_LABEL[m] ? tr(METHOD_LABEL[m]) : m; }

// Cedis, and the foreign money a manager can turn on (CNY is shown as RMB).
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

// Dine in, pickup or delivery.
export const FULFILLMENT = [
  { key: 'dine_in', label: msg('Dine in'), icon: 'table' },
  { key: 'pickup', label: msg('Pickup'), icon: 'bag' },
  { key: 'delivery', label: msg('Delivery'), icon: 'send' }
];
export function fulfillmentName(k) { const f = FULFILLMENT.find((x) => x.key === k); return f ? tr(f.label) : ''; }
const TABLE_PATH = <path d="M3 9h18M6 9v10M18 9v10M4.5 9 7 5h10l2.5 4" />;
export function FulfillmentIcon({ kind }) {
  if (kind === 'dine_in') return <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{TABLE_PATH}</svg>;
  return <Icon name={kind === 'delivery' ? 'send' : 'bag'} />;
}

// Where an order's food stands in the kitchen (restaurantKitchen.statusOf):
// cooking, ready to take out, or served.
export function KitchenTag({ kitchen, compact }) {
  if (!kitchen || !kitchen.state) return null;
  const label = kitchen.state === 'served' ? tr('Food served') : kitchen.state === 'ready' ? tr('Food ready') : tr('Cooking');
  const title = kitchen.state === 'served' ? tr('The kitchen\'s food for this order has been served.')
    : kitchen.state === 'ready' ? tr('The kitchen marked the food ready: take it out.') : tr('The kitchen is cooking it.');
  return (
    <span className={'tl-ktag is-' + kitchen.state + (compact ? ' is-compact' : '')} title={title}>
      <i aria-hidden="true">{kitchen.state === 'served' ? '✓' : kitchen.state === 'ready' ? '●' : '◔'}</i>{label}
      {kitchen.state === 'cooking' && kitchen.served > 0 && <small>{tr('{n} served', { n: kitchen.served })}</small>}
    </span>
  );
}

// A line on an order: the dish (or one not on the menu, by its name), and
// its note — the same dish with another note is another line.
export function lineKey(l) {
  return (l.custom ? 'c:' + String(l.custom.name || l.name).toLowerCase() + ':' + l.price : l.menuItemId + '::' + (l.variationId || '')) + '::' + String(l.note || '').trim().toLowerCase();
}
// What the server needs for a line.
export function lineBody(l) {
  return l.custom
    ? { custom: { name: l.custom.name, price: l.custom.price, category: l.custom.category || '' }, qty: l.qty, note: l.note || undefined }
    : { menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty, note: l.note || undefined };
}
// A line kept on an open order (restaurantPos tabRows), back on the till.
export function lineFromTab(l) {
  return l.custom
    ? { menuItemId: null, variationId: null, name: l.name, price: l.unitPrice, qty: l.qty, note: l.note || '', custom: { name: l.name, price: l.unitPrice, category: l.category || '' } }
    : { menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, price: l.unitPrice, qty: l.qty, note: l.note || '' };
}

// Quick notes a cashier taps instead of typing.
export const QUICK_NOTES = [msg('No pepper'), msg('Less spicy'), msg('Extra spicy'), msg('No onions'), msg('No salt'), msg('Well done'), msg('Sauce on the side'), msg('Takeaway pack')];
