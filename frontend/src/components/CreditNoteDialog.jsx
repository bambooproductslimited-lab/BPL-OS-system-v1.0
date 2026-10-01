import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './EmailDocumentDialog.css';
import './CreditNoteDialog.css';

// A credit note on an invoice (backend creditNotes.service.js): take some
// of it back — goods returned, a price agreed down, a booking cut short —
// and refund what the customer then has paid over what they owe. The
// figures below the form say, before anything is saved, what they will owe
// or what they will have overpaid, so nobody has to work it out.
// `apiBase` is '/invoices' or '/poki/invoices'.

const METHODS = ['mobile_money', 'cash', 'bank_transfer', 'card', 'cheque'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function Glyph({ d, size = 18 }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
}
const UNDO = <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>;
const CHECK = <path d="m5 12.5 4.5 4.5L19 7.5" />;

export default function CreditNoteDialog({ invoice, apiBase, onClose, onDone }) {
  const cur = invoice.currency;
  const m = (n) => money(n, cur);
  const [history, setHistory] = useState([]);
  const [amount, setAmount] = useState('');
  const [refund, setRefund] = useState('');
  const [refundTouched, setRefundTouched] = useState(false);
  const [method, setMethod] = useState('mobile_money');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get(apiBase + '/' + invoice.id + '/credit-notes').then((l) => alive && setHistory(l)).catch(() => {});
    return () => { alive = false; };
  }, [apiBase, invoice.id]);

  // Where things stand, and where they would after this credit note.
  const creditable = Math.max(0, r2(invoice.grandTotal - (invoice.creditTotal || 0)));
  const paid = r2(invoice.amountPaid);
  const credit = Math.min(r2(amount), creditable);
  const owesAfter = Math.max(0, r2(creditable - credit - paid));
  const overpaid = Math.max(0, r2(paid - (creditable - credit)));
  const refundNow = refundTouched ? Math.min(r2(refund), overpaid) : overpaid;
  const tooMuch = r2(amount) > creditable + 0.005;
  const keep = r2(overpaid - refundNow);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const res = await api.post(apiBase + '/' + invoice.id + '/credit-notes', {
        amount: r2(amount), refundAmount: refundNow, refundMethod: refundNow > 0 ? method : undefined,
        refundReference: reference, reason
      });
      setDone(res);
      setHistory(res.creditNotes);
      if (onDone) onDone(res);
    } catch (err) { setError(err.message); }
    setSaving(false);
  }

  const canSave = !saving && reason.trim() && !tooMuch && (r2(amount) > 0 || refundNow > 0);
  return (
    <div className="dialog-backdrop ed-over no-print" onClick={() => !saving && onClose()}>
      <form className="dialog ed cn" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="cn-title">
        <div className="ed-head">
          <span className="ed-head-icon"><Glyph d={UNDO} size={20} /></span>
          <div>
            <h2 id="cn-title">{tr('Credit note on {invoiceNo}', { invoiceNo: invoice.invoiceNo })}</h2>
            <p className="ed-sub">{tr('Take some of the invoice back, and refund what the customer then paid over what they owe.')}</p>
          </div>
        </div>

        <div className="cn-now">
          <div><span>{tr('Invoiced')}</span><strong>{m(invoice.grandTotal)}</strong></div>
          {invoice.creditTotal > 0 && <div><span>{tr('Credited before')}</span><strong>− {m(invoice.creditTotal)}</strong></div>}
          <div><span>{tr('Paid')}</span><strong>{m(paid)}</strong></div>
          <div><span>{tr('Still to pay')}</span><strong>{m(invoice.balanceDue)}</strong></div>
        </div>

        {done ? (
          <div className="ed-done" role="status">
            <span className="ed-done-icon"><Glyph d={CHECK} size={26} /></span>
            <strong>{tr('{creditNo} made', { creditNo: done.creditNote.creditNo })}</strong>
            <span>{done.invoice.balanceDue > 0 ? tr('They now owe {amount}.', { amount: m(done.invoice.balanceDue) }) : tr('Nothing is owed on this invoice now.')}
              {done.creditNote.refundAmount > 0 && ' ' + tr('{amount} refunded.', { amount: m(done.creditNote.refundAmount) })}
              {done.overpaidLeft > 0 && ' ' + tr('{amount} they overpaid is still with you, as credit for them.', { amount: m(done.overpaidLeft) })}</span>
          </div>
        ) : (
          <>
            <div className="ed-grid">
              <label className="field">
                <span className="field-label">{tr('Take off the invoice')}</span>
                <input className="input" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={'0.00'} autoFocus />
                <small className={tooMuch ? 'ed-hint' : 'cn-hint'}>{tr('Up to {amount}. Leave 0 to only refund an overpayment.', { amount: m(creditable) })}</small>
              </label>
              <label className="field">
                <span className="field-label">{tr('Why')}</span>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required placeholder={tr('e.g. 2 panels returned, price agreed down')} />
              </label>
            </div>

            <div className={'cn-after' + (overpaid > 0 ? ' is-over' : '')} aria-live="polite">
              {overpaid > 0
                ? tr('After this, they have paid {amount} more than they owe.', { amount: m(overpaid) })
                : tr('After this, they owe {amount}.', { amount: m(owesAfter) })}
            </div>

            {overpaid > 0 && (
              <div className="cn-refund">
                <div className="ed-grid">
                  <label className="field">
                    <span className="field-label">{tr('Refund now')}</span>
                    <input className="input" type="number" min="0" step="0.01" max={overpaid} value={refundTouched ? refund : String(overpaid)} onChange={(e) => { setRefundTouched(true); setRefund(e.target.value); }} />
                    <small className="cn-hint">{keep > 0 ? tr('{amount} stays with you as credit for them.', { amount: m(keep) }) : tr('All of it goes back.')}</small>
                  </label>
                  <label className="field">
                    <span className="field-label">{tr('Paid back by')}</span>
                    <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                      {METHODS.map((k) => <option key={k} value={k}>{{ mobile_money: tr('Mobile money'), cash: tr('Cash'), bank_transfer: tr('Bank transfer'), card: tr('Card'), cheque: tr('Cheque') }[k]}</option>)}
                    </select>
                  </label>
                </div>
                <label className="field">
                  <span className="field-label">{tr('Reference (optional)')}</span>
                  <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder={tr('e.g. the MoMo transaction ID')} />
                </label>
              </div>
            )}
            {error && <div className="error-banner" role="alert">{error}</div>}
          </>
        )}

        {history.length > 0 && (
          <div className="ed-history">
            <div className="ed-history-title">{tr('Credit notes on this invoice')}</div>
            <ul>
              {history.map((h) => (
                <li key={h.id}>
                  <span className="ed-dot" aria-hidden="true" />
                  <span className="ed-history-text">
                    <strong>{h.creditNo} · {[h.amount > 0 && tr('{amount} off', { amount: m(h.amount) }), h.refundAmount > 0 && tr('{amount} refunded', { amount: m(h.refundAmount) })].filter(Boolean).join(' · ')}</strong>
                    <span>{h.reason} · {new Date(h.createdAt).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' })}{h.createdByName ? ' · ' + tr('by {name}', { name: h.createdByName }) : ''}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="dialog-actions">
          {done ? <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button> : (
            <>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={!canSave}>
                {saving ? tr('Saving…') : refundNow > 0 ? tr('Make credit note and refund {amount}', { amount: m(refundNow) }) : tr('Make credit note')}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
