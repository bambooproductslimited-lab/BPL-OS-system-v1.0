import { useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { API_ORIGIN } from '../../api/client';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme, THEME_KEY } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';
import DeliveryMap from '../delivery/DeliveryMap';
import { kmText, minText, payName } from '../delivery/dlShared';
import './online.css';

// The restaurant's website (online.starbartema.com): its menu with photos,
// a basket, and checkout — delivered to a pin dropped on the map (or this
// phone's location), or picked up — paid on delivery or at pickup, in cash
// or by Mobile Money. The order waits for the restaurant to accept it
// (backend restaurantOnline place); the customer then follows it
// (OnlineTrack.jsx). The fee is worked out here as the server does it, by
// road from the restaurant (restaurantDelivery quote), and checked there.

const ME_KEY = 'bamboo.online.me';
const ORDERS_KEY = 'bamboo.online.orders';
function load(key, dflt) { try { return JSON.parse(localStorage.getItem(key) || 'null') || dflt; } catch { return dflt; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not kept */ } }
function photo(u) { return u ? API_ORIGIN + u : null; }
function roadKm(a, b) {
  if (!a || !b) return null;
  const R = 6371, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)) * 1.3 * 10) / 10;
}
const PALETTE = ['#f97316', '#ef4444', '#10b981', '#2563eb', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6'];
function tint(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
function lineKey(l) { return l.id + ':' + (l.variationId || '') + ':' + (l.note || ''); }

export default function OnlineShop({ code, onTrack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [item, setItem] = useState(null);
  const [basket, setBasket] = useState([]);
  const [checkout, setCheckout] = useState(false);
  const [mine] = useState(() => load(ORDERS_KEY, []));
  const sections = useRef({});
  useEffect(() => { applyTheme(theme); try { localStorage.setItem(THEME_KEY, theme); } catch { /* not kept */ } }, [theme]);
  useEffect(() => {
    posFetch('GET', '/pos/online/' + encodeURIComponent(code) + '/menu').then((d) => { setData(d); document.title = d.restaurant.name + ' · ' + tr('Order online'); }).catch((e) => setError(e.message));
  }, [code]);

  const shown = useMemo(() => {
    if (!data) return [];
    const words = q.trim().toLowerCase();
    return data.categories.map((c) => [c, data.items.filter((i) => i.category === c && (!words || i.name.toLowerCase().includes(words)))]).filter(([, list]) => list.length);
  }, [data, q]);
  const count = basket.reduce((s, l) => s + l.qty, 0);
  const subtotal = Math.round(basket.reduce((s, l) => s + l.qty * l.price, 0) * 100) / 100;

  function add(line) {
    setBasket((b) => {
      const k = lineKey(line);
      const at = b.findIndex((x) => lineKey(x) === k);
      if (at < 0) return b.concat([line]);
      return b.map((x, i) => (i === at ? { ...x, qty: Math.min(50, x.qty + line.qty) } : x));
    });
  }
  function setQty(k, qty) { setBasket((b) => (qty <= 0 ? b.filter((x) => lineKey(x) !== k) : b.map((x) => (lineKey(x) === k ? { ...x, qty: Math.min(50, qty) } : x)))); }
  function jump(c) {
    setCat(c);
    const el = sections.current[c];
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
  }

  if (error) return <div className="on-shell is-empty"><div className="on-empty"><span aria-hidden="true">🍽️</span><strong>{tr('This menu is not available')}</strong><p>{error}</p></div></div>;
  if (!data) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🍲</span><strong>{tr('Loading the menu…')}</strong></div></div>;
  const r = data.restaurant;
  const logo = restaurantLogoUrl(r.code);
  const last = mine[0];
  const rideMin = 10;
  return (
    <div className="on-shell" data-brand={r.code}>
      <header className="on-hero">
        <div className="on-hero-bg" aria-hidden="true"><span>🍗</span><span>🥤</span><span>🍚</span><span>🌶️</span><span>🍔</span><span>🥗</span></div>
        <div className="on-hero-tools"><DeviceLanguage className="on-lang" /><button type="button" className="on-icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('Light mode') : tr('Dark mode')}>{theme === 'dark' ? '☀' : '☾'}</button></div>
        <div className="on-hero-main">
          {logo ? <img className="on-logo" src={logo} alt="" /> : <span className="on-logo is-mark">🍽️</span>}
          <div>
            <h1>{r.name}</h1>
            <p className={'on-open' + (r.open ? ' is-on' : '')}><i />{r.open ? tr('Open for orders') : tr('Not taking orders right now')}</p>
          </div>
        </div>
        <div className="on-facts">
          {r.delivery && <span>🛵 <b>{tr('Delivery')}</b> {tr('about {m}', { m: minText(r.readyMinutes + rideMin) })} · {tr('from {fee}', { fee: money(r.fee.base) })}</span>}
          {r.pickup && <span>🥡 <b>{tr('Pickup')}</b> {tr('about {m}', { m: minText(r.readyMinutes) })}</span>}
          <span>💵 {tr('Pay on delivery: cash or Mobile Money')}</span>
          {r.location && r.location.address && <span>📍 {r.location.address}</span>}
        </div>
        {r.note && <p className="on-note">{r.note}</p>}
      </header>

      {last && (
        <button type="button" className="on-mine" onClick={() => onTrack(last.token)}>
          <span aria-hidden="true">🧾</span><span><strong>{tr('Your order {ref}', { ref: last.ref })}</strong><small>{tr('See where it is')}</small></span><b>→</b>
        </button>
      )}

      <nav className="on-cats" aria-label={tr('Menu sections')}>
        <label className="on-search"><span aria-hidden="true">🔎</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the menu')} aria-label={tr('Search the menu')} /></label>
        <div className="on-cat-row">
          {shown.map(([c]) => <button key={c} type="button" className={cat === c ? 'is-on' : ''} onClick={() => jump(c)}>{c || tr('Other')}</button>)}
        </div>
      </nav>

      <div className="on-body">
        <main className="on-menu">
          {!shown.length && <div className="on-empty"><span aria-hidden="true">🔎</span><strong>{tr('Nothing called that')}</strong></div>}
          {shown.map(([c, list]) => (
            <section key={c} ref={(el) => { sections.current[c] = el; }} className="on-sec">
              <h2>{c || tr('Other')}<small>{list.length}</small></h2>
              <div className="on-grid">
                {list.map((i) => {
                  const inBasket = basket.filter((l) => l.id === i.id).reduce((s, l) => s + l.qty, 0);
                  const from = i.variations.length ? Math.min(...i.variations.map((v) => v.price)) : i.price;
                  return (
                    <button key={i.id} type="button" className={'on-dish' + (i.soldOut ? ' is-out' : '') + (inBasket ? ' is-in' : '')} disabled={i.soldOut} onClick={() => setItem(i)}>
                      <span className="on-dish-pic" style={{ '--c': tint(i.name) }}>
                        {i.photoFull ? <img src={photo(i.photoFull)} alt="" loading="lazy" decoding="async" /> : <b>{i.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
                        {inBasket > 0 && <em>{inBasket}</em>}
                        {i.soldOut && <span className="on-sold">{tr('Sold out')}</span>}
                      </span>
                      <span className="on-dish-text">
                        <strong>{i.name}</strong>
                        <span>{i.variations.length ? tr('from {price}', { price: money(from) }) : money(i.price)}</span>
                      </span>
                      {!i.soldOut && <span className="on-plus" aria-hidden="true">+</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          <footer className="on-foot">
            <p>{r.phone ? tr('Questions? Call {phone}.', { phone: r.phone }) : ''}</p>
            <small>{tr('Ordered here, paid on delivery or at pickup. The restaurant accepts each order before it is cooked.')}</small>
          </footer>
        </main>
        <aside className="on-basket" aria-label={tr('Your basket')}>
          <Basket basket={basket} subtotal={subtotal} setQty={setQty} onCheckout={() => setCheckout(true)} open={r.open} />
        </aside>
      </div>

      {count > 0 && (
        <button type="button" className="on-bar" onClick={() => setCheckout(true)}>
          <span className="on-bar-n">{count}</span><span>{tr('View basket')}</span><strong>{money(subtotal)}</strong>
        </button>
      )}
      {item && <ItemSheet item={item} onClose={() => setItem(null)} onAdd={(line) => { add(line); setItem(null); }} />}
      {checkout && (
        <Checkout code={code} r={r} basket={basket} subtotal={subtotal} setQty={setQty} onClose={() => setCheckout(false)}
          onPlaced={(res) => { save(ORDERS_KEY, [{ ref: res.ref, token: res.token, at: Date.now() }].concat(mine).slice(0, 5)); setBasket([]); onTrack(res.token); }} />
      )}
    </div>
  );
}

function Basket({ basket, subtotal, setQty, onCheckout, open }) {
  if (!basket.length) return <div className="on-basket-empty"><span aria-hidden="true">🧺</span><strong>{tr('Your basket is empty')}</strong><p>{tr('Tap a dish to add it.')}</p></div>;
  return (
    <div className="on-basket-box">
      <h3>{tr('Your basket')}</h3>
      <ul className="on-lines">
        {basket.map((l) => (
          <li key={lineKey(l)}>
            <span className="on-line-text"><strong>{l.name}</strong>{l.note && <small>{l.note}</small>}</span>
            <span className="on-qty">
              <button type="button" onClick={() => setQty(lineKey(l), l.qty - 1)} aria-label={tr('One less')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(lineKey(l), l.qty + 1)} aria-label={tr('One more')}>+</button>
            </span>
            <i>{money(l.qty * l.price)}</i>
          </li>
        ))}
      </ul>
      <div className="on-sum"><span>{tr('Food')}</span><strong>{money(subtotal)}</strong></div>
      <button type="button" className="on-go" disabled={!open} onClick={onCheckout}>{open ? tr('Checkout') : tr('Not taking orders right now')}</button>
    </div>
  );
}

// A dish: its photo, its size, how many, a note for the kitchen.
function ItemSheet({ item, onClose, onAdd }) {
  const [variation, setVariation] = useState(item.variations[0] || null);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const price = variation ? variation.price : item.price;
  return (
    <div className="on-sheet-back" onClick={onClose}>
      <div className="on-sheet" role="dialog" aria-modal="true" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
        <div className="on-sheet-pic" style={{ '--c': tint(item.name) }}>
          {item.photoFull ? <img src={photo(item.photoFull)} alt="" /> : <b>{item.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
          <button type="button" className="on-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <div className="on-sheet-body">
          <h2>{item.name}</h2>
          <p className="on-price">{money(price)}</p>
          {item.variations.length > 0 && (
            <div className="on-vars" role="radiogroup" aria-label={tr('Choose one')}>
              {item.variations.map((v) => (
                <button key={v.id} type="button" role="radio" aria-checked={variation && variation.id === v.id} className={variation && variation.id === v.id ? 'is-on' : ''} onClick={() => setVariation(v)}>
                  <span>{v.name}</span><b>{money(v.price)}</b>
                </button>
              ))}
            </div>
          )}
          <label className="on-field"><span>{tr('A note for the kitchen')}</span><input className="input" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. no pepper, extra sauce')} /></label>
          <div className="on-sheet-go">
            <span className="on-qty is-big"><button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label={tr('One less')}>−</button><b>{qty}</b><button type="button" onClick={() => setQty(Math.min(50, qty + 1))} aria-label={tr('One more')}>+</button></span>
            <button type="button" className="on-go" onClick={() => onAdd({ id: item.id, variationId: variation ? variation.id : null, name: item.name + (variation ? ' — ' + variation.name : ''), price, qty, note: note.trim() })}>
              {tr('Add · {amount}', { amount: money(price * qty) })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Checkout: delivered or picked up; where; who; how they pay.
function Checkout({ code, r, basket, subtotal, setQty, onClose, onPlaced }) {
  const remembered = load(ME_KEY, {});
  const [how, setHow] = useState(r.delivery ? 'delivery' : 'pickup');
  const [name, setName] = useState(remembered.name || '');
  const [phone, setPhone] = useState(remembered.phone || '');
  const [address, setAddress] = useState(remembered.address || '');
  const [landmark, setLandmark] = useState(remembered.landmark || '');
  const [pin, setPin] = useState(remembered.lat != null ? { lat: remembered.lat, lng: remembered.lng } : null);
  const [pay, setPay] = useState('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [locating, setLocating] = useState(false);
  const [fitKey, setFitKey] = useState('start');
  const website = useRef(null);
  const here = r.location ? { lat: r.location.lat, lng: r.location.lng } : null;
  const km = how === 'delivery' ? roadKm(here, pin) : null;
  const fee = how === 'delivery' ? (r.fee.freeOver > 0 && subtotal >= r.fee.freeOver ? 0 : Math.round(r.fee.base + (km != null ? r.fee.perKm * km : 0))) : 0;
  const tooFar = how === 'delivery' && km != null && r.maxKm > 0 && km > r.maxKm;
  const short = r.minOrder > 0 && subtotal < r.minOrder;
  const ready = name.trim() && phone.replace(/\D/g, '').length >= 9 && (how === 'pickup' || (pin && address.trim())) && !tooFar && !short && basket.length;

  function locate() {
    if (!navigator.geolocation) { setError(tr('This phone cannot tell where it is: tap the map instead.')); return; }
    setLocating(true); setError(null);
    navigator.geolocation.getCurrentPosition((p) => { setLocating(false); setPin({ lat: p.coords.latitude, lng: p.coords.longitude }); setFitKey('me' + Date.now()); },
      () => { setLocating(false); setError(tr('Location is off for this page: tap the map where you are.')); }, { enableHighAccuracy: true, timeout: 15000 });
  }
  async function place(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      save(ME_KEY, { name: name.trim(), phone: phone.trim(), address: address.trim(), landmark: landmark.trim(), lat: pin ? pin.lat : null, lng: pin ? pin.lng : null });
      const res = await posFetch('POST', '/pos/online/' + encodeURIComponent(code) + '/orders', null, {
        name, phone, fulfillment: how, address, landmark, lat: how === 'delivery' && pin ? pin.lat : null, lng: how === 'delivery' && pin ? pin.lng : null,
        payMethod: pay, note, website: website.current ? website.current.value : '',
        items: basket.map((l) => ({ menuItemId: l.id, variationId: l.variationId || undefined, qty: l.qty, note: l.note || undefined }))
      });
      onPlaced(res);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const markers = here ? [{ id: 'here', kind: 'restaurant', lat: here.lat, lng: here.lng, emoji: '🍽️', label: r.name, fit: true }] : [];
  return (
    <div className="on-sheet-back is-checkout" onClick={() => !busy && onClose()}>
      <form className="on-sheet on-checkout" role="dialog" aria-modal="true" aria-labelledby="on-co-title" onClick={(e) => e.stopPropagation()} onSubmit={place}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Back')}>←</button>
          <h2 id="on-co-title">{tr('Checkout')}</h2>
        </div>
        <ul className="on-lines">
          {basket.map((l) => (
            <li key={lineKey(l)}>
              <span className="on-line-text"><strong>{l.name}</strong>{l.note && <small>{l.note}</small>}</span>
              <span className="on-qty"><button type="button" onClick={() => setQty(lineKey(l), l.qty - 1)} aria-label={tr('One less')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(lineKey(l), l.qty + 1)} aria-label={tr('One more')}>+</button></span>
              <i>{money(l.qty * l.price)}</i>
            </li>
          ))}
        </ul>

        {r.delivery && r.pickup && (
          <div className="on-how" role="radiogroup" aria-label={tr('Delivery or pickup')}>
            <button type="button" role="radio" aria-checked={how === 'delivery'} className={how === 'delivery' ? 'is-on' : ''} onClick={() => setHow('delivery')}><span aria-hidden="true">🛵</span><strong>{tr('Delivery')}</strong><small>{tr('to your door')}</small></button>
            <button type="button" role="radio" aria-checked={how === 'pickup'} className={how === 'pickup' ? 'is-on' : ''} onClick={() => setHow('pickup')}><span aria-hidden="true">🥡</span><strong>{tr('Pickup')}</strong><small>{tr('at the counter')}</small></button>
          </div>
        )}

        {how === 'delivery' && (
          <fieldset className="on-fs">
            <legend>{tr('Where to bring it')}</legend>
            <p className="on-hint">{pin ? tr('Drag the pin to your door if it is not quite right.') : tr('Tap the map where you are, or use your location.')}</p>
            <div className="on-map">
              <DeliveryMap lite markers={markers} fitKey={fitKey} pick={pin} onPick={(lat, lng) => setPin({ lat, lng })} center={here ? [here.lat, here.lng] : undefined} zoom={13} />
              <button type="button" className="on-locate" onClick={locate} disabled={locating}>📍 {locating ? tr('Finding you…') : tr('Use my location')}</button>
            </div>
            {pin && km != null && <p className={'on-dist' + (tooFar ? ' is-bad' : '')}>{tooFar ? tr('{km} away: we deliver up to {max} km. Pick it up instead?', { km: kmText(km), max: r.maxKm }) : tr('{km} away by road · delivery {fee}', { km: kmText(km), fee: money(fee) })}</p>}
            <label className="on-field"><span>{tr('Address or area')}</span><input className="input" value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} placeholder={tr('e.g. East Legon, Lagos Avenue')} /></label>
            <label className="on-field"><span>{tr('How to find you')}</span><input className="input" value={landmark} maxLength={200} onChange={(e) => setLandmark(e.target.value)} placeholder={tr('e.g. blue gate opposite the pharmacy')} /></label>
          </fieldset>
        )}

        <fieldset className="on-fs">
          <legend>{tr('You')}</legend>
          <div className="on-two">
            <label className="on-field"><span>{tr('Your name')}</span><input className="input" required value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} /></label>
            <label className="on-field"><span>{tr('Phone number')}</span><input className="input" required type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} placeholder="024 000 0000" /></label>
          </div>
          <input ref={website} className="on-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" />
        </fieldset>

        <fieldset className="on-fs">
          <legend>{how === 'delivery' ? tr('Pay on delivery') : tr('Pay at pickup')}</legend>
          <div className="on-how is-pay" role="radiogroup" aria-label={tr('How you pay')}>
            {['cash', 'mobile_money'].map((m) => (
              <button key={m} type="button" role="radio" aria-checked={pay === m} className={pay === m ? 'is-on' : ''} onClick={() => setPay(m)}><span aria-hidden="true">{m === 'cash' ? '💵' : '📱'}</span><strong>{payName(m)}</strong></button>
            ))}
          </div>
          <label className="on-field"><span>{tr('A note for the restaurant')}</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={tr('Optional')} /></label>
        </fieldset>

        <div className="on-total">
          <div><span>{tr('Food')}</span><b>{money(subtotal)}</b></div>
          {how === 'delivery' && <div><span>{tr('Delivery')}{km != null ? ' · ' + kmText(km) : ''}</span><b>{fee ? money(fee) : tr('Free')}</b></div>}
          <div className="is-total"><span>{tr('Total')}</span><strong>{money(subtotal + fee)}</strong></div>
          {short && <p className="on-dist is-bad">{tr('The smallest order is {amount}.', { amount: money(r.minOrder) })}</p>}
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="on-go is-big" disabled={busy || !ready}>{busy ? tr('Sending your order…') : tr('Place order · {amount}', { amount: money(subtotal + fee) })}</button>
        <p className="on-hint is-center">{tr('The restaurant accepts your order first; you can watch it here all the way to your door.')}</p>
      </form>
    </div>
  );
}
