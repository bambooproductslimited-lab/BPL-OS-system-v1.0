import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './ShopOrdersPage.css';

// Online shop (Quotations & Invoicing → Online shop; backend
// shop.service.js): the orders from the shop at /shop, newest first, each
// with its invoice and whether it is paid; marked ready (the customer is
// texted when texts are set up), done, or cancelled. The shop's own
// settings: open or closed, its words, which categories are on it, delivery
// and pickup.

const STATUS = {
  new: ['🆕', () => tr('New')], ready: ['📦', () => tr('Ready')], done: ['✅', () => tr('Done')], cancelled: ['✕', () => tr('Cancelled')]
};
const FILTERS = [['', () => tr('All')], ['new', () => tr('New')], ['ready', () => tr('Ready')], ['done', () => tr('Done')], ['cancelled', () => tr('Cancelled')]];
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
            {s.delivery && <label className="sho-field">{tr('About delivery')}<input className="input" maxLength={300} value={s.deliveryNote} onChange={(e) => setS({ ...s, deliveryNote: e.target.value })} placeholder={tr('e.g. Delivery fee agreed on the phone; 2–5 days.')} /></label>}
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
      setToast(status === 'ready' ? (r.texted ? tr('{no} is ready: {name} was texted.', { no: o.orderNo, name: o.name }) : tr('{no} is ready.', { no: o.orderNo })) : tr('{no} updated.', { no: o.orderNo }));
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
          <p>{tr('Orders from the shop on the website: each is an invoice the customer can pay online. Mark them ready and done as they go out.')}</p>
        </div>
        <div className="sho-hero-acts">
          <a className="btn btn-secondary" href={data.url} target="_blank" rel="noreferrer">↗ {tr('Open the shop')}</a>
          {can('catalog.manage') && <button type="button" className="btn btn-primary" onClick={() => setSettingsOpen(true)}>⚙️ {tr('Shop settings')}</button>}
        </div>
      </section>

      <div className="sho-stats">
        <div className={'sho-stat' + (t.fresh ? ' is-hot' : '')}><small>{tr('New orders')}</small><strong>{t.fresh}</strong><span>{tr('to call and prepare')}</span></div>
        <div className="sho-stat"><small>{tr('Ready')}</small><strong>{t.ready}</strong><span>{tr('waiting to go out')}</span></div>
        <div className="sho-stat"><small>{tr('This month')}</small><strong>{money(t.month)}</strong><span>{t.monthCount === 1 ? tr('1 order') : tr('{n} orders', { n: t.monthCount })}</span></div>
        <div className="sho-stat"><small>{tr('Paid this month')}</small><strong>{t.monthPaid}</strong><span>{data.payOnline ? tr('card and Mobile Money online') : tr('online payments off')}</span></div>
      </div>

      <div className="sho-filters" role="tablist" aria-label={tr('Which orders')}>
        {FILTERS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{label()}</button>)}
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
                {o.address && <p className="sho-o-addr">📍 {o.address}</p>}
                <ul className="sho-o-lines">
                  {o.lines.map((l) => <li key={l.variationId}><b>{l.qty}×</b> {l.description}<span>{money(l.unitPrice * l.qty)}</span></li>)}
                </ul>
                {o.note && <p className="sho-o-note">“{o.note}”</p>}
                <div className="sho-o-foot">
                  {o.invoice && (
                    <Link className={'sho-inv' + (paid ? ' is-paid' : '')} to={'/invoices?open=' + o.invoice.id}>
                      🧾 {o.invoice.invoiceNo} · {paid ? tr('Paid') : o.invoice.status === 'void' ? tr('Voided') : tr('{amount} due', { amount: money(o.invoice.balance) })}
                    </Link>
                  )}
                  {can('invoice.manage') && (
                    <span className="sho-acts">
                      {o.status === 'new' && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => mark(o, 'ready')}>📦 {tr('Mark ready')}</button>}
                      {o.status === 'ready' && <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => mark(o, 'done')}>✅ {tr('Mark done')}</button>}
                      {(o.status === 'new' || o.status === 'ready') && <button type="button" className="btn btn-secondary" disabled={busy === o.id} onClick={() => mark(o, 'cancelled')}>{tr('Cancel')}</button>}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); setToast(tr('Shop settings saved.')); load(); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
