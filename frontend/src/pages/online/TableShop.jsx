import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme, saveTheme } from '../../lib/theme';
import ThemeSwitch from '../../components/ThemeSwitch';
import DeviceLanguage from '../../components/DeviceLanguage';
import { timeOf } from '../delivery/dlShared';
import ItemSheet from './ItemSheet';
import GoesWith from './GoesWith';
import { TablePaidBanner, TablePaySheet } from './TablePay';
import { DishAllergens, DishFlags, DishPrice, LineAmount } from './DishBits';
import { goesWithFor, happySaved, lineKey, photo, tint } from './onlineShared';
import { modsWords, serviceWords } from '../till/tillBill';
import './online.css';

// Ordering from the table (online.starbartema.com/q/<the table's code>,
// the QR code on the table; backend restaurantTableOrders): the whole menu,
// a basket, and "Send to the kitchen" — a waiter accepts it on the till
// (or it goes straight to the kitchen, if the restaurant says so). Each
// order sent from this phone is followed here (kept on the phone for the
// day), with what the table has had so far; and the waiter can be called
// or the bill asked for. Paid at the end: to the waiter as usual, or from
// the phone (TablePay: the bill or a share, with a tip, through Paystack,
// when the restaurant takes it; ?pay=1 from the printed bill's QR code).

const POLL_MS = 5000;
const OVER = ['served', 'rejected', 'cancelled'];
function keyOf(code) { return 'bamboo.table.' + code; }
function loadMine(code) {
  try { return (JSON.parse(localStorage.getItem(keyOf(code)) || '[]') || []).filter((o) => Date.now() - o.at < 12 * 3600000); } catch { return []; }
}
function saveMine(code, list) { try { localStorage.setItem(keyOf(code), JSON.stringify(list.slice(0, 12))); } catch { /* kept for this visit */ } }
const STAGE = {
  waiting: ['⏳', () => tr('Waiting for a waiter to accept it')],
  cooking: ['👩‍🍳', () => tr('In the kitchen')],
  ready: ['🛎️', () => tr('Ready, coming to your table')],
  served: ['✅', () => tr('Served. Enjoy!')],
  rejected: ['😔', () => tr('Not accepted')],
  cancelled: ['✕', () => tr('Cancelled')]
};

export default function TableShop({ code }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(getInitialTheme);
  const [cat, setCat] = useState('');
  const [q, setQ] = useState('');
  const [item, setItem] = useState(null);
  const [goes, setGoes] = useState(null); // { item, list }: "goes well with" after adding
  const [basket, setBasket] = useState([]);
  const [checkout, setCheckout] = useState(false);
  const [mine, setMine] = useState(() => loadMine(code));
  const [orders, setOrders] = useState({}); // token → where it stands
  const [calling, setCalling] = useState(null);
  const [toast, setToast] = useState(null);
  const [pay, setPay] = useState(null); // paying from the phone: the bill as it stands
  const [paying, setPaying] = useState(false);
  const [returned] = useState(() => { try { return new URLSearchParams(window.location.search).get('reference') || ''; } catch { return ''; } });
  const [payState, setPayState] = useState(returned ? { status: 'checking' } : null);
  const askedToPay = useRef((() => { try { return new URLSearchParams(window.location.search).get('pay') === '1'; } catch { return false; } })());
  const sections = useRef({});
  useEffect(() => { applyTheme(theme); saveTheme(theme); }, [theme]);

  const load = useCallback(() => posFetch('GET', '/pos/table/' + encodeURIComponent(code)).then((d) => {
    setData(d); setError(null); document.title = d.table.name + ' · ' + d.restaurant.name;
  }).catch((e) => { if (e.status) setError(e.message); }), [code]);
  const loadPay = useCallback(() => posFetch('GET', '/pos/table/' + encodeURIComponent(code) + '/pay').then((p) => {
    setPay(p);
    // From the printed bill's QR code: straight to paying.
    if (askedToPay.current && p.on && p.left > 0) { askedToPay.current = false; setPaying(true); }
  }).catch(() => { /* paying from the phone is not offered */ }), [code]);
  useEffect(() => { load(); loadPay(); const t = setInterval(() => { load(); loadPay(); }, 15000); return () => clearInterval(t); }, [load, loadPay]);
  // Back from Paystack (?reference=…): asked until Paystack says paid or not.
  useEffect(() => {
    if (!returned) return undefined;
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* the address keeps it */ }
    let live = true, tries = 0, timer = null;
    async function ask() {
      try {
        const r = await posFetch('GET', '/pos/table/' + encodeURIComponent(code) + '/pay/' + encodeURIComponent(returned));
        if (!live) return;
        setPay(r.bill);
        if (r.payment.status === 'pending' && tries++ < 20) { timer = setTimeout(ask, 2500); return; }
        setPayState(r.payment);
      } catch (e) { if (live) setPayState({ status: 'failed', message: e.message }); }
    }
    ask();
    return () => { live = false; clearTimeout(timer); };
  }, [returned, code]);
  // The orders sent from this phone, asked again until they are over.
  useEffect(() => {
    let live = true;
    async function poll() {
      for (const o of mine) {
        if (orders[o.token] && OVER.includes(orders[o.token].stage)) continue;
        try { const r = await posFetch('GET', '/pos/table/orders/' + encodeURIComponent(o.token)); if (live) setOrders((x) => ({ ...x, [o.token]: r })); } catch { /* asked again in a moment */ }
      }
    }
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [mine]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t); }, [toast]);

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
      return at < 0 ? b.concat([line]) : b.map((x, i) => (i === at ? { ...x, qty: Math.min(20, x.qty + line.qty) } : x));
    });
  }
  function setQty(k, qty) { setBasket((b) => (qty <= 0 ? b.filter((x) => lineKey(x) !== k) : b.map((x) => (lineKey(x) === k ? { ...x, qty: Math.min(20, qty) } : x)))); }
  function jump(c) {
    setCat(c);
    const el = sections.current[c];
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
  }
  async function call(kind) {
    setCalling(kind);
    try {
      const r = await posFetch('POST', '/pos/table/' + encodeURIComponent(code) + '/call', null, { kind });
      setData((d) => ({ ...d, calls: r.calls }));
      setToast(kind === 'bill' ? tr('The bill is on its way.') : tr('A waiter is coming.'));
    } catch (e) { setToast(e.message); } finally { setCalling(null); }
  }
  async function cancel(o) {
    if (!window.confirm(tr('Cancel this order?'))) return;
    try { const r = await posFetch('POST', '/pos/table/orders/' + encodeURIComponent(o.token) + '/cancel'); setOrders((x) => ({ ...x, [o.token]: r })); } catch (e) { setToast(e.message); }
  }

  if (error) return <div className="on-shell is-empty"><div className="on-empty"><span aria-hidden="true">🍽️</span><strong>{tr('This table\'s menu is not available')}</strong><p>{error}</p></div></div>;
  if (!data) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🍲</span><strong>{tr('Loading the menu…')}</strong></div></div>;
  const r = data.restaurant;
  const logo = restaurantLogoUrl(r.code);
  const called = (kind) => data.calls.some((c) => c.kind === kind);
  const recent = mine.filter((o) => orders[o.token]);
  const canPay = !!(pay && pay.on && pay.open && pay.left > 0);
  return (
    <div className="on-shell on-table" data-brand={r.code}>
      <header className="on-hero is-table">
        <div className="on-hero-bg" aria-hidden="true"><span>🍗</span><span>🥤</span><span>🍚</span><span>🌶️</span><span>🍔</span><span>🥗</span></div>
        <div className="on-hero-tools"><DeviceLanguage className="on-lang" /><ThemeSwitch theme={theme} onChange={setTheme} className="on-icon-btn" /></div>
        <div className="on-hero-main">
          {logo ? <img className="on-logo" src={logo} alt="" /> : <span className="on-logo is-mark">🍽️</span>}
          <div>
            <h1>{r.name}</h1>
            <p className="tb-chip"><span aria-hidden="true">🪑</span>{tr('Table {name}', { name: data.table.name })}{data.table.area ? ' · ' + data.table.area : ''}</p>
          </div>
        </div>
        <div className="on-facts">
          <span>📱 <b>{tr('Order from your table')}</b> {data.straight ? tr('straight to the kitchen') : tr('a waiter checks it first')}</span>
          <span>💵 {pay && pay.on ? tr('Pay the waiter, or from your phone') : tr('Pay at the end, as usual')}</span>
        </div>
        <div className="tb-actions">
          <button type="button" className={called('waiter') ? 'is-on' : ''} disabled={!!calling} onClick={() => call('waiter')}>
            <span aria-hidden="true">🙋</span><strong>{called('waiter') ? tr('A waiter is coming') : tr('Call the waiter')}</strong>
          </button>
          <button type="button" className={called('bill') ? 'is-on' : ''} disabled={!!calling} onClick={() => call('bill')}>
            <span aria-hidden="true">🧾</span><strong>{called('bill') ? tr('The bill is coming') : tr('Ask for the bill')}</strong>
          </button>
          {canPay && (
            <button type="button" className="tb-pay" onClick={() => setPaying(true)}>
              <span aria-hidden="true">💳</span><strong>{pay.paid > 0 ? tr('Pay what is left · {amount}', { amount: money(pay.left) }) : tr('Pay the bill from your phone · {amount}', { amount: money(pay.left) })}</strong><em>{tr('Card or MoMo · split it · tip')}</em>
            </button>
          )}
        </div>
      </header>

      {!data.open && <p className="tb-off">⏸️ {tr('Ordering from the table is off right now. Call the waiter to order.')}</p>}

      {recent.length > 0 && (
        <section className="tb-mine" aria-label={tr('Your orders')}>
          {recent.map((o) => {
            const x = orders[o.token];
            const st = STAGE[x.stage] || STAGE.waiting;
            return (
              <article key={o.token} className={'tb-order is-' + x.stage}>
                <span className="tb-order-art" aria-hidden="true">{st[0]}</span>
                <div>
                  <strong>{st[1]()}</strong>
                  <small>{[x.ref, timeOf(x.placedAt), x.items.map((l) => l.qty + '× ' + l.name).join(', ')].join(' · ')}</small>
                  {x.stage === 'rejected' && x.rejectReason && <small className="tb-why">✎ {x.rejectReason}</small>}
                </div>
                {x.canCancel && <button type="button" className="tb-cancel" onClick={() => cancel(o)}>{tr('Cancel')}</button>}
              </article>
            );
          })}
        </section>
      )}

      {data.bill.items.length > 0 && (
        <details className="tb-bill">
          <summary><span aria-hidden="true">🧾</span><strong>{tr('Your table so far')}</strong><b>{money(data.bill.total)}</b></summary>
          <ul className="on-lines is-plain">
            {data.bill.items.map((l, i) => (
              <li key={i}>
                <span className="on-line-text"><strong>{l.qty}× {l.name}</strong>
                  {(l.modifiers || []).length > 0 && <small className="on-line-mods">+ {modsWords(l.modifiers, tr)}</small>}
                  {l.compReason ? <small className="on-line-off">🎁 {tr('On the house')}</small> : l.discount > 0 ? <small className="on-line-off">−{money(l.discount)}</small> : null}
                </span>
                <i>{money(l.lineTotal)}</i>
              </li>
            ))}
          </ul>
          {(data.bill.serviceCharge > 0 || (data.bill.taxes || []).length > 0) && (
            <div className="on-total tb-bill-sums">
              {data.bill.serviceCharge > 0 && <div><span>{serviceWords(data.bill.serviceName, tr)}</span><b>{money(data.bill.serviceCharge)}</b></div>}
              {(data.bill.taxes || []).filter((t) => !t.included).map((t) => <div key={t.name}><span>{t.name} {t.rate}%</span><b>{money(t.amount)}</b></div>)}
              <div className="is-total"><span>{tr('Total')}</span><strong>{money(data.bill.total)}</strong></div>
              {(data.bill.taxes || []).filter((t) => t.included).map((t) => <div key={t.name} className="is-incl"><span>{tr('incl. {tax} {rate}%', { tax: t.name, rate: t.rate })}</span><b>{money(t.amount)}</b></div>)}
            </div>
          )}
          {pay && pay.paid > 0 && (
            <div className="on-total tb-bill-sums">
              <div className="is-paid"><span>✓ {tr('Paid from phones')}</span><b>−{money(pay.paid)}</b></div>
              <div className="is-total"><span>{tr('Left to pay')}</span><strong>{money(pay.left)}</strong></div>
            </div>
          )}
          {canPay && <button type="button" className="on-go tp-go" onClick={() => setPaying(true)}>💳 {tr('Pay from your phone')}</button>}
        </details>
      )}

      <nav className="on-cats" aria-label={tr('Menu sections')}>
        <label className="on-search"><span aria-hidden="true">🔎</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the menu')} aria-label={tr('Search the menu')} /></label>
        <div className="on-cat-row">
          {shown.map(([c]) => <button key={c} type="button" className={cat === c ? 'is-on' : ''} onClick={() => jump(c)}>{c || tr('Other')}</button>)}
        </div>
      </nav>

      <main className="on-menu tb-menu">
        {!shown.length && <div className="on-empty"><span aria-hidden="true">🔎</span><strong>{tr('Nothing called that')}</strong></div>}
        {shown.map(([c, list]) => (
          <section key={c} ref={(el) => { sections.current[c] = el; }} className="on-sec">
            <h2>{c || tr('Other')}<small>{list.length}</small></h2>
            <div className="on-grid">
              {list.map((i) => {
                const inBasket = basket.filter((l) => l.id === i.id).reduce((s, l) => s + l.qty, 0);
                return (
                  <button key={i.id} type="button" className={'on-dish' + (i.soldOut || i.notNow ? ' is-out' : '') + (inBasket ? ' is-in' : '') + (i.happy ? ' is-happy' : '')} disabled={i.soldOut || !data.open} onClick={() => setItem(i)}>
                    <span className="on-dish-pic" style={{ '--c': tint(i.name) }}>
                      {i.photoFull ? <img src={photo(i.photoFull)} alt="" loading="lazy" decoding="async" /> : <b>{i.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
                      {inBasket > 0 && <em>{inBasket}</em>}
                      {i.soldOut && <span className="on-sold">{tr('Sold out')}</span>}
                      <DishFlags item={i} />
                    </span>
                    <span className="on-dish-text"><strong>{i.name}</strong><DishPrice item={i} /><DishAllergens item={i} /></span>
                    {!i.soldOut && !i.notNow && data.open && <span className="on-plus" aria-hidden="true">+</span>}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <footer className="on-foot"><small>{tr('Ordered here, served at your table, paid at the end. Allergies or questions? Call the waiter.')}</small></footer>
      </main>

      {count > 0 && (
        <button type="button" className="on-bar" onClick={() => setCheckout(true)}>
          <span className="on-bar-n">{count}</span><span>{tr('Your order')}</span><strong>{money(subtotal - happySaved(basket))}</strong>
        </button>
      )}
      {item && <ItemSheet item={item} onClose={() => setItem(null)} onAdd={(line) => {
        add(item.suggested ? { ...line, suggested: true } : line); setItem(null);
        const list = item.suggested ? [] : goesWithFor(item, data.items).filter((x) => !basket.some((b) => b.id === x.id));
        if (list.length) setGoes({ item, list });
      }} />}
      {goes && <GoesWith item={goes.item} list={goes.list} onClose={() => setGoes(null)}
        onAdd={(line) => { add(line); const left = goes.list.filter((x) => x.id !== line.id); setGoes(left.length ? { ...goes, list: left } : null); }}
        onOpen={(x) => { setGoes(null); setItem({ ...x, suggested: true }); }} />}
      {checkout && (
        <SendSheet code={code} table={data.table} straight={data.straight} basket={basket} subtotal={subtotal} setQty={setQty} onClose={() => setCheckout(false)}
          onSent={(res) => {
            const list = [{ ref: res.ref, token: res.token, at: Date.now() }].concat(mine);
            saveMine(code, list); setMine(list); setOrders((x) => ({ ...x, [res.token]: res.order }));
            setBasket([]); setCheckout(false); window.scrollTo({ top: 0, behavior: 'smooth' });
            setToast(res.order.stage === 'waiting' ? tr('Sent! A waiter will accept it in a moment.') : tr('Sent to the kitchen!'));
            load();
          }} />
      )}
      {paying && pay && <TablePaySheet code={code} info={pay} onClose={() => setPaying(false)} />}
      <TablePaidBanner state={payState} left={pay ? pay.left : 0} onAgain={() => { setPayState(null); setPaying(true); }} onClose={() => setPayState(null)} />
      {toast && <div className="on-toast" role="status">{toast}</div>}
    </div>
  );
}

// The order, checked before it goes: how many of each, a name for the
// waiter (optional), a note.
function SendSheet({ code, table, straight, basket, subtotal, setQty, onClose, onSent }) {
  const [name, setName] = useState(() => { try { return localStorage.getItem('bamboo.table.name') || ''; } catch { return ''; } });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const website = useRef(null);
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      try { localStorage.setItem('bamboo.table.name', name.trim()); } catch { /* not kept */ }
      onSent(await posFetch('POST', '/pos/table/' + encodeURIComponent(code) + '/orders', null, {
        name: name.trim(), note: note.trim(), website: website.current ? website.current.value : '',
        items: basket.map((l) => ({ menuItemId: l.id, variationId: l.variationId || undefined, qty: l.qty, note: l.note || undefined, modifiers: (l.modifiers || []).map((m) => ({ id: m.id })), suggested: l.suggested || undefined }))
      }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="on-sheet-back is-checkout" onClick={() => !busy && onClose()}>
      <form className="on-sheet on-checkout" role="dialog" aria-modal="true" aria-labelledby="tb-send-title" onClick={(e) => e.stopPropagation()} onSubmit={send}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Back')}>←</button>
          <h2 id="tb-send-title">{tr('Your order for {table}', { table: table.name })}</h2>
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
        <fieldset className="on-fs">
          <legend>{tr('For the waiter')}</legend>
          <div className="on-two">
            <label className="on-field"><span>{tr('Your name (optional)')}</span><input className="input" value={name} maxLength={60} autoComplete="given-name" onChange={(e) => setName(e.target.value)} /></label>
            <label className="on-field"><span>{tr('A note (optional)')}</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. bring the drinks first')} /></label>
          </div>
          <input ref={website} className="on-trap" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" />
        </fieldset>
        <div className="on-total">
          {happySaved(basket) > 0 && <div className="is-happy"><span>🍹 {tr('Happy hour')}</span><b>−{money(happySaved(basket))}</b></div>}
          <div className="is-total"><span>{tr('This order')}</span><strong>{money(subtotal - happySaved(basket))}</strong></div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="on-go is-big" disabled={busy || !basket.length}>{busy ? tr('Sending…') : '🍽️ ' + tr('Send to the kitchen · {amount}', { amount: money(subtotal - happySaved(basket)) })}</button>
        <p className="on-hint is-center">{straight ? tr('It goes straight to the kitchen. You pay at the end, as usual.') : tr('A waiter accepts it first, then the kitchen starts. You pay at the end, as usual.')}</p>
      </form>
    </div>
  );
}
