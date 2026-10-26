import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { QuoteRequestsDialog, RestockDialog, ReviewsDialog } from './ShopAsks';
import './ShopOrdersPage.css';

// Online shop (Quotations & Invoicing → Online shop; backend
// shop.service.js): the orders from the shop at /shop, newest first, each
// with its invoice and whether it is paid; marked ready (the customer is
// texted when texts are set up), done, or cancelled. The shop's own
// settings: open or closed, its words, which categories are on it, delivery
// and pickup, its discount codes, the reminder to checkouts not paid, and
// reviews; the days each item takes to make (made to order), which the
// customer sees before ordering; and what customers ask besides orders
// (ShopAsks.jsx): reviews to show or hide, and requests for a quote.

const STATUS = {
  unpaid: ['💳', () => tr('Not paid yet')], new: ['🆕', () => tr('New')], making: ['🛠️', () => tr('Being made')], ready: ['📦', () => tr('Ready')], out: ['🚚', () => tr('On its way')], done: ['✅', () => tr('Done')], cancelled: ['✕', () => tr('Cancelled')]
};
const FILTERS = [['', () => tr('All')], ['new', () => tr('New')], ['making', () => tr('Being made')], ['ready', () => tr('Ready')], ['out', () => tr('On its way')], ['done', () => tr('Done')], ['unpaid', () => tr('Not paid yet')], ['cancelled', () => tr('Cancelled')]];
function dayWords(day) { return new Date(day + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }); }
const NEW_CODE = { code: '', kind: 'percent', value: 10, minTotal: 0, endsOn: null, maxUses: 0, on: true };
const REMIND_HOURS = [0, 1, 3, 6, 12, 24];

// The discount codes: what each takes off, from what order, until when, how
// many times; and how often each was used.
function CodesEditor({ codes, uses, onChange }) {
  const set = (i, patch) => onChange(codes.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <fieldset className="sho-fs">
      <legend>🏷️ {tr('Discount codes')}</legend>
      <p className="muted">{tr('Customers type one at checkout; it comes off their invoice.')}</p>
      {codes.map((c, i) => {
        const u = uses[c.code];
        return (
          <div key={i} className={'sho-code' + (c.on ? '' : ' is-off')}>
            <input className="input sho-code-name" maxLength={24} value={c.code} onChange={(e) => set(i, { code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} placeholder="BAMBOO10" aria-label={tr('Code')} />
            <span className="sho-code-val">
              <input className="input" type="number" min="1" max={c.kind === 'percent' ? 90 : 1000000} step="any" value={c.value} onChange={(e) => set(i, { value: e.target.value })} aria-label={tr('How much off')} />
              <select className="input" value={c.kind} onChange={(e) => set(i, { kind: e.target.value })} aria-label={tr('Percentage or amount')}>
                <option value="percent">%</option><option value="amount">GHS</option>
              </select>
            </span>
            <label className="sho-code-f">{tr('From an order of')}<input className="input" type="number" min="0" step="any" value={c.minTotal || 0} onChange={(e) => set(i, { minTotal: e.target.value })} /></label>
            <label className="sho-code-f">{tr('Last day')}<input className="input" type="date" value={c.endsOn || ''} onChange={(e) => set(i, { endsOn: e.target.value || null })} /></label>
            <label className="sho-code-f">{tr('Times (0: no limit)')}<input className="input" type="number" min="0" value={c.maxUses || 0} onChange={(e) => set(i, { maxUses: e.target.value })} /></label>
            <label className="sho-code-on"><input type="checkbox" checked={c.on} onChange={(e) => set(i, { on: e.target.checked })} />{c.on ? tr('On') : tr('Off')}</label>
            <small className="sho-code-used">{u ? tr('Used {n}× · {amount} off', { n: u.uses, amount: money(u.off) }) : tr('Not used yet')}</small>
            <button type="button" className="sho-code-x" onClick={() => onChange(codes.filter((_, j) => j !== i))} aria-label={tr('Remove')}>✕</button>
          </div>
        );
      })}
      <button type="button" className="btn btn-secondary sho-code-add" onClick={() => onChange(codes.concat([{ ...NEW_CODE }]))}>＋ {tr('Add a code')}</button>
    </fieldset>
  );
}

// Days to make: each item on the shop, from and to (empty: in stock).
function MakeDaysDialog({ onClose, onSaved }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/shop/settings').then((r) => setItems(r.items.map((i) => ({ ...i, from: i.makeDays ? i.makeDays.from : '', to: i.makeDays ? i.makeDays.to : '', was: i.makeDays })))).catch((e) => setError(e.message)); }, []);
  const set = (id, patch) => setItems(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const changed = (items || []).filter((i) => String(i.was ? i.was.from : '') !== String(i.from) || String(i.was ? i.was.to : '') !== String(i.to));
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.put('/shop/make-days', { items: changed.map((i) => ({ itemId: i.id, from: i.from, to: i.to })) }); onSaved(changed.length); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const shown = (items || []).filter((i) => !q.trim() || (i.name + ' ' + i.category).toLowerCase().includes(q.trim().toLowerCase()));
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog sho-dlg" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="sho-mk-title">
        <h2 id="sho-mk-title">🛠️ {tr('Days to make')}</h2>
        <p className="muted">{tr('For items made to order: how many days they take, e.g. 3 to 7. Customers see it on the item and at checkout, with the days their order will be ready between. Leave empty for items in stock.')}</p>
        {!items ? <p className="muted">{error || tr('Loading…')}</p> : (
          <>
            <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find an item')} aria-label={tr('Find an item')} />
            <div className="sho-mk-list">
              {shown.map((i) => (
                <div key={i.id} className={'sho-mk' + (i.to !== '' && Number(i.to) > 0 ? ' is-made' : '')}>
                  <span className="sho-mk-name"><strong>{i.name}</strong><small>{i.category}</small></span>
                  <span className="sho-mk-days">
                    <input className="input" type="number" min="0" max="180" value={i.from} onChange={(e) => set(i.id, { from: e.target.value })} aria-label={tr('From (days)')} placeholder="–" />
                    <span aria-hidden="true">→</span>
                    <input className="input" type="number" min="0" max="180" value={i.to} onChange={(e) => set(i.id, { to: e.target.value })} aria-label={tr('To (days)')} placeholder="–" />
                    <small>{tr('days')}</small>
                  </span>
                </div>
              ))}
              {!shown.length && <p className="muted">{tr('No items on the shop match.')}</p>}
            </div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !changed.length}>{busy ? tr('Saving…') : changed.length ? tr('Save {n} changes', { n: changed.length }) : tr('Save')}</button>
            </div>
          </>
        )}
      </form>
    </div>, document.body
  );
}

function when(d) { return new Date(d).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

function SettingsDialog({ onClose, onSaved }) {
  const [d, setD] = useState(null);
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/shop/settings').then((r) => { setD(r); setS(r.settings); }).catch((e) => setError(e.message)); }, []);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await api.put('/shop/settings', s); onSaved(r.settings); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const toggleCat = (id) => setS({ ...s, categories: s.categories.includes(id) ? s.categories.filter((x) => x !== id) : s.categories.concat([id]) });
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog sho-dlg" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="sho-set-title">
        <h2 id="sho-set-title">⚙️ {tr('The online shop')}</h2>
        {!s ? <p className="muted">{error || tr('Loading…')}</p> : (
          <>
            <label className="sho-switch"><input type="checkbox" checked={s.on} onChange={(e) => setS({ ...s, on: e.target.checked })} />
              <span><strong>{s.on ? tr('Open: customers can order') : tr('Closed')}</strong><small>{d.url}</small></span></label>
            <label className="sho-field">{tr('Name of the shop')}<input className="input" maxLength={80} value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} /></label>
            <label className="sho-field">{tr('A few words at the top')}<textarea className="input" rows={2} maxLength={400} value={s.intro} onChange={(e) => setS({ ...s, intro: e.target.value })} placeholder={tr('e.g. Furniture, blinds and décor made from Ghanaian bamboo.')} /></label>
            <fieldset className="sho-fs">
              <legend>{tr('Categories on the shop')}</legend>
              <p className="muted">{s.categories.length ? tr('Only the ones ticked.') : tr('None ticked: every category with active items.')}</p>
              <div className="sho-cats">
                {d.categories.map((c) => (
                  <label key={c.id} className={'sho-cat' + (s.categories.includes(c.id) ? ' is-on' : '')}>
                    <input type="checkbox" checked={s.categories.includes(c.id)} onChange={() => toggleCat(c.id)} />{c.name}<small>{c.items}</small>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="sho-two">
              <label className="sho-check"><input type="checkbox" checked={s.delivery} onChange={(e) => setS({ ...s, delivery: e.target.checked })} />🚚 {tr('Delivery')}</label>
              <label className="sho-check"><input type="checkbox" checked={s.pickup} onChange={(e) => setS({ ...s, pickup: e.target.checked })} />🏬 {tr('Pickup')}</label>
            </div>
            {s.pickup && <label className="sho-field">{tr('Where to pick up')}<input className="input" maxLength={200} value={s.pickupAddress} onChange={(e) => setS({ ...s, pickupAddress: e.target.value })} placeholder={tr('e.g. our showroom')} /></label>}
            {s.delivery && (
              <fieldset className="sho-fs">
                <legend>🚚 {tr('Delivery areas')}</legend>
                <p className="muted">{s.areas && s.areas.length ? tr('Customers choose their area; its fee goes on the invoice.') : tr('None: the delivery fee is agreed on the phone.')}</p>
                {(s.areas || []).map((a, i) => (
                  <div key={i} className="sho-area">
                    <input className="input" maxLength={60} value={a.name} onChange={(e) => setS({ ...s, areas: s.areas.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder={tr('e.g. Accra')} aria-label={tr('Area')} />
                    <label className="sho-area-fee">GHS<input className="input" type="number" min="0" step="1" value={a.fee} onChange={(e) => setS({ ...s, areas: s.areas.map((x, j) => (j === i ? { ...x, fee: Number(e.target.value) } : x)) })} aria-label={tr('Delivery fee (GHS)')} /></label>
                    <button type="button" className="sho-code-x" onClick={() => setS({ ...s, areas: s.areas.filter((_, j) => j !== i) })} aria-label={tr('Remove')}>✕</button>
                  </div>
                ))}
                <button type="button" className="btn btn-secondary sho-code-add" onClick={() => setS({ ...s, areas: (s.areas || []).concat([{ name: '', fee: 0 }]) })}>＋ {tr('Add an area')}</button>
              </fieldset>
            )}
            {s.delivery && <label className="sho-field">{tr('About delivery')}<input className="input" maxLength={300} value={s.deliveryNote} onChange={(e) => setS({ ...s, deliveryNote: e.target.value })} placeholder={tr('e.g. Delivery fee agreed on the phone; 2–5 days.')} /></label>}
            <CodesEditor codes={s.codes || []} uses={d.codeUses || {}} onChange={(codes) => setS({ ...s, codes })} />
            <fieldset className="sho-fs">
              <legend>🔔 {tr('Checkouts not paid')}</legend>
              <p className="muted">{tr('One reminder by email and text, with the link to pay. Not paid in two days: cancelled.')}</p>
              <label className="sho-field">{tr('Remind them')}
                <select className="input" value={s.remindAfter} onChange={(e) => setS({ ...s, remindAfter: Number(e.target.value) })}>
                  {REMIND_HOURS.map((h) => <option key={h} value={h}>{h === 0 ? tr('Never') : h === 1 ? tr('1 hour after checkout') : tr('{n} hours after checkout', { n: h })}</option>)}
                </select></label>
            </fieldset>
            <fieldset className="sho-fs">
              <legend>⭐ {tr('Reviews')}</legend>
              <p className="muted">{tr('Once an order is done, the customer is asked to rate what they bought. Reviews show on the shop with the first name only.')}</p>
              <label className="sho-check"><input type="checkbox" checked={s.reviews.on} onChange={(e) => setS({ ...s, reviews: { ...s.reviews, on: e.target.checked } })} />{tr('Ask customers for reviews')}</label>
              {s.reviews.on && <label className="sho-check"><input type="checkbox" checked={s.reviews.autoShow} onChange={(e) => setS({ ...s, reviews: { ...s.reviews, autoShow: e.target.checked } })} />{tr('Show 4 and 5 stars at once; the rest wait for you')}</label>}
            </fieldset>
            <p className={'sho-pay' + (d.payOnline ? ' is-on' : '')}>{d.payOnline ? '💳 ' + tr('Customers pay their invoice online by card or Mobile Money.') : '🏦 ' + tr('Online payments are not set up (PAYSTACK_BPL_SECRET_KEY on the server): customers pay by the bank details on the invoice.')}</p>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save')}</button>
            </div>
          </>
        )}
      </form>
    </div>, document.body
  );
}

export default function ShopOrdersPage() {
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [filter, setFilter] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [makeOpen, setMakeOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(() => params.get('reviews') === '1');
  // Sold out and who is waiting (ShopAsks.jsx RestockDialog; migration 0194).
  const [restock, setRestock] = useState(null);
  const [restockOpen, setRestockOpen] = useState(() => params.get('restock') === '1');
  useEffect(() => { api.get('/shop-orders/restock').then(setRestock).catch(() => {}); }, []);
  const [quotesOpen, setQuotesOpen] = useState(() => params.get('quotes') === '1');
  const openId = params.get('open');
  const load = useCallback(() => api.get('/shop-orders' + (filter ? '?status=' + filter : '')).then(setData).catch((e) => setError(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data || !openId) return;
    const el = document.getElementById('sho-' + openId);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [data, openId]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

  async function mark(o, status) {
    if (status === 'cancelled' && !window.confirm(tr('Cancel order {no}? Its invoice is voided.', { no: o.orderNo }))) return;
    setBusy(o.id);
    try {
      const r = await api.patch('/shop-orders/' + o.id, { status });
      setToast((status === 'ready' || status === 'out') && r.texted ? tr('{no}: {name} was texted.', { no: o.orderNo, name: o.name }) : r.emailed ? tr('{no}: {name} was emailed.', { no: o.orderNo, name: o.name }) : tr('{no} updated.', { no: o.orderNo }));
      load();
    } catch (e) { setToast(e.message); } finally { setBusy(null); }
  }
  async function remind(o) {
    setBusy(o.id);
    try {
      const r = await api.post('/shop-orders/' + o.id + '/remind');
      setToast(r.emailed && r.texted ? tr('{no}: {name} was emailed and texted a reminder.', { no: o.orderNo, name: o.name }) : r.emailed ? tr('{no}: {name} was emailed a reminder.', { no: o.orderNo, name: o.name }) : tr('{no}: {name} was texted a reminder.', { no: o.orderNo, name: o.name }));
      load();
    } catch (e) { setToast(e.message); } finally { setBusy(null); }
  }

  if (error) return <div className="sho"><div className="error-banner" role="alert">{error}</div></div>;
  if (!data) return <div className="sho"><p className="muted">{tr('Loading…')}</p></div>;
  const t = data.totals;
  return (
    <div className="sho">
      <section className="sho-hero">
        <span className="sho-hero-art" aria-hidden="true">🛍️</span>
        <div className="sho-hero-main">
          <span className={'sho-state' + (data.settings.on ? ' is-on' : '')}><i />{data.settings.on ? tr('The shop is open') : tr('The shop is closed')}</span>
          <h1>{tr('Online shop')}</h1>
          <p>{tr('Orders from the shop on the website, paid before they show here; checkouts not paid wait under "Not paid yet" and are cancelled after two days. Move them along: the customer is told at each step.')}</p>
        </div>
        <div className="sho-hero-acts">
          <a className="btn btn-secondary" href={data.url} target="_blank" rel="noreferrer">↗ {tr('Open the shop')}</a>
          {can('catalog.manage') && <button type="button" className="btn btn-secondary" onClick={() => setMakeOpen(true)}>🛠️ {tr('Days to make')}</button>}
          {can('catalog.manage') && <button type="button" className="btn btn-primary" onClick={() => setSettingsOpen(true)}>⚙️ {tr('Shop settings')}</button>}
        </div>
      </section>

      <div className="sho-stats">
        <div className={'sho-stat' + (t.fresh ? ' is-hot' : '')}><small>{tr('New orders')}</small><strong>{t.fresh}</strong><span>{tr('to call and prepare')}</span></div>
        <div className="sho-stat"><small>{tr('Being made')}</small><strong>{t.making || 0}</strong><span>{tr('in the workshop')}</span></div>
        <div className="sho-stat"><small>{tr('Ready')}</small><strong>{t.ready}</strong><span>{t.out ? tr('{n} on its way', { n: t.out }) : tr('waiting to go out')}</span></div>
        <div className="sho-stat"><small>{tr('This month')}</small><strong>{money(t.month)}</strong><span>{t.monthCount === 1 ? tr('1 order') : tr('{n} orders', { n: t.monthCount })}</span></div>
        <div className="sho-stat"><small>{tr('Paid this month')}</small><strong>{t.monthPaid}</strong><span>{data.payOnline ? tr('card and Mobile Money online') : tr('online payments off')}</span></div>
      </div>

      <div className="sho-asks">
        <button type="button" className={'sho-ask is-reviews' + (t.reviews ? ' is-hot' : '')} onClick={() => setReviewsOpen(true)}>
          <span className="sho-ask-art" aria-hidden="true">⭐</span>
          <span><strong>{tr('Reviews')}</strong><small>{t.reviews ? (t.reviews === 1 ? tr('1 to look at') : tr('{n} to look at', { n: t.reviews })) : data.settings.reviews.on ? tr('All looked at') : tr('Off in the shop settings')}</small></span>
          {t.reviews > 0 && <em className="sho-count">{t.reviews}</em>}
        </button>
        <button type="button" className={'sho-ask is-quotes' + (t.quotes ? ' is-hot' : '')} onClick={() => setQuotesOpen(true)}>
          <span className="sho-ask-art" aria-hidden="true">📐</span>
          <span><strong>{tr('Quote requests')}</strong><small>{t.quotes ? (t.quotes === 1 ? tr('1 new to price') : tr('{n} new to price', { n: t.quotes })) : tr('None waiting')}</small></span>
          {t.quotes > 0 && <em className="sho-count">{t.quotes}</em>}
        </button>
        {restock && (
          <button type="button" className={'sho-ask is-restock' + (restock.waiting ? ' is-hot' : '')} onClick={() => setRestockOpen(true)}>
            <span className="sho-ask-art" aria-hidden="true">🔔</span>
            <span><strong>{tr('Sold out and waiting')}</strong><small>{restock.waiting ? (restock.waiting === 1 ? tr('1 customer waiting') : tr('{n} customers waiting', { n: restock.waiting })) : restock.soldOut ? tr('{n} sold out', { n: restock.soldOut }) : tr('Everything on sale')}</small></span>
            {restock.waiting > 0 && <em className="sho-count">{restock.waiting}</em>}
          </button>
        )}
      </div>

      <div className="sho-filters" role="tablist" aria-label={tr('Which orders')}>
        {FILTERS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{label()}{k === 'unpaid' && t.unpaid > 0 && <em className="sho-count">{t.unpaid}</em>}</button>)}
      </div>

      {!data.orders.length ? (
        <div className="sho-empty"><span aria-hidden="true">🧺</span><strong>{tr('No orders here yet')}</strong>
          <p>{data.settings.on ? tr('Share the shop\'s address with customers: {url}', { url: data.url }) : tr('Open the shop in its settings, then share its address with customers.')}</p></div>
      ) : (
        <ul className="sho-list">
          {data.orders.map((o, i) => {
            const paid = o.invoice && o.invoice.status === 'paid';
            return (
              <li key={o.id} id={'sho-' + o.id} className={'sho-order is-' + o.status + (openId === o.id ? ' is-picked' : '')} style={{ '--i': Math.min(i, 10) }}>
                <div className="sho-o-top">
                  <span className={'sho-tag is-' + o.status}>{STATUS[o.status][0]} {STATUS[o.status][1]()}</span>
                  <strong>{o.orderNo}</strong>
                  <small>{when(o.createdAt)}</small>
                  <b className="sho-o-total">{money(o.total)}</b>
                </div>
                <div className="sho-o-who">
                  <span className="sho-av" aria-hidden="true">{o.name.replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                  <span><strong>{o.name}</strong><small><a href={'tel:' + o.phone}>{o.phone}</a>{o.email ? ' · ' + o.email : ''}</small></span>
                  <span className={'sho-how is-' + o.fulfilment}>{o.fulfilment === 'delivery' ? '🚚 ' + tr('Delivery') : '🏬 ' + tr('Pickup')}</span>
                </div>
                {o.address && <p className="sho-o-addr">📍 {o.address}{o.area ? ' · ' + o.area : ''}{o.deliveryFee > 0 ? ' · ' + tr('delivery {amount}', { amount: money(o.deliveryFee) }) : ''}</p>}
                <ul className="sho-o-lines">
                  {o.lines.map((l) => <li key={l.variationId}><b>{l.qty}×</b> {l.description}<span>{money(l.unitPrice * l.qty)}</span></li>)}
                </ul>
                {(o.readyBy || o.promoCode) && (
                  <div className="sho-o-chips">
                    {o.readyBy && <span className="sho-ready">🛠️ {o.readyFrom && o.readyFrom !== o.readyBy ? tr('Made to order: ready {from} – {to}', { from: dayWords(o.readyFrom), to: dayWords(o.readyBy) }) : tr('Made to order: ready by {day}', { day: dayWords(o.readyBy) })}</span>}
                    {o.promoCode && <span className="sho-promo">🏷️ {o.promoCode} · −{money(o.discount)}</span>}
                  </div>
                )}
                {o.note && <p className="sho-o-note">“{o.note}”</p>}
                {o.status === 'unpaid' && <p className="sho-o-wait">⏳ {tr('Waiting for the customer to pay. It is placed once its invoice is paid: record a payment on the invoice if they paid you another way.')}{o.remindedAt && <small className="sho-reminded">🔔 {tr('Reminded {when}', { when: when(o.remindedAt) })}</small>}</p>}
                <div className="sho-o-foot">
                  {o.trackUrl && <a className="sho-track" href={o.trackUrl} target="_blank" rel="noreferrer">🔗 {tr('Their page')}</a>}
                  {o.invoice && (
                    <Link className={'sho-inv' + (paid ? ' is-paid' : '')} to={'/invoices?open=' + o.invoice.id}>
                      🧾 {o.invoice.invoiceNo} · {paid ? tr('Paid') : o.invoice.status === 'void' ? tr('Voided') : tr('{amount} due', { amount: money(o.invoice.balance) })}
                    </Link>
                  )}
                  {can('invoice.manage') && (
                    <span className="sho-acts">
                      {o.status === 'new' && <button type="button" className="btn btn-secondary" disabled={busy === o.id} onClick={() => mark(o, 'making')}>🛠️ {tr('Start making')}</button>}
                      {(o.status === 'new' || o.status === 'making') && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => mark(o, 'ready')}>📦 {tr('Mark ready')}</button>}
                      {o.status === 'ready' && o.fulfilment === 'delivery' && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => mark(o, 'out')}>🚚 {tr('Out for delivery')}</button>}
                      {o.status === 'ready' && o.fulfilment === 'pickup' && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => mark(o, 'done')}>🤝 {tr('Collected')}</button>}
                      {o.status === 'out' && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => mark(o, 'done')}>🏡 {tr('Delivered')}</button>}
                      {o.status === 'unpaid' && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => remind(o)}>🔔 {tr('Remind to pay')}</button>}
                      {['unpaid', 'new', 'making', 'ready'].includes(o.status) && <button type="button" className="btn btn-secondary" disabled={busy === o.id} onClick={() => mark(o, 'cancelled')}>{tr('Cancel')}</button>}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setToast(tr('Shop settings saved.')); load(); }} />}
      {reviewsOpen && <ReviewsDialog onClose={() => setReviewsOpen(false)} onChanged={load} />}
      {restockOpen && <RestockDialog onClose={() => setRestockOpen(false)} onChanged={setRestock} />}
      {quotesOpen && <QuoteRequestsDialog openId={params.get('quotes') === '1' ? openId : null} onClose={() => setQuotesOpen(false)} onChanged={load} />}
      {makeOpen && <MakeDaysDialog onClose={() => setMakeOpen(false)} onSaved={(n) => { setMakeOpen(false); setToast(tr('Days to make saved for {n} items.', { n })); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
