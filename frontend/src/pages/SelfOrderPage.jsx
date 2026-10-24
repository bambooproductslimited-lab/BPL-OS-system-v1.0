import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { money } from '../lib/currency';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import DeviceLanguage from '../components/DeviceLanguage';
import { tr } from '../lib/i18n.jsx';
import ItemSheet from './online/ItemSheet';
import { DishAllergens, DishFlags, DishPrice } from './online/DishBits';
import { lineKey, photo, tint } from './online/onlineShared';
import { billOf, modsWords } from './till/tillBill';
import { dealWords } from './till/promos';
import PromoCodeDialog from './till/PromoCode';
import './online/online.css';
import './SelfOrder.css';

// The self-order kiosk at the counter (backend restaurantKiosk; the till's
// side is till/Kiosks.jsx): a tablet opened at /self-order — on the till's
// website or in the OS — shows 6 numbers until the till pairs it. Then: a
// welcome screen; eat here or take away; the menu with photos, sizes and
// add-ons; the basket; a name to be called by; pay at the counter (the
// order waits on the till, K-0012) or pay here by card or Mobile Money
// (Paystack's page, then back here). The number to wait for, big. Untouched
// for a while, it goes back to the welcome screen for the next customer.

const KEY = 'bamboo.selforder.key';
function readKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function writeKey(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* kept for this visit */ } }
function r2(n) { return Math.round(Number(n) * 100) / 100; }
// Back here from Paystack: the payment to check.
function returnedRef() { try { return new URLSearchParams(window.location.search).get('reference') || ''; } catch { return ''; } }

export default function SelfOrderPage() {
  const [key, setKey] = useState(readKey);
  const [view, setView] = useState(null);
  const [menu, setMenu] = useState(null);
  const [offline, setOffline] = useState(false);
  const [stage, setStage] = useState(returnedRef() ? 'paying' : 'welcome'); // welcome | menu | checkout | done | paying
  const [dining, setDining] = useState('away');
  const [cat, setCat] = useState('');
  const [item, setItem] = useState(null);
  const [basket, setBasket] = useState([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // { ref, number, total, status, paid }
  const [promo, setPromo] = useState(null); // a promo code typed and its deal (till/PromoCode.jsx)
  const [promoOpen, setPromoOpen] = useState(false);
  const [payRef, setPayRef] = useState(returnedRef);
  const touched = useRef(Date.now());

  const hello = useCallback(async (k) => {
    try {
      const v = await posFetch('POST', '/pos/kiosk/hello', null, { key: k || undefined });
      writeKey(v.key); setKey(v.key); setOffline(false);
    } catch (err) { setOffline(true); setError(err.status === 429 ? err.message : null); }
  }, []);
  useEffect(() => { hello(readKey()); }, [hello]);
  // What the kiosk is (a code while it waits for the till), every few seconds.
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const ask = async () => {
      try { const v = await posFetch('GET', '/pos/kiosk', key); if (live) { setView(v); setOffline(false); } }
      catch (err) { if (!live) return; if (err.status === 401) { writeKey(''); setView(null); hello(''); } else setOffline(true); }
    };
    ask();
    const t = setInterval(ask, view && view.paired ? 15000 : 2500);
    return () => { live = false; clearInterval(t); };
  }, [key, hello, view && view.paired]); // eslint-disable-line react-hooks/exhaustive-deps
  // The menu, once paired, and again every few minutes (sold out, menu times).
  useEffect(() => {
    if (!view || !view.paired) return undefined;
    let live = true;
    const load = () => posFetch('GET', '/pos/kiosk/menu', key).then((m) => { if (live) setMenu(m); }).catch(() => {});
    load();
    const t = setInterval(load, 180000);
    return () => { live = false; clearInterval(t); };
  }, [view && view.paired, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Untouched for a while: back to the welcome screen for the next customer.
  function reset() { setStage('welcome'); setBasket([]); setName(''); setNote(''); setItem(null); setDone(null); setError(null); setCat(''); setPromo(null); }
  useEffect(() => {
    const poke = () => { touched.current = Date.now(); };
    ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, poke));
    const t = setInterval(() => {
      const idle = ((view && view.idleSeconds) || 90) * 1000;
      if (stage !== 'welcome' && stage !== 'paying' && Date.now() - touched.current > (stage === 'done' ? Math.min(idle, 30000) : idle)) reset();
    }, 2000);
    return () => { ['pointerdown', 'keydown'].forEach((e) => window.removeEventListener(e, poke)); clearInterval(t); };
  }, [stage, view]);

  // Back from Paystack: asked until it is paid or not.
  useEffect(() => {
    if (stage !== 'paying' || !payRef || !key) return undefined;
    let live = true;
    const ask = async () => {
      try {
        const r = await posFetch('GET', '/pos/kiosk/pay/' + encodeURIComponent(payRef), key);
        if (!live) return;
        if (r.paid || r.status === 'cancelled') {
          setDone({ ref: r.ref, number: r.ref, paid: r.paid, status: r.status, kitchen: r.kitchen });
          setStage('done'); setPayRef('');
          window.history.replaceState(null, '', window.location.pathname);
        }
      } catch (err) { if (live && err.status === 404) { setStage('welcome'); setPayRef(''); window.history.replaceState(null, '', window.location.pathname); } }
    };
    ask();
    const t = setInterval(ask, 3000);
    return () => { live = false; clearInterval(t); };
  }, [stage, payRef, key]);

  const count = basket.reduce((s, l) => s + l.qty, 0);
  // The dishes with their happy hour and a deal (till/promos.js: by itself,
  // or with the code typed); any service charge or tax goes on at the till.
  const bill = useMemo(() => {
    const cats = new Map(((menu && menu.items) || []).map((i) => [i.id, i.category]));
    const deals = ((menu && menu.bill && menu.bill.promotions) || []).concat(promo ? [promo.deal] : []);
    return billOf(basket.map((l) => ({ price: l.price, qty: l.qty, menuItemId: l.id, category: cats.get(l.id) || '', discountSpec: l.happy ? { kind: 'percent', value: l.happy.percent, name: l.happy.name } : null })),
      { promoCode: promo ? promo.code : null }, { promotions: deals }, dining === 'here' ? 'dine_in' : 'pickup', { channel: 'kiosk' });
  }, [basket, menu, promo, dining]);
  const subtotal = r2(bill.total);
  function add(line) {
    setBasket((b) => {
      const k = lineKey(line);
      const same = b.find((x) => lineKey(x) === k);
      return same ? b.map((x) => (x === same ? { ...x, qty: Math.min(20, x.qty + line.qty) } : x)) : b.concat([line]);
    });
    setItem(null);
  }
  function setQty(k, qty) { setBasket((b) => (qty <= 0 ? b.filter((x) => lineKey(x) !== k) : b.map((x) => (lineKey(x) === k ? { ...x, qty: Math.min(20, qty) } : x)))); }
  const shown = useMemo(() => (menu ? menu.categories.map((c) => [c, menu.items.filter((i) => i.category === c)]).filter(([, l]) => l.length) : []), [menu]);
  const visible = cat ? shown.filter(([c]) => c === cat) : shown;

  async function place(pay) {
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/kiosk/orders', key, {
        items: basket.map((l) => ({ menuItemId: l.id, variationId: l.variationId || undefined, qty: l.qty, note: l.note || undefined, modifiers: (l.modifiers || []).map((m) => ({ id: m.id })) })),
        dining, name: name.trim(), note: note.trim() || undefined, pay, back: window.location.origin + window.location.pathname, promoCode: promo ? promo.code : undefined
      });
      if (r.pay && r.pay.url) { window.location.href = r.pay.url; return; }
      setDone(r); setStage('done'); setBasket([]);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const restaurant = view && view.restaurant;
  const logo = restaurant ? restaurantLogoUrl(restaurant.code) : null;
  const brand = (
    <div className="so-brand">
      {logo ? <img src={logo} alt="" /> : <span className="so-brand-dot" aria-hidden="true">✦</span>}
      <b>{restaurant ? restaurant.name : ''}</b>
    </div>
  );

  if (!view || !view.paired) {
    return (
      <div className="so so-pair">
        <div className="so-orbs" aria-hidden="true"><i /><i /><i /></div>
        <div className="so-pair-card">
          <span className="so-pair-ico" aria-hidden="true">🧾</span>
          <h1>{tr('Self-order kiosk')}</h1>
          {view && view.code ? (
            <>
              <p>{tr('On the till: More → Self-order kiosk, and type these numbers.')}</p>
              <div className="so-code" aria-label={tr('Pairing code')}>{String(view.code).split('').map((d, i) => <span key={i}>{d}</span>)}</div>
            </>
          ) : <p>{offline ? tr('No connection. Checking again…') : error || tr('Starting…')}</p>}
        </div>
        <DeviceLanguage className="on-lang so-lang" />
      </div>
    );
  }

  if (!view.on) {
    return (
      <div className="so so-closed">
        {brand}
        <div className="so-closed-card"><span aria-hidden="true">🙏</span><h1>{tr('Please order at the counter')}</h1><p>{tr('This kiosk is not taking orders right now.')}</p></div>
      </div>
    );
  }

  if (stage === 'welcome') {
    return (
      <div className="so so-welcome">
        <div className="so-orbs" aria-hidden="true"><i /><i /><i /></div>
        <header className="so-top">{brand}<DeviceLanguage className="on-lang so-lang" /></header>
        <div className="so-hero">
          <h1>{tr('Hungry?')}<br /><span>{tr('Order here.')}</span></h1>
          <p>{view.welcome}</p>
          <div className="so-dine">
            <button type="button" className="so-dine-btn is-here" onClick={() => { setDining('here'); setStage('menu'); }}><span aria-hidden="true">🍽️</span><b>{tr('Eat here')}</b></button>
            <button type="button" className="so-dine-btn is-away" onClick={() => { setDining('away'); setStage('menu'); }}><span aria-hidden="true">🥡</span><b>{tr('Take away')}</b></button>
          </div>
        </div>
        {offline && <p className="so-offline">{tr('No connection. Checking again…')}</p>}
      </div>
    );
  }

  if (stage === 'paying') {
    return (
      <div className="so so-done">
        {brand}
        <div className="so-done-card"><span className="so-spin" aria-hidden="true" /><h1>{tr('Checking your payment…')}</h1><p>{tr('One moment, please.')}</p></div>
      </div>
    );
  }

  if (stage === 'done' && done) {
    const unpaid = done.status === 'cancelled';
    return (
      <div className={'so so-done' + (unpaid ? ' is-bad' : '')}>
        <div className="so-orbs" aria-hidden="true"><i /><i /><i /></div>
        {brand}
        <div className="so-done-card">
          {unpaid ? (
            <><span className="so-done-ico" aria-hidden="true">😕</span><h1>{tr('The payment did not go through')}</h1><p>{tr('Nothing was taken. Try again, or order at the counter.')}</p></>
          ) : (
            <>
              <span className="so-done-ico" aria-hidden="true">🎉</span>
              <h1>{tr('Thank you!')}</h1>
              <p>{tr('Your number')}</p>
              <strong className="so-number">{done.ref}</strong>
              <p className="so-next">{done.paid ? tr('Paid. We call your number when it is ready.')
                : done.status === 'accepted' ? tr('It is in the kitchen. Pay at the counter with your number.') : tr('Pay at the counter with your number, and we start cooking.')}</p>
              {done.total != null && !done.paid && <p className="so-due">{tr('To pay: {amount}', { amount: money(done.total) })}</p>}
            </>
          )}
          <button type="button" className="so-big-btn" onClick={reset}>{unpaid ? tr('Start again') : tr('Done')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="so so-shop">
      <header className="so-bar">
        <button type="button" className="so-back" onClick={reset} aria-label={tr('Start again')}>✕</button>
        {brand}
        <button type="button" className={'so-dine-pill is-' + dining} onClick={() => setDining(dining === 'here' ? 'away' : 'here')}>{dining === 'here' ? '🍽️ ' + tr('Eat here') : '🥡 ' + tr('Take away')}</button>
      </header>
      <nav className="so-cats" aria-label={tr('Menu')}>
        <button type="button" className={!cat ? 'is-on' : ''} onClick={() => setCat('')}>{tr('Everything')}</button>
        {shown.map(([c]) => <button key={c} type="button" className={cat === c ? 'is-on' : ''} onClick={() => setCat(c)}>{c || tr('Other')}</button>)}
      </nav>
      <main className="so-menu">
        {/* The deals on the kiosk now (backend restaurantPromos shown): they go on the order by themselves. */}
        {((menu && menu.bill && menu.bill.promotions) || []).length > 0 && (
          <div className="so-deals">{menu.bill.promotions.map((p) => <span key={p.id}><b>🎟️ {p.name}</b> {dealWords(p, tr, money)}</span>)}</div>
        )}
        {!menu && <p className="so-loading">{tr('Loading the menu…')}</p>}
        {visible.map(([c, list]) => (
          <section key={c} className="so-sec">
            <h2>{c || tr('Other')}</h2>
            <div className="so-grid">
              {list.map((i) => {
                const inBasket = basket.filter((l) => l.id === i.id).reduce((s, l) => s + l.qty, 0);
                return (
                  <button key={i.id} type="button" className={'so-dish' + (i.soldOut || i.notNow ? ' is-out' : '') + (inBasket ? ' is-in' : '')} disabled={i.soldOut || i.notNow} onClick={() => setItem(i)}>
                    <span className="so-dish-pic" style={{ '--c': tint(i.name) }}>
                      {i.photoFull ? <img src={photo(i.photoFull)} alt="" loading="lazy" decoding="async" /> : <b>{i.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
                      {inBasket > 0 && <em>{inBasket}</em>}
                      {i.soldOut && <span className="on-sold">{tr('Sold out')}</span>}
                      <DishFlags item={i} />
                    </span>
                    <span className="so-dish-text"><strong>{i.name}</strong><DishPrice item={i} /><DishAllergens item={i} /></span>
                    {!i.soldOut && !i.notNow && <span className="so-plus" aria-hidden="true">+</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </main>
      <aside className={'so-basket' + (count ? ' is-full' : '')} aria-label={tr('Your order')}>
        <h2>{tr('Your order')}{count > 0 && <small>{count === 1 ? tr('1 item') : tr('{n} items', { n: count })}</small>}</h2>
        {!count && <p className="so-empty"><span aria-hidden="true">🛒</span>{tr('Tap a dish to add it.')}</p>}
        <ul className="so-lines is-plain">
          {basket.map((l) => {
            const k = lineKey(l);
            return (
              <li key={k}>
                <span className="so-line-name"><b>{l.name}</b>{(l.modifiers || []).length > 0 && <small>{modsWords(l.modifiers, tr)}</small>}{l.note && <small>✎ {l.note}</small>}</span>
                <span className="so-step"><button type="button" onClick={() => setQty(k, l.qty - 1)} aria-label={tr('Decrease')}>−</button><b>{l.qty}</b><button type="button" onClick={() => setQty(k, l.qty + 1)} aria-label={tr('Increase')}>+</button></span>
                <span className="so-line-sum">{money(r2(l.price * l.qty))}</span>
              </li>
            );
          })}
        </ul>
        {bill.deal && <div className="so-deal-row"><span>🎟️ {bill.deal.name}</span><b>−{money(bill.deal.amount)}</b></div>}
        {count > 0 && (
          <button type="button" className={'so-promo' + (promo ? ' is-set' : '')} onClick={() => setPromoOpen(true)}>
            🎟️ {promo ? tr('Code {code}', { code: promo.code }) + (bill.deal && bill.deal.code === promo.code ? '' : ' · ' + tr('not on this order')) : tr('Have a promo code?')}
          </button>
        )}
        {stage === 'checkout' ? (
          <div className="so-check">
            <label className="so-field"><span>{tr('Your name, to call you')}</span><input className="input" maxLength={40} value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder={tr('e.g. Ama')} /></label>
            <label className="so-field"><span>{tr('Anything for the kitchen? (optional)')}</span><input className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. no pepper')} /></label>
            <div className="so-total"><span>{tr('Total')}</span><strong>{money(subtotal)}</strong></div>
            <small className="so-small">{tr('Any service charge or tax is added as on the receipt.')}</small>
            {error && <div className="error-banner">{error}</div>}
            <div className="so-pay">
              {view.payHere && <button type="button" className="so-big-btn is-card" disabled={busy || !name.trim()} onClick={() => place('here')}>💳 {tr('Pay here')}<small>{tr('Card or Mobile Money')}</small></button>}
              <button type="button" className="so-big-btn" disabled={busy || !name.trim()} onClick={() => place('counter')}>💵 {tr('Pay at the counter')}<small>{tr('Cash, card or Mobile Money')}</small></button>
            </div>
            <button type="button" className="so-link" onClick={() => setStage('menu')}>← {tr('Add more')}</button>
          </div>
        ) : (
          <>
            <div className="so-total"><span>{tr('Total')}</span><strong>{money(subtotal)}</strong></div>
            <button type="button" className="so-big-btn" disabled={!count} onClick={() => { setStage('checkout'); setError(null); }}>{tr('Order')} · {money(subtotal)}</button>
          </>
        )}
      </aside>
      {item && <ItemSheet item={item} onClose={() => setItem(null)} onAdd={add} />}
      {promoOpen && (
        <PromoCodeDialog promotions={[]} channel="kiosk" current={promo ? promo.code : null}
          lookup={(c) => posFetch('GET', '/pos/kiosk/promo?code=' + encodeURIComponent(c), key).then((x) => x.promo)}
          onApply={(c, deal) => { setPromo(c ? { code: c, deal } : null); setPromoOpen(false); }} onClose={() => setPromoOpen(false)} />
      )}
    </div>
  );
}
