import { useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme, saveTheme } from '../../lib/theme';
import ThemeSwitch from '../../components/ThemeSwitch';
import DeviceLanguage from '../../components/DeviceLanguage';
import DeliveryMap from '../delivery/DeliveryMap';
import { dayName, kmText, laterText, minText, payName } from '../delivery/dlShared';
import ItemSheet from './ItemSheet';
import { DishAllergens, DishFlags, DishPrice, LineAmount } from './DishBits';
import { happySaved, lineKey, loadAccount, photo, saveAccount, tint } from './onlineShared';
import AccountSheet from './AccountSheet';
import BookSheet from './BookSheet';
import { GiftBuySheet } from './GiftBuy';
import { billOf, modsWords, serviceWords } from '../till/tillBill';
import { dealWords } from '../till/promos';
import PromoCodeDialog from '../till/PromoCode';
import './online.css';

// Until when the restaurant is busy (Ghana keeps UTC all year, as the till does).
function busyTime(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); }

// The restaurant's website (online.starbartema.com): its menu with photos,
// a basket, and checkout — delivered to a pin dropped on the map (or this
// phone's location), or picked up — paid on delivery or at pickup, in cash
// or by Mobile Money — as soon as it can be, or for a day and a time the
// restaurant offers (even while it is not taking orders now). The order
// waits for the restaurant to accept it (backend restaurantOnline place);
// the customer then follows it (OnlineTrack.jsx). The fee is worked out here as the server does it, by
// road from the restaurant (restaurantDelivery quote), and checked there.

const ME_KEY = 'bamboo.online.me';
const ORDERS_KEY = 'bamboo.online.orders';
function load(key, dflt) { try { return JSON.parse(localStorage.getItem(key) || 'null') || dflt; } catch { return dflt; } }
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not kept */ } }
function roadKm(a, b) {
  if (!a || !b) return null;
  const R = 6371, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)) * 1.3 * 10) / 10;
}
// The times on offer one day, from its first to its last, step minutes apart.
function slotsOf(from, to, step) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const out = [];
  for (let x = m(from); x <= m(to); x += step) out.push(String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'));
  return out;
}
function partOf(t) { const h = Number(t.slice(0, 2)); return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening'; }
const PARTS = [['morning', '🌅', () => tr('Morning')], ['afternoon', '☀️', () => tr('Afternoon')], ['evening', '🌙', () => tr('Evening')]];

// onTrackMine(order): follow an order of the signed-in customer's (their account).
export default function OnlineShop({ code, onTrack, onTrackMine, onBooking }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [item, setItem] = useState(null);
  const [basket, setBasket] = useState([]);
  const [checkout, setCheckout] = useState(false);
  const [mine] = useState(() => load(ORDERS_KEY, []));
  // The customer's own account on this phone (AccountSheet.jsx), and its sheet.
  const [account, setAccount] = useState(loadAccount);
  // Signed in on this phone: the account as it is now (an address saved on
  // another phone), or signed out when the sign-in has run out.
  useEffect(() => {
    const a = loadAccount();
    if (!a) return;
    posFetch('GET', '/pos/online/account', a.token).then((d) => { const now = { token: a.token, account: d.account }; saveAccount(now); setAccount(now); })
      .catch((e) => { if (e.status === 401) { saveAccount(null); setAccount(null); } });
  }, []);
  const [acctOpen, setAcctOpen] = useState(false);
  const [bookOpen, setBookOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const sections = useRef({});
  useEffect(() => { applyTheme(theme); saveTheme(theme); }, [theme]);
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
  // An earlier order again: its dishes as the menu has them now (gone ones left out).
  function reorder(o) {
    if (o.restaurant.code !== data.restaurant.code) return;
    o.items.forEach((l) => {
      const it = data.items.find((i) => i.id === l.menuItemId);
      if (!it || it.soldOut || it.notNow) return;
      const v = l.variationId ? it.variations.find((x) => x.id === l.variationId) : null;
      if (it.variations.length && !v) return;
      const opts = (it.addOns || []).flatMap((g) => g.options);
      const mods = (l.modifiers || []).map((m) => opts.find((x) => x.id === m.id)).filter(Boolean);
      const price = (v ? v.price : it.price) + mods.reduce((a, m) => a + m.price, 0);
      add({ id: it.id, variationId: v ? v.id : null, name: it.name + (v ? ' — ' + v.name : ''), price: Math.round(price * 100) / 100, qty: l.qty, note: l.note || '', modifiers: mods, happy: it.happy || null });
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
  const later = r.later && r.later.on ? r.later : null;
  const firstLater = later ? later.days[0] : null;
  return (
    <div className="on-shell" data-brand={r.code}>
      <header className="on-hero">
        <div className="on-hero-bg" aria-hidden="true"><span>🍗</span><span>🥤</span><span>🍚</span><span>🌶️</span><span>🍔</span><span>🥗</span></div>
        <div className="on-hero-tools">
          <button type="button" className={'on-acct-btn' + (account ? ' is-in' : '')} onClick={() => setAcctOpen(true)}>
            <span aria-hidden="true">{account ? (account.account.name || '?').replace(/^zq\s+/i, '').charAt(0).toUpperCase() : '👤'}</span>
            {account ? tr('Hi, {name}', { name: String(account.account.name || '').split(' ').slice(0, 2).join(' ') }) : tr('Sign in')}
          </button>
          <DeviceLanguage className="on-lang" /><ThemeSwitch theme={theme} onChange={setTheme} className="on-icon-btn" />
        </div>
        <div className="on-hero-main">
          {logo ? <img className="on-logo" src={logo} alt="" /> : <span className="on-logo is-mark">🍽️</span>}
          <div>
            <h1>{r.name}</h1>
            <p className={'on-open' + (r.open ? ' is-on' : later ? ' is-later' : '')}><i />{r.open ? tr('Open for orders') : later ? tr('Closed now · order for later') : tr('Not taking orders right now')}</p>
          </div>
        </div>
        <div className="on-facts">
          {r.delivery && <span>🛵 <b>{tr('Delivery')}</b> {tr('about {m}', { m: minText(r.readyMinutes + rideMin) })} · {tr('from {fee}', { fee: money(r.fee.base) })}</span>}
          {r.pickup && <span>🥡 <b>{tr('Pickup')}</b> {tr('about {m}', { m: minText(r.readyMinutes) })}</span>}
          {later && <span className="is-later">🗓️ <b>{tr('Order for later')}</b> {r.open ? tr('choose a day and a time') : tr('from {when}', { when: laterText(firstLater.date + 'T' + (firstLater.from.delivery || firstLater.from.pickup) + ':00Z') })}</span>}
          <span>💵 {tr('Pay on delivery: cash or Mobile Money')}</span>
          {r.location && r.location.address && <span>📍 {r.location.address}</span>}
        </div>
        {r.busy && r.open && (
          <p className={'on-busy is-' + r.busy.mode} role="status">
            <span aria-hidden="true">{r.busy.mode === 'paused' ? '⏸️' : '🔥'}</span>
            <span>{r.busy.mode === 'paused'
              ? <><b>{tr('We are very busy right now')}</b> {later ? tr('New orders are paused until {time}: order for later instead.', { time: busyTime(r.busy.until) }) : tr('New orders are paused until {time}. Thank you for your patience!', { time: busyTime(r.busy.until) })}</>
              : <><b>{tr('We are busy right now')}</b> {tr('Orders take about {n} min longer than usual, until {time}.', { n: r.busy.extraMinutes, time: busyTime(r.busy.until) })}</>}</span>
          </p>
        )}
        {r.note && <p className="on-note">{r.note}</p>}
        {(r.book || r.gift) && (
          <div className="on-hero-btns">
            {r.book && <button type="button" className="on-book-btn" onClick={() => setBookOpen(true)}><span aria-hidden="true">📅</span>{tr('Book a table')}<b aria-hidden="true">→</b></button>}
            {r.gift && <button type="button" className="on-book-btn is-gift" onClick={() => setGiftOpen(true)}><span aria-hidden="true">🎁</span>{tr('Send a gift card')}<b aria-hidden="true">→</b></button>}
          </div>
        )}
      </header>

      {last && (
        <button type="button" className="on-mine" onClick={() => onTrack(last.token)}>
          <span aria-hidden="true">🧾</span><span><strong>{tr('Your order {ref}', { ref: last.ref })}</strong><small>{tr('See where it is')}</small></span><b>→</b>
        </button>
      )}

      {/* The deals on the website now (backend restaurantPromos shown): they go on the basket by themselves. */}
      {((r.bill && r.bill.promotions) || []).length > 0 && (
        <div className="on-deals" aria-label={tr('Deals today')}>
          {r.bill.promotions.map((p) => <span key={p.id} className="on-deal"><b>🎟️ {p.name}</b><small>{dealWords(p, tr, money)}{p.minSpend > 0 ? ' · ' + tr('from {amount}', { amount: money(p.minSpend) }) : ''}{p.from ? ' · ' + p.from + '–' + p.to : ''}</small></span>)}
        </div>
      )}

      <nav className="on-cats" aria-label={tr('Menu sections')}>
        <label className="on-search"><span aria-hidden="true">🔎</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the menu')} aria-label={tr('Search the menu')} /></label>
        <div className="on-cat-row">
          {shown.map(([c]) => <button key={c} type="button" className={cat === c ? 'is-on' : ''} onClick={() => jump(c)}>{c || tr('Other')}</button>)}
        </div>
      </nav>

      <div className="on-body">
        <main className="on-menu">
          {!shown.length && (data.items.length
            ? <div className="on-empty"><span aria-hidden="true">🔎</span><strong>{tr('Nothing called that')}</strong></div>
            : <div className="on-empty"><span aria-hidden="true">🍽️</span><strong>{tr('Nothing on the menu online right now')}</strong>{r.phone && <p>{tr('Questions? Call {phone}.', { phone: r.phone })}</p>}</div>)}
          {shown.map(([c, list]) => (
            <section key={c} ref={(el) => { sections.current[c] = el; }} className="on-sec">
              <h2>{c || tr('Other')}<small>{list.length}</small></h2>
              <div className="on-grid">
                {list.map((i) => {
                  const inBasket = basket.filter((l) => l.id === i.id).reduce((s, l) => s + l.qty, 0);
                  return (
                    <button key={i.id} type="button" className={'on-dish' + (i.soldOut || i.notNow ? ' is-out' : '') + (inBasket ? ' is-in' : '') + (i.happy ? ' is-happy' : '')} disabled={i.soldOut} onClick={() => setItem(i)}>
                      <span className="on-dish-pic" style={{ '--c': tint(i.name) }}>
                        {i.photoFull ? <img src={photo(i.photoFull)} alt="" loading="lazy" decoding="async" /> : <b>{i.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
                        {inBasket > 0 && <em>{inBasket}</em>}
                        {i.soldOut && <span className="on-sold">{tr('Sold out')}</span>}
                        <DishFlags item={i} />
                      </span>
                      <span className="on-dish-text">
                        <strong>{i.name}</strong>
                        <DishPrice item={i} />
                        <DishAllergens item={i} />
                      </span>
                      {!i.soldOut && !i.notNow && <span className="on-plus" aria-hidden="true">+</span>}
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
          <Basket basket={basket} subtotal={subtotal} setQty={setQty} onCheckout={() => setCheckout(true)} open={r.open} later={!!later} />
        </aside>
      </div>

      {count > 0 && (
        <button type="button" className="on-bar" onClick={() => setCheckout(true)}>
          <span className="on-bar-n">{count}</span><span>{tr('View basket')}</span><strong>{money(subtotal - happySaved(basket))}</strong>
        </button>
      )}
      {item && <ItemSheet item={item} onClose={() => setItem(null)} onAdd={(line) => { add(line); setItem(null); }} />}
      {giftOpen && <GiftBuySheet code={code} restaurant={r} account={account} onClose={() => setGiftOpen(false)} />}
      {bookOpen && <BookSheet code={code} account={account} onClose={() => setBookOpen(false)} onBooked={(b) => { setBookOpen(false); onBooking(b.token); }} />}
      {acctOpen && <AccountSheet account={account} onAccount={setAccount} onClose={() => setAcctOpen(false)}
        onFollow={(o) => { setAcctOpen(false); onTrackMine(o); }} onReorder={(o) => { reorder(o); setAcctOpen(false); }} />}
      {checkout && (
        <Checkout code={code} r={r} items={data.items} basket={basket} subtotal={subtotal} setQty={setQty} onClose={() => setCheckout(false)} account={account} onSignIn={() => { setCheckout(false); setAcctOpen(true); }}
          onPlaced={(res, leaving) => { save(ORDERS_KEY, [{ ref: res.ref, token: res.token, at: Date.now() }].concat(mine).slice(0, 5)); setBasket([]); if (!leaving) onTrack(res.token); }} />
      )}
    </div>
  );
}

function Basket({ basket, subtotal, setQty, onCheckout, open, later }) {
  if (!basket.length) return <div className="on-basket-empty"><span aria-hidden="true">🧺</span><strong>{tr('Your basket is empty')}</strong><p>{tr('Tap a dish to add it.')}</p></div>;
  return (
    <div className="on-basket-box">
      <h3>{tr('Your basket')}</h3>
      <ul className="on-lines">
        {basket.map((l) => (
          <li key={lineKey(l)}>
            <span className="on-line-text"><strong>{l.name}</strong>{(l.modifiers || []).length > 0 && <small className="on-line-mods">+ {modsWords(l.modifiers, tr)}</small>}{l.note && <small>{l.note}</small>}</span>
            <span className="on-qty">
              <button type="button" onClick={() => setQty(lineKey(l), l.qty - 1)} aria-label={tr('One less')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(lineKey(l), l.qty + 1)} aria-label={tr('One more')}>+</button>
            </span>
            <LineAmount line={l} />
          </li>
        ))}
      </ul>
      <div className="on-sum"><span>{tr('Food')}</span><strong>{money(subtotal - happySaved(basket))}</strong></div>
      <button type="button" className="on-go" disabled={!open && !later} onClick={onCheckout}>{open ? tr('Checkout') : later ? '🗓️ ' + tr('Order for later') : tr('Not taking orders right now')}</button>
    </div>
  );
}

// Checkout: delivered or picked up; when; where; who; how they pay.
function Checkout({ code, r, items, basket, subtotal, setQty, onClose, onPlaced, account, onSignIn }) {
  // A deal's promo code typed (till/PromoCode.jsx): its deal, looked up with the restaurant.
  const [promo, setPromo] = useState(null); // { code, deal }
  const [promoOpen, setPromoOpen] = useState(false);
  // Signed in: their name, number and saved place, unless this phone has its own.
  const acct = account ? account.account : null;
  const kept = load(ME_KEY, {});
  const remembered = acct ? { name: acct.name, phone: acct.phone ? '+' + acct.phone : '', address: acct.address || kept.address, landmark: acct.landmark || kept.landmark,
    lat: acct.lat != null ? acct.lat : kept.lat, lng: acct.lat != null ? acct.lng : kept.lng } : kept;
  const [saveAddress, setSaveAddress] = useState(!!acct && !acct.address);
  const [how, setHow] = useState(r.delivery ? 'delivery' : 'pickup');
  const [name, setName] = useState(remembered.name || '');
  const [phone, setPhone] = useState(remembered.phone || '');
  const [address, setAddress] = useState(remembered.address || '');
  const [landmark, setLandmark] = useState(remembered.landmark || '');
  const [pin, setPin] = useState(remembered.lat != null ? { lat: remembered.lat, lng: remembered.lng } : null);
  const payOnline = (r.payMethods || []).includes('online');
  const [pay, setPay] = useState(payOnline ? 'online' : 'cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [locating, setLocating] = useState(false);
  const [fitKey, setFitKey] = useState('start');
  const later = r.later && r.later.on ? r.later : null;
  // Paused (busy mode on the till): only orders for later.
  const paused = !!(r.busy && r.busy.mode === 'paused');
  const [when, setWhen] = useState(r.open && !paused ? 'now' : 'later');
  const [day, setDay] = useState(null);
  const [time, setTime] = useState(null);
  const website = useRef(null);
  const here = r.location ? { lat: r.location.lat, lng: r.location.lng } : null;
  const km = how === 'delivery' ? roadKm(here, pin) : null;
  const fee = how === 'delivery' ? (r.fee.freeOver > 0 && subtotal >= r.fee.freeOver ? 0 : Math.round(r.fee.base + (km != null ? r.fee.perKm * km : 0))) : 0;
  const tooFar = how === 'delivery' && km != null && r.maxKm > 0 && km > r.maxKm;
  const short = r.minOrder > 0 && subtotal < r.minOrder;
  // The service charge and taxes the restaurant adds on this kind of order,
  // as the server works them out (restaurantOnline chargesOf).
  // And a deal (till/promos.js): on the dishes it is on, by itself or with its code.
  const cats = new Map((items || []).map((i) => [i.id, i.category]));
  const rules = { ...(r.bill || {}), promotions: ((r.bill && r.bill.promotions) || []).concat(promo ? [promo.deal] : []) };
  const bill = billOf(basket.map((l) => ({ price: l.price, qty: l.qty, menuItemId: l.id, category: cats.get(l.id) || '', discountSpec: l.happy ? { kind: 'percent', value: l.happy.percent, name: l.happy.name } : null })).concat(fee > 0 ? [{ price: fee, qty: 1, fee: true }] : []),
    { promoCode: promo ? promo.code : null }, rules, how, { channel: 'online' });
  const otherOff = Math.round((bill.discountTotal - (bill.deal ? bill.deal.amount : 0)) * 100) / 100;
  // For later: the days with a time left for delivery (or pickup), the one chosen, its times.
  const days = later ? later.days.filter((d) => d.from[how]) : [];
  const dayRow = days.find((d) => d.date === day) || days[0] || null;
  const slots = dayRow ? slotsOf(dayRow.from[how], dayRow.to, later.step) : [];
  const chosen = when === 'later' && slots.includes(time) ? time : null;
  const scheduledFor = chosen ? dayRow.date + 'T' + chosen + ':00.000Z' : null;
  const ready = name.trim() && phone.replace(/\D/g, '').length >= 9 && (how === 'pickup' || (pin && address.trim())) && !tooFar && !short && basket.length && (when === 'now' ? r.open && !paused : !!chosen);

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
      const res = await posFetch('POST', '/pos/online/' + encodeURIComponent(code) + '/orders', account ? account.token : null, {
        name, phone, fulfillment: how, address, landmark, lat: how === 'delivery' && pin ? pin.lat : null, lng: how === 'delivery' && pin ? pin.lng : null,
        payMethod: pay, note, website: website.current ? website.current.value : '', scheduledFor: scheduledFor || undefined, saveAddress: account && how === 'delivery' ? saveAddress : undefined, promoCode: promo ? promo.code : undefined,
        items: basket.map((l) => ({ menuItemId: l.id, variationId: l.variationId || undefined, qty: l.qty, note: l.note || undefined, modifiers: (l.modifiers || []).map((m) => ({ id: m.id })) }))
      });
      // Paid online: on to Paystack's page; it brings them back to the order's.
      if (res.payUrl) { save(ME_KEY, { name: name.trim(), phone: phone.trim(), address: address.trim(), landmark: landmark.trim(), lat: pin ? pin.lat : null, lng: pin ? pin.lng : null }); onPlaced(res, true); window.location.assign(res.payUrl); return; }
      onPlaced(res);
    } catch (err) { setError(err.message); setBusy(false); }
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
              <span className="on-line-text"><strong>{l.name}</strong>{(l.modifiers || []).length > 0 && <small className="on-line-mods">+ {modsWords(l.modifiers, tr)}</small>}{l.note && <small>{l.note}</small>}</span>
              <span className="on-qty"><button type="button" onClick={() => setQty(lineKey(l), l.qty - 1)} aria-label={tr('One less')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(lineKey(l), l.qty + 1)} aria-label={tr('One more')}>+</button></span>
              <LineAmount line={l} />
            </li>
          ))}
        </ul>

        {r.delivery && r.pickup && (
          <div className="on-how" role="radiogroup" aria-label={tr('Delivery or pickup')}>
            <button type="button" role="radio" aria-checked={how === 'delivery'} className={how === 'delivery' ? 'is-on' : ''} onClick={() => setHow('delivery')}><span aria-hidden="true">🛵</span><strong>{tr('Delivery')}</strong><small>{tr('to your door')}</small></button>
            <button type="button" role="radio" aria-checked={how === 'pickup'} className={how === 'pickup' ? 'is-on' : ''} onClick={() => setHow('pickup')}><span aria-hidden="true">🥡</span><strong>{tr('Pickup')}</strong><small>{tr('at the counter')}</small></button>
          </div>
        )}

        {later && (
          <fieldset className="on-fs on-when">
            <legend>{tr('When')}</legend>
            <div className="on-how" role="radiogroup" aria-label={tr('When')}>
              <button type="button" role="radio" aria-checked={when === 'now'} className={when === 'now' ? 'is-on' : ''} disabled={!r.open || paused} onClick={() => setWhen('now')}>
                <span aria-hidden="true">⚡</span><strong>{tr('As soon as possible')}</strong><small>{paused ? tr('Paused for now') : r.open ? tr('about {m}', { m: minText(r.readyMinutes + (how === 'delivery' ? 10 : 0)) }) : tr('Closed now')}</small>
              </button>
              <button type="button" role="radio" aria-checked={when === 'later'} className={when === 'later' ? 'is-on' : ''} onClick={() => setWhen('later')}>
                <span aria-hidden="true">🗓️</span><strong>{tr('Later')}</strong><small>{chosen ? dayName(dayRow.date) + ' · ' + chosen : tr('choose a day and a time')}</small>
              </button>
            </div>
            {when === 'later' && (days.length ? (
              <>
                <div className="on-days" role="radiogroup" aria-label={tr('Day')}>
                  {days.map((d) => (
                    <button key={d.date} type="button" role="radio" aria-checked={dayRow.date === d.date} className={dayRow.date === d.date ? 'is-on' : ''} onClick={() => setDay(d.date)}>
                      <strong>{dayName(d.date)}</strong><small>{tr('from {time}', { time: d.from[how] })}</small>
                    </button>
                  ))}
                </div>
                <div className="on-times">
                  {PARTS.map(([k, icon, label]) => {
                    const list = slots.filter((t) => partOf(t) === k);
                    if (!list.length) return null;
                    return (
                      <div key={k} className="on-times-part" role="radiogroup" aria-label={label()}>
                        <span className="on-times-label"><span aria-hidden="true">{icon}</span> {label()}</span>
                        <div className="on-times-row">
                          {list.map((t) => <button key={t} type="button" role="radio" aria-checked={chosen === t} className={chosen === t ? 'is-on' : ''} onClick={() => setTime(t)}>{t}</button>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="on-hint">{how === 'pickup' ? tr('Ready at the counter at the time you choose.') : tr('At your door around the time you choose.')}</p>
              </>
            ) : <p className="on-dist is-bad">{how === 'delivery' ? tr('No delivery times left on offer: try pickup.') : tr('No pickup times left on offer: try delivery.')}</p>)}
          </fieldset>
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
            {account && <label className="on-check"><input type="checkbox" checked={saveAddress} onChange={(e) => setSaveAddress(e.target.checked)} />{tr('Keep this place in my account')}</label>}
          </fieldset>
        )}

        <fieldset className="on-fs">
          <legend>{tr('You')}</legend>
          {!account && <button type="button" className="on-acct-nudge" onClick={onSignIn}>👤 <span><b>{tr('Have an account? Sign in')}</b><small>{tr('Your details fill in by themselves, and your orders stay in your account.')}</small></span></button>}
          <div className="on-two">
            <label className="on-field"><span>{tr('Your name')}</span><input className="input" required value={name} maxLength={80} autoComplete="name" onChange={(e) => setName(e.target.value)} /></label>
            <label className="on-field"><span>{tr('Phone number')}</span><input className="input" required type="tel" inputMode="tel" autoComplete="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} placeholder="024 000 0000" /></label>
          </div>
          <input ref={website} className="on-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" />
        </fieldset>

        <fieldset className="on-fs">
          <legend>{tr('How you pay')}</legend>
          <div className={'on-how is-pay' + (payOnline ? ' is-three' : '')} role="radiogroup" aria-label={tr('How you pay')}>
            {payOnline && (
              <button type="button" role="radio" aria-checked={pay === 'online'} className={'is-online' + (pay === 'online' ? ' is-on' : '')} onClick={() => setPay('online')}>
                <span aria-hidden="true">💳</span><strong>{tr('Pay now')}</strong><small>{tr('Card or Mobile Money')}</small>
              </button>
            )}
            {['cash', 'mobile_money'].map((m) => (
              <button key={m} type="button" role="radio" aria-checked={pay === m} className={pay === m ? 'is-on' : ''} onClick={() => setPay(m)}><span aria-hidden="true">{m === 'cash' ? '💵' : '📱'}</span><strong>{payName(m)}</strong>
                <small>{how === 'delivery' ? tr('on delivery') : tr('at pickup')}</small></button>
            ))}
          </div>
          <label className="on-field"><span>{tr('A note for the restaurant')}</span><input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={tr('Optional')} /></label>
        </fieldset>

        <div className="on-total">
          <div><span>{tr('Food')}</span><b>{money(subtotal)}</b></div>
          {otherOff > 0 && <div className="is-happy"><span>🍹 {tr('Happy hour')}</span><b>−{money(otherOff)}</b></div>}
          {bill.deal && <div className="is-deal"><span>🎟️ {bill.deal.name}</span><b>−{money(bill.deal.amount)}</b></div>}
          <button type="button" className={'on-promo' + (promo ? ' is-set' : '')} onClick={() => setPromoOpen(true)}>
            🎟️ {promo ? tr('Code {code}', { code: promo.code }) + (bill.deal && bill.deal.code === promo.code ? '' : ' · ' + tr('not on this basket')) : tr('Have a promo code?')}
          </button>
          {how === 'delivery' && <div><span>{tr('Delivery')}{km != null ? ' · ' + kmText(km) : ''}</span><b>{fee ? money(fee) : tr('Free')}</b></div>}
          {bill.serviceCharge > 0 && <div><span>{serviceWords(bill.serviceName, tr)} {bill.serviceRate}%</span><b>{money(bill.serviceCharge)}</b></div>}
          {bill.taxes.filter((t) => !t.included).map((t) => <div key={t.name}><span>{t.name} {t.rate}%</span><b>{money(t.amount)}</b></div>)}
          <div className="is-total"><span>{tr('Total')}</span><strong>{money(bill.total)}</strong></div>
          {bill.taxes.filter((t) => t.included).map((t) => <div key={t.name} className="is-incl"><span>{tr('incl. {tax} {rate}%', { tax: t.name, rate: t.rate })}</span><b>{money(t.amount)}</b></div>)}
          {scheduledFor && <p className="on-when-sum">🗓️ {how === 'pickup' ? tr('Pickup {when}', { when: laterText(scheduledFor) }) : tr('Delivery {when}', { when: laterText(scheduledFor) })}</p>}
          {short && <p className="on-dist is-bad">{tr('The smallest order is {amount}.', { amount: money(r.minOrder) })}</p>}
        </div>
        {promoOpen && (
          <PromoCodeDialog promotions={[]} channel="online" current={promo ? promo.code : null}
            lookup={(c) => posFetch('GET', '/pos/online/' + encodeURIComponent(code) + '/promo?code=' + encodeURIComponent(c), null).then((x) => x.promo)}
            onApply={(c, deal) => { setPromo(c ? { code: c, deal } : null); setPromoOpen(false); }} onClose={() => setPromoOpen(false)} />
        )}
        {!r.open && !later && <p className="on-dist is-bad">{tr('Not taking orders right now')}</p>}
        {paused && !later && <p className="on-dist is-bad">{tr('Very busy: not taking orders until {time}.', { time: busyTime(r.busy.until) })}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="on-go is-big" disabled={busy || !ready}>{busy ? (pay === 'online' ? tr('On to pay…') : tr('Sending your order…')) : pay === 'online' ? '🔒 ' + tr('Pay {amount}', { amount: money(bill.total) }) : tr('Place order · {amount}', { amount: money(bill.total) })}</button>
        <p className="on-hint is-center">{pay === 'online' ? tr('Paid safely with Paystack. The restaurant gets your order once it is paid, and gives the money back if they cannot make it.')
          : scheduledFor ? tr('The restaurant confirms your order first, and starts cooking it in time. You can cancel until then.') : tr('The restaurant accepts your order first; you can watch it here all the way to your door.')}</p>
      </form>
    </div>
  );
}
