import { useEffect, useMemo, useState } from 'react';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import DeviceLanguage from '../components/DeviceLanguage';
import { loadToken, portalCall, saveSignup, saveToken } from '../lib/portal';
import QuoteSheet from './QuoteSheet';
import './ShopPage.css';

// Bamboo Products' online shop at /shop (backend shop.service.js): public,
// outside the OS's frame. The catalogue's items put on the shop, by
// category, with a search; an item's sheet with its photos and choices; a
// basket kept on this phone; and the order — delivery or pickup — paid
// before it is placed: the checkout goes straight on to pay by card or
// Mobile Money (when online payments are on; else the invoice says how),
// and the order is placed once it is paid. Items made to order say how many
// days they take, and the checkout the days the order will be ready
// between; a discount code is checked before it is placed. A signed-in
// customer's details are filled in; anyone else may ask for an account.

const CART_KEY = 'bplShopCart';
function loadCart() { try { const c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; } catch { return []; } }
function saveCart(c) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* the basket lives as long as the page */ } }
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function photoUrl(id) { return API_URL + '/shop/photos/' + id; }
async function call(method, path, body) {
  const r = await fetch(API_URL + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
  return j;
}
const LEAVES = ['🎋', '🌿', '🍃', '🎍', '🌱'];
// How long an item takes to make: "3–7 days", "5 days".
function daysText(md) { return md.from === md.to ? tr('{n} days', { n: md.to }) : tr('{from}–{to} days', { from: md.from, to: md.to }); }
function made(md) { return md && md.to > 0 ? md : null; }
// The days an order will be ready between, as the server works them out
// (shop.service readyOf): the longest of its items', Sundays skipped.
function readyOf(mds) {
  const list = mds.filter(Boolean);
  if (!list.length) return null;
  const at = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); if (d.getDay() === 0) d.setDate(d.getDate() + 1); return d; };
  const from = Math.max(...list.map((m) => m.from)), to = Math.max(...list.map((m) => m.to));
  return { from: at(from), by: at(to), days: { from, to } };
}
// Without a closing full stop ("29 oct."): the sentence brings its own.
function dayWords(d) { return new Date(d).toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\.$/, ''); }

// Stars, as many as the rating (rounded to a half), the rest pale.
function Stars({ value, size }) {
  const full = Math.round(value * 2) / 2;
  return (
    <span className={'shp-stars' + (size ? ' is-' + size : '')} role="img" aria-label={tr('{n} out of 5', { n: value })}>
      {[1, 2, 3, 4, 5].map((n) => <i key={n} className={full >= n ? 'is-on' : full >= n - 0.5 ? 'is-half' : ''} aria-hidden="true">★</i>)}
    </span>
  );
}
function when(iso) { return new Date(iso).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }); }

function ItemSheet({ item, onAdd, onClose, onQuote }) {
  const [vid, setVid] = useState(item.variations[0].id);
  const [qty, setQty] = useState(1);
  const [pic, setPic] = useState(0);
  const [reviews, setReviews] = useState(null);
  useEffect(() => {
    if (!item.stars) return;
    call('GET', '/shop/items/' + item.id + '/reviews').then((r) => setReviews(r.reviews)).catch(() => setReviews([]));
  }, [item.id, item.stars]);
  const v = item.variations.find((x) => x.id === vid);
  const photos = item.photos.length ? item.photos : [];
  useEffect(() => {
    const own = photos.findIndex((p) => p.variationId === vid);
    if (own >= 0) setPic(own);
  }, [vid]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="shp-back" onClick={onClose}>
      <div className="shp-sheet" role="dialog" aria-modal="true" aria-labelledby="shp-item-title" onClick={(e) => e.stopPropagation()}>
        <div className="shp-pics">
          {photos.length ? <img src={photoUrl(photos[pic].id)} alt="" /> : <span className="shp-noimg" aria-hidden="true">🎋</span>}
          <button type="button" className="shp-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
          {photos.length > 1 && (
            <div className="shp-dots">{photos.map((p, i) => <button key={p.id} type="button" className={i === pic ? 'is-on' : ''} onClick={() => setPic(i)} aria-label={tr('Photo {n}', { n: i + 1 })} />)}</div>
          )}
        </div>
        <div className="shp-sheet-body">
          <small className="shp-cat">{item.category}</small>
          <h2 id="shp-item-title">{item.name}</h2>
          {item.stars && <p className="shp-rating"><Stars value={item.stars.average} /><b>{item.stars.average.toFixed(1)}</b><small>{item.stars.count === 1 ? tr('1 review') : tr('{n} reviews', { n: item.stars.count })}</small></p>}
          {item.description && <p className="shp-desc">{item.description}</p>}
          {made(item.makeDays) && (
            <p className="shp-made-note"><span aria-hidden="true">🛠️</span>{tr('Made to order for you: ready in about {days}.', { days: daysText(item.makeDays) })}</p>
          )}
          {item.variations.length > 1 && (
            <div className="shp-vars" role="radiogroup" aria-label={tr('Choose one')}>
              {item.variations.map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={x.id === vid} className={x.id === vid ? 'is-on' : ''} onClick={() => setVid(x.id)}>
                  <span>{x.name || tr('Standard')}</span><b>{cedis(x.price)}</b>
                </button>
              ))}
            </div>
          )}
          <div className="shp-add">
            <div className="shp-qty">
              <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} disabled={qty <= 1} aria-label={tr('Fewer')}>−</button>
              <b aria-live="polite">{qty}</b>
              <button type="button" onClick={() => setQty(Math.min(999, qty + 1))} aria-label={tr('More')}>+</button>
            </div>
            <button type="button" className="shp-go" onClick={() => onAdd(item, v, qty)}>{tr('Add · {amount}', { amount: cedis(v.price * qty) })}</button>
          </div>
          {v.unit && v.unit !== 'each' && <p className="shp-hint">{tr('Price per {unit}', { unit: v.unit })}</p>}
          {onQuote && <button type="button" className="shp-quote-link" onClick={() => onQuote(item)}>📐 {tr('Need another size, or many? Ask for a quote')}</button>}
          {reviews && reviews.length > 0 && (
            <section className="shp-reviews" aria-label={tr('What customers say')}>
              <h3>{tr('What customers say')}</h3>
              <ul>
                {reviews.map((r, i) => (
                  <li key={r.id} style={{ '--i': i }}>
                    <div className="shp-review-top"><Stars value={r.rating} size="sm" /><strong>{r.name}</strong><small>{when(r.at)}</small></div>
                    {r.words && <p>“{r.words}”</p>}
                    {r.reply && <p className="shp-review-reply"><b>🎋 Bamboo Products</b> {r.reply}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Checkout({ shop, cart, items, setCart, me, onDone, onClose }) {
  const [how, setHow] = useState(shop.delivery ? 'delivery' : 'pickup');
  const mine = (me && me.profile) || {};
  const [f, setF] = useState({ name: mine.name || '', phone: mine.phone || '', email: mine.email || '', address: mine.address || '', note: '', area: '' });
  const [account, setAccount] = useState(false);
  const areas = shop.areas || [];
  const area = how === 'delivery' ? areas.find((a) => a.name === f.area) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [code, setCode] = useState('');
  const [promo, setPromo] = useState(null);
  const [codeError, setCodeError] = useState(null);
  const lines = cart.map((c) => {
    const it = items.find((i) => i.id === c.itemId);
    const v = it && it.variations.find((x) => x.id === c.variationId);
    return it && v ? { ...c, item: it, v } : null;
  }).filter(Boolean);
  const total = lines.reduce((a, l) => a + l.v.price * l.qty, 0);
  const ready = readyOf(lines.map((l) => made(l.item.makeDays)));
  const fee = area ? area.fee : 0;
  const toPay = Math.max(0, total - (promo ? promo.discount : 0)) + fee;
  // The basket changed: the code is checked again for it.
  useEffect(() => {
    if (!promo) return;
    call('GET', '/shop/code?code=' + encodeURIComponent(promo.code) + '&subtotal=' + total).then(setPromo).catch((e) => { setPromo(null); setCodeError(e.message); });
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps
  async function apply() {
    if (!code.trim()) return;
    setCodeError(null);
    try { setPromo(await call('GET', '/shop/code?code=' + encodeURIComponent(code.trim()) + '&subtotal=' + total)); } catch (e) { setPromo(null); setCodeError(e.message); }
  }
  function setQty(l, q) {
    setCart(q <= 0 ? cart.filter((c) => c.variationId !== l.variationId) : cart.map((c) => (c.variationId === l.variationId ? { ...c, qty: q } : c)));
  }
  async function place(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await call('POST', '/shop/orders', { ...f, fulfilment: how, code: promo ? promo.code : '', lines: lines.map((l) => ({ variationId: l.variationId, qty: l.qty })), website: '' });
      // The account is made on the order's page, once it is paid.
      if (account && !me) saveSignup({ name: f.name, email: f.email, phone: f.phone });
      onDone(r);
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="shp-back" onClick={onClose}>
      <form className="shp-sheet is-checkout" role="dialog" aria-modal="true" aria-labelledby="shp-co-title" onClick={(e) => e.stopPropagation()} onSubmit={place}>
        <div className="shp-co-head">
          <button type="button" className="shp-x is-plain" onClick={onClose} aria-label={tr('Close')}>←</button>
          <h2 id="shp-co-title">🧺 {tr('Your basket')}</h2>
        </div>
        {!lines.length ? <p className="shp-hint">{tr('Your basket is empty.')}</p> : (
          <ul className="shp-lines">
            {lines.map((l) => (
              <li key={l.variationId}>
                {l.item.photos[0] ? <img src={photoUrl(l.item.photos[0].id)} alt="" /> : <span className="shp-line-ico" aria-hidden="true">🎋</span>}
                <span className="shp-line-main"><strong>{l.item.name}</strong><small>{l.v.name ? l.v.name + ' · ' : ''}{cedis(l.v.price)}</small>
                  {made(l.item.makeDays) && <em className="shp-made is-line">🛠️ {daysText(l.item.makeDays)}</em>}</span>
                <span className="shp-qty is-small">
                  <button type="button" onClick={() => setQty(l, l.qty - 1)} aria-label={tr('Fewer')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(l, Math.min(999, l.qty + 1))} aria-label={tr('More')}>+</button>
                </span>
                <b className="shp-line-amt">{cedis(l.v.price * l.qty)}</b>
              </li>
            ))}
          </ul>
        )}
        {shop.codes && lines.length > 0 && (
          <div className="shp-code">
            {promo ? (
              <p className="shp-code-on"><span aria-hidden="true">🏷️</span><b>{promo.code}</b><span>{promo.kind === 'percent' ? tr('{n}% off', { n: promo.value }) : tr('{amount} off', { amount: cedis(promo.value) })}</span>
                <button type="button" className="shp-link" onClick={() => { setPromo(null); setCode(''); }}>{tr('Remove')}</button></p>
            ) : (
              <div className="shp-code-row">
                <input className="input" value={code} maxLength={24} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
                  placeholder={tr('Discount code')} aria-label={tr('Discount code')} autoCapitalize="characters" />
                <button type="button" className="shp-go is-ghost" onClick={apply} disabled={!code.trim()}>{tr('Apply')}</button>
              </div>
            )}
            {codeError && <small className="shp-code-err" role="alert">{codeError}</small>}
          </div>
        )}
        {promo && promo.discount > 0 && <div className="shp-total is-off"><span>{tr('Discount ({code})', { code: promo.code })}</span><strong>− {cedis(promo.discount)}</strong></div>}
        {area && fee > 0 && <div className="shp-total is-fee"><span>{tr('Delivery to {area}', { area: area.name })}</span><strong>+ {cedis(fee)}</strong></div>}
        <div className="shp-total"><span>{tr('Total')}</span><strong>{cedis(toPay)}</strong></div>
        <p className="shp-hint">{areas.length ? tr('Prices include what is charged on the invoice.') : tr('Prices include what is charged on the invoice; delivery is agreed with you on the phone.')}</p>
        {ready && (
          <div className="shp-ready" role="note">
            <span className="shp-ready-ico" aria-hidden="true">🗓️</span>
            <span><strong>{tr('Made to order: ready in about {days}', { days: daysText(ready.days) })}</strong>
              <small>{tr('Between {from} and {to}. We will call you when it is ready.', { from: dayWords(ready.from), to: dayWords(ready.by) })}</small></span>
          </div>
        )}

        {shop.delivery && shop.pickup && (
          <div className="shp-how" role="radiogroup" aria-label={tr('Delivery or pickup')}>
            <button type="button" role="radio" aria-checked={how === 'delivery'} className={how === 'delivery' ? 'is-on' : ''} onClick={() => setHow('delivery')}><span aria-hidden="true">🚚</span><strong>{tr('Delivery')}</strong><small>{tr('to your door or site')}</small></button>
            <button type="button" role="radio" aria-checked={how === 'pickup'} className={how === 'pickup' ? 'is-on' : ''} onClick={() => setHow('pickup')}><span aria-hidden="true">🏬</span><strong>{tr('Pickup')}</strong><small>{shop.pickupAddress || tr('at our showroom')}</small></button>
          </div>
        )}
        {me && <p className="shp-signed">👤 {tr('Signed in as {who}: your details are filled in.', { who: me.signedInAs })}</p>}
        <label className="shp-field"><span>{tr('Your name')}</span><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="shp-two">
          <label className="shp-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" /></label>
          <label className="shp-field"><span>{tr('Email (for the invoice)')}</span><input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        </div>
        {how === 'delivery' && areas.length > 0 && (
          <div className="shp-field"><span>{tr('Your area')}</span>
            <div className="shp-areas" role="radiogroup" aria-label={tr('Your area')}>
              {areas.map((a) => (
                <button key={a.name} type="button" role="radio" aria-checked={f.area === a.name} className={f.area === a.name ? 'is-on' : ''} onClick={() => setF({ ...f, area: a.name })}>
                  <strong>{a.name}</strong><small>{a.fee > 0 ? cedis(a.fee) : tr('Free')}</small>
                </button>
              ))}
            </div>
          </div>
        )}
        {how === 'delivery' && <label className="shp-field"><span>{tr('Delivery address or landmark')}</span><input className="input" required maxLength={300} autoComplete="street-address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>}
        {how === 'delivery' && shop.deliveryNote && <p className="shp-hint">🚚 {shop.deliveryNote}</p>}
        <label className="shp-field"><span>{tr('Anything we should know? (optional)')}</span><input className="input" maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('e.g. sizes, colours, a time to call')} /></label>
        {!me && (
          <label className="shp-acct-opt">
            <input type="checkbox" checked={account} onChange={(e) => setAccount(e.target.checked)} />
            <span><strong>{tr('Create an account with these details')}</strong><small>{tr('To follow your orders and invoices later, and check out faster. We send you a code once you have paid.')}</small></span>
          </label>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="shp-go is-big" disabled={busy || !lines.length || (how === 'delivery' && areas.length > 0 && !area)}>
          {busy ? tr('One moment…') : shop.payOnline ? '🔒 ' + tr('Pay {amount}', { amount: cedis(toPay) }) : tr('Place the order · {amount}', { amount: cedis(toPay) })}</button>
        <p className="shp-hint is-center">{shop.payOnline ? tr('Next: pay by card or Mobile Money. Your order is placed once it is paid.') : tr('Next: your invoice, with how to pay it. Your order is placed once it is paid.')}</p>
      </form>
    </div>
  );
}

// Placed without going on to pay (online payments off, or Paystack did not
// answer): what is left is to pay; the order starts once it is.
function Placed({ r, onShop }) {
  return (
    <div className="shp shp-done">
      <span className="shp-done-art" aria-hidden="true">{['💳', '🎋', '✨'].map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
      <h1>{tr('Almost there! Order {no} is waiting for your payment.', { no: r.orderNo })}</h1>
      <p>{r.payOnline ? tr('Pay {amount} by card or Mobile Money; we start on your order as soon as it is paid.', { amount: cedis(r.total) })
        : tr('Pay its invoice {no} of {amount} as it says; we start on your order as soon as it is paid. Unpaid orders are cancelled after two days.', { no: r.invoiceNo, amount: cedis(r.total) })}</p>
      {r.ready && <p className="shp-ready is-done"><span aria-hidden="true">🛠️</span>{tr('It is made to order for you: ready between {from} and {to}.', { from: dayWords(r.ready.from + 'T12:00:00'), to: dayWords(r.ready.by + 'T12:00:00') })}</p>}
      {r.payOnline && r.orderToken
        ? <a className="shp-go is-big" href={'/o/' + r.orderToken}>💳 {tr('Pay {amount}', { amount: cedis(r.total) })}</a>
        : <a className="shp-go is-big" href={'/share/' + r.token}>🧾 {tr('See the invoice and how to pay')}</a>}
      {r.orderToken && !r.payOnline && <a className="shp-go is-big is-ghost" href={'/o/' + r.orderToken}>📦 {tr('Follow your order')}</a>}
      <button type="button" className="shp-go is-ghost" onClick={onShop}>{tr('Back to the shop')}</button>
    </div>
  );
}

export default function ShopPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [cart, setCartState] = useState(loadCart);
  const [checkout, setCheckout] = useState(false);
  const [placed, setPlaced] = useState(null);
  const [bump, setBump] = useState(0);
  const [me, setMe] = useState(null);
  const [going, setGoing] = useState(false);
  const [quote, setQuote] = useState(null); // { item } while asking for a quote
  useEffect(() => { call('GET', '/shop').then((d) => { setData(d); document.title = d.shop.title; }).catch((e) => setError(e.message)); }, []);
  // Signed in to "My account": their details for the checkout.
  useEffect(() => {
    const token = loadToken();
    if (token) portalCall('GET', '/portal/me', null, token).then(setMe).catch((e) => { if (e.status === 401) saveToken(''); });
  }, []);
  function setCart(c) { setCartState(c); saveCart(c); }
  function add(item, v, qty) {
    const have = cart.find((c) => c.variationId === v.id);
    setCart(have ? cart.map((c) => (c.variationId === v.id ? { ...c, qty: Math.min(999, c.qty + qty) } : c)) : cart.concat([{ itemId: item.id, variationId: v.id, qty }]));
    setOpen(null);
    setBump((b) => b + 1);
  }
  const items = useMemo(() => (data ? data.items : []), [data]);
  const shown = items.filter((i) => (!cat || i.category === cat) && (!q.trim() || (i.name + ' ' + i.description + ' ' + i.category).toLowerCase().includes(q.trim().toLowerCase())));
  const count = cart.reduce((a, c) => a + c.qty, 0);
  const total = cart.reduce((a, c) => { const it = items.find((i) => i.id === c.itemId); const v = it && it.variations.find((x) => x.id === c.variationId); return a + (v ? v.price * c.qty : 0); }, 0);

  if (error) return <div className="shp shp-mid"><img src="/logo.png" alt="Bamboo Products Limited" className="shp-logo" /><h1>{tr('The shop is closed for now')}</h1><p>{error}</p></div>;
  if (!data) return <div className="shp shp-mid"><span className="shp-spin" aria-hidden="true">🎋</span><p>{tr('Loading…')}</p></div>;
  if (going) return <div className="shp shp-mid"><span className="shp-spin" aria-hidden="true">💳</span><h1>{tr('On to pay…')}</h1><p>{tr('Your order is placed as soon as it is paid.')}</p></div>;
  if (placed) return <Placed r={placed} onShop={() => setPlaced(null)} />;
  const s = data.shop;
  return (
    <div className="shp">
      <header className="shp-hero">
        <span className="shp-leaves" aria-hidden="true">{LEAVES.map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
        <div className="shp-hero-top">
          <img src="/logo.png" alt="" className="shp-logo" />
          <span className="shp-hero-acts">
            <a className="shp-acct" href="/account">👤 {me && me.name ? me.name.split(' ')[0] : tr('My account')}</a>
            <DeviceLanguage className="shp-lang" />
          </span>
        </div>
        <h1>{s.title}</h1>
        {s.intro && <p>{s.intro}</p>}
        {s.quotes && <button type="button" className="shp-quote-btn" onClick={() => setQuote({ item: null })}><span aria-hidden="true">📐</span><span><strong>{tr('Made to your size')}</strong><small>{tr('Ask for a quote')}</small></span></button>}
        <div className="shp-facts">
          {s.delivery && <span>🚚 {tr('Delivery')}</span>}
          {s.pickup && <span>🏬 {s.pickupAddress ? tr('Pickup at {place}', { place: s.pickupAddress }) : tr('Pickup')}</span>}
          <span>{s.payOnline ? '💳 ' + tr('Pay by card or Mobile Money') : '🏦 ' + tr('Pay by bank or Mobile Money')}</span>
        </div>
      </header>

      <div className="shp-bar">
        <input className="input shp-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the shop')} aria-label={tr('Search the shop')} />
        <div className="shp-cats" role="tablist" aria-label={tr('Categories')}>
          <button type="button" role="tab" aria-selected={!cat} className={!cat ? 'is-on' : ''} onClick={() => setCat('')}>{tr('Everything')}</button>
          {data.categories.map((c) => <button key={c} type="button" role="tab" aria-selected={cat === c} className={cat === c ? 'is-on' : ''} onClick={() => setCat(cat === c ? '' : c)}>{c}</button>)}
        </div>
      </div>

      {!shown.length ? <p className="shp-hint is-center">{tr('Nothing matches. Try another word.')}</p> : (
        <div className="shp-grid">
          {shown.map((it, i) => {
            const from = Math.min(...it.variations.map((v) => v.price));
            const inCart = cart.filter((c) => c.itemId === it.id).reduce((a, c) => a + c.qty, 0);
            return (
              <button key={it.id} type="button" className="shp-card" style={{ '--i': Math.min(i, 12) }} onClick={() => setOpen(it)}>
                <span className="shp-card-pic">{it.photos[0] ? <img src={photoUrl(it.photos[0].id)} alt="" loading="lazy" /> : <span aria-hidden="true">🎋</span>}
                  {inCart > 0 && <em className="shp-in">{inCart}</em>}</span>
                <span className="shp-card-body">
                  <strong>{it.name}</strong>
                  <small>{it.variations.length > 1 ? tr('{n} choices', { n: it.variations.length }) : it.category}</small>
                  {it.stars && <span className="shp-card-stars"><Stars value={it.stars.average} size="sm" /><em>{it.stars.average.toFixed(1)} ({it.stars.count})</em></span>}
                  {made(it.makeDays) && <em className="shp-made">🛠️ {tr('Made to order · {days}', { days: daysText(it.makeDays) })}</em>}
                  <b>{it.variations.length > 1 ? tr('from {amount}', { amount: cedis(from) }) : cedis(from)}</b>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {count > 0 && (
        <button type="button" className="shp-basket" key={bump} onClick={() => setCheckout(true)}>
          <span className="shp-basket-n">{count}</span><span>{tr('Your basket')}</span><strong>{cedis(total)}</strong>
        </button>
      )}
      {open && <ItemSheet item={open} onAdd={add} onClose={() => setOpen(null)} onQuote={s.quotes ? (it) => { setOpen(null); setQuote({ item: it }); } : null} />}
      {quote && <QuoteSheet item={quote.item} me={me} onClose={() => setQuote(null)} />}
      {checkout && <Checkout shop={s} cart={cart} items={items} setCart={setCart} me={me} onClose={() => setCheckout(false)}
        onDone={(r) => {
          setCart([]); setCheckout(false);
          // Straight on to Paystack's page, back to the order's own page.
          if (r.payUrl) { setGoing(true); window.location.assign(r.payUrl); return; }
          setPlaced(r); window.scrollTo(0, 0);
        }} />}
      <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
    </div>
  );
}
