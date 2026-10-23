import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { kioskUrl } from './customerScreenLink';
import './growth.css';

// The back office's settings for the fourth five (TillSettings.jsx → Setup;
// backend restaurantTillFront clean): the delivery apps (and what each owes,
// with its payouts — restaurantApps), the self-order kiosk
// (restaurantKiosk), and cards — the bank's terminals and pay by phone
// through Paystack (restaurantPaystack), with what came in through it.

function Toggle({ on, title, note, disabled, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} disabled={disabled} className="ts-toggle-row" onClick={() => onChange(!on)}>
      <span><strong>{title}</strong>{note && <small>{note}</small>}</span>
      <span className={'ts-switch' + (on ? ' is-on' : '')} aria-hidden="true"><i /></span>
    </button>
  );
}
function day(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) : ''; }
function iso(d) { return d.toISOString().slice(0, 10); }
const APP_LOOK = { bolt: '🟢', glovo: '🟡' };

// ── delivery apps ──
export function AppsTab({ token, pin, draft, set, onFail }) {
  const list = draft.apps.list;
  const [data, setData] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback((body) => posFetch('POST', '/pos/settings/apps', token, { managerPin: pin || undefined, ...(body || {}) }).then(setData), [token, pin]);
  useEffect(() => { load().catch(onFail); }, [load, onFail]);
  const setApp = (i, patch) => set(['apps', 'list'], list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  async function payout(e) {
    e.preventDefault();
    setBusy(true);
    try { await load({ action: 'payout', ...payFor, amount: Number(payFor.amount) }); setPayFor(null); } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  return (
    <section className="ts-sec ts-bill">
      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🛵</span>{tr('Delivery apps')}</h3>
        <p className="dk-muted">{tr('Orders from Bolt Food, Glovo and others are rung up on the till as the app\'s (More → Delivery-app order): at the app\'s prices, paid on the app, and kept apart in the reports.')}</p>
        <div className="ga-apps">
          {list.map((a, i) => (
            <div key={a.key} className={'ga-app' + (a.on ? ' is-on' : '')}>
              <span className="ga-app-dot" aria-hidden="true">{APP_LOOK[a.key] || '🛵'}</span>
              <input className="input ga-name" maxLength={40} value={a.name} onChange={(e) => setApp(i, { name: e.target.value })} aria-label={tr('Name')} />
              <label className="ga-num"><span>{tr('Prices +%')}</span><input className="input ts-bill-num" type="number" min="0" max="100" step="0.5" value={a.markup} onChange={(e) => setApp(i, { markup: Number(e.target.value) })} /></label>
              <label className="ga-num"><span>{tr('It keeps %')}</span><input className="input ts-bill-num" type="number" min="0" max="60" step="0.5" value={a.commission} onChange={(e) => setApp(i, { commission: Number(e.target.value) })} /></label>
              <button type="button" role="switch" aria-checked={a.on} className="ts-fx-switch" onClick={() => setApp(i, { on: !a.on })} aria-label={tr('Take orders from {app}', { app: a.name })}>
                <span className={'ts-switch' + (a.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
              </button>
              {!['bolt', 'glovo'].includes(a.key) && <button type="button" className="pos-line-x" onClick={() => set(['apps', 'list'], list.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>}
            </div>
          ))}
        </div>
        {list.length < 6 && <button type="button" className="btn btn-secondary" onClick={() => set(['apps', 'list'], list.concat([{ key: 'app-' + Date.now().toString(36).slice(-5), name: '', on: false, markup: 0, commission: 20 }]))}>＋ {tr('Another app')}</button>}
        <p className="ts-note">{tr('Linking the apps themselves (orders arriving on the till by themselves) needs each app\'s partner programme; until then the cashier rings them up from the app\'s tablet.')}</p>
      </div>
      {data && (
        <div className="ts-bill-block">
          <h3><span aria-hidden="true">💸</span>{tr('What the apps owe')}</h3>
          <div className="ga-owed">
            {data.apps.filter((a) => a.on || a.unpaid.orders || a.month.orders).map((a) => (
              <div key={a.key} className="ga-owe">
                <span className="ga-owe-name">{APP_LOOK[a.key] || '🛵'} {a.name}</span>
                <strong>{money(a.unpaid.owed)}</strong>
                <small>{a.unpaid.orders ? tr('{n} orders since {day}: {sales} sold, {fee} kept by the app', { n: a.unpaid.orders, day: day(a.unpaid.from), sales: money(a.unpaid.sales), fee: money(a.unpaid.commission) }) : tr('Nothing waiting to be paid')}</small>
                <small className="dk-muted">{tr('This month: {n} orders, {amount}', { n: a.month.orders, amount: money(a.month.sales) })}</small>
                {a.unpaid.orders > 0 && <button type="button" className="btn btn-secondary" onClick={() => setPayFor({ app: a.key, name: a.name, through: iso(new Date()), amount: String(a.unpaid.owed), method: 'mobile_money', receivedOn: iso(new Date()), note: '' })}>{tr('Enter a payout')}</button>}
              </div>
            ))}
          </div>
          {payFor && (
            <form className="ga-pay" onSubmit={payout}>
              <strong>{tr('{app} paid', { app: payFor.name })}</strong>
              <label className="field"><span>{tr('Amount')}</span><input className="input" type="number" min="0" step="0.01" required value={payFor.amount} onChange={(e) => setPayFor({ ...payFor, amount: e.target.value })} /></label>
              <label className="field"><span>{tr('For its orders up to')}</span><input className="input" type="date" required value={payFor.through} onChange={(e) => setPayFor({ ...payFor, through: e.target.value })} /></label>
              <label className="field"><span>{tr('Received on')}</span><input className="input" type="date" value={payFor.receivedOn} onChange={(e) => setPayFor({ ...payFor, receivedOn: e.target.value })} /></label>
              <label className="field"><span>{tr('Paid by')}</span>
                <select className="input" value={payFor.method} onChange={(e) => setPayFor({ ...payFor, method: e.target.value })}>
                  <option value="mobile_money">{tr('Mobile Money')}</option><option value="bank_transfer">{tr('Bank transfer')}</option><option value="cash">{tr('Cash')}</option><option value="other">{tr('Other')}</option>
                </select></label>
              <label className="field ga-pay-note"><span>{tr('Note')}</span><input className="input" maxLength={200} value={payFor.note} onChange={(e) => setPayFor({ ...payFor, note: e.target.value })} /></label>
              <div className="ga-pay-go">
                <button type="button" className="btn btn-secondary" onClick={() => setPayFor(null)}>{tr('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save the payout')}</button>
              </div>
            </form>
          )}
          {data.payouts.length > 0 && (
            <table className="ts-table ga-table">
              <thead><tr><th>{tr('Received')}</th><th>{tr('App')}</th><th>{tr('Orders up to')}</th><th className="is-num">{tr('Expected')}</th><th className="is-num">{tr('Paid')}</th><th className="is-num">{tr('Difference')}</th></tr></thead>
              <tbody>
                {data.payouts.map((p) => (
                  <tr key={p.id}><td>{day(p.receivedOn)}</td><td>{p.name}</td><td>{day(p.through)} · {tr('{n} orders', { n: p.orders })}</td><td className="is-num">{money(p.expected)}</td><td className="is-num">{money(p.amount)}</td>
                    <td className={'is-num' + (Math.abs(p.difference) >= 0.01 ? (p.difference < 0 ? ' is-bad' : ' is-good') : '')}>{p.difference > 0 ? '+' : ''}{money(p.difference)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {data.recent.length > 0 && (
            <ul className="ga-recent is-plain">
              {data.recent.slice(0, 12).map((o) => (
                <li key={o.id}><span>{APP_LOOK[o.app] || '🛵'} <b>{o.name} #{o.ref}</b>{o.customer ? ' · ' + o.customer : ''}<small>{o.orderNo} · {new Date(o.at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></span>
                  <span className="ga-recent-sum">{money(o.total)}<small>−{money(o.commission)}</small></span>
                  <span className={'ko-pill' + (o.paidOut ? ' is-on' : '')}>{o.paidOut ? tr('Paid out') : tr('Owed')}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ── the self-order kiosk ──
export function KioskTab({ draft, set, paystackReady }) {
  const k = draft.kiosk;
  const setK = (patch) => set(['kiosk'], { ...k, ...patch });
  return (
    <section className="ts-sec ts-bill">
      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🧾</span>{tr('Self-order kiosk')}</h3>
        <p className="dk-muted">{tr('A tablet at the counter where customers order themselves, with the menu\'s photos and add-ons. Open {url} on it, then pair it from the till (More → Self-order kiosk).', { url: kioskUrl() })}</p>
        <Toggle on={k.on} title={tr('Take orders on the kiosk')} note={k.on ? tr('Customers can order on it now.') : tr('It shows the welcome screen but takes no orders.')} onChange={(v) => setK({ on: v })} />
        <Toggle on={k.straightToKitchen} title={tr('Straight to the kitchen')} note={k.straightToKitchen ? tr('The kitchen starts at once; the cashier takes the money when the customer comes with their number.') : tr('Each order waits on the till until the cashier takes it.')} onChange={(v) => setK({ straightToKitchen: v })} />
        <Toggle on={k.payHere && paystackReady} disabled={!paystackReady} title={tr('Pay on the kiosk')}
          note={paystackReady ? tr('By card or Mobile Money through Paystack before the order goes in; paid orders go straight to the kitchen.') : tr('Needs pay by phone (Paystack) on: Payments → Cards.')} onChange={(v) => setK({ payHere: v })} />
        <div className="ts-guests-grid">
          <div className="field"><label htmlFor="ks-idle">{tr('Back to the start after (seconds)')}</label><input id="ks-idle" className="input ts-bill-num" type="number" min="30" max="600" value={k.idleSeconds} onChange={(e) => setK({ idleSeconds: Number(e.target.value) })} /></div>
          <div className="field ga-wide"><label htmlFor="ks-welcome">{tr('Welcome line')}</label><input id="ks-welcome" className="input" maxLength={120} value={k.welcome} onChange={(e) => setK({ welcome: e.target.value })} /></div>
        </div>
      </div>
    </section>
  );
}

// ── cards (in Payments): the terminals, pay by phone, what came in through Paystack ──
export function CardSettings({ token, pin, draft, set, paystackReady, onFail }) {
  const c = draft.card;
  const cardOn = draft.paymentMethods.includes('card');
  const [paid, setPaid] = useState(null);
  useEffect(() => {
    if (!c.paystack || !paystackReady) return;
    const to = iso(new Date()); const from = iso(new Date(Date.now() - 13 * 86400000));
    posFetch('POST', '/pos/settings/paystack', token, { managerPin: pin || undefined, from, to }).then(setPaid).catch(onFail);
  }, [c.paystack, paystackReady, token, pin, onFail]);
  const setT = (i, v) => set(['card', 'terminals'], c.terminals.map((t, j) => (j === i ? v : t)));
  return (
    <div className="ts-fx ga-cards">
      <div className="ts-fx-head">
        <strong>💳 {tr('Cards')}</strong>
        <small className="dk-muted">{tr('Turn on Card above to take cards on the bank\'s terminal: the cashier notes the card\'s brand, last 4 digits and approval code, for the reconciliation with the bank.')}</small>
      </div>
      {cardOn && (
        <div className="ga-terms">
          <span className="ts-label">{tr('Your card terminals')}</span>
          {c.terminals.map((t, i) => (
            <div key={i} className="ga-term"><span aria-hidden="true">📟</span><input className="input" maxLength={40} value={t} onChange={(e) => setT(i, e.target.value)} placeholder={tr('e.g. GCB terminal')} />
              {c.terminals.length > 1 && <button type="button" className="pos-line-x" onClick={() => set(['card', 'terminals'], c.terminals.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>}</div>
          ))}
          {c.terminals.length < 6 && <button type="button" className="pos-link" onClick={() => set(['card', 'terminals'], c.terminals.concat(['']))}>＋ {tr('Another terminal')}</button>}
        </div>
      )}
      <Toggle on={c.paystack && paystackReady} disabled={!paystackReady} title={'📲 ' + tr('Pay by phone (Paystack)')}
        note={paystackReady ? tr('The till shows a QR code; the customer pays on their phone by card or Mobile Money, and the till moves on by itself. Paystack keeps its fee.')
          : tr('Not set up: an administrator adds the Paystack secret key (PAYSTACK_SECRET_KEY) on the server first.')}
        onChange={(v) => set(['card'], { ...c, paystack: v })} />
      <Toggle on={draft.tablePay.on && paystackReady} disabled={!paystackReady} title={'🪑 ' + tr('Pay at the table')}
        note={paystackReady ? tr('Guests scan the table\'s QR code, or the one on the printed bill, and pay all of it or their share, with a tip, by card or Mobile Money. The till closes the bill with it.')
          : tr('Not set up: an administrator adds the Paystack secret key (PAYSTACK_SECRET_KEY) on the server first.')}
        onChange={(v) => set(['tablePay'], { ...draft.tablePay, on: v })} />
      {paid && paid.payments.length > 0 && (
        <table className="ts-table ga-table">
          <thead><tr><th>{tr('Paid')}</th><th>{tr('How')}</th><th>{tr('Sale')}</th><th className="is-num">{tr('Amount')}</th><th className="is-num">{tr('Paystack fee')}</th></tr></thead>
          <tbody>
            {paid.payments.map((p) => (
              <tr key={p.reference}><td>{new Date(p.paidAt).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                <td>{p.channel === 'mobile_money' ? tr('Mobile Money') : (p.cardBrand || tr('Card')) + (p.cardLast4 ? ' •••• ' + p.cardLast4 : '')}{p.purpose === 'kiosk' ? ' · ' + tr('Kiosk') : p.purpose === 'table' ? ' · ' + tr('At the table') + (p.payer ? ' (' + p.payer + ')' : '') : ''}</td>
                <td>{p.orderNo || <span className="dk-muted">{tr('not used yet')}</span>}</td><td className="is-num">{money(p.amount)}</td><td className="is-num">{p.fees != null ? money(p.fees) : '—'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
