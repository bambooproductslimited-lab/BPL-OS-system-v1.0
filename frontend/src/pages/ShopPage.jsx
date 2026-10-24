import { useEffect, useMemo, useState } from 'react';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import DeviceLanguage from '../components/DeviceLanguage';
import './ShopPage.css';

// Bamboo Products' online shop at /shop (backend shop.service.js): public,
// outside the OS's frame. The catalogue's items put on the shop, by
// category, with a search; an item's sheet with its photos and choices; a
// basket kept on this phone; and the order — delivery or pickup — which
// becomes an invoice, opened to pay at once (by card or Mobile Money when
// online payments are on, else by the bank details on it).

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

function ItemSheet({ item, onAdd, onClose }) {
  const [vid, setVid] = useState(item.variations[0].id);
  const [qty, setQty] = useState(1);
  const [pic, setPic] = useState(0);
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
          {item.description && <p className="shp-desc">{item.description}</p>}
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
        </div>
      </div>
    </div>
  );
}

function Checkout({ shop, cart, items, setCart, onDone, onClose }) {
  const [how, setHow] = useState(shop.delivery ? 'delivery' : 'pickup');
  const [f, setF] = useState({ name: '', phone: '', email: '', address: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const lines = cart.map((c) => {
    const it = items.find((i) => i.id === c.itemId);
    const v = it && it.variations.find((x) => x.id === c.variationId);
    return it && v ? { ...c, item: it, v } : null;
  }).filter(Boolean);
  const total = lines.reduce((a, l) => a + l.v.price * l.qty, 0);
  function setQty(l, q) {
    setCart(q <= 0 ? cart.filter((c) => c.variationId !== l.variationId) : cart.map((c) => (c.variationId === l.variationId ? { ...c, qty: q } : c)));
  }
  async function place(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await call('POST', '/shop/orders', { ...f, fulfilment: how, lines: lines.map((l) => ({ variationId: l.variationId, qty: l.qty })), website: '' });
      onDone(r);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
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
                <span className="shp-line-main"><strong>{l.item.name}</strong><small>{l.v.name ? l.v.name + ' · ' : ''}{cedis(l.v.price)}</small></span>
                <span className="shp-qty is-small">
                  <button type="button" onClick={() => setQty(l, l.qty - 1)} aria-label={tr('Fewer')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(l, Math.min(999, l.qty + 1))} aria-label={tr('More')}>+</button>
                </span>
                <b className="shp-line-amt">{cedis(l.v.price * l.qty)}</b>
              </li>
            ))}
          </ul>
        )}
        <div className="shp-total"><span>{tr('Total')}</span><strong>{cedis(total)}</strong></div>
        <p className="shp-hint">{tr('Prices include what is charged on the invoice; delivery is agreed with you on the phone.')}</p>

        {shop.delivery && shop.pickup && (
          <div className="shp-how" role="radiogroup" aria-label={tr('Delivery or pickup')}>
            <button type="button" role="radio" aria-checked={how === 'delivery'} className={how === 'delivery' ? 'is-on' : ''} onClick={() => setHow('delivery')}><span aria-hidden="true">🚚</span><strong>{tr('Delivery')}</strong><small>{tr('to your door or site')}</small></button>
            <button type="button" role="radio" aria-checked={how === 'pickup'} className={how === 'pickup' ? 'is-on' : ''} onClick={() => setHow('pickup')}><span aria-hidden="true">🏬</span><strong>{tr('Pickup')}</strong><small>{shop.pickupAddress || tr('at our showroom')}</small></button>
          </div>
        )}
        <label className="shp-field"><span>{tr('Your name')}</span><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="shp-two">
          <label className="shp-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" /></label>
          <label className="shp-field"><span>{tr('Email (for the invoice)')}</span><input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        </div>
        {how === 'delivery' && <label className="shp-field"><span>{tr('Delivery address or landmark')}</span><input className="input" required maxLength={300} autoComplete="street-address" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>}
        {how === 'delivery' && shop.deliveryNote && <p className="shp-hint">🚚 {shop.deliveryNote}</p>}
        <label className="shp-field"><span>{tr('Anything we should know? (optional)')}</span><input className="input" maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('e.g. sizes, colours, a time to call')} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="shp-go is-big" disabled={busy || !lines.length}>{busy ? tr('One moment…') : tr('Place the order · {amount}', { amount: cedis(total) })}</button>
        <p className="shp-hint is-center">{shop.payOnline ? tr('Next: your invoice, to pay by card or Mobile Money.') : tr('Next: your invoice, with how to pay it.')}</p>
      </form>
    </div>
  );
}

function Placed({ r, onShop }) {
  return (
    <div className="shp shp-done">
      <span className="shp-done-art" aria-hidden="true">{['🎉', '🎋', '✨'].map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
      <h1>{tr('Thank you! Order {no} is in.', { no: r.orderNo })}</h1>
      <p>{tr('Its invoice {no} for {amount} is ready. We will call you to agree the delivery or pickup.', { no: r.invoiceNo, amount: cedis(r.total) })}</p>
      <a className="shp-go is-big" href={'/share/' + r.token}>{r.payOnline ? '💳 ' + tr('See the invoice and pay') : '🧾 ' + tr('See the invoice')}</a>
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
  useEffect(() => { call('GET', '/shop').then((d) => { setData(d); document.title = d.shop.title; }).catch((e) => setError(e.message)); }, []);
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
  if (placed) return <Placed r={placed} onShop={() => setPlaced(null)} />;
  const s = data.shop;
  return (
    <div className="shp">
      <header className="shp-hero">
        <span className="shp-leaves" aria-hidden="true">{LEAVES.map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
        <div className="shp-hero-top">
          <img src="/logo.png" alt="" className="shp-logo" />
          <DeviceLanguage className="shp-lang" />
        </div>
        <h1>{s.title}</h1>
        {s.intro && <p>{s.intro}</p>}
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
      {open && <ItemSheet item={open} onAdd={add} onClose={() => setOpen(null)} />}
      {checkout && <Checkout shop={s} cart={cart} items={items} setCart={setCart} onClose={() => setCheckout(false)}
        onDone={(r) => { setCart([]); setCheckout(false); setPlaced(r); window.scrollTo(0, 0); }} />}
      <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
    </div>
  );
}
