import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../lib/posApi';
import { money } from '../lib/currency';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import DeviceLanguage from '../components/DeviceLanguage';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './CustomerDisplay.css';

// The screen that faces the customer (backend restaurantDisplays; the till's
// side is till/customerScreenLink.js and till/CustomerScreen.jsx). Opened on
// a tablet or a second monitor at /display (the till's website) or
// /customer-display (the OS): it shows a code until someone at the till
// types it, then the order as it is rung up, the bill with a tip to tap
// while paying, and a thank-you with the receipt's QR code.

const KEY = 'bamboo.display.key';
function readKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function writeKey(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* kept for this visit only */ } }

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);
  return <span className="cd-clock">{now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}</span>;
}

function ReceiptCode({ url }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 260, color: { dark: '#0f172a', light: '#ffffff' } }).then((d) => { if (live) setSrc(d); }).catch(() => {});
    return () => { live = false; };
  }, [url]);
  return src ? <img className="cd-qr" src={src} alt={tr('QR code of your receipt')} /> : null;
}

function Brand({ restaurant }) {
  const logo = restaurant ? restaurantLogoUrl(restaurant.code) : null;
  return (
    <div className="cd-brand">
      {logo ? <img src={logo} alt="" /> : <span className="cd-brand-dot" aria-hidden="true">✦</span>}
      <b>{restaurant ? restaurant.name : ''}</b>
    </div>
  );
}

export default function CustomerDisplay() {
  const [key, setKey] = useState(readKey);
  const [view, setView] = useState(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState(null); // the tip amount being typed, or null
  const [error, setError] = useState(null);
  const lastRef = useRef('');

  const hello = useCallback(async (k) => {
    try {
      const v = await posFetch('POST', '/pos/display/hello', null, { key: k || undefined });
      writeKey(v.key); setKey(v.key); setView(v); setOffline(false);
    } catch (err) { setOffline(true); setError(err.status === 429 ? err.message : null); }
  }, []);
  useEffect(() => { hello(readKey()); }, [hello]);

  // What to show, every second or so (a new code if the till let it go).
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const ask = async () => {
      try {
        const v = await posFetch('GET', '/pos/display', key);
        if (live) { setView(v); setOffline(false); }
      } catch (err) {
        if (!live) return;
        if (err.status === 401) { writeKey(''); hello(''); } else setOffline(true);
      }
    };
    const t = setInterval(ask, 1200);
    return () => { live = false; clearInterval(t); };
  }, [key, hello]);

  const state = view && view.paired ? view.state || { phase: 'idle' } : null;
  // A new order or a new step: the tip being typed and any message go.
  const stateRef = state ? state.phase + ':' + (state.ref || '') : '';
  useEffect(() => {
    if (stateRef !== lastRef.current) { lastRef.current = stateRef; setOwn(null); setError(null); }
  }, [stateRef]);

  async function tip(choice) {
    setBusy(true); setError(null);
    try {
      const v = await posFetch('POST', '/pos/display/tip', key, { ref: state.ref, ...choice });
      setView(v); setOwn(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!view) {
    return <div className="cd cd-is-wait"><div className="cd-glow" aria-hidden="true" /><span className="cd-spin" aria-label={tr('Loading…')} /></div>;
  }

  const lang = <DeviceLanguage className="cd-lang" />;

  if (!view.paired) {
    return (
      <div className="cd cd-is-pair">
        <div className="cd-glow" aria-hidden="true" />
        <div className="cd-top"><span className="cd-tag">🖥️ {tr('Customer screen')}</span>{lang}</div>
        <main className="cd-pair">
          <h1>{tr('Put this screen on a till')}</h1>
          <p>{tr('On the till: More → Customer screen, then type this code.')}</p>
          <div className="cd-code" aria-label={tr('Code {code}', { code: view.code })}>
            {String(view.code || '').split('').map((d, i) => <span key={i} style={{ animationDelay: i * 70 + 'ms' }}>{d}</span>)}
          </div>
          <small>{tr('The code changes every 30 minutes.')}</small>
          {error && <p className="cd-error">{error}</p>}
        </main>
      </div>
    );
  }

  const r = view.restaurant;
  const top = (
    <div className="cd-top">
      <Brand restaurant={r} />
      <div className="cd-top-right">{offline && <span className="cd-offline">{tr('Reconnecting…')}</span>}<Clock />{lang}</div>
    </div>
  );

  if (state.phase === 'paid' && state.paid) {
    const p = state.paid;
    return (
      <div className="cd cd-is-paid">
        <div className="cd-glow" aria-hidden="true" />
        <div className="cd-confetti" aria-hidden="true">{Array.from({ length: 24 }).map((_, i) => <i key={i} style={{ left: (i * 41) % 100 + '%', animationDelay: (i % 8) * 0.18 + 's' }} />)}</div>
        {top}
        <main className="cd-thanks">
          <span className="cd-tick" aria-hidden="true">✓</span>
          <h1>{state.customer ? tr('Thank you, {name}!', { name: state.customer.split(' ')[0] }) : tr('Thank you!')}</h1>
          <p className="cd-thanks-paid">{tr('Paid {amount}', { amount: money(p.total + (p.tip || 0)) })}{p.orderNo ? ' · ' + p.orderNo : ''}</p>
          {p.change > 0 && <p className="cd-change">{tr('Your change: {amount}', { amount: money(p.change) })}</p>}
          {p.tip > 0 && <p className="cd-tipped">💛 {tr('Thank you for the tip of {amount}.', { amount: money(p.tip) })}</p>}
          {p.points && p.points.earned > 0 && <p className="cd-points">⭐ {tr('{earned} points earned · {balance} points now', { earned: p.points.earned, balance: p.points.balance })}</p>}
          {p.receiptUrl && (
            <div className="cd-receipt">
              <ReceiptCode url={p.receiptUrl} />
              <span>{tr('Scan for your receipt')}</span>
            </div>
          )}
          {view.receipt && view.receipt.footer && <em className="cd-footer">{view.receipt.footer}</em>}
        </main>
      </div>
    );
  }

  if (state.phase === 'idle' || !state.lines || !state.lines.length) {
    return (
      <div className="cd cd-is-idle">
        <div className="cd-glow" aria-hidden="true" />
        {top}
        <main className="cd-welcome">
          {r && restaurantLogoUrl(r.code) && <img className="cd-welcome-logo" src={restaurantLogoUrl(r.code)} alt="" />}
          <h1><span>{tr('Welcome')}</span></h1>
          <p>{r ? tr('to {name}', { name: r.name }) : ''}</p>
          <small>{tr('Your order shows here as it is taken.')}</small>
        </main>
      </div>
    );
  }

  const t = state.totals || {};
  const paying = state.phase === 'pay';
  const ask = paying && state.tip && state.tip.ask && view.tips && view.tips.on;
  const chosen = view.tipChosen && view.tipChosen.ref === state.ref ? view.tipChosen : null;
  const tipAmount = chosen ? chosen.amount : state.tip ? state.tip.amount || 0 : 0;
  const base = state.tip ? state.tip.base || t.total : t.total;
  const qty = state.lines.reduce((n, l) => n + (l.qty || 0), 0);

  return (
    <div className={'cd cd-is-order' + (paying ? ' cd-is-pay' : '')}>
      <div className="cd-glow" aria-hidden="true" />
      {top}
      <main className="cd-order">
        <section className="cd-lines" aria-label={tr('Your order')}>
          <header>
            <h1>{state.customer ? tr('{name}\'s order', { name: state.customer.split(' ')[0] }) : tr('Your order')}</h1>
            <span>{qty === 1 ? tr('1 item') : tr('{n} items', { n: qty })}{state.cashier ? ' · ' + tr('served by {name}', { name: state.cashier }) : ''}</span>
          </header>
          <ul>
            {state.lines.map((l, i) => (
              <li key={i + ':' + l.name} className={l.comp ? 'is-comp' : ''}>
                <span className="cd-qty">{l.qty}×</span>
                <span className="cd-name">{l.name}{l.mods && <small>{l.mods}</small>}{l.off && <em>{l.off}</em>}</span>
                <span className="cd-amt">{l.gross != null && l.gross > l.amount && <s>{money(l.gross)}</s>}{money(l.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
        <aside className="cd-bill">
          <div className="cd-sums">
            {t.discount > 0 && <p><span>{tr('Items')}</span><b>{money(t.items)}</b></p>}
            {t.discount > 0 && <p className="is-off"><span>{tr('Discounts')}</span><b>−{money(t.discount)}</b></p>}
            {t.service > 0 && <p><span>{t.serviceName || tr('Service charge')}</span><b>{money(t.service)}</b></p>}
            {(t.taxes || []).map((x) => <p key={x.name} className="is-tax"><span>{x.name}{x.included ? ' ' + tr('(included)') : ''}</span><b>{money(x.amount)}</b></p>)}
            {paying && tipAmount > 0 && <p className="is-tip"><span>💛 {tr('Tip')}</span><b>{money(tipAmount)}</b></p>}
          </div>
          <div className="cd-total">
            <span>{paying ? tr('To pay') : tr('Total')}</span>
            <strong key={String(t.total + (paying ? tipAmount : 0))}>{money((t.total || 0) + (paying ? tipAmount : 0))}</strong>
          </div>
          {ask && (
            <div className="cd-tips">
              <h2>{tr('Would you like to add a tip?')}</h2>
              <div className="cd-tip-grid">
                {(view.tips.percents || []).map((pc) => {
                  const amount = Math.round(base * pc) / 100;
                  const on = chosen && chosen.percent === pc;
                  return (
                    <button key={pc} type="button" className={on ? 'is-on' : ''} disabled={busy} onClick={() => tip({ percent: pc })}>
                      <b>{pc}%</b><small>{money(amount)}</small>
                    </button>
                  );
                })}
                <button type="button" className={'is-other' + (own !== null || (chosen && chosen.percent == null && !chosen.none) ? ' is-on' : '')} disabled={busy} onClick={() => setOwn(chosen && chosen.percent == null && chosen.amount ? String(chosen.amount) : '')}>
                  <b>{tr('Other')}</b><small>{chosen && chosen.percent == null && chosen.amount ? money(chosen.amount) : tr('an amount')}</small>
                </button>
              </div>
              {own !== null && (
                <form className="cd-own" onSubmit={(e) => { e.preventDefault(); tip({ amount: Number(own) || 0 }); }}>
                  <input inputMode="decimal" type="number" min="0" step="0.5" autoFocus value={own} onChange={(e) => setOwn(e.target.value)} aria-label={tr('Tip amount')} placeholder="0.00" />
                  <button type="submit" disabled={busy}>{tr('Add')}</button>
                </form>
              )}
              <button type="button" className={'cd-notip' + (chosen && chosen.none ? ' is-on' : '')} disabled={busy} onClick={() => tip({ none: true })}>{tr('No tip, thank you')}</button>
              {error && <p className="cd-error">{error}</p>}
            </div>
          )}
          {paying && !ask && <p className="cd-paying">💳 {tr('Paying…')}</p>}
        </aside>
      </main>
    </div>
  );
}
