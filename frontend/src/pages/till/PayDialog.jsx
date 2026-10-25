import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { CURRENCY_LABEL, MethodGlyph, fmt, liveCurrencies, methodCurrencies, methodName, round2 } from './tillShared';
import { CardFields, PhonePay } from './CardPay';
import { cardOk, paidAheadWords } from './tillBill';
import './fifth.css';

// Taking payment (RestaurantPosPage.jsx's Charge): one way, or the bill
// split several ways; each in the money that way takes (tillShared
// METHOD_CURRENCIES: Alipay and WeChat Pay in RMB, Mobile Money in cedis,
// cash in cedis or US dollars), a foreign one at the manager's rate (cash
// change is always given in cedis). VIP and IOU stay greyed out unless the
// customer picked has a VIP account (money put down) or an IOU account
// (opened by a manager); Alipay and WeChat Pay until the RMB rate is set.
// The server checks it all again (restaurantTillMoney.planPayments) and
// answers with the sale.
// By dish (an open order, dishes: { lines, billFor, why }): one guest pays
// for the dishes they had, and the rest of the order stays open.
// A tip on top (the till's settings, tips): tapped here, or chosen by the
// customer on their screen (screenTip, CustomerScreen.jsx) — paid with the
// bill, not a sale. A gift card (settings.giftCards) is a way of paying:
// its number checked for what is left on it (backend restaurantGiftCards).
// A card on the bank's terminal (its brand, last 4 and approval code noted),
// or paid on the customer's phone through Paystack (a QR code; CardPay.jsx).
// An order paid ahead through Paystack — on the self-order kiosk, or by
// guests from the table (paidAhead: their part of the bill, with any tip)
// — is taken with those payments, and what is left another way.

const NEEDS_CUSTOMER = { vip: true, iou: true };

export default function PayDialog({ token, title, total: wholeTotal, methods: tillMethods, settings, customer, refreshKey, busy, error, dishes, screenTip, paidAhead, onTip, onPickCustomer, onTopUp, onCancel, onComplete }) {
  const giftOn = !!(settings.giftCards && settings.giftCards.on);
  const phoneOn = !!(settings.card && settings.card.paystack);
  const terminals = (settings.card && settings.card.terminals) || [];
  const methods = tillMethods.concat(giftOn ? ['gift_card'] : [], phoneOn ? ['paystack'] : []);
  const [card, setCard] = useState({ brand: 'Visa', entry: 'tap', last4: '', ref: '', terminal: terminals[0] || '' });
  const [phonePaid, setPhonePaid] = useState(null);
  const tips = settings.tips && settings.tips.on ? settings.tips : null;
  const currencies = liveCurrencies(settings);
  const rateOf = (c) => (currencies.find((x) => x.code === c) || { rate: 1 }).rate;
  const curFor = (m) => methodCurrencies(m, currencies);
  const firstCur = (m) => (curFor(m)[0] || { code: 'GHS' }).code;
  const vipOk = !!(customer && customer.vip);
  const iouOk = !!(customer && customer.iouAllowed);
  const allowed = (m) => (m === 'vip' ? vipOk : m === 'iou' ? iouOk : curFor(m).length > 0);
  const firstOk = methods.find((m) => allowed(m) && m === 'cash') || methods.find(allowed) || 'cash';
  const [method, setMethod] = useState(firstOk);
  const [currency, setCurrency] = useState(() => firstCur(firstOk));
  const [given, setGiven] = useState('');
  const [mode, setMode] = useState('one'); // 'one' | 'split' | 'dish'
  const split = mode === 'split';
  const [pick, setPick] = useState({}); // by dish: line key → how many
  const dishBill = mode === 'dish' && dishes && !dishes.why ? dishes.billFor(pick) : null;
  const picked = dishBill ? dishBill.lines.reduce((n, l) => n + l.qty, 0) : 0;
  // What is paid now: the whole bill, or the dishes picked.
  const bill = mode === 'dish' ? (dishBill ? dishBill.total : 0) : wholeTotal;
  // The tip, and what is paid: the bill and the tip.
  const [tip, setTip] = useState(0);
  const [tipPct, setTipPct] = useState(null);
  const [tipOwn, setTipOwn] = useState(false);
  // Paid ahead (kiosk, table): their payments, and the tips in them, are part of it.
  const ahead = paidAhead || [];
  const aheadSum = round2(ahead.reduce((a, p) => a + p.amount, 0));
  const aheadTip = round2(ahead.reduce((a, p) => a + (p.tip || 0), 0));
  const tipAll = round2(tip + aheadTip);
  const total = round2(bill + tipAll);
  function pickTip(pct, amount) { setTipPct(pct); setTip(pct != null ? round2(bill * pct / 100) : round2(amount || 0)); }
  // The customer's choice on their screen.
  useEffect(() => { if (screenTip) { setTipOwn(false); pickTip(screenTip.percent, screenTip.amount); } }, [screenTip]); // eslint-disable-line react-hooks/exhaustive-deps
  // A percentage follows the bill (by dish: the dishes picked).
  useEffect(() => { if (tipPct != null) setTip(round2(bill * tipPct / 100)); }, [bill]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (onTip) onTip({ bill, tip: tipAll }); }, [bill, tipAll]); // eslint-disable-line react-hooks/exhaustive-deps
  // A gift card: its number, and what is left on it.
  const [giftCode, setGiftCode] = useState('');
  const [gift, setGift] = useState(null);
  const [giftErr, setGiftErr] = useState(null);
  async function checkGift(code) {
    setGiftErr(null); setGift(null);
    try { const c = await posFetch('GET', '/pos/gift-cards/' + encodeURIComponent(String(code).replace(/\D/g, '')), token); setGift(c); return c; }
    catch (e) { setGiftErr(e.message); return null; }
  }
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
  // Each way of paying in its own money: switching to Alipay is RMB, to Mobile Money cedis.
  useEffect(() => {
    if (!curFor(method).some((c) => c.code === currency)) { setCurrency(firstCur(method)); setGiven(''); }
  }, [method]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const giftShort = method === 'gift_card' && gift && (gift.status !== 'active' || gift.balance + 0.004 < total);

  // ── split ──
  const paid = round2(parts.reduce((s2, p) => s2 + (Number(p.amount) || 0), 0));
  const left = round2(total - paid);
  function startSplit(n) {
    const each = Math.floor((total / n) * 100) / 100;
    const list = Array.from({ length: n }, (_, i) => ({ method: i === 0 ? firstOk : 'cash', currency: 'GHS', amount: String(i === n - 1 ? round2(total - each * (n - 1)) : each), tendered: '' }))
      .map((p) => ({ ...p, method: allowed(p.method) && methods.includes(p.method) && p.method !== 'iou' ? p.method : 'cash' }))
      .map((p) => ({ ...p, currency: firstCur(p.method) }));
    setParts(list); setMode('split');
  }
  function setPart(i, patch) { setParts((list) => list.map((p, j) => (j === i ? { ...p, ...patch, ...(patch.method && !curFor(patch.method).some((c) => c.code === p.currency) ? { currency: firstCur(patch.method), tendered: '' } : {}) } : p))); }
  const vipSplit = round2(parts.filter((p) => p.method === 'vip').reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const splitProblems = parts.map((p) => {
    const a = Number(p.amount);
    if (!(a > 0)) return tr('Give it an amount.');
    if (!allowed(p.method)) return p.method === 'vip' ? tr('Needs a customer with a VIP account.') : tr('Needs a customer with an IOU account.');
    if (p.method === 'gift_card' && String(p.code || '').replace(/\D/g, '').length !== 16) return tr('Type the 16-digit number on the gift card.');
    if (p.method === 'cash' && p.tendered !== '') {
      const owes = p.currency === 'GHS' ? a : round2(a / rateOf(p.currency));
      if (Number(p.tendered) < owes) return tr('Less than this part.');
    }
    return null;
  });
  const splitOk = split && parts.length > 1 && Math.abs(left) < 0.005 && splitProblems.every((x) => !x) && !(vipSplit > 0 && vipBalance !== null && vipBalance < vipSplit);

  const singleOk = !split && allowed(method) && !(method === 'cash' && changeCedis !== null && changeCedis < 0) && !vipShort && !iouOver && !(mode === 'dish' && !(picked > 0))
    && !(method === 'gift_card' && (!gift || giftShort)) && !(tip > 0 && method === 'iou')
    && !(method === 'card' && !cardOk(card)) && !(method === 'paystack' && !(phonePaid && Math.abs(phonePaid.amount - total) < 0.005));
  // The rest of the bill another way, after what is left on the card.
  function splitWithCard() {
    const onCard = round2(Math.min(gift.balance, total));
    setParts([{ method: 'gift_card', currency: 'GHS', amount: String(onCard), tendered: '', code: gift.code }, { method: 'cash', currency: 'GHS', amount: String(round2(total - onCard)), tendered: '' }]);
    setMode('split');
  }
  // Paid ahead: those payments, and what is left (added since, or the
  // guests' shares not paid yet) in cash, Mobile Money or on the card terminal.
  const aheadRest = ahead.length ? round2(total - aheadSum) : 0;
  const restMethods = ['cash', 'mobile_money', 'card'].filter((m) => methods.includes(m));
  const [restMethod, setRestMethod] = useState(restMethods[0] || 'cash');
  const [restGiven, setRestGiven] = useState('');
  const aheadOk = aheadRest > -0.004 && !(restMethod === 'cash' && restGiven !== '' && Number(restGiven) < aheadRest - 0.004);
  function completeAhead() {
    const refs = ahead.map((p) => ({ paystackRef: p.ref, amount: p.amount }));
    onComplete(aheadRest > 0.004 ? refs.concat([{ method: restMethod, currency: 'GHS', amount: aheadRest, tendered: restMethod === 'cash' && restGiven !== '' ? Number(restGiven) : undefined,
      card: restMethod === 'card' ? { brand: 'Other', entry: null } : undefined }]) : refs, null, tipAll);
  }
  function complete() {
    if (ahead.length) { completeAhead(); return; }
    if (method === 'paystack') { onComplete([{ paystackRef: phonePaid.reference }], null, tip); return; }
    const one = [{ method: method, currency: currency, tendered: method === 'cash' && given !== '' ? Number(given) : undefined, code: method === 'gift_card' ? gift.code : undefined,
      card: method === 'card' ? { brand: card.brand, entry: card.entry, last4: card.last4 || undefined, ref: card.ref || undefined, terminal: card.terminal || undefined } : undefined }];
    if (mode === 'dish') { onComplete(one, Object.keys(pick).filter((k) => pick[k] > 0).map((k) => ({ key: k, qty: pick[k] })), tip); return; }
    if (split) {
      onComplete(parts.map((p) => ({ method: p.method, currency: p.currency, amount: round2(p.amount), tendered: p.method === 'cash' && p.tendered !== '' ? Number(p.tendered) : undefined,
        code: p.method === 'gift_card' ? String(p.code || '').replace(/\D/g, '') : undefined })), null, tip);
    } else {
      onComplete(one, null, tip);
    }
  }

  const lockedNote = methods.some((m) => NEEDS_CUSTOMER[m] && !allowed(m));
  const rmbNote = methods.some((m) => (m === 'alipay' || m === 'wechat') && !allowed(m));
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onCancel()}>
      <form className="dialog pos-pay tl-pay" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (ahead.length ? aheadOk : split ? splitOk : singleOk) complete(); }}>
        <h2>{tr('Take payment')}</h2>
        <div className="pos-pay-due">
          <span>{title}</span>
          <strong>{money(total)}</strong>
          {tipAll > 0 && <small className="tl-pay-tipline">{tr('{bill} + a tip of {tip}', { bill: money(bill), tip: money(tipAll) })}</small>}
          {currencies.length > 1 && <small className="tl-pay-fx">{currencies.filter((c) => c.code !== 'GHS').map((c) => fmt(round2(total / c.rate), c.code)).join(' · ')}</small>}
        </div>
        {ahead.length > 0 && (
          <div className={'cp-kiosk' + (aheadRest < -0.004 ? ' is-bad' : '')}>
            <span className="cp-tick" aria-hidden="true">✓</span>
            <div>
              <strong>{paidAheadWords(ahead, money(aheadSum), tr)}</strong>
              {ahead.map((p) => (
                <small key={p.ref}>{[p.payer || null, p.channel === 'mobile_money' ? methodName('mobile_money') : methodName('card'), 'Paystack', p.tip > 0 ? tr('a tip of {amount}', { amount: money(p.tip) }) : null, p.ref].filter(Boolean).join(' · ')}</small>
              ))}
              {aheadRest > 0.004 && (
                <div className="cp-rest">
                  <small className="cp-kiosk-rest">{tr('{amount} is still to pay:', { amount: money(aheadRest) })}</small>
                  <div className="cp-rest-row" role="radiogroup" aria-label={tr('How the rest is paid')}>
                    {restMethods.map((m) => <button key={m} type="button" role="radio" aria-checked={restMethod === m} className={'tl-chip' + (restMethod === m ? ' is-on' : '')} onClick={() => setRestMethod(m)}>{methodName(m)}</button>)}
                    {restMethod === 'cash' && <input className="input cp-rest-given" type="number" min="0" step="0.5" inputMode="decimal" value={restGiven} onChange={(e) => setRestGiven(e.target.value)} aria-label={tr('Cash received')} placeholder={tr('Cash received')} />}
                  </div>
                  {restMethod === 'cash' && restGiven !== '' && Number(restGiven) >= aheadRest && <small>{tr('Change: {amount}', { amount: money(round2(Number(restGiven) - aheadRest)) })}</small>}
                </div>
              )}
              {aheadRest < -0.004 && <small className="cp-kiosk-rest">{tr('The bill is now less than what was paid: put the dishes back, or refund the difference after.')}</small>}
            </div>
          </div>
        )}
        {!ahead.length && <div className="dk-segment tl-pay-mode" role="radiogroup" aria-label={tr('How it is paid')}>
          <button type="button" role="radio" aria-checked={mode === 'one'} className={mode === 'one' ? 'is-on' : ''} onClick={() => setMode('one')}>{tr('One payment')}</button>
          <button type="button" role="radio" aria-checked={split} className={split ? 'is-on' : ''} onClick={() => (parts.length ? setMode('split') : startSplit(2))}>{tr('Split the bill')}</button>
          {dishes && <button type="button" role="radio" aria-checked={mode === 'dish'} className={mode === 'dish' ? 'is-on' : ''} onClick={() => setMode('dish')}>{tr('By dish')}</button>}
        </div>}
        {mode === 'dish' && (dishes.why ? <p className="tl-pay-lock"><span>{dishes.why}</span></p> : (
          <div className="tl-bydish">
            <p className="dk-muted tl-small">{tr('Pick what this guest had: they pay for it now, and the rest of the order stays open.')}</p>
            {/* A seat's dishes in one tap (till/tillService.js seats). */}
            {dishes.lines.some((l) => l.seat) && (
              <div className="tl-chips tl-byseat">
                {Array.from(new Set(dishes.lines.map((l) => l.seat).filter(Boolean))).sort((a, b) => a - b).map((n) => {
                  const mine = dishes.lines.filter((l) => l.seat === n);
                  const on = mine.every((l) => pick[l.key] === l.qty);
                  return (
                    <button key={n} type="button" className={'tl-chip' + (on ? ' is-on' : '')} aria-pressed={on}
                      onClick={() => { const next = { ...pick }; mine.forEach((l) => { next[l.key] = on ? 0 : l.qty; }); setPick(next); }}>
                      💺 {tr('Seat {n}', { n })}
                    </button>
                  );
                })}
              </div>
            )}
            <ul className="tl-bydish-list is-plain">
              {dishes.lines.map((l) => {
                const n = pick[l.key] || 0;
                return (
                  <li key={l.key} className={n ? 'is-on' : ''}>
                    <button type="button" className="tl-bydish-name" onClick={() => setPick({ ...pick, [l.key]: n ? 0 : l.qty })}>
                      <b>{l.qty}×</b><span>{l.seat ? <em className="tl-seat">S{l.seat}</em> : null}{l.name}{l.words && <small>{l.words}</small>}</span>
                    </button>
                    <div className="pos-stepper">
                      <button type="button" disabled={!n} onClick={() => setPick({ ...pick, [l.key]: n - 1 })} aria-label={tr('Decrease')}>−</button>
                      <span>{n}</span>
                      <button type="button" disabled={n >= l.qty} onClick={() => setPick({ ...pick, [l.key]: n + 1 })} aria-label={tr('Increase')}>+</button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="tl-bydish-sum">{picked ? tr('{n} picked: {amount}', { n: picked, amount: money(total) }) : tr('Nothing picked yet')}</p>
          </div>
        ))}

        {tips && !(mode === 'dish' && (dishes.why || !picked)) && (
          <div className="tl-tips">
            <span className="tl-tips-label">💛 {tr('Tip')}{screenTip && <small>{tr('chosen on the customer screen')}</small>}</span>
            <div className="tl-chips" role="radiogroup" aria-label={tr('Tip')}>
              <button type="button" role="radio" aria-checked={!tip && !tipOwn} className={'tl-chip' + (!tip && !tipOwn ? ' is-on' : '')} onClick={() => { setTipOwn(false); pickTip(null, 0); }}>{tr('No tip')}</button>
              {tips.percents.map((pc) => (
                <button key={pc} type="button" role="radio" aria-checked={tipPct === pc} className={'tl-chip' + (tipPct === pc ? ' is-on' : '')} onClick={() => { setTipOwn(false); pickTip(pc); }}>
                  {pc}% <small>{money(round2(bill * pc / 100))}</small>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={tipOwn} className={'tl-chip' + (tipOwn ? ' is-on' : '')} onClick={() => { setTipOwn(true); setTipPct(null); }}>{tr('Other')}</button>
              {tipOwn && <input className="input tl-tip-own" type="number" min="0" step="0.5" inputMode="decimal" value={tip || ''} onChange={(e) => pickTip(null, e.target.value)} aria-label={tr('Tip')} placeholder="0.00" />}
            </div>
          </div>
        )}
        {(mode === 'dish' && (dishes.why || !picked)) || ahead.length ? null : !split ? (
          <>
            <div className="pos-methods tl-methods" role="radiogroup" aria-label={tr('Payment method')}>
              {methods.map((k) => {
                const ok = allowed(k);
                return (
                  <button key={k} type="button" role="radio" aria-checked={method === k} aria-disabled={!ok} data-m={k}
                    className={(method === k ? 'is-on' : '') + (ok ? '' : ' is-locked')}
                    title={ok ? methodName(k) : k === 'vip' ? tr('Only for a customer with a VIP account (money put down).') : k === 'iou' ? tr('Only for a customer with an IOU account (a manager opens it).') : tr('Alipay and WeChat Pay are charged in RMB: a manager sets the RMB rate in the till settings first.')}
                    onClick={() => (ok ? setMethod(k) : NEEDS_CUSTOMER[k] ? onPickCustomer() : undefined)}>
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
            {rmbNote && <p className="tl-pay-lock"><span>{tr('Alipay and WeChat Pay are charged in RMB: a manager sets the RMB rate in the till settings first.')}</span></p>}
            {curFor(method).length > 1 && (
              <div className="tl-pay-cur" role="radiogroup" aria-label={tr('Currency')}>
                {curFor(method).map((c) => (
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
            {method === 'card' && <CardFields terminals={terminals} value={card} onChange={setCard} />}
            {method === 'paystack' && <PhonePay token={token} amount={total} paid={phonePaid} onPaid={setPhonePaid} onReset={() => setPhonePaid(null)} />}
            {method === 'gift_card' && (
              <div className="tl-giftpay">
                <label htmlFor="tl-gift-code" className="pos-big-label">🎁 {tr('The number on the gift card')}</label>
                <div className="tl-giftpay-row">
                  <input id="tl-gift-code" className="input pos-big-input" inputMode="numeric" autoComplete="off" autoFocus value={giftCode} placeholder="0000 0000 0000 0000"
                    onChange={(e) => { const d = e.target.value.replace(/\D/g, '').slice(0, 16); setGiftCode(d.replace(/(\d{4})(?=\d)/g, '$1 ')); setGift(null); setGiftErr(null); if (d.length === 16) checkGift(d); }} />
                  <button type="button" className="btn btn-secondary tl-btn" disabled={giftCode.replace(/\D/g, '').length !== 16} onClick={() => checkGift(giftCode)}>{tr('Check')}</button>
                </div>
                {giftErr && <p className="tl-pay-acct is-bad"><span>{giftErr}</span></p>}
                {gift && (
                  <p className={'tl-pay-acct' + (giftShort ? ' is-bad' : '')}>
                    <span>{gift.status !== 'active' ? tr('This gift card was cancelled.')
                      : gift.balance + 0.004 < total ? tr('{balance} left on this card: not enough for {amount}.', { balance: money(gift.balance), amount: money(total) })
                        : tr('{balance} left on this card; {left} after this.', { balance: money(gift.balance), left: money(round2(gift.balance - total)) })}</span>
                    {gift.status === 'active' && gift.balance > 0 && gift.balance + 0.004 < total && <button type="button" className="btn btn-primary tl-btn" onClick={splitWithCard}>{tr('Use it, and pay the rest another way')}</button>}
                  </p>
                )}
              </div>
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
                      {methods.filter((m) => m !== 'iou' && m !== 'paystack').map((m) => <option key={m} value={m} disabled={!allowed(m)}>{methodName(m)}{allowed(m) ? '' : ' — ' + (NEEDS_CUSTOMER[m] ? tr('no account') : tr('no RMB rate'))}</option>)}
                    </select>
                    {curFor(p.method).length > 1 ? (
                      <select className="input tl-part-cur" value={p.currency} onChange={(e) => setPart(i, { currency: e.target.value, tendered: '' })} aria-label={tr('Currency')}>
                        {curFor(p.method).map((c) => <option key={c.code} value={c.code}>{CURRENCY_LABEL[c.code]}</option>)}
                      </select>
                    ) : p.currency !== 'GHS' && <span className="tl-part-cur is-fixed">{CURRENCY_LABEL[p.currency]}</span>}
                    <input className="input tl-part-amt" type="number" min="0" step="0.01" inputMode="decimal" value={p.amount} onChange={(e) => setPart(i, { amount: e.target.value })} aria-label={tr('Amount in cedis')} placeholder="0.00" />
                    {p.method === 'gift_card' && <input className="input tl-part-given" inputMode="numeric" value={p.code || ''} onChange={(e) => setPart(i, { code: e.target.value.replace(/[^\d ]/g, '').slice(0, 19) })} placeholder={tr('Card number')} aria-label={tr('The number on the gift card')} />}
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
          <button type="submit" className="btn btn-primary pos-complete" disabled={busy || !(ahead.length ? aheadOk : split ? splitOk : singleOk)}>{busy ? tr('Processing…') : tr('Complete sale')}</button>
        </div>
      </form>
    </div>
  );
}
