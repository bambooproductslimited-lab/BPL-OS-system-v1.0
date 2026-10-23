import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { methodName } from './tillShared';
import { CARD_BRANDS, CARD_ENTRIES } from './tillBill';
import './growth.css';

// Cards at the till (PayDialog.jsx), two ways (backend
// restaurantTillMoney, restaurantPaystack):
// - the bank's card terminal on the counter: the cashier charges the card
//   there, then notes here its brand, how it was read (tap, chip, swipe),
//   its last 4 digits and the terminal's approval code — for the
//   reconciliation with the bank, and Square's Card Brand / PAN Suffix;
// - pay by phone: a QR code the customer scans to pay on their own phone,
//   by card or Mobile Money, through Paystack (when the server has its key
//   and a manager turned it on); the till waits until Paystack says paid.

export function CardFields({ terminals, value, onChange }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="cp-card">
      <div className="cp-face" data-brand={value.brand}>
        <span className="cp-chip" aria-hidden="true" />
        <span className="cp-wave" aria-hidden="true">{value.entry === 'tap' ? ')))' : ''}</span>
        <b className="cp-num">•••• •••• •••• {value.last4.padEnd(4, '•')}</b>
        <span className="cp-brand">{value.brand === 'Other' ? tr('Card') : value.brand}</span>
      </div>
      <div className="cp-fields">
        <div className="tl-chips" role="radiogroup" aria-label={tr('Card')}>
          {CARD_BRANDS.map((b) => <button key={b} type="button" role="radio" aria-checked={value.brand === b} className={'tl-chip' + (value.brand === b ? ' is-on' : '')} onClick={() => set({ brand: b })}>{b === 'Other' ? tr('Other') : b}</button>)}
        </div>
        <div className="dk-segment" role="radiogroup" aria-label={tr('How the card was read')}>
          {CARD_ENTRIES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={value.entry === k} className={value.entry === k ? 'is-on' : ''} onClick={() => set({ entry: k })}>{tr(label)}</button>)}
        </div>
        <div className="cp-row">
          <label className="field"><span>{tr('Last 4 digits')}</span>
            <input className="input cp-last4" inputMode="numeric" autoComplete="off" maxLength={4} value={value.last4} onChange={(e) => set({ last4: e.target.value.replace(/\D/g, '').slice(0, 4) })} placeholder="1234" /></label>
          <label className="field"><span>{tr('Approval code')}</span>
            <input className="input" autoComplete="off" maxLength={20} value={value.ref} onChange={(e) => set({ ref: e.target.value.replace(/[^\w-]/g, '').toUpperCase() })} placeholder={tr('On the terminal\'s slip')} /></label>
          {terminals.length > 1 && (
            <label className="field"><span>{tr('Terminal')}</span>
              <select className="input" value={value.terminal} onChange={(e) => set({ terminal: e.target.value })}>{terminals.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
          )}
        </div>
        <p className="dk-muted tl-small">{tr('Charge the card on the terminal first. Nothing here charges it: this keeps a note for the reconciliation.')}</p>
      </div>
    </div>
  );
}

// Pay by phone: the QR code, then the wait. onPaid({ reference, channel, cardBrand, cardLast4 }).
export function PhonePay({ token, amount, paid, onPaid, onReset }) {
  const [pay, setPay] = useState(null);
  const [qr, setQr] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const amountFor = useRef(null);
  async function start() {
    setBusy(true); setError(null);
    try {
      const p = await posFetch('POST', '/pos/paystack', token, { amount });
      amountFor.current = amount;
      setPay(p);
      setQr(await QRCode.toDataURL(p.url, { margin: 1, width: 260, color: { dark: '#0b1324', light: '#ffffff' } }));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  // Asked again every 3 seconds until Paystack says paid, failed or given up.
  useEffect(() => {
    if (!pay || pay.status !== 'pending') return undefined;
    let live = true;
    const t = setInterval(async () => {
      try {
        const s = await posFetch('GET', '/pos/paystack/' + encodeURIComponent(pay.reference), token);
        if (!live) return;
        setPay(s);
        if (s.status === 'success') onPaid(s);
      } catch { /* asked again next time */ }
    }, 3000);
    return () => { live = false; clearInterval(t); };
  }, [pay, token, onPaid]);
  // The bill changed (a tip): a new code for the new amount.
  useEffect(() => { if (pay && pay.status !== 'success' && amountFor.current !== amount) { setPay(null); setQr(null); onReset(); } }, [amount]); // eslint-disable-line react-hooks/exhaustive-deps

  if (paid) {
    return (
      <div className="cp-phone is-paid">
        <span className="cp-tick" aria-hidden="true">✓</span>
        <div><strong>{tr('Paid: {amount}', { amount: money(paid.amount) })}</strong>
          <small>{paid.channel === 'mobile_money' ? methodName('mobile_money') : (paid.cardBrand || tr('Card')) + (paid.cardLast4 ? ' •••• ' + paid.cardLast4 : '')} · {paid.reference}</small></div>
      </div>
    );
  }
  if (!pay) {
    return (
      <div className="cp-phone">
        <span className="cp-phone-ico" aria-hidden="true">📲</span>
        <div><strong>{tr('The customer pays on their phone')}</strong><small>{tr('By card, or Mobile Money, through Paystack: they scan the code and pay {amount}.', { amount: money(amount) })}</small></div>
        <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={start}>{busy ? tr('Starting…') : tr('Show the QR code')}</button>
        {error && <div className="error-banner cp-wide">{error}</div>}
      </div>
    );
  }
  return (
    <div className={'cp-qr' + (pay.status === 'failed' || pay.status === 'abandoned' ? ' is-bad' : '')}>
      {qr && <img src={qr} alt={tr('QR code to pay {amount}', { amount: money(amount) })} />}
      <div className="cp-qr-side">
        <strong>{money(amount)}</strong>
        {pay.status === 'pending' ? <p className="cp-wait"><span className="cp-dot" aria-hidden="true" />{tr('Waiting for the customer to pay…')}</p>
          : <p className="cp-wait is-bad">{tr('Paystack says it did not go through.')}</p>}
        <small className="dk-muted">{tr('Scan with the phone\'s camera. The till moves on by itself once it is paid.')}</small>
        <code>{pay.reference}</code>
        {pay.status !== 'pending' && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setPay(null); setQr(null); onReset(); }}>{tr('Try again')}</button>}
      </div>
    </div>
  );
}
