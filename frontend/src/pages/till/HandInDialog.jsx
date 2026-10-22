import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { payName, timeOf } from '../delivery/dlShared';

// The money a rider brought back for a delivery (backend restaurantDelivery
// handIn): what the rider says they collected, what the cashier counts and
// how the customer paid. Confirmed, the open order is charged into the
// cashier's drawer as a sale; less than the order comes to needs the reason
// and goes to a manager as a dispute. Opens by itself on the till when a
// rider says they have collected (RestaurantPosPage), or from Open orders.
function round2(n) { return Math.round(Number(n) * 100) / 100; }

export default function HandInDialog({ token, tab, onClose, onDone }) {
  const d = tab.delivery;
  const owed = d.toCollect || tab.total;
  const said = d.collected;
  const [method, setMethod] = useState((said && said.method) || d.collectMethod || 'cash');
  const [amount, setAmount] = useState(String(said ? said.amount : owed));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n >= 0;
  const short = valid && n < owed - 0.004 ? round2(owed - n) : 0;
  const change = valid && method === 'cash' && n > owed + 0.004 ? round2(n - owed) : 0;

  async function confirm() {
    setBusy(true); setError(null);
    try { onDone(await posFetch('POST', '/pos/delivery/' + d.id + '/hand-in', token, { amount: n, method, note: note.trim() })); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog tl-handin" role="dialog" aria-modal="true" aria-labelledby="tl-handin-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico is-money" aria-hidden="true">💵</span>
        <h2 id="tl-handin-title">{tr('Money from {name}', { name: d.riderName })}</h2>
        <p className="dk-muted">{[d.ref, tab.customerName || tab.label, tr('the order comes to {amount}', { amount: money(owed) })].filter(Boolean).join(' · ')}</p>
        <div className={'tl-handin-says' + (said ? '' : ' is-none')}>
          <span aria-hidden="true">🛵</span>
          <div>
            {said ? tr('{name} says: collected {amount} ({method}) at {time}.', { name: d.riderName, amount: money(said.amount), method: payName(said.method), time: timeOf(said.at) })
              : tr('{name} has not said yet what was collected.', { name: d.riderName })}
            {said && said.note && <small>✎ {said.note}</small>}
          </div>
        </div>
        <span className="tl-handin-label">{tr('How the customer paid')}</span>
        <div className="tl-handin-pick" role="radiogroup" aria-label={tr('How the customer paid')}>
          {['cash', 'mobile_money'].map((m) => (
            <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? 'is-on' : ''} onClick={() => setMethod(m)}>{m === 'cash' ? '💵' : '📱'} {payName(m)}</button>
          ))}
        </div>
        {method === 'mobile_money' && <p className="dk-muted tl-small">📱 {tr('Check the restaurant\'s Mobile Money phone: the payment has come in.')}</p>}
        <label className="tl-handin-amount">
          <span>{method === 'cash' ? tr('Cash you counted') : tr('Amount that came in')}</span>
          <input className="input" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
        </label>
        {short > 0 && (
          <>
            <p className="tl-handin-short">⚠️ {tr('Short by {amount}. A manager sees it under Disputes.', { amount: money(short) })}</p>
            <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={tr('Why is it short?')} />
          </>
        )}
        {change > 0 && <p className="tl-handin-change">{tr('Give back {amount} change.', { amount: money(change) })}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{tr('Not now')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !valid || (short > 0 && !note.trim())} onClick={confirm}>
            {busy ? tr('Processing…') : '✅ ' + tr('Received {amount} · into the drawer', { amount: money(valid ? n : 0) })}
          </button>
        </div>
      </div>
    </div>
  );
}
