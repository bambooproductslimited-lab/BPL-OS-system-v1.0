import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { CURRENCY_LABEL, MethodGlyph, fmt, liveCurrencies, methodName, round2 } from './tillShared';

// Taking payment (RestaurantPosPage.jsx's Charge): one way, or the bill
// split several ways; each in cedis or a currency the manager turned on, at
// their rate (cash change is always given in cedis). VIP and IOU stay greyed
// out unless the customer picked has a VIP account (money put down) or an
// IOU account (opened by a manager). The server checks it all again
// (restaurantTillMoney.planPayments) and answers with the sale.

const NEEDS_CUSTOMER = { vip: true, iou: true };

export default function PayDialog({ token, title, total, methods, settings, customer, refreshKey, busy, error, onPickCustomer, onTopUp, onCancel, onComplete }) {
  const currencies = liveCurrencies(settings);
  const rateOf = (c) => (currencies.find((x) => x.code === c) || { rate: 1 }).rate;
  const vipOk = !!(customer && customer.vip);
  const iouOk = !!(customer && customer.iouAllowed);
  const allowed = (m) => (m === 'vip' ? vipOk : m === 'iou' ? iouOk : true);
  const firstOk = methods.find((m) => allowed(m) && m === 'cash') || methods.find(allowed) || 'cash';
  const [method, setMethod] = useState(firstOk);
  const [currency, setCurrency] = useState('GHS');
  const [given, setGiven] = useState('');
  const [split, setSplit] = useState(false);
  const [parts, setParts] = useState([]);
  const [vipBalance, setVipBalance] = useState(null);

  // The customer's VIP balance, fresh, when VIP is in play.
  const vipInPlay = split ? parts.some((p) => p.method === 'vip') : method === 'vip';
  useEffect(() => {
    if (!vipInPlay || !customer) { setVipBalance(null); return undefined; }
    let live = true;
    posFetch('GET', '/pos/vip/' + customer.id, token).then((r) => { if (live) setVipBalance(r.balance); }).catch(() => { if (live) setVipBalance(null); });
    return () => { live = false; };
  }, [vipInPlay, customer, token, refreshKey]);
  // A method that is no longer allowed (another customer) goes back to the first.
  useEffect(() => { if (!allowed(method)) setMethod(firstOk); }, [customer]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── one way ──
  const rate = rateOf(currency);
  const dueHere = currency === 'GHS' ? round2(total) : round2(total / rate);
  const givenN = given === '' ? null : Number(given);
  const changeCedis = givenN === null ? null : round2(givenN * rate - total);
  const roundUps = useMemo(() => {
    const steps = currency === 'GHS' ? [10, 20, 50, 100, 200] : currency === 'USD' ? [5, 10, 20, 50, 100] : [10, 20, 50, 100];
    return Array.from(new Set(steps.map((s) => { const v = Math.ceil(dueHere / s) * s; return v > dueHere ? v : v + s; }))).sort((a, b) => a - b).slice(0, 3);
  }, [dueHere, currency]);
  const vipShort = method === 'vip' && vipBalance !== null && vipBalance < total;
  const iouOver = method === 'iou' && customer && customer.iouLimit != null && customer.iouOwed + total > customer.iouLimit + 0.009;

  // ── split ──
  const paid = round2(parts.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const left = round2(total - paid);
  function startSplit(n) {
    const each = Math.floor((total / n) * 100) / 100;
    const list = Array.from({ length: n }, (_, i) => ({ method: i === 0 ? firstOk : 'cash', currency: 'GHS', amount: String(i === n - 1 ? round2(total - each * (n - 1)) : each), tendered: '' }))
      .map((p) => ({ ...p, method: allowed(p.method) && methods.includes(p.method) && p.method !== 'iou' ? p.method : 'cash' }));
    setParts(list); setSplit(true);
  }
  function setPart(i, patch) { setParts((list) => list.map((p, j) => (j === i ? { ...p, ...patch, ...(patch.method && (patch.method === 'vip') ? { currency: 'GHS' } : {}) } : p))); }
  const vipSplit = round2(parts.filter((p) => p.method === 'vip').reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const splitProblems = parts.map((p) => {
    const a = Number(p.amount);
    if (!(a > 0)) return tr('Give it an amount.');
    if (!allowed(p.method)) return p.method === 'vip' ? tr('Needs a customer with a VIP account.') : tr('Needs a customer with an IOU account.');
    if (p.method === 'cash' && p.tendered !== '') {
      const owes = p.currency === 'GHS' ? a : round2(a / rateOf(p.currency));
      if (Number(p.tendered) < owes) return tr('Less than this part.');
    }
    return null;
  });
  const splitOk = split && parts.length > 1 && Math.abs(left) < 0.005 && splitProblems.every((x) => !x) && !(vipSplit > 0 && vipBalance !== null && vipBalance < vipSplit);

  const singleOk = !split && allowed(method) && !(method === 'cash' && changeCedis !== null && changeCedis < 0) && !vipShort && !iouOver;
  function complete() {
    if (split) {
      onComplete(parts.map((p) => ({ method: p.method, currency: p.currency, amount: round2(p.amount), tendered: p.method === 'cash' && p.tendered !== '' ? Number(p.tendered) : undefined })));
    } else {
      onComplete([{ method: method, currency: currency, tendered: method === 'cash' && given !== '' ? Number(given) : undefined }]);
    }
  }

  const lockedNote = methods.some((m) => NEEDS_CUSTOMER[m] && !allowed(m));
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onCancel()}>
      <form className="dialog pos-pay tl-pay" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (split ? splitOk : singleOk) complete(); }}>
        <h2>{tr('Take payment')}</h2>
        <div className="pos-pay-due">
          <span>{title}</span>
          <strong>{money(total)}</strong>
          {currencies.length > 1 && <small className="tl-pay-fx">{currencies.filter((c) => c.code !== 'GHS').map((c) => fmt(round2(total / c.rate), c.code)).join(' · ')}</small>}
        </div>
        <div className="dk-segment tl-pay-mode" role="radiogroup" aria-label={tr('How it is paid')}>
          <button type="button" role="radio" aria-checked={!split} className={!split ? 'is-on' : ''} onClick={() => setSplit(false)}>{tr('One payment')}</button>
          <button type="button" role="radio" aria-checked={split} className={split ? 'is-on' : ''} onClick={() => (parts.length ? setSplit(true) : startSplit(2))}>{tr('Split the bill')}</button>
        </div>

        {!split ? (
          <>
            <div className="pos-methods tl-methods" role="radiogroup" aria-label={tr('Payment method')}>
              {methods.map((k) => {
                const ok = allowed(k);
                return (
                  <button key={k} type="button" role="radio" aria-checked={method === k} aria-disabled={!ok} data-m={k}
                    className={(method === k ? 'is-on' : '') + (ok ? '' : ' is-locked')}
                    title={ok ? methodName(k) : k === 'vip' ? tr('Only for a customer with a VIP account (money put down).') : tr('Only for a customer with an IOU account (a manager opens it).')}
                    onClick={() => (ok ? setMethod(k) : onPickCustomer())}>
                    <MethodGlyph method={k} /><span>{methodName(k)}</span>
                  </button>
                );
              })}
            </div>
            {lockedNote && (
              <p className="tl-pay-lock">
                <span>{customer ? tr('{name} has no VIP or IOU account yet, so those stay greyed out.', { name: customer.name }) : tr('VIP and IOU open once you pick a customer who has that account.')}</span>
                <button type="button" className="pos-link" onClick={onPickCustomer}>{customer ? tr('Another customer') : tr('Pick the customer')}</button>
              </p>
            )}
            {method !== 'vip' && method !== 'iou' && currencies.length > 1 && (
              <div className="tl-pay-cur" role="radiogroup" aria-label={tr('Currency')}>
                {currencies.map((c) => (
                  <button key={c.code} type="button" role="radio" aria-checked={currency === c.code} className={currency === c.code ? 'is-on' : ''} onClick={() => { setCurrency(c.code); setGiven(''); }}>
                    <b>{CURRENCY_LABEL[c.code]}</b>{c.code !== 'GHS' && <small>{tr('1 = {rate}', { rate: money(c.rate) })}</small>}
                  </button>
                ))}
              </div>
            )}
            {currency !== 'GHS' && method !== 'cash' && (
              <p className="tl-pay-foreign">{tr('Charge {amount} by {method}.', { amount: fmt(dueHere, currency), method: methodName(method) })}</p>
            )}
            {method === 'vip' && customer && (
              <p className={'tl-pay-acct' + (vipShort ? ' is-bad' : '')}>
                <span>{vipBalance === null ? tr('Checking {name}\'s VIP balance…', { name: customer.name })
                  : vipShort ? tr('{name} has {balance} on their VIP account: not enough for {amount}.', { name: customer.name, balance: money(vipBalance), amount: money(total) })
                    : tr('{name} has {balance} on their VIP account; {left} left after this.', { name: customer.name, balance: money(vipBalance), left: money(round2(vipBalance - total)) })}</span>
                {vipShort && <button type="button" className="btn btn-primary tl-btn" onClick={onTopUp}>{tr('Put money down…')}</button>}
              </p>
            )}
            {method === 'iou' && customer && (
              <p className={'tl-pay-acct' + (iouOver ? ' is-bad' : '')}>
                <span>{iouOver ? tr('{name} owes {owed} already; their IOU limit is {limit}.', { name: customer.name, owed: money(customer.iouOwed), limit: money(customer.iouLimit) })
                  : tr('{name} owes {amount} more, paid later from IOUs on the till.', { name: customer.name, amount: money(total) })
                    + (customer.iouLimit != null ? ' ' + tr('Limit {limit}, owed now {owed}.', { limit: money(customer.iouLimit), owed: money(customer.iouOwed) }) : '')}</span>
              </p>
            )}
            {method === 'cash' && (
              <div className="pos-cash">
                <label htmlFor="tl-cash-given" className="pos-big-label">{currency === 'GHS' ? tr('Cash received') : tr('Cash received in {cur}', { cur: CURRENCY_LABEL[currency] })}</label>
                <input id="tl-cash-given" className="input pos-big-input" type="number" min="0" step="0.01" inputMode="decimal" autoFocus
                  value={given} onChange={(e) => setGiven(e.target.value)} placeholder={currency === 'GHS' ? tr('Optional') : fmt(dueHere, currency)} />
                <div className="pos-quick">
                  <button type="button" className={givenN === dueHere ? 'is-on' : ''} onClick={() => setGiven(String(dueHere))}>{tr('Exact')}</button>
                  {roundUps.map((v) => <button key={v} type="button" className={givenN === v ? 'is-on' : ''} onClick={() => setGiven(String(v))}>{fmt(v, currency)}</button>)}
                </div>
                {changeCedis !== null && (
                  <div className={'pos-change' + (changeCedis < 0 ? ' is-bad' : '')}>
                    <span>{changeCedis < 0 ? tr('Still to pay') : tr('Change to give')}</span>
                    <strong>{changeCedis < 0 ? fmt(round2(-changeCedis / rate), currency) : money(changeCedis)}</strong>
                  </div>
                )}
                {currency !== 'GHS' && <p className="dk-muted tl-small">{tr('Change is given in cedis.')}</p>}
              </div>
            )}
          </>
        ) : (
          <div className="tl-split">
            <div className="tl-split-even">
              <span>{tr('Split evenly')}</span>
              {[2, 3, 4, 5].map((n) => <button key={n} type="button" className="tl-chip" onClick={() => startSplit(n)}>{tr('{n} ways', { n })}</button>)}
            </div>
            <ol className="tl-parts">
              {parts.map((p, i) => {
                const a = Number(p.amount) || 0;
                const r = rateOf(p.currency);
                return (
                  <li key={i} className={splitProblems[i] ? 'is-bad' : ''}>
                    <span className="tl-part-no">{i + 1}</span>
                    <select className="input" value={p.method} onChange={(e) => setPart(i, { method: e.target.value })} aria-label={tr('Payment method')}>
                      {methods.filter((m) => m !== 'iou').map((m) => <option key={m} value={m} disabled={!allowed(m)}>{methodName(m)}{allowed(m) ? '' : ' — ' + tr('no account')}</option>)}
                    </select>
                    {currencies.length > 1 && p.method !== 'vip' && (
                      <select className="input tl-part-cur" value={p.currency} onChange={(e) => setPart(i, { currency: e.target.value, tendered: '' })} aria-label={tr('Currency')}>
                        {currencies.map((c) => <option key={c.code} value={c.code}>{CURRENCY_LABEL[c.code]}</option>)}
                      </select>
                    )}
                    <input className="input tl-part-amt" type="number" min="0" step="0.01" inputMode="decimal" value={p.amount} onChange={(e) => setPart(i, { amount: e.target.value })} aria-label={tr('Amount in cedis')} placeholder="0.00" />
                    {left > 0.004 && <button type="button" className="pos-link" onClick={() => setPart(i, { amount: String(round2(a + left)) })}>{tr('+ the rest')}</button>}
                    {p.currency !== 'GHS' && a > 0 && <small className="tl-part-fx">= {fmt(round2(a / r), p.currency)}</small>}
                    {p.method === 'cash' && (
                      <input className="input tl-part-given" type="number" min="0" step="0.01" inputMode="decimal" value={p.tendered} onChange={(e) => setPart(i, { tendered: e.target.value })}
                        placeholder={tr('Received')} aria-label={tr('Cash received')} />
                    )}
                    {p.method === 'cash' && p.tendered !== '' && Number(p.tendered) * r - a > 0.004 && <small className="tl-part-change">{tr('Change {amount}', { amount: money(round2(Number(p.tendered) * r - a)) })}</small>}
                    {parts.length > 2 && <button type="button" className="pos-line-x" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>}
                    {splitProblems[i] && <small className="tl-part-why">{splitProblems[i]}</small>}
                  </li>
                );
              })}
            </ol>
            <div className="tl-split-foot">
              {parts.length < 6 && <button type="button" className="btn btn-secondary tl-btn" onClick={() => setParts(parts.concat([{ method: 'cash', currency: 'GHS', amount: left > 0 ? String(left) : '', tendered: '' }]))}>{tr('+ Another payment')}</button>}
              <span className={'tl-split-left' + (Math.abs(left) < 0.005 ? ' is-done' : left < 0 ? ' is-bad' : '')}>
                {Math.abs(left) < 0.005 ? tr('Adds up to the bill') : left > 0 ? tr('{amount} still to pay', { amount: money(left) }) : tr('{amount} too much', { amount: money(-left) })}
              </span>
            </div>
            {vipSplit > 0 && customer && vipBalance !== null && (
              <p className={'tl-pay-acct' + (vipBalance < vipSplit ? ' is-bad' : '')}>
                <span>{tr('{name} has {balance} on their VIP account.', { name: customer.name, balance: money(vipBalance) })}</span>
                {vipBalance < vipSplit && <button type="button" className="btn btn-primary tl-btn" onClick={onTopUp}>{tr('Put money down…')}</button>}
              </p>
            )}
            <p className="dk-muted tl-small">{tr('An IOU is for the whole bill, so it is not offered here.')}</p>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary pos-complete" disabled={busy || !(split ? splitOk : singleOk)}>{busy ? tr('Processing…') : tr('Complete sale')}</button>
        </div>
      </form>
    </div>
  );
}
