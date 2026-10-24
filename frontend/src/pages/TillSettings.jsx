import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { Icon } from '../components/DashKit';
import { CURRENCY_LABEL, CURRENCY_NAME, FULFILLMENT, FulfillmentIcon, MethodGlyph } from './till/tillShared';
import { ActivityTab, CustomersTab, FloorMapTab } from './till/SettingsTabs';
import SalesReport from './till/SalesReport';
import { AccountsTab, DisputesTab, DrawersTab, KitchenScreensTab } from './till/OfficeTabs';
import { MenuTab, StockTab } from './till/MenuStock';
import { TableQrTab } from './till/TableQr';
import BillSettings from './till/BillSettings';
import ServiceSettings from './till/ServiceSettings';
import GuestSettings from './till/GuestSettings';
import { GiftCardsReport, LoyaltyReport } from './till/GuestReports';
import CampaignsTab from './till/Campaigns';
import Insights from './till/Insights';
import { AppsTab, CardSettings, KioskTab } from './till/GrowthSettings';
import TipsReport from './till/TipsReport';
import FeedbackReport from './till/FeedbackReport';
import FoodCostReport, { RecipesTab } from './till/FoodCost';
import DealsSettings from './till/Deals';
import PurchasingTab from './till/Purchasing';
import CloseDayTab from './till/CloseDay';
import RotaTab from './till/Rota';
import './TillSettings.css';
// The monthly report brings the OS's report and its styles: loaded when opened.
const MonthlyReport = lazy(() => import('./till/MonthlyReport'));

// The till's settings, opened by a manager (backend:
// restaurantTillAccess.service.js): each person's role, what each role may
// do, the ways of paying the till offers and the dollar and yuan rates, the
// receipt's own lines, signing out after a while unused, a waiter for every
// table, the kitchen screen's amber and red and its printed tickets, the
// floor map, the tables' QR codes (till/TableQr.jsx), the customers' IOU
// accounts, the kitchen screens; the reports
// — sales (till/SalesReport.jsx), drawers, disputes, IOUs and VIP money
// (till/OfficeTabs.jsx), activity (till/SettingsTabs.jsx); the menu and the
// stock (till/MenuStock.jsx). The server checks every rule; this only sets them.

const ROLE_LABEL = {
  manager: () => tr('Manager'), cashier: () => tr('Cashier'), waiter: () => tr('Waiter'), kitchen: () => tr('Kitchen'), none: () => tr('No access')
};
const ROLE_HINT = {
  manager: () => tr('Everything, and these settings. Opens their own drawer beside the cashier on duty\'s when needed.'),
  cashier: () => tr('Sells and runs a cash drawer.'),
  waiter: () => tr('Sends orders to the kitchen for the cashier to charge.'),
  kitchen: () => tr('The kitchen screen only.'),
  none: () => tr('Cannot sign in to the till or the kitchen screen.')
};
const PERMISSION = {
  till: [() => tr('Use the till'), () => tr('Sign in to the till at all.')],
  charge: [() => tr('Take payments'), () => tr('Charge sales and open tables, with their own cash drawer.')],
  keepOpen: [() => tr('Send orders to the kitchen'), () => tr('Send an order to the kitchen and keep it open to pay later.')],
  customItem: [() => tr('Add dishes not on the menu'), () => tr('Ring up something the menu does not have, at a price they type.')],
  removeTable: [() => tr('Remove open tables'), () => tr('Delete an open table nobody has paid for.')],
  refund: [() => tr('Refund sales'), () => tr('Start a refund; a manager still approves it.')],
  approveRefunds: [() => tr('Approve refunds'), () => tr('Type their PIN to approve a refund.')],
  vipTopUp: [() => tr('Take VIP money'), () => tr('Put money down on a VIP customer\'s balance.')],
  iou: [() => tr('Sell on IOU'), () => tr('Let a customer with an IOU account owe a sale.')],
  iouPaid: [() => tr('Take IOU payments'), () => tr('Mark what a customer owed as paid.')],
  favorites: [() => tr('Change favourites'), () => tr('Star and unstar dishes for everyone.')],
  stock: [() => tr('Count the stock'), () => tr('Count stock and enter what came in.')],
  delivery: [() => tr('Send deliveries'), () => tr('Use the delivery screen: take website orders, give them to riders and follow them on the map.')],
  kds: [() => tr('Use the kitchen screen'), () => tr('Sign in to the kitchen screen.')],
  discount: [() => tr('Give discounts'), () => tr('Take money off a dish or a bill, or the service charge off; without it, a manager types their PIN.')],
  comp: [() => tr('Put dishes on the house'), () => tr('Make a dish free, saying why; without it, a manager types their PIN.')],
  bookings: [() => tr('Take bookings'), () => tr('Book tables, answer the website\'s booking requests and run the waitlist.')],
  giftCards: [() => tr('Sell gift cards'), () => tr('Sell gift cards into their drawer and cancel one (with a manager\'s PIN).')]
};
const TILL_PERMS = ['charge', 'keepOpen', 'customItem', 'removeTable', 'refund', 'approveRefunds', 'vipTopUp', 'iou', 'iouPaid', 'favorites', 'stock', 'delivery', 'discount', 'comp', 'bookings', 'giftCards'];
const METHOD = {
  cash: [() => tr('Cash'), () => tr('Into the cashier\'s drawer, in cedis or US dollars.')],
  mobile_money: [() => tr('Mobile Money'), () => tr('Sent to the restaurant\'s number, in cedis only.')],
  alipay: [() => tr('Alipay'), () => tr('Scanned with the customer\'s Alipay, in RMB only.')],
  wechat: [() => tr('WeChat Pay'), () => tr('Scanned with the customer\'s WeChat, in RMB only.')],
  vip: [() => tr('VIP'), () => tr('From money a VIP customer put down.')],
  iou: [() => tr('IOU'), () => tr('A customer with an IOU account pays later.')],
  card: [() => tr('Card'), () => tr('On the bank\'s card terminal; the card\'s brand and last 4 digits are noted.')]
};
// What each foreign currency is taken for (tillShared METHOD_CURRENCIES).
const FX_FOR = { USD: () => tr('For cash'), CNY: () => tr('For Alipay and WeChat Pay') };
// The tabs, in three groups: what happened, what is sold, how the till works.
const GROUPS = [
  ['reports', () => tr('Reports'), [['sales', () => tr('Sales'), 'up'], ['closeday', () => tr('Close the day'), 'check'], ['insights', () => tr('Insights'), 'pulse'], ['tips', () => tr('Tips'), 'cash'], ['foodcost', () => tr('Food cost'), 'percent'], ['monthly', () => tr('Monthly report'), 'calendar'], ['drawers', () => tr('Drawers'), 'drawer'], ['disputes', () => tr('Disputes'), 'warn'], ['accounts', () => tr('IOUs and VIP'), 'owed'], ['activity', () => tr('Activity'), 'pulse']]],
  ['guestsGroup', () => tr('Guests'), [['feedback', () => tr('Feedback'), 'star'], ['campaigns', () => tr('Texts and emails'), 'send'], ['loyalty', () => tr('Loyalty'), 'star'], ['giftcards', () => tr('Gift cards'), 'card']]],
  ['menu', () => tr('Menu and stock'), [['menu', () => tr('Menu'), 'receipt'], ['recipes', () => tr('Recipes and costs'), 'percent'], ['stock', () => tr('Stock'), 'layers'], ['purchasing', () => tr('Low stock and orders'), 'send']]],
  ['setup', () => tr('Setup'), [['people', () => tr('People'), 'people'], ['rota', () => tr('Rota'), 'calendar'], ['roles', () => tr('What each role can do'), 'key'], ['payments', () => tr('Payments'), 'cash'], ['map', () => tr('Floor map'), 'map'], ['qr', () => tr('Table QR codes'), 'phone'],
    ['screens', () => tr('Kitchen screens'), 'layers'], ['customers', () => tr('Customers'), 'owed'], ['bill', () => tr('Discounts, service and tax'), 'percent'], ['deals', () => tr('Deals and promo codes'), 'spark'], ['service', () => tr('Courses, menu times and happy hours'), 'clock'], ['guests', () => tr('Bookings, tips and rewards'), 'spark'],
    ['apps', () => tr('Delivery apps'), 'send'], ['kiosk', () => tr('Self-order kiosk'), 'receipt'], ['receipts', () => tr('Receipts'), 'receipt'], ['till', () => tr('Till and kitchen'), 'clock']]]
];
const GROUP_OF = {};
GROUPS.forEach(([g, , tabs]) => tabs.forEach(([k]) => { GROUP_OF[k] = g; }));
// The floor map as the settings edit it: each table keyed (new ones too).
function tablesDraftOf(tables) { return (tables || []).map((t) => ({ ...t, key: t.id })); }

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export default function TillSettings({ token, companyName, logoUrl, onClose, onSaved, onAuth, initialTab }) {
  const [step, setStep] = useState('opening'); // opening | pin | edit
  const [pin, setPin] = useState('');
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [roles, setRoles] = useState({}); // employee id -> role or null, changed here
  const [tables, setTables] = useState([]); // the floor map, as edited
  const [customers, setCustomers] = useState({}); // customer id -> { iouAllowed, iouLimit }, changed here
  const [tab, setTab] = useState(initialTab && GROUP_OF[initialTab] ? initialTab : 'sales');
  const [actDrawer, setActDrawer] = useState(null); // the activity report on one cash drawer (from Drawers)
  const group = GROUP_OF[tab];
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  const fail = useCallback((err) => { if (err.status === 401) onAuth(); else setError(err.message); }, [onAuth]);
  function take(d) { setData(d); setDraft(clone(d.settings)); setRoles({}); setTables(tablesDraftOf(d.tables)); setCustomers({}); setStep('edit'); }
  async function open(managerPin) {
    setBusy(true); setError(null);
    try { take(await posFetch('POST', '/pos/settings/open', token, managerPin ? { managerPin } : {})); }
    catch (err) {
      if (err.status === 403 && !managerPin) setStep('pin');
      else { setPin(''); fail(err); if (step === 'opening') setStep('pin'); }
    } finally { setBusy(false); }
  }
  useEffect(() => { open(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The tables added, changed or taken away on the floor map.
  const tableChanges = useMemo(() => {
    if (!data) return [];
    const was = new Map(data.tables.map((t) => [t.id, t]));
    return tables.filter((t) => {
      if (!t.id) return !t.remove;
      if (t.remove) return true;
      const o = was.get(t.id);
      return !o || ['name', 'mapX', 'mapY', 'shape', 'seats', 'area'].some((k) => o[k] !== t[k]);
    }).map((t) => ({ id: t.id, name: t.name.trim(), mapX: t.mapX, mapY: t.mapY, shape: t.shape, seats: t.seats, area: (t.area || '').trim(), remove: t.remove || undefined }));
  }, [data, tables]);
  const dirty = useMemo(() => !!data && (Object.keys(roles).length > 0 || tableChanges.length > 0 || Object.keys(customers).length > 0 || JSON.stringify(draft) !== JSON.stringify(data.settings)),
    [data, draft, roles, tableChanges, customers]);
  const setCustomer = useCallback((id, v) => { setCustomers((c) => ({ ...c, [id]: v })); setFlash(null); }, []);
  function setRate(c, field, value) {
    const cur = draft.currencies[c];
    set(['currencies', c], { ...cur, [field]: value, ...(field === 'rate' && !(Number(value) > 0) ? { on: false } : {}) });
  }
  function set(path, value) {
    const next = clone(draft);
    let o = next;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = value;
    setDraft(next); setFlash(null);
  }
  function setPerm(role, perm, on) {
    const next = clone(draft);
    const r = next.roles[role];
    r[perm] = on;
    if (perm === 'till' && !on) TILL_PERMS.forEach((k) => { r[k] = false; });
    if (perm !== 'till' && perm !== 'kds' && on) r.till = true;
    if (perm === 'iou' && on) r.charge = true;
    if (perm === 'charge' && !on) r.iou = false;
    setDraft(next); setFlash(null);
  }
  function roleOf(p) { return Object.prototype.hasOwnProperty.call(roles, p.id) ? roles[p.id] : p.role; }
  function setRole(p, role) {
    const next = { ...roles };
    if (role === p.role) delete next[p.id]; else next[p.id] = role;
    setRoles(next); setFlash(null);
  }

  async function save() {
    setBusy(true); setError(null);
    try {
      const d = await posFetch('PUT', '/pos/settings', token, {
        managerPin: pin || undefined, settings: draft,
        staff: Object.keys(roles).map((id) => ({ employeeId: id, role: roles[id] })),
        tables: tableChanges,
        customers: Object.keys(customers).map((id) => ({ id, iouAllowed: customers[id].iouAllowed, iouLimit: customers[id].iouLimit }))
      });
      take(d); setFlash(tr('Saved. The till follows the new settings straight away.')); onSaved();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  function close() {
    if (dirty && !window.confirm(tr('Close without saving your changes?'))) return;
    onClose();
  }

  const staff = data ? data.staff.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.position.toLowerCase().includes(q.trim().toLowerCase())) : [];
  const counts = useMemo(() => {
    const c = { manager: 0, cashier: 0, waiter: 0, kitchen: 0, none: 0 };
    if (data && draft) data.staff.forEach((p) => { const r = roleOf(p) || draft.defaultRole; c[r] = (c[r] || 0) + 1; });
    return c;
  }, [data, draft, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="dialog-backdrop" onClick={() => !busy && close()}>
      <div className="dialog pos-panel ts" onClick={(e) => e.stopPropagation()}>
        {step !== 'edit' ? (
          <form className="ts-lock" onSubmit={(e) => { e.preventDefault(); if (pin.length === 4) open(pin); }}>
            <span className="ts-lock-ico" aria-hidden="true"><Icon name="key" /></span>
            <h2>{tr('Till settings')}</h2>
            <p className="dk-muted">{step === 'opening' ? tr('Opening…') : tr('A manager opens the settings: who can do what on the till, payments, receipts and more. Type a manager\'s PIN.')}</p>
            {step === 'pin' && (
              <input className="input ts-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={4} autoFocus value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" aria-label={tr('Manager PIN')} />
            )}
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              {step === 'pin' && <button type="submit" className="btn btn-primary" disabled={busy || pin.length !== 4}>{busy ? tr('Checking…') : tr('Open settings')}</button>}
            </div>
          </form>
        ) : (
          <>
            <header className="ts-head">
              <span className="ts-head-ico" aria-hidden="true"><Icon name="key" /></span>
              <div>
                <h2>{tr('Till settings')}</h2>
                <p className="dk-muted">{tr('{place} · opened by {name}', { place: companyName, name: data.managerName })}</p>
              </div>
            </header>
            <div className="ts-groups" role="radiogroup" aria-label={tr('Show')}>
              {GROUPS.map(([g, label, tabs]) => (
                <button key={g} type="button" role="radio" aria-checked={group === g} className={'is-' + g + (group === g ? ' is-on' : '')} onClick={() => setTab(tabs[0][0])}>{label()}</button>
              ))}
            </div>
            <nav className="ts-tabs" role="tablist" aria-label={tr('Till settings')}>
              {GROUPS.find(([g]) => g === group)[2].map(([k, label, icon]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}><Icon name={icon} />{label()}</button>
              ))}
            </nav>

            {tab === 'people' && (
              <section className="ts-sec">
                <div className="ts-roles-sum">
                  {data.choices.roles.map((r) => <span key={r} className={'ts-role-chip is-' + r}><b>{counts[r] || 0}</b>{ROLE_LABEL[r]()}</span>)}
                </div>
                <label className="ts-default">
                  <span><strong>{tr('Everyone not given a role')}</strong><small>{tr('Staff of this restaurant you have not set below have this role.')}</small></span>
                  <select className="input" value={draft.defaultRole} onChange={(e) => set(['defaultRole'], e.target.value)}>
                    {['cashier', 'waiter', 'kitchen', 'none'].map((r) => <option key={r} value={r}>{ROLE_LABEL[r]()}</option>)}
                  </select>
                </label>
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find someone…')} aria-label={tr('Find someone…')} />
                <ul className="ts-people">
                  {staff.map((p) => {
                    const r = roleOf(p);
                    const shown = r || draft.defaultRole;
                    return (
                      <li key={p.id} className={Object.prototype.hasOwnProperty.call(roles, p.id) ? 'is-changed' : ''}>
                        <span className={'ts-avatar is-' + shown} aria-hidden="true">{p.name.replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                        <span className="ts-person">
                          <strong>{p.name}</strong>
                          <small>{[p.position, !p.hasPin ? tr('No PIN yet: cannot sign in') : null, !r ? tr('Default: {role}', { role: ROLE_LABEL[draft.defaultRole]() }) : null].filter(Boolean).join(' · ')}</small>
                        </span>
                        <select className={'input ts-role-select is-' + shown} value={r || ''} onChange={(e) => setRole(p, e.target.value || null)} aria-label={tr('Role for {name}', { name: p.name })}>
                          <option value="">{tr('Default ({role})', { role: ROLE_LABEL[draft.defaultRole]() })}</option>
                          {data.choices.roles.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]()}</option>)}
                        </select>
                      </li>
                    );
                  })}
                  {!staff.length && <li className="dk-empty"><Icon name="info" /><p>{tr('Nobody matches "{search}".', { search: q })}</p></li>}
                </ul>
                <p className="ts-note"><Icon name="info" />{tr('Anyone whose OS account can manage restaurants can always open these settings with their PIN.')}</p>
              </section>
            )}

            {tab === 'roles' && (
              <section className="ts-sec">
                <div className="ts-matrix-wrap">
                  <table className="ts-matrix">
                    <thead>
                      <tr>
                        <th scope="col"><span className="dk-muted">{tr('Can…')}</span></th>
                        {['manager', 'cashier', 'waiter', 'kitchen'].map((r) => <th key={r} scope="col"><span className={'ts-role-chip is-' + r}>{ROLE_LABEL[r]()}</span></th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {/* A right the server has and this screen has no words for is left out, rather than breaking the page. */}
                      {data.choices.permissions.filter((perm) => PERMISSION[perm]).map((perm) => (
                        <tr key={perm}>
                          <th scope="row"><strong>{PERMISSION[perm][0]()}</strong><small>{PERMISSION[perm][1]()}</small></th>
                          <td data-role={ROLE_LABEL.manager()} className="is-manager"><span className="ts-tick is-on is-locked" title={tr('Managers can do everything.')}>✓</span></td>
                          {['cashier', 'waiter', 'kitchen'].map((r) => (
                            <td key={r} data-role={ROLE_LABEL[r]()} className={'is-' + r}>
                              <button type="button" role="switch" aria-checked={!!draft.roles[r][perm]} aria-label={PERMISSION[perm][0]() + ' · ' + ROLE_LABEL[r]()}
                                className={'ts-tick' + (draft.roles[r][perm] ? ' is-on' : '')} onClick={() => setPerm(r, perm, !draft.roles[r][perm])}>{draft.roles[r][perm] ? '✓' : ''}</button>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="ts-role-hints">
                  {['manager', 'cashier', 'waiter', 'kitchen', 'none'].map((r) => <li key={r}><span className={'ts-role-chip is-' + r}>{ROLE_LABEL[r]()}</span>{ROLE_HINT[r]()}</li>)}
                </ul>
              </section>
            )}

            {tab === 'payments' && (
              <section className="ts-sec">
                <p className="dk-muted">{tr('The ways of paying the till offers. Past sales keep how they were paid.')}</p>
                <div className="ts-methods">
                  {data.choices.paymentMethods.map((m) => {
                    const on = draft.paymentMethods.includes(m);
                    const last = on && draft.paymentMethods.length === 1;
                    return (
                      <button key={m} type="button" role="switch" aria-checked={on} disabled={last} data-m={m} className={'ts-method' + (on ? ' is-on' : '')}
                        onClick={() => set(['paymentMethods'], on ? draft.paymentMethods.filter((x) => x !== m) : data.choices.paymentMethods.filter((x) => x === m || draft.paymentMethods.includes(x)))}>
                        <span className="ts-method-ico"><MethodGlyph method={m} /></span>
                        <span className="ts-method-text"><strong>{METHOD[m][0]()}</strong><small>{last ? tr('Keep at least one way of paying.') : METHOD[m][1]()}</small></span>
                        <span className={'ts-switch' + (on ? ' is-on' : '')} aria-hidden="true"><i /></span>
                      </button>
                    );
                  })}
                </div>
                <div className="ts-fx">
                  <div className="ts-fx-head">
                    <strong>{tr('Foreign money at the till')}</strong>
                    <small className="dk-muted">{tr('Cash can be paid in US dollars; Alipay and WeChat Pay are charged in Chinese yuan (RMB); Mobile Money is in cedis only. Set how many cedis one is worth; the till works out the price and gives change in cedis.')}</small>
                  </div>
                  {data.choices.currencies.map((c) => {
                    const cur = draft.currencies[c];
                    const rate = Number(cur.rate);
                    return (
                      <div key={c} className={'ts-fx-row' + (cur.on ? ' is-on' : '')}>
                        <span className={'ts-fx-flag is-' + c.toLowerCase()} aria-hidden="true">{c === 'CNY' ? '¥' : '$'}</span>
                        <span className="ts-fx-name"><strong>{CURRENCY_LABEL[c]}</strong><small>{tr(CURRENCY_NAME[c])} · {FX_FOR[c] ? FX_FOR[c]() : ''}</small></span>
                        <label className="ts-fx-rate">
                          <span>{tr('1 {currency} =', { currency: CURRENCY_LABEL[c] })}</span>
                          <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={cur.rate || ''} placeholder="0.00"
                            onChange={(e) => setRate(c, 'rate', e.target.value === '' ? 0 : Number(e.target.value))} aria-label={tr('Cedis for one {currency}', { currency: CURRENCY_LABEL[c] })} />
                          <span>GHS</span>
                        </label>
                        <button type="button" role="switch" aria-checked={cur.on} disabled={!(rate > 0)} className="ts-fx-switch" onClick={() => setRate(c, 'on', !cur.on)}
                          title={rate > 0 ? '' : tr('Set the rate first.')} aria-label={tr('Take {currency} at the till', { currency: CURRENCY_LABEL[c] })}>
                          <span className={'ts-switch' + (cur.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
                        </button>
                        {rate > 0 && <small className="ts-fx-eg">{tr('e.g. a {amount} bill is {foreign}', { amount: money(100), foreign: CURRENCY_LABEL[c] + ' ' + (100 / rate).toFixed(2) })}</small>}
                      </div>
                    );
                  })}
                  <small className="dk-muted ts-fx-set">
                    {draft.ratesSetAt ? tr('Rates last set {date} by {name}.', { date: new Date(draft.ratesSetAt).toLocaleString(activeIntlLocale(), { dateStyle: 'medium', timeStyle: 'short' }), name: draft.ratesSetBy || '—' }) : tr('No rates set yet. Check them every day: the till uses them for every sale.')}
                  </small>
                </div>
                <CardSettings token={token} pin={pin} draft={draft} set={set} paystackReady={!!data.choices.paystack} onFail={fail} />
              </section>
            )}

            {tab === 'qr' && <TableQrTab token={token} pin={pin} draft={draft} set={set} onFail={fail} />}
            {tab === 'map' && <FloorMapTab tables={tables} setTables={(t) => { setTables(t); setFlash(null); }} />}
            {tab === 'customers' && <CustomersTab token={token} pin={pin} changes={customers} setChange={setCustomer} onFail={fail} />}
            {tab === 'sales' && <SalesReport token={token} pin={pin} onFail={fail} />}
            {tab === 'monthly' && <Suspense fallback={<p className="dk-muted">{tr('Loading…')}</p>}><MonthlyReport token={token} pin={pin} companyName={companyName} /></Suspense>}
            {tab === 'drawers' && <DrawersTab token={token} pin={pin} onFail={fail} onActivity={(d) => { setActDrawer(d); setTab('activity'); }} />}
            {tab === 'disputes' && <DisputesTab token={token} pin={pin} onFail={fail} />}
            {tab === 'accounts' && <AccountsTab token={token} pin={pin} onFail={fail} />}
            {tab === 'loyalty' && <LoyaltyReport token={token} pin={pin} onFail={fail} />}
            {tab === 'giftcards' && <GiftCardsReport token={token} pin={pin} onFail={fail} />}
            {tab === 'insights' && <Insights token={token} pin={pin} onFail={fail} />}
            {tab === 'tips' && <TipsReport token={token} pin={pin} onFail={fail} />}
            {tab === 'foodcost' && <FoodCostReport token={token} pin={pin} onFail={fail} />}
            {tab === 'feedback' && <FeedbackReport token={token} pin={pin} onFail={fail} />}
            {tab === 'recipes' && <RecipesTab token={token} pin={pin} onFail={fail} />}
            {tab === 'campaigns' && <CampaignsTab token={token} pin={pin} draft={draft} set={set} companyName={companyName} onFail={fail} />}
            {tab === 'apps' && <AppsTab token={token} pin={pin} draft={draft} set={set} onFail={fail} />}
            {tab === 'kiosk' && <KioskTab draft={draft} set={set} paystackReady={!!data.choices.paystack} />}
            {tab === 'menu' && <MenuTab token={token} pin={pin} onFail={fail} />}
            {tab === 'stock' && <StockTab token={token} pin={pin} onFail={fail} />}
            {tab === 'screens' && <KitchenScreensTab token={token} pin={pin} onFail={fail} />}
            {tab === 'activity' && <ActivityTab token={token} pin={pin} onFail={fail} drawer={actDrawer} onClearDrawer={() => setActDrawer(null)} />}

            {tab === 'bill' && <BillSettings draft={draft} set={set} />}
            {tab === 'deals' && <DealsSettings draft={draft} set={set} categories={data.categories} token={token} />}
            {tab === 'purchasing' && <PurchasingTab token={token} pin={pin} onFail={fail} />}
            {tab === 'rota' && <RotaTab token={token} pin={pin} onFail={fail} />}
            {tab === 'closeday' && <CloseDayTab token={token} pin={pin} draft={draft} set={set} onFail={fail} />}
            {tab === 'service' && <ServiceSettings draft={draft} set={set} categories={data.categories} />}
            {tab === 'guests' && <GuestSettings draft={draft} set={set} companyName={companyName} />}

            {tab === 'receipts' && (
              <section className="ts-sec ts-receipt-sec">
                <div className="ts-receipt-form">
                  <div className="field">
                    <label htmlFor="ts-extra">{tr('Line under the restaurant\'s name')}</label>
                    <input id="ts-extra" className="input" maxLength={200} value={draft.receipt.extra} onChange={(e) => set(['receipt', 'extra'], e.target.value)} placeholder={tr('e.g. address, phone, Mobile Money number')} />
                  </div>
                  <div className="field">
                    <label htmlFor="ts-footer">{tr('Message at the bottom')}</label>
                    <input id="ts-footer" className="input" maxLength={120} value={draft.receipt.footer} onChange={(e) => set(['receipt', 'footer'], e.target.value)} placeholder={tr('e.g. Thank you!')} />
                  </div>
                  <button type="button" role="switch" aria-checked={draft.receipt.showLogo} className="ts-toggle-row" onClick={() => set(['receipt', 'showLogo'], !draft.receipt.showLogo)}>
                    <span><strong>{tr('Show the logo')}</strong><small>{tr('At the top of printed receipts.')}</small></span>
                    <span className={'ts-switch' + (draft.receipt.showLogo ? ' is-on' : '')} aria-hidden="true"><i /></span>
                  </button>
                </div>
                <div className="ts-receipt-preview" aria-label={tr('Preview')}>
                  {draft.receipt.showLogo && logoUrl && <img src={logoUrl} alt="" />}
                  <strong>{companyName}</strong>
                  {draft.receipt.extra && <small>{draft.receipt.extra}</small>}
                  <span className="ts-rule" />
                  <span className="ts-line"><span>2 × {tr('Dish')}</span><span>{money(90)}</span></span>
                  <span className="ts-line"><span>1 × {tr('Drink')}</span><span>{money(15)}</span></span>
                  <span className="ts-rule" />
                  <span className="ts-line is-total"><span>{tr('Total')}</span><span>{money(105)}</span></span>
                  {draft.receipt.footer && <em>{draft.receipt.footer}</em>}
                </div>
              </section>
            )}

            {tab === 'till' && (
              <section className="ts-sec">
                <div className="field">
                  <label htmlFor="ts-idle">{tr('Sign out when the till is not used for')}</label>
                  <div className="ts-chips" id="ts-idle" role="radiogroup">
                    {data.choices.idleMinutes.map((m) => (
                      <button key={m} type="button" role="radio" aria-checked={draft.idleMinutes === m} className={draft.idleMinutes === m ? 'is-on' : ''} onClick={() => set(['idleMinutes'], m)}>
                        {m === 0 ? tr('Never') : tr('{n} min', { n: m })}
                      </button>
                    ))}
                  </div>
                  <small className="dk-muted">{tr('So nobody sells under someone else\'s name on a till left signed in.')}</small>
                </div>
                <div className="field">
                  <span className="ts-label">{tr('A new order starts as')}</span>
                  <div className="ts-chips" role="radiogroup" aria-label={tr('A new order starts as')}>
                    {FULFILLMENT.filter((f) => f.key !== 'delivery').map((f) => (
                      <button key={f.key} type="button" role="radio" aria-checked={draft.defaultFulfillment === f.key} className={draft.defaultFulfillment === f.key ? 'is-on' : ''} onClick={() => set(['defaultFulfillment'], f.key)}>
                        <FulfillmentIcon kind={f.key} /> {tr(f.label)}
                      </button>
                    ))}
                  </div>
                  <small className="dk-muted">{tr('The cashier can switch any order to dine in, pickup or delivery.')}</small>
                </div>
                <button type="button" role="switch" aria-checked={draft.requireWaiter} className="ts-toggle-row" onClick={() => set(['requireWaiter'], !draft.requireWaiter)}>
                  <span><strong>{tr('Every table needs its waiter')}</strong><small>{tr('An order at a table cannot be sent to the kitchen or charged without picking the waiter.')}</small></span>
                  <span className={'ts-switch' + (draft.requireWaiter ? ' is-on' : '')} aria-hidden="true"><i /></span>
                </button>
                <div className="ts-kitchen">
                  <strong>{tr('Kitchen screen')}</strong>
                  <small className="dk-muted">{tr('How long a ticket cooks before it turns amber, then red.')}</small>
                  <div className="ts-kitchen-row">
                    <label className="ts-time is-warn">
                      <span>{tr('Amber after')}</span>
                      <input className="input" type="number" min="1" max="120" value={draft.kitchen.warnAfter} onChange={(e) => set(['kitchen', 'warnAfter'], Number(e.target.value))} />
                      <small>{tr('min')}</small>
                    </label>
                    <label className="ts-time is-late">
                      <span>{tr('Red after')}</span>
                      <input className="input" type="number" min="2" max="240" value={draft.kitchen.lateAfter} onChange={(e) => set(['kitchen', 'lateAfter'], Number(e.target.value))} />
                      <small>{tr('min')}</small>
                    </label>
                  </div>
                  <button type="button" role="switch" aria-checked={draft.kitchen.printReady} className="ts-toggle-row" onClick={() => set(['kitchen', 'printReady'], !draft.kitchen.printReady)}>
                    <span className="ts-print-text"><Icon name="receipt" /><span><strong>{tr('Print a ticket when food is done')}</strong><small>{tr('Done on the kitchen screen prints a ticket saying who the food is for and where it goes: the table, pickup at the counter, or the delivery address. Off: the kitchen can still print one by hand.')}</small></span></span>
                    <span className={'ts-switch' + (draft.kitchen.printReady ? ' is-on' : '')} aria-hidden="true"><i /></span>
                  </button>
                </div>
              </section>
            )}

            {flash && <div className="ts-flash" role="status"><Icon name="check" />{flash}</div>}
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions ts-actions">
              {dirty && <span className="ts-dirty">{tr('Unsaved changes')}</span>}
              <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>{tr('Close')}</button>
              {/* Reports, the menu, the stock and the kitchen screens save as they go. */}
              {(dirty || (group === 'setup' && tab !== 'screens') || tab === 'campaigns') && <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? tr('Saving…') : tr('Save changes')}</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
