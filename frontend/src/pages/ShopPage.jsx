import { useEffect, useMemo, useRef, useState } from 'react';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { loadToken, portalCall, saveSignup, saveToken } from '../lib/portal';
import QuoteSheet from './QuoteSheet';
import { StoreFoot, StoreTop } from './StoreChrome';
import './ShopPage.css';
import './ShopFancy.css';

// Bamboo Products' online shop (online.bplghana.com, and /shop on the OS;
// backend shop.service.js): public, outside the OS's frame. A bar along the
// top (StoreChrome.jsx); a hero with the pieces' own photos; the shop by
// category; customers' favourites (what sells most, then the best rated);
// every piece, searched, sorted and saved for later (a heart, kept on this
// phone); how buying works; what customers say; and a footer. A piece's
// sheet has its photos, its choices, its reviews and more like it; a quick
// "+" puts a piece with one choice straight in the basket. The basket
// slides in from the side, and the order — delivery or pickup — is paid
// before it is placed: the checkout goes straight on to pay by card or
// Mobile Money (when online payments are on; else the invoice says how),
// and the order is placed once it is paid. Items made to order say how many
// days they take, and the checkout the days the order will be ready
// between; a discount code is checked before it is placed. A signed-in
// customer's details are filled in; anyone else may ask for an account.

const CART_KEY = 'bplShopCart';
const SAVED_KEY = 'bplShopSaved';
function loadCart() { try { const c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; } catch { return []; } }
function saveCart(c) { try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* the basket lives as long as the page */ } }
function loadSaved() { try { const c = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(c) ? c : []; } catch { return []; } }
function keepSaved(c) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(c)); } catch { /* kept for this visit only */ } }
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
// Round prices on cards and in the hero: "GHS 9,500".
function cedisShort(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: Number(n) % 1 ? 2 : 0 }); }
function photoUrl(id) { return API_URL + '/shop/photos/' + id; }
async function call(method, path, body) {
  const r = await fetch(API_URL + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
  return j;
}
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
function fromPrice(it) { return Math.min(...it.variations.map((v) => v.price)); }
// For sorting by rating: the stars, then how many said so.
function ratedOf(i) { return i.stars ? i.stars.average * 10 + Math.min(i.stars.count, 9) : 0; }
// A category's picture when none of its pieces has a photo.
function catIcon(name) {
  const n = String(name).toLowerCase();
  if (/light|lamp/.test(n)) return '💡';
  if (/garden|outdoor|pergola/.test(n)) return '🌳';
  if (/blind|curtain|window/.test(n)) return '🪟';
  if (/bed|sleep/.test(n)) return '🛏️';
  if (/furni|chair|table|stool|sofa/.test(n)) return '🪑';
  if (/decor|craft|gift/.test(n)) return '🎁';
  return '🎋';
}
// The ways to sort, worded in the visitor's language when shown.
const sorts = () => [['featured', tr('Featured')], ['popular', tr('Most popular')], ['rated', tr('Best rated')], ['low', tr('Price: low to high')], ['high', tr('Price: high to low')]];

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

// Saved for later: a heart on a piece, kept on this phone.
function Heart({ on, onToggle, className }) {
  return (
    <button type="button" className={'shf-heart' + (on ? ' is-on' : '') + (className ? ' ' + className : '')} aria-pressed={on}
      aria-label={on ? tr('Saved: press to forget it') : tr('Save for later')} title={on ? tr('Saved: press to forget it') : tr('Save for later')} onClick={onToggle}>
      <span aria-hidden="true">{on ? '♥' : '♡'}</span>
    </button>
  );
}

// Sold out (backend shopRestock.service, migration 0194): a phone number or
// an email address, told once when it is back.
function BackInStock({ item, me }) {
  const [name, setName] = useState(me && me.name ? me.name : '');
  const [phone, setPhone] = useState(me && me.phone ? me.phone : '');
  const [email, setEmail] = useState(me && me.email ? me.email : '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  async function ask(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setDone(await call('POST', '/shop/items/' + item.id + '/alert', { name, phone, email })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (done) {
    return (
      <div className="rst-done" role="status">
        <span aria-hidden="true">🔔</span>
        <div><strong>{tr('We will tell you when it is back')}</strong><small>{done.by === 'email' ? tr('By email, once, as soon as it is back in stock.') : tr('By text, once, as soon as it is back in stock.')}</small></div>
      </div>
    );
  }
  return (
    <form className="rst-form" onSubmit={ask}>
      <div className="rst-form-head"><span aria-hidden="true">🔔</span><div><strong>{tr('Tell me when it\'s back')}</strong><small>{tr('Leave a phone number or an email: we let you know once, as soon as it is back.')}</small></div></div>
      <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={tr('Your name (optional)')} autoComplete="name" aria-label={tr('Your name')} />
      <div className="rst-two">
        <input className="input" type="tel" inputMode="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} placeholder={tr('Phone, e.g. 024 412 3456')} autoComplete="tel" aria-label={tr('Phone number')} />
        <input className="input" type="email" value={email} maxLength={120} onChange={(e) => setEmail(e.target.value)} placeholder={tr('or email')} autoComplete="email" aria-label={tr('Email address')} />
      </div>
      {error && <p className="rst-error" role="alert">{error}</p>}
      <button type="submit" className="shp-go rst-go" disabled={busy || (!phone.trim() && !email.trim())}>{busy ? tr('Sending…') : '🔔 ' + tr('Tell me when it\'s back')}</button>
    </form>
  );
}

// A piece: its photos (big, with the others to pick from), its words, its
// choices, how many, its reviews, and more like it.
function ItemSheet({ item, items, saved, onSave, onAdd, onClose, onQuote, onOpen, me }) {
  const [vid, setVid] = useState(item.variations[0].id);
  const [qty, setQty] = useState(1);
  const [pic, setPic] = useState(0);
  const [reviews, setReviews] = useState(null);
  useEffect(() => {
    setReviews(null);
    if (!item.stars) return;
    call('GET', '/shop/items/' + item.id + '/reviews').then((r) => setReviews(r.reviews)).catch(() => setReviews([]));
  }, [item.id, item.stars]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const v = item.variations.find((x) => x.id === vid) || item.variations[0];
  const out = !!(item.soldOut || (v && v.soldOut));
  const photos = item.photos.length ? item.photos : [];
  useEffect(() => {
    const own = photos.findIndex((p) => p.variationId === vid);
    if (own >= 0) setPic(own);
  }, [vid]); // eslint-disable-line react-hooks/exhaustive-deps
  const more = items.filter((x) => x.id !== item.id && x.category === item.category && !x.soldOut).slice(0, 3);
  return (
    <div className="shp-back" onClick={onClose}>
      <div className="shp-sheet shf-item" role="dialog" aria-modal="true" aria-labelledby="shp-item-title" onClick={(e) => e.stopPropagation()}>
        <div className="shf-gallery">
          <div className="shp-pics">
            {/* The whole photo, over a blurred copy of itself filling the frame. */}
            {photos.length ? <><img className="shf-pic-fill" src={photoUrl(photos[pic].id)} alt="" aria-hidden="true" /><img key={photos[pic].id} className="shf-pic-main" src={photoUrl(photos[pic].id)} alt="" /></>
              : <span className="shp-noimg" aria-hidden="true">🎋</span>}
            <button type="button" className="shp-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
            <Heart on={saved} onToggle={onSave} className="is-sheet" />
            {photos.length > 1 && (
              <>
                <button type="button" className="shf-arrow is-prev" onClick={() => setPic((pic - 1 + photos.length) % photos.length)} aria-label={tr('Previous photo')}>‹</button>
                <button type="button" className="shf-arrow is-next" onClick={() => setPic((pic + 1) % photos.length)} aria-label={tr('Next photo')}>›</button>
              </>
            )}
          </div>
          {photos.length > 1 && (
            <div className="shf-thumbs">{photos.map((p, i) => <button key={p.id} type="button" className={i === pic ? 'is-on' : ''} onClick={() => setPic(i)} aria-label={tr('Photo {n}', { n: i + 1 })}><img src={photoUrl(p.id)} alt="" /></button>)}</div>
          )}
        </div>
        <div className="shp-sheet-body">
          <small className="shp-cat">{item.category}</small>
          <h2 id="shp-item-title">{item.name}</h2>
          <p className="shf-price">{item.variations.length > 1 && <small>{v.name || tr('Standard')}</small>}<b>{cedis(v.price)}</b>{v.unit && v.unit !== 'each' && <em>{tr('Price per {unit}', { unit: v.unit })}</em>}</p>
          {item.stars && <p className="shp-rating"><Stars value={item.stars.average} /><b>{item.stars.average.toFixed(1)}</b><small>{item.stars.count === 1 ? tr('1 review') : tr('{n} reviews', { n: item.stars.count })}</small></p>}
          {item.description && <p className="shp-desc">{item.description}</p>}
          {made(item.makeDays) && (
            <p className="shp-made-note"><span aria-hidden="true">🛠️</span>{tr('Made to order for you: ready in about {days}.', { days: daysText(item.makeDays) })}</p>
          )}
          {item.variations.length > 1 && (
            <div className="shp-vars" role="radiogroup" aria-label={tr('Choose one')}>
              {item.variations.map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={x.id === vid} className={(x.id === vid ? 'is-on' : '') + (x.soldOut ? ' is-out' : '')} onClick={() => setVid(x.id)}>
                  <span>{x.name || tr('Standard')}{x.soldOut && <small className="rst-var-out">{tr('Sold out')}</small>}</span><b>{cedis(x.price)}</b>
                </button>
              ))}
            </div>
          )}
          {out && !item.soldOut ? (
            <p className="rst-out"><span aria-hidden="true">😔</span>{tr('This one is sold out right now: choose another.')}</p>
          ) : out ? (
            <>
              <p className="rst-out"><span aria-hidden="true">😔</span>{tr('Sold out right now')}</p>
              <BackInStock key={item.id} item={item} me={me} />
            </>
          ) : (
            <div className="shp-add">
              <div className="shp-qty">
                <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} disabled={qty <= 1} aria-label={tr('Fewer')}>−</button>
                <b aria-live="polite">{qty}</b>
                <button type="button" onClick={() => setQty(Math.min(999, qty + 1))} aria-label={tr('More')}>+</button>
              </div>
              <button type="button" className="shp-go" onClick={() => onAdd(item, v, qty)}>🧺 {tr('Add · {amount}', { amount: cedis(v.price * qty) })}</button>
            </div>
          )}
          <ul className="shf-promises">
            <li><span aria-hidden="true">🎋</span>{tr('Handmade in Accra')}</li>
            <li><span aria-hidden="true">🔒</span>{tr('Pay safely by card or Mobile Money')}</li>
            <li><span aria-hidden="true">🚚</span>{tr('Delivery or pickup')}</li>
          </ul>
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
          {more.length > 0 && (
            <section className="shf-more" aria-label={tr('More like this')}>
              <h3>{tr('More like this')}</h3>
              <div className="shf-more-row">
                {more.map((x) => (
                  <button key={x.id} type="button" onClick={() => onOpen(x)}>
                    <span className="shf-more-pic">{x.photos[0] ? <img src={photoUrl(x.photos[0].id)} alt="" loading="lazy" /> : <span aria-hidden="true">🎋</span>}</span>
                    <strong>{x.name}</strong><small>{cedisShort(fromPrice(x))}</small>
                  </button>
                ))}
              </div>
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
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
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
  const filled = !!(f.name.trim() && f.phone.trim());
  const step = !lines.length ? 0 : filled ? 2 : 1;
  return (
    <div className="shp-back shf-drawer-back" onClick={onClose}>
      <form className="shp-sheet is-checkout shf-drawer" role="dialog" aria-modal="true" aria-labelledby="shp-co-title" onClick={(e) => e.stopPropagation()} onSubmit={place}>
        <div className="shp-co-head">
          <button type="button" className="shp-x is-plain" onClick={onClose} aria-label={tr('Close')}>←</button>
          <h2 id="shp-co-title">🧺 {tr('Your basket')}</h2>
          {lines.length > 0 && <span className="shf-co-count">{lines.reduce((a, l) => a + l.qty, 0)}</span>}
        </div>
        <ol className="shf-steps" aria-label={tr('Steps')}>
          {[['🧺', tr('Basket')], ['📝', tr('Your details')], ['🔒', tr('Payment')]].map(([ic, label], i) => (
            <li key={i} className={i < step ? 'is-done' : i === step ? 'is-now' : ''}><span aria-hidden="true">{i < step ? '✓' : ic}</span>{label}</li>
          ))}
        </ol>
        {!lines.length ? (
          <div className="shf-empty"><span aria-hidden="true">🧺</span><strong>{tr('Your basket is empty.')}</strong><button type="button" className="shp-go is-ghost" onClick={onClose}>{tr('Back to the shop')}</button></div>
        ) : (
          <ul className="shp-lines">
            {lines.map((l) => (
              <li key={l.variationId}>
                {l.item.photos[0] ? <img src={photoUrl(l.item.photos[0].id)} alt="" /> : <span className="shp-line-ico" aria-hidden="true">🎋</span>}
                <span className="shp-line-main"><strong>{l.item.name}</strong><small>{l.v.name ? l.v.name + ' · ' : ''}{cedis(l.v.price)}</small>
                  {made(l.item.makeDays) && <em className="shp-made is-line">🛠️ {daysText(l.item.makeDays)}</em>}</span>
                <span className="shp-qty is-small">
                  <button type="button" onClick={() => setQty(l, l.qty - 1)} aria-label={l.qty <= 1 ? tr('Remove') : tr('Fewer')}>{l.qty <= 1 ? '🗑' : '−'}</button><b>{l.qty}</b><button type="button" onClick={() => setQty(l, Math.min(999, l.qty + 1))} aria-label={tr('More')}>+</button>
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
                  placeholder={'🏷️ ' + tr('Discount code')} aria-label={tr('Discount code')} autoCapitalize="characters" />
                <button type="button" className="shp-go is-ghost" onClick={apply} disabled={!code.trim()}>{tr('Apply')}</button>
              </div>
            )}
            {codeError && <small className="shp-code-err" role="alert">{codeError}</small>}
          </div>
        )}
        {lines.length > 0 && (
          <div className="shf-sum">
            {((promo && promo.discount > 0) || (area && fee > 0)) && <div className="shp-total is-sub"><span>{tr('Subtotal')}</span><strong>{cedis(total)}</strong></div>}
            {promo && promo.discount > 0 && <div className="shp-total is-off"><span>{tr('Discount ({code})', { code: promo.code })}</span><strong>− {cedis(promo.discount)}</strong></div>}
            {area && fee > 0 && <div className="shp-total is-fee"><span>{tr('Delivery to {area}', { area: area.name })}</span><strong>+ {cedis(fee)}</strong></div>}
            <div className="shp-total"><span>{tr('Total')}</span><strong>{cedis(toPay)}</strong></div>
            <p className="shp-hint">{areas.length ? tr('Prices include what is charged on the invoice.') : tr('Prices include what is charged on the invoice; delivery is agreed with you on the phone.')}</p>
          </div>
        )}
        {ready && (
          <div className="shp-ready" role="note">
            <span className="shp-ready-ico" aria-hidden="true">🗓️</span>
            <span><strong>{tr('Made to order: ready in about {days}', { days: daysText(ready.days) })}</strong>
              <small>{tr('Between {from} and {to}. We will call you when it is ready.', { from: dayWords(ready.from), to: dayWords(ready.by) })}</small></span>
          </div>
        )}

        {lines.length > 0 && (
          <>
            <h3 className="shf-co-h">📝 {tr('Your details')}</h3>
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
            <div className="shf-pay">
              <button type="submit" className="shp-go is-big" disabled={busy || !lines.length || (how === 'delivery' && areas.length > 0 && !area)}>
                {busy ? tr('One moment…') : shop.payOnline ? '🔒 ' + tr('Pay {amount}', { amount: cedis(toPay) }) : tr('Place the order · {amount}', { amount: cedis(toPay) })}</button>
              <p className="shp-hint is-center">{shop.payOnline ? tr('Next: pay by card or Mobile Money. Your order is placed once it is paid.') : tr('Next: your invoice, with how to pay it. Your order is placed once it is paid.')}</p>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

// Placed without going on to pay (online payments off, or Paystack did not
// answer): what is left is to pay; the order starts once it is.
function Placed({ r, onShop }) {
  return (
    <div className="shp shp-done shf-done">
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

// One piece in the grid or a row: its photo (the second one on hover), a
// heart, what stands out about it, its price, and a quick "+".
function Card({ it, i, inCart, badge, saved, onSave, onOpen, onQuick, wide }) {
  const from = fromPrice(it);
  const quick = !it.soldOut && it.variations.length === 1 && !it.variations[0].soldOut;
  return (
    <article className={'shp-card shf-card' + (it.soldOut ? ' is-out' : '') + (wide ? ' is-wide' : '')} style={{ '--i': Math.min(i, 12) }}>
      <button type="button" className="shf-card-open" onClick={() => onOpen(it)} aria-label={it.name}>
        <span className="shp-card-pic">
          {it.photos[0] ? <img src={photoUrl(it.photos[0].id)} alt="" loading="lazy" /> : <span aria-hidden="true">🎋</span>}
          {it.photos[1] && <img className="shf-pic-2" src={photoUrl(it.photos[1].id)} alt="" loading="lazy" />}
          {inCart > 0 && <em className="shp-in">🧺 {inCart}</em>}
          {it.soldOut ? <em className="rst-card-out">{tr('Sold out')}</em> : badge && <em className={'shf-badge is-' + badge.kind}>{badge.text}</em>}
        </span>
        <span className="shp-card-body">
          <small className="shf-card-cat">{it.category}</small>
          <strong>{it.name}</strong>
          {it.stars ? <span className="shp-card-stars"><Stars value={it.stars.average} size="sm" /><em>{it.stars.average.toFixed(1)} ({it.stars.count})</em></span>
            : it.variations.length > 1 && <small>{tr('{n} choices', { n: it.variations.length })}</small>}
          {made(it.makeDays) && <em className="shp-made">🛠️ {tr('Made to order · {days}', { days: daysText(it.makeDays) })}</em>}
          <b>{it.variations.length > 1 ? <><small>{tr('from')}</small> {cedisShort(from)}</> : cedisShort(from)}</b>
        </span>
      </button>
      <Heart on={saved} onToggle={onSave} />
      {!it.soldOut && (
        <button type="button" className="shf-quick" onClick={() => (quick ? onQuick(it) : onOpen(it))} aria-label={quick ? tr('Add {name} to the basket', { name: it.name }) : tr('Choose for {name}', { name: it.name })} title={quick ? tr('Add to the basket') : tr('Choose a size or colour')}>
          {quick ? '+' : '›'}
        </button>
      )}
    </article>
  );
}

export default function ShopPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('featured');
  const [savedOnly, setSavedOnly] = useState(false);
  const [open, setOpen] = useState(null);
  const [cart, setCartState] = useState(loadCart);
  const [saved, setSavedState] = useState(loadSaved);
  const [checkout, setCheckout] = useState(false);
  const [placed, setPlaced] = useState(null);
  const [bump, setBump] = useState(0);
  const [me, setMe] = useState(null);
  const [going, setGoing] = useState(false);
  const [quote, setQuote] = useState(null); // { item } while asking for a quote
  const [toast, setToast] = useState(null);
  const listRef = useRef(null);
  useEffect(() => {
    call('GET', '/shop').then((d) => {
      setData(d); document.title = d.shop.title;
      // A link to one item (?item=…, as the back-in-stock message has): its sheet open.
      const id = new URLSearchParams(window.location.search).get('item');
      const it = id && d.items.find((i) => i.id === id);
      if (it) setOpen(it);
    }).catch((e) => setError(e.message));
  }, []);
  // Signed in to "My account": their details for the checkout.
  useEffect(() => {
    const token = loadToken();
    if (token) portalCall('GET', '/portal/me', null, token).then(setMe).catch((e) => { if (e.status === 401) saveToken(''); });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);
  function setCart(c) { setCartState(c); saveCart(c); }
  function toggleSaved(id) { const next = saved.includes(id) ? saved.filter((x) => x !== id) : saved.concat([id]); setSavedState(next); keepSaved(next); }
  function add(item, v, qty) {
    const have = cart.find((c) => c.variationId === v.id);
    setCart(have ? cart.map((c) => (c.variationId === v.id ? { ...c, qty: Math.min(999, c.qty + qty) } : c)) : cart.concat([{ itemId: item.id, variationId: v.id, qty }]));
    setOpen(null);
    setBump((b) => b + 1);
    setToast({ key: Date.now(), name: item.name, photo: item.photos[0] ? item.photos[0].id : null, qty });
  }
  function pickCategory(c) {
    setCat(c); setSavedOnly(false);
    if (listRef.current) listRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const items = useMemo(() => (data ? data.items : []), [data]);
  // What sells most (at least two sold), then the best rated: the favourites.
  const favourites = useMemo(() => items.filter((i) => !i.soldOut && (i.sold >= 2 || (i.stars && i.stars.average >= 4.5)))
    .sort((a, b) => b.sold - a.sold || ((b.stars ? b.stars.average : 0) - (a.stars ? a.stars.average : 0))).slice(0, 8), [items]);
  const popular = useMemo(() => new Set(items.filter((i) => !i.soldOut && i.sold >= 2).sort((a, b) => b.sold - a.sold).slice(0, 3).map((i) => i.id)), [items]);
  function badgeOf(it) {
    if (popular.has(it.id)) return { kind: 'hot', text: '🔥 ' + tr('Popular') };
    if (it.stars && it.stars.average >= 4.5 && it.stars.count >= 1) return { kind: 'star', text: '⭐ ' + tr('Top rated') };
    if (made(it.makeDays)) return { kind: 'made', text: '🛠️ ' + tr('Made for you') };
    return null;
  }
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = items.filter((i) => (!cat || i.category === cat) && (!savedOnly || saved.includes(i.id)) &&
      (!needle || (i.name + ' ' + i.description + ' ' + i.category).toLowerCase().includes(needle)));
    const by = {
      featured: (a, b) => b.sold - a.sold || ratedOf(b) - ratedOf(a) || a.name.localeCompare(b.name),
      popular: (a, b) => b.sold - a.sold || a.name.localeCompare(b.name),
      rated: (a, b) => ratedOf(b) - ratedOf(a) || a.name.localeCompare(b.name),
      low: (a, b) => fromPrice(a) - fromPrice(b),
      high: (a, b) => fromPrice(b) - fromPrice(a)
    }[sort];
    // Sold out last, however they are sorted.
    return list.slice().sort((a, b) => (a.soldOut ? 1 : 0) - (b.soldOut ? 1 : 0) || by(a, b));
  }, [items, cat, q, sort, savedOnly, saved]);
  const count = cart.reduce((a, c) => a + c.qty, 0);
  const total = cart.reduce((a, c) => { const it = items.find((i) => i.id === c.itemId); const v = it && it.variations.find((x) => x.id === c.variationId); return a + (v ? v.price * c.qty : 0); }, 0);
  const inCartOf = (id) => cart.filter((c) => c.itemId === id).reduce((a, c) => a + c.qty, 0);

  if (error) return <div className="shp shp-mid"><img src="/logo.png" alt="Bamboo Products Limited" className="shp-logo" /><h1>{tr('The shop is closed for now')}</h1><p>{error}</p></div>;
  if (!data) return <div className="shp shp-mid"><span className="shp-spin" aria-hidden="true">🎋</span><p>{tr('Loading…')}</p></div>;
  if (going) return <div className="shp shp-mid"><span className="shp-spin" aria-hidden="true">💳</span><h1>{tr('On to pay…')}</h1><p>{tr('Your order is placed as soon as it is paid.')}</p></div>;
  if (placed) return <Placed r={placed} onShop={() => setPlaced(null)} />;
  const s = data.shop;
  const withPhotos = items.filter((i) => i.photos.length && !i.soldOut).sort((a, b) => b.sold - a.sold || ratedOf(b) - ratedOf(a));
  const heroPicks = withPhotos.slice(0, 3);
  const reviewed = items.filter((i) => i.stars);
  const reviewCount = reviewed.reduce((a, i) => a + i.stars.count, 0);
  const reviewAvg = reviewCount ? Math.round((reviewed.reduce((a, i) => a + i.stars.average * i.stars.count, 0) / reviewCount) * 10) / 10 : null;
  const madeDays = items.map((i) => made(i.makeDays)).filter(Boolean);
  const perks = [
    ['🎋', tr('Handmade in Accra from Ghanaian bamboo')],
    s.delivery && ['🚚', s.areas && s.areas.length ? tr('Delivery to {n} areas', { n: s.areas.length }) : tr('Delivery to your door or site')],
    s.pickup && ['🏬', s.pickupAddress ? tr('Pickup at {place}', { place: s.pickupAddress }) : tr('Pickup at our showroom')],
    ['💳', s.payOnline ? tr('Pay by card or Mobile Money') : tr('Pay by bank or Mobile Money')],
    madeDays.length > 0 && ['🛠️', tr('Made to order for you')],
    s.quotes && ['📐', tr('Made to your size')],
    ['🌱', tr('A plant that grows back: kind to the planet')]
  ].filter(Boolean);
  const cats = data.categories.map((c) => {
    const inCat = items.filter((i) => i.category === c);
    const pic = inCat.find((i) => i.photos.length && !i.soldOut) || inCat.find((i) => i.photos.length);
    return { name: c, n: inCat.length, photo: pic ? pic.photos[0].id : null, from: inCat.length ? Math.min(...inCat.map(fromPrice)) : 0 };
  });

  return (
    <div className="shp shf">
      <StoreTop active="shop" me={me} count={count} bump={bump} onBasket={() => setCheckout(true)} />

      <header className="shf-hero">
        <span className="shf-blob is-a" aria-hidden="true" /><span className="shf-blob is-b" aria-hidden="true" />
        <svg className="shf-stalks" viewBox="0 0 200 400" aria-hidden="true" preserveAspectRatio="xMidYMax slice">
          {[30, 80, 130, 170].map((x, i) => (
            <g key={x} style={{ '--i': i }}>
              <rect x={x} y={40 + i * 30} width="14" height={400} rx="7" />
              {[0, 1, 2, 3, 4, 5].map((k) => <rect key={k} className="is-node" x={x - 2} y={80 + i * 30 + k * 62} width="18" height="5" rx="2.5" />)}
              <path className="is-leaf" d={`M${x + 7} ${70 + i * 30} q 40 -20 60 -6 q -34 14 -60 6 z`} />
            </g>
          ))}
        </svg>
        <div className="shf-hero-copy">
          <span className="shf-eyebrow">🎋 {tr('Handmade in Accra from Ghanaian bamboo')}</span>
          <h1>{s.title}</h1>
          {s.intro && <p>{s.intro}</p>}
          <div className="shf-ctas">
            <button type="button" className="shf-btn is-primary" onClick={() => pickCategory('')}>{tr('Shop the collection')} <span aria-hidden="true">↓</span></button>
            {s.quotes && <button type="button" className="shf-btn is-gold" onClick={() => setQuote({ item: null })}><span aria-hidden="true">📐</span> {tr('Made to your size')}</button>}
            <a className="shf-btn is-glass" href="/book"><span aria-hidden="true">📅</span> {tr('Book a consultation')}</a>
          </div>
          <div className="shf-proof">
            {reviewAvg !== null && <span><b>★ {reviewAvg.toFixed(1)}</b><small>{reviewCount === 1 ? tr('1 review') : tr('{n} reviews', { n: reviewCount })}</small></span>}
            <span><b>{items.length}</b><small>{items.length === 1 ? tr('piece to choose from') : tr('pieces to choose from')}</small></span>
            {data.categories.length > 1 && <span><b>{data.categories.length}</b><small>{tr('collections')}</small></span>}
          </div>
        </div>
        <div className="shf-hero-art" aria-hidden="true">
          {heroPicks.length ? heroPicks.map((it, i) => (
            <button key={it.id} type="button" tabIndex={-1} className={'shf-float shf-f' + i} onClick={() => setOpen(it)}>
              <img src={photoUrl(it.photos[0].id)} alt="" />
              <span><b>{it.name}</b><em>{cedisShort(fromPrice(it))}</em></span>
            </button>
          )) : <span className="shf-hero-emoji">🎋</span>}
        </div>
      </header>

      <div className="shf-marquee" aria-label={tr('Why shop with us')}>
        <div className="shf-marquee-track">
          {[0, 1].map((k) => (
            <span key={k} className="shf-marquee-set" aria-hidden={k === 1 ? 'true' : undefined}>
              {perks.map(([ic, text], i) => <span key={i}><i aria-hidden="true">{ic}</i>{text}</span>)}
            </span>
          ))}
        </div>
      </div>

      {cats.length > 1 && (
        <section className="shf-sec" aria-labelledby="shf-cats-h">
          <div className="shf-sec-head"><h2 id="shf-cats-h">{tr('Shop by collection')}</h2><p>{tr('Pick one to see its pieces.')}</p></div>
          <div className="shf-cats">
            {cats.map((c, i) => (
              <button key={c.name} type="button" className={'shf-cat' + (cat === c.name ? ' is-on' : '')} style={{ '--i': i }} onClick={() => pickCategory(cat === c.name ? '' : c.name)}>
                <span className="shf-cat-pic">{c.photo ? <img src={photoUrl(c.photo)} alt="" loading="lazy" /> : <span aria-hidden="true">{catIcon(c.name)}</span>}</span>
                <span className="shf-cat-words"><strong>{c.name}</strong><small>{c.n === 1 ? tr('1 piece') : tr('{n} pieces', { n: c.n })} · {tr('prices from {amount}', { amount: cedisShort(c.from) })}</small></span>
                <span className="shf-cat-go" aria-hidden="true">→</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {favourites.length > 1 && (
        <section className="shf-sec" aria-labelledby="shf-fav-h">
          <div className="shf-sec-head"><h2 id="shf-fav-h">🔥 {tr('Customers\' favourites')}</h2><p>{tr('What sells most, and what customers rate best.')}</p></div>
          <div className="shf-row">
            {favourites.map((it, i) => (
              <Card key={it.id} it={it} i={i} wide inCart={inCartOf(it.id)} badge={badgeOf(it)} saved={saved.includes(it.id)} onSave={() => toggleSaved(it.id)}
                onOpen={setOpen} onQuick={(x) => add(x, x.variations[0], 1)} />
            ))}
          </div>
        </section>
      )}

      <section className="shf-sec" id="shf-all" ref={listRef} aria-labelledby="shf-all-h">
        <div className="shf-sec-head"><h2 id="shf-all-h">{savedOnly ? '♥ ' + tr('Saved for later') : cat || tr('Every piece')}</h2><p>{shown.length === 1 ? tr('1 piece') : tr('{n} pieces', { n: shown.length })}</p></div>
        <div className="shp-bar shf-bar">
          <label className="shf-search"><span aria-hidden="true">🔎</span><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the shop')} aria-label={tr('Search the shop')} /></label>
          <div className="shp-cats" role="tablist" aria-label={tr('Categories')}>
            <button type="button" role="tab" aria-selected={!cat && !savedOnly} className={!cat && !savedOnly ? 'is-on' : ''} onClick={() => { setCat(''); setSavedOnly(false); }}>{tr('Everything')}</button>
            {data.categories.map((c) => <button key={c} type="button" role="tab" aria-selected={cat === c} className={cat === c ? 'is-on' : ''} onClick={() => setCat(cat === c ? '' : c)}><span aria-hidden="true">{catIcon(c)}</span> {c}</button>)}
            {saved.length > 0 && <button type="button" role="tab" aria-selected={savedOnly} className={'shf-saved-chip' + (savedOnly ? ' is-on' : '')} onClick={() => setSavedOnly(!savedOnly)}>♥ {tr('Saved')} <b>{saved.length}</b></button>}
          </div>
          <label className="shf-sort"><span>{tr('Sort')}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label={tr('Sort')}>
              {sorts().map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </label>
        </div>
        {!shown.length ? (
          <div className="shf-nothing"><span aria-hidden="true">{savedOnly ? '♡' : '🔍'}</span><strong>{savedOnly ? tr('Nothing saved yet') : tr('Nothing matches. Try another word.')}</strong>
            {savedOnly && <small>{tr('Press the heart on a piece to keep it here.')}</small>}</div>
        ) : (
          <div className="shp-grid shf-grid">
            {shown.map((it, i) => (
              <Card key={it.id} it={it} i={i} inCart={inCartOf(it.id)} badge={badgeOf(it)} saved={saved.includes(it.id)} onSave={() => toggleSaved(it.id)}
                onOpen={setOpen} onQuick={(x) => add(x, x.variations[0], 1)} />
            ))}
          </div>
        )}
      </section>

      <section className="shf-sec shf-how" aria-labelledby="shf-how-h">
        <div className="shf-sec-head"><h2 id="shf-how-h">{tr('How it works')}</h2></div>
        <ol>
          <li style={{ '--i': 0 }}><span className="shf-how-n">1</span><span className="shf-how-ic" aria-hidden="true">🛋️</span><strong>{tr('Choose your piece')}</strong><small>{tr('Pick a size or a colour, or ask for one made to your size.')}</small></li>
          <li style={{ '--i': 1 }}><span className="shf-how-n">2</span><span className="shf-how-ic" aria-hidden="true">🔒</span><strong>{tr('Pay safely')}</strong><small>{s.payOnline ? tr('By card or Mobile Money, on a secure page.') : tr('By bank transfer or Mobile Money, as the invoice says.')}</small></li>
          <li style={{ '--i': 2 }}><span className="shf-how-n">3</span><span className="shf-how-ic" aria-hidden="true">🛠️</span><strong>{tr('We make it')}</strong><small>{madeDays.length ? tr('Pieces made to order take a few days; you can follow your order online.') : tr('We prepare your order and you can follow it online.')}</small></li>
          <li style={{ '--i': 3 }}><span className="shf-how-n">4</span><span className="shf-how-ic" aria-hidden="true">{s.delivery ? '🚚' : '🏬'}</span><strong>{s.delivery ? tr('Delivered to you') : tr('Collect it')}</strong><small>{s.delivery && s.pickup ? tr('To your door or site, or picked up at our showroom.') : s.delivery ? tr('To your door or site.') : tr('At our showroom.')}</small></li>
        </ol>
      </section>

      {data.highlights && data.highlights.length > 0 && (
        <section className="shf-sec shf-voices" aria-labelledby="shf-voices-h">
          <div className="shf-sec-head"><h2 id="shf-voices-h">💬 {tr('What customers say')}</h2>{reviewAvg !== null && <p><Stars value={reviewAvg} size="sm" /> {tr('{avg} out of 5 from {n} reviews', { avg: reviewAvg.toFixed(1), n: reviewCount })}</p>}</div>
          <div className="shf-voices-row">
            {data.highlights.map((r, i) => {
              const it = items.find((x) => x.id === r.itemId);
              return (
                <figure key={r.id} style={{ '--i': i }}>
                  <Stars value={r.rating} size="sm" />
                  <blockquote>“{r.words}”</blockquote>
                  <figcaption><span className="shf-voice-av" aria-hidden="true">{(r.name || '?').trim().charAt(0).toUpperCase()}</span><span><b>{r.name}</b>{it && <button type="button" onClick={() => setOpen(it)}>{tr('on {item}', { item: r.itemName })}</button>}</span></figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}

      <section className="shf-band">
        <span className="shf-band-art" aria-hidden="true">📐</span>
        <div><h2>{tr('Something made just for you?')}</h2><p>{tr('A table for your room, blinds for your windows, a gazebo for your garden: tell us the size and we send you a price.')}</p></div>
        <div className="shf-band-acts">
          {s.quotes && <button type="button" className="shf-btn is-gold" onClick={() => setQuote({ item: null })}>📐 {tr('Ask for a quote')}</button>}
          <a className="shf-btn is-glass" href="/book">📅 {tr('Book a consultation')}</a>
        </div>
      </section>

      <StoreFoot shop={s} categories={data.categories} onCategory={pickCategory} />

      {count > 0 && (
        <button type="button" className="shp-basket shf-basket" key={bump} onClick={() => setCheckout(true)}>
          <span className="shp-basket-n">{count}</span><span>{tr('Your basket')}</span><strong>{cedis(total)}</strong>
        </button>
      )}
      {toast && (
        <div className="shf-toast" key={toast.key} role="status">
          <span className="shf-toast-burst" aria-hidden="true">{['🎋', '🌿', '✨', '🍃', '✨'].map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
          {toast.photo ? <img src={photoUrl(toast.photo)} alt="" /> : <span className="shf-toast-ic" aria-hidden="true">🎋</span>}
          <span><strong>{tr('Added to your basket')}</strong><small>{toast.qty > 1 ? toast.qty + ' × ' : ''}{toast.name}</small></span>
          <button type="button" onClick={() => { setToast(null); setCheckout(true); }}>{tr('View basket')}</button>
        </div>
      )}
      {open && <ItemSheet key={open.id} item={open} items={items} me={me} saved={saved.includes(open.id)} onSave={() => toggleSaved(open.id)} onAdd={add} onOpen={setOpen} onClose={() => setOpen(null)}
        onQuote={s.quotes ? (it) => { setOpen(null); setQuote({ item: it }); } : null} />}
      {quote && <QuoteSheet item={quote.item} me={me} onClose={() => setQuote(null)} />}
      {checkout && <Checkout shop={s} cart={cart} items={items} setCart={setCart} me={me} onClose={() => setCheckout(false)}
        onDone={(r) => {
          setCart([]); setCheckout(false);
          // Straight on to Paystack's page, back to the order's own page.
          if (r.payUrl) { setGoing(true); window.location.assign(r.payUrl); return; }
          setPlaced(r); window.scrollTo(0, 0);
        }} />}
    </div>
  );
}
