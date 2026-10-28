import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';
import { fmt, methodName } from '../till/tillShared';
import { modsWords, serviceWords } from '../till/tillBill';
import FeedbackCard from './FeedbackCard';
import './online.css';

// A sale's receipt on the customer's phone (online.starbartema.com/receipt/
// <its link>; ?receipt= also works, for testing): the link the till's QR
// code, WhatsApp message or text message gives them (backend restaurantPos
// sendReceipt, publicReceipt). Its dishes with their add-ons and discounts,
// the service charge and taxes, how it was paid and anything refunded —
// and no phone number or name of the customer. Then "How was your visit?"
// (FeedbackCard), when the restaurant asks.

function whenText(at) {
  return new Date(at).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const FULFIL = { dine_in: ['🍽️', () => tr('Dine in')], togo: ['🥤', () => tr('To go')], pickup: ['🥡', () => tr('Pickup')], delivery: ['🛵', () => tr('Delivery')] };

export default function OnlineReceipt({ token }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  useEffect(() => {
    posFetch('GET', '/pos/receipt/' + encodeURIComponent(token))
      .then((d) => { setR(d); document.title = tr('Receipt {no}', { no: d.orderNo }) + ' · ' + d.restaurant.name; })
      .catch((e) => setError(e.message || tr('No answer from the server.')));
  }, [token]);

  if (!r) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">🧾</span><strong>{error ? tr('We cannot find that receipt') : tr('Finding your receipt…')}</strong>{error && <p>{error}</p>}</div></div>;
  const logo = restaurantLogoUrl(r.restaurant.code);
  const ful = FULFIL[r.fulfillment];
  const extras = r.discountTotal > 0 || r.serviceCharge > 0 || r.taxes.some((t) => !t.included);
  const voided = r.status === 'voided';
  return (
    <div className="on-shell on-track on-rc-page" data-brand={r.restaurant.code}>
      <header className="on-track-top">
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{r.restaurant.name}</strong><small>{tr('Your receipt')}</small></div>
        <DeviceLanguage className="on-lang" />
      </header>

      <article className={'on-rc' + (voided ? ' is-void' : '')} aria-labelledby="on-rc-total">
        <div className="on-rc-hero">
          <span className="on-rc-tick" aria-hidden="true">{voided ? '✕' : '✓'}</span>
          <small>{voided ? tr('This sale was voided') : r.refunded > 0 ? tr('Paid, {amount} refunded', { amount: money(r.refunded) }) : tr('Paid. Thank you!')}</small>
          <strong id="on-rc-total">{money(r.total)}</strong>
          <span className="on-rc-meta">
            <span>#{r.orderNo}</span>
            <span>{whenText(r.createdAt)}</span>
            {ful && <span>{ful[0]} {ful[1]()}{r.tableName ? ' · ' + r.tableName : ''}</span>}
            {r.servedBy && <span>🙋 {tr('Served by {name}', { name: r.servedBy })}</span>}
          </span>
        </div>

        <ul className="on-rc-lines is-plain">
          {r.items.map((it, i) => (
            <li key={i} className={it.compReason ? 'is-comp' : ''}>
              <b className="on-rc-qty">{it.qty}×</b>
              <span className="on-rc-name">
                <strong>{it.name}</strong>
                {(it.modifiers || []).length > 0 && <small>+ {modsWords(it.modifiers, tr)}</small>}
                {it.compReason ? <small className="is-off">🎁 {tr('On the house')}</small>
                  : it.discount > 0 && it.discountName && !(r.billDiscount && it.discountName === r.billDiscount.name) ? <small className="is-off">{it.discountName} −{money(it.discount)}</small> : null}
              </span>
              <span className="on-rc-amt">{it.discount > 0 && <s>{money(it.gross)}</s>}{money(it.lineTotal)}</span>
            </li>
          ))}
        </ul>

        <div className="on-rc-sums">
          {extras && <div><span>{tr('Dishes')}</span><b>{money(r.itemsGross)}</b></div>}
          {r.discountTotal > 0 && <div className="is-off"><span>{tr('Discounts')}{r.billDiscount ? ' · ' + r.billDiscount.name : ''}</span><b>−{money(r.discountTotal)}</b></div>}
          {r.serviceCharge > 0 && <div><span>{serviceWords(r.serviceName, tr)} {r.serviceRate ? r.serviceRate + '%' : ''}</span><b>{money(r.serviceCharge)}</b></div>}
          {r.taxes.filter((t) => !t.included).map((t) => <div key={t.name}><span>{t.name} {t.rate}%</span><b>{money(t.amount)}</b></div>)}
          <div className="is-total"><span>{tr('Total')}</span><strong>{money(r.total)}</strong></div>
          {r.taxes.filter((t) => t.included).map((t) => <div key={t.name} className="is-incl"><span>{tr('incl. {tax} {rate}%', { tax: t.name, rate: t.rate })}</span><b>{money(t.amount)}</b></div>)}
          {r.tip > 0 && <div className="is-tip"><span>💛 {tr('Tip')}</span><b>{money(r.tip)}</b></div>}
          {r.tip > 0 && <div className="is-total is-paid"><span>{tr('Paid')}</span><strong>{money(r.total + r.tip)}</strong></div>}
        </div>
        {r.points && (
          <p className="on-rc-points">⭐ {[r.points.earned ? tr('{n} loyalty points earned', { n: r.points.earned }) : null, r.points.used ? tr('{n} points used', { n: r.points.used }) : null].filter(Boolean).join(' · ')}</p>
        )}

        {r.payments.length > 0 && (
          <div className="on-rc-paid">
            <h2>{tr('How it was paid')}</h2>
            {r.payments.map((p, i) => (
              <div key={i}><span>{methodName(p.method)}{p.giftCard ? ' •••• ' + p.giftCard : ''}{p.currency && p.currency !== 'GHS' && p.foreignAmount ? ' · ' + fmt(p.foreignAmount, p.currency) : ''}</span><b>{money(p.amount)}</b></div>
            ))}
            {r.change > 0 && <div className="is-change"><span>{tr('Change')}</span><b>{money(r.change)}</b></div>}
          </div>
        )}

        {r.refunds.length > 0 && (
          <div className="on-rc-paid is-refund">
            <h2>{tr('Refunded')}</h2>
            {r.refunds.map((x, i) => <div key={i}><span>{whenText(x.createdAt)}</span><b>−{money(x.amount)}</b></div>)}
          </div>
        )}

        {(r.footer || r.extra) && <p className="on-rc-foot">{[r.footer, r.extra].filter(Boolean).join(' · ')}</p>}
        <span className="on-rc-edge" aria-hidden="true" />
      </article>

      {!voided && <FeedbackCard token={token} />}

      <div className="on-rc-actions">
        <button type="button" className="on-go is-ghost" onClick={() => window.print()}>🖨️ {tr('Print or save it')}</button>
        {r.restaurant.website && <a className="on-go" href={r.restaurant.website}>🛵 {tr('Order from {name} online', { name: r.restaurant.name })}</a>}
      </div>
    </div>
  );
}
