import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { loadSignup, loadToken, saveSignup, saveToken } from '../lib/portal';
import DeviceLanguage from '../components/DeviceLanguage';
import MakeAccount from '../components/MakeAccount';
import './ShopPage.css';
import './ShopOrderPage.css';

// An order from the shop, followed by its customer at /o/<its link>
// (backend shop.service.js track): where it stands — waiting to be paid,
// received, being made, ready, on its way (a delivery), delivered or
// collected — with when each step came, the days a made-to-order piece will
// be ready between, and what is in it. Unpaid, it is paid from here (by card
// or Mobile Money; Paystack sends the customer back here, and the payment is
// checked at once). An account asked for at checkout is finished here once
// it is paid. Looked at again every half minute.

async function call(path, method, body) {
  const r = await fetch(API_URL + path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
  return j;
}
function cedis(n) { return 'GHS ' + Number(n || 0).toLocaleString(activeIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
// Without a closing full stop ("29 oct."): the sentence brings its own.
function dayWords(day) { return new Date(day + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\.$/, ''); }

function stepsFor(o) {
  const made = o.lines.some((l) => l.makeDays && l.makeDays.to > 0);
  const list = [
    ['new', '🧾', () => tr('Received')],
    ['making', made ? '🛠️' : '📦', () => (made ? tr('Being made') : tr('Being prepared'))],
    ['ready', '✅', () => tr('Ready')]
  ];
  if (o.fulfilment === 'delivery') list.push(['out', '🚚', () => tr('On its way')]);
  list.push(['done', o.fulfilment === 'delivery' ? '🏡' : '🤝', () => (o.fulfilment === 'delivery' ? tr('Delivered') : tr('Collected'))]);
  return list;
}

// Back from Paystack (?reference=…): the payment, checked with the invoice's page.
function referenceOf() { const m = /[?&]reference=([A-Za-z0-9_-]{6,80})/.exec(window.location.search); return m ? m[1] : null; }

// Done: each thing in it rated, stars and a few words (backend shopReviews
// rate). Shown on the shop once Bamboo Products has read it; until then
// it can be changed.
function RateItems({ token, reviews, onSaved }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(reviews.items.map((it) => [it.itemId, { rating: it.rating || 0, words: it.words || '' }])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const open = reviews.items.filter((it) => !it.status || it.status === 'pending');
  const ready = open.some((it) => draft[it.itemId].rating > 0);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await call('/shop/orders/' + encodeURIComponent(token) + '/reviews', 'POST', { reviews: open.filter((it) => draft[it.itemId].rating > 0).map((it) => ({ itemId: it.itemId, rating: draft[it.itemId].rating, words: draft[it.itemId].words })) });
      onSaved(r); setSaved(true);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className="sop-card sop-rate" onSubmit={save}>
      <h2>⭐ {tr('How do you like it?')}</h2>
      <p className="ptl-note">{tr('Rate what you bought: it helps other customers, and us.')}</p>
      <ul className="sop-rate-list">
        {reviews.items.map((it) => {
          const d = draft[it.itemId];
          const locked = it.status && it.status !== 'pending';
          return (
            <li key={it.itemId}>
              <strong>{it.name}</strong>
              <span className="sop-stars" role="radiogroup" aria-label={tr('Stars for {name}', { name: it.name })}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={d.rating === n} disabled={locked} className={d.rating >= n ? 'is-on' : ''}
                    onClick={() => setDraft({ ...draft, [it.itemId]: { ...d, rating: n } })} aria-label={tr('{n} out of 5', { n })}>★</button>
                ))}
              </span>
              {locked ? <small className="sop-rate-done">{it.status === 'shown' ? '✅ ' + tr('Thank you! It is on the shop.') : '✓ ' + tr('Thank you for telling us.')}</small>
                : d.rating > 0 && <textarea className="input" rows={2} maxLength={600} value={d.words} onChange={(e) => setDraft({ ...draft, [it.itemId]: { ...d, words: e.target.value } })} placeholder={tr('A few words (optional)')} />}
            </li>
          );
        })}
      </ul>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {open.length > 0 && <button type="submit" className="shp-go" disabled={busy || !ready}>{busy ? tr('One moment…') : saved ? tr('Save my changes') : tr('Send my review')}</button>}
      {saved && <p className="sop-rate-thanks" role="status">🎉 {tr('Thank you! We show it on the shop once we have read it.')}</p>}
    </form>
  );
}

// The account asked for at checkout: its code, then signed in.
function FinishAccount({ pending, onDone }) {
  const [made, setMade] = useState(false);
  if (made) return <section className="sop-card sop-acct is-made"><h2>🎉 {tr('Your account is ready')}</h2><p>{tr('Your orders and invoices are in My account, and the shop fills in your details next time.')}</p><a className="shp-go" href="/account">👤 {tr('Open my account')}</a></section>;
  return (
    <section className="sop-card sop-acct">
      <h2>✨ {tr('Finish making your account')}</h2>
      <p className="ptl-note">{tr('You asked for one at checkout. Check your details and we send you a code.')}</p>
      <MakeAccount compact initial={{ name: pending.name || '', email: pending.email || '', phone: pending.phone || '' }} onIn={(t) => { saveToken(t); saveSignup(null); setMade(true); onDone(); }} />
      <button type="button" className="shp-link ptl-again" onClick={() => { saveSignup(null); onDone(); }}>{tr('No thanks')}</button>
    </section>
  );
}

export default function ShopOrderPage() {
  const { token } = useParams();
  const [o, setO] = useState(null);
  const [error, setError] = useState(null);
  const [ref, setRef] = useState(referenceOf);
  const [paying, setPaying] = useState(ref ? 'checking' : null);
  const [payError, setPayError] = useState(null);
  const [pending, setPending] = useState(() => (loadToken() ? null : loadSignup()));
  const load = useCallback(() => call('/shop/orders/' + encodeURIComponent(token)).then((r) => { setO(r); document.title = r.orderNo + ' · Bamboo Products'; return r; }), [token]);
  useEffect(() => {
    let live = true;
    const tick = () => load().catch((e) => live && setError(e.message));
    tick();
    const t = setInterval(tick, 30000);
    return () => { live = false; clearInterval(t); };
  }, [load]);
  // Back from paying: asked once, then again with the page while the bank or MoMo is still deciding.
  const invoiceToken = o && o.invoice ? o.invoice.token : null;
  useEffect(() => {
    if (!ref || !invoiceToken) return undefined;
    let live = true;
    const check = () => call('/share/' + encodeURIComponent(invoiceToken) + '/pay/' + encodeURIComponent(ref)).then((p) => {
      if (!live) return;
      if (p.status === 'success') { setPaying('paid'); setRef(null); window.history.replaceState(null, '', window.location.pathname); load().catch(() => {}); }
      else if (p.status === 'pending') setPaying('waiting');
      else { setPaying('failed'); setRef(null); window.history.replaceState(null, '', window.location.pathname); }
    }).catch(() => live && setPaying('waiting'));
    check();
    const t = setInterval(check, 15000);
    return () => { live = false; clearInterval(t); };
  }, [ref, invoiceToken, load]);
  async function pay() {
    setPayError(null); setPaying('going');
    try {
      const r = await call('/share/' + encodeURIComponent(o.invoice.token) + '/pay', 'POST', { pay: 'all', back: window.location.origin + '/o/' + token });
      window.location.assign(r.url);
    } catch (e) { setPayError(e.message); setPaying(null); }
  }

  if (error && !o) return <div className="shp shp-mid"><img src="/logo.png" alt="Bamboo Products Limited" className="shp-logo" /><h1>{tr('We cannot find that order')}</h1><p>{error}</p></div>;
  if (!o) return <div className="shp shp-mid"><span className="shp-spin" aria-hidden="true">📦</span><p>{tr('Loading…')}</p></div>;
  const steps = stepsFor(o);
  const cancelled = o.status === 'cancelled';
  const unpaid = o.status === 'unpaid';
  const at = steps.findIndex((s) => s[0] === o.status);
  const subtotal = o.lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  return (
    <div className="shp sop">
      <header className="sop-head">
        <a href="/" className="sop-back" aria-label={tr('Back to the shop')}><img src="/logo.png" alt="" className="shp-logo" /></a>
        <span className="sop-head-t"><small>{tr('Your order')}</small><strong>{o.orderNo}</strong></span>
        <a className="sop-acct" href="/account" aria-label={tr('My account')}>👤<span> {tr('My account')}</span></a>
        <DeviceLanguage className="shp-lang sop-lang" />
      </header>

      {paying === 'paid' && <p className="sop-flash is-paid" role="status">🎉 {tr('Paid, thank you! Your order is placed.')}</p>}
      {paying === 'failed' && <p className="sop-flash is-failed" role="alert">{tr('The payment did not go through. Nothing was taken; try again.')}</p>}

      <section className={'sop-hero' + (cancelled ? ' is-cancelled' : unpaid ? ' is-unpaid' : o.status === 'done' ? ' is-done' : '')}>
        <span className="sop-hero-ico" aria-hidden="true">{cancelled ? '✕' : unpaid ? '💳' : steps[Math.max(0, at)][1]}</span>
        <h1>{cancelled ? tr('This order was cancelled') : unpaid ? tr('Hello {name}, your order is waiting for your payment', { name: o.name }) : tr('Hello {name}, your order is: {state}', { name: o.name, state: steps[Math.max(0, at)][2]().toLowerCase() })}</h1>
        {unpaid && <p>{paying === 'checking' || paying === 'waiting' ? '⏳ ' + tr('Checking your payment… This page updates by itself.') : tr('We start on it as soon as it is paid. Unpaid orders are cancelled after two days.')}</p>}
        {!cancelled && o.readyBy && o.status !== 'done' && o.status !== 'out' && (
          <p>🗓️ {o.readyFrom && o.readyFrom !== o.readyBy ? tr('Made to order: ready between {from} and {to}.', { from: dayWords(o.readyFrom), to: dayWords(o.readyBy) }) : tr('Made to order: ready by {day}.', { day: dayWords(o.readyBy) })}</p>
        )}
        {!cancelled && o.fulfilment === 'pickup' && o.status === 'ready' && <p>🏬 {o.pickupAddress ? tr('Come and collect it at {place}.', { place: o.pickupAddress }) : tr('Come and collect it at our showroom.')}</p>}
        {!cancelled && o.fulfilment === 'delivery' && <p>📍 {o.address}{o.area ? ' · ' + o.area : ''}</p>}
      </section>

      {unpaid && o.invoice && paying !== 'checking' && paying !== 'waiting' && (
        <section className="sop-card sop-pay">
          <div className="sop-pay-amt"><small>{tr('To pay')}</small><strong>{cedis(o.invoice.balance)}</strong></div>
          {o.payOnline
            ? <button type="button" className="shp-go is-big" onClick={pay} disabled={paying === 'going'}>{paying === 'going' ? tr('One moment…') : '🔒 ' + tr('Pay by card or Mobile Money')}</button>
            : o.invoice.token && <a className="shp-go is-big" href={'/share/' + o.invoice.token}>🧾 {tr('See the invoice and how to pay')}</a>}
          {payError && <div className="error-banner" role="alert">{payError}</div>}
          <p className="sop-pay-note">{o.payOnline ? tr('Paid safely with Paystack. You come back here when it is done.') : tr('Once we have your payment, your order is placed and this page moves on.')}</p>
        </section>
      )}

      {!cancelled && !unpaid && pending && <FinishAccount pending={pending} onDone={() => setPending(null)} />}

      {o.reviews && o.reviews.items.length > 0 && <RateItems token={token} reviews={o.reviews} onSaved={(r) => setO({ ...o, reviews: r })} />}

      {!cancelled && (
        <ol className={'sop-steps' + (unpaid ? ' is-waiting' : '')} aria-label={tr('Where your order is')}>
          {steps.map(([k, ico, label], i) => {
            const done = i <= at, now = i === at;
            return (
              <li key={k} className={(done ? 'is-done' : '') + (now ? ' is-now' : '')} style={{ '--i': i }}>
                <span className="sop-dot" aria-hidden="true">{done ? ico : ''}</span>
                <span className="sop-step-t"><strong>{label()}</strong>{o.steps[k] && <small>{when(o.steps[k])}</small>}</span>
              </li>
            );
          })}
        </ol>
      )}

      <section className="sop-card">
        <h2>{tr('In your order')}</h2>
        <ul className="sop-lines">
          {o.lines.map((l, i) => (
            <li key={i}><b>{l.qty}×</b><span>{l.description}{l.makeDays && l.makeDays.to > 0 && <em className="shp-made is-line">🛠️ {l.makeDays.from === l.makeDays.to ? tr('{n} days', { n: l.makeDays.to }) : tr('{from}–{to} days', { from: l.makeDays.from, to: l.makeDays.to })}</em>}</span><strong>{cedis(l.unitPrice * l.qty)}</strong></li>
          ))}
        </ul>
        <div className="sop-sum">
          <span>{tr('Items')}</span><b>{cedis(subtotal)}</b>
          {o.discount > 0 && <><span>{tr('Discount ({code})', { code: o.promoCode })}</span><b>− {cedis(o.discount)}</b></>}
          {o.deliveryFee > 0 && <><span>{tr('Delivery to {area}', { area: o.area })}</span><b>+ {cedis(o.deliveryFee)}</b></>}
          <span className="is-total">{tr('Total')}</span><b className="is-total">{cedis(o.total)}</b>
        </div>
        {o.invoice && o.invoice.paid && <p className="sop-paid">✅ {tr('Paid · invoice {no}', { no: o.invoice.invoiceNo })}{o.invoice.token && <> · <a href={'/share/' + o.invoice.token}>{tr('See it')}</a></>}</p>}
      </section>
      <p className="shp-hint is-center">{tr('Placed {when}. This page updates by itself.', { when: when(o.placedAt) })}</p>
      <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
    </div>
  );
}
