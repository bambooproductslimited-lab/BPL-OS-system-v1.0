import { useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import './EmailDocumentDialog.css';
import './CreditNoteDialog.css';
import './CancelInvoiceDialog.css';

// Cancelling an invoice that is not needed any more, paid or not (backend
// invoices.service.js voidInvoice). It stays on the list as Voided, for the
// record, and owes nothing. When something was paid on it, the person
// cancelling says what happens to that money:
//   refund — it goes back to the customer: recorded as a refund, so the
//            money in and the money back both stay on record;
//   remove — it never came in (recorded by mistake, or twice): the payments
//            and their receipts are taken off.

const METHODS = ['mobile_money', 'cash', 'bank_transfer', 'card', 'cheque'];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function Glyph({ d, size = 18 }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
}
const BAN = <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>;

export default function CancelInvoiceDialog({ invoice, onClose, onDone }) {
  const m = (n) => money(n, invoice.currency);
  const paid = r2(invoice.amountPaid);
  const paidOnline = (invoice.payments || []).some((p) => p.online);
  const [reason, setReason] = useState('');
  const [way, setWay] = useState(paid > 0 ? 'refund' : null);
  const [method, setMethod] = useState('mobile_money');
  const [reference, setReference] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const hasStock = (invoice.items || []).some((it) => it.productId);

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const out = await api.post('/invoices/' + invoice.id + '/void', {
        reason: reason.trim(),
        money: paid > 0 ? (way === 'refund' ? { way, method, reference: reference.trim() } : { way }) : undefined
      });
      onDone(out, paid > 0 ? { way, amount: paid } : null);
    } catch (err) { setError(err.message); setSaving(false); }
  }

  const canSave = !saving && (paid <= 0 || (reason.trim() && way));
  return (
    <div className="dialog-backdrop ed-over no-print" onClick={() => !saving && onClose()}>
      <form className="dialog ed cn ci" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="ci-title">
        <div className="ed-head">
          <span className="ed-head-icon ci-icon"><Glyph d={BAN} size={20} /></span>
          <div>
            <h2 id="ci-title">{tr('Cancel {invoiceNo}?', { invoiceNo: invoice.invoiceNo })}</h2>
            <p className="ed-sub">{tr('For an invoice you do not need any more. It stays on the list as Voided, for the record, and nothing is owed on it.')}</p>
          </div>
        </div>

        <div className="cn-now">
          <div><span>{tr('Customer')}</span><strong className="ci-name">{invoice.customerName || '—'}</strong></div>
          <div><span>{tr('Invoiced')}</span><strong>{m(invoice.grandTotal)}</strong></div>
          <div><span>{tr('Paid')}</span><strong>{m(paid)}</strong></div>
        </div>

        {paid > 0 && (
          <fieldset className="ci-ways">
            <legend className="field-label">{tr('{amount} was paid on it. What happens to that money?', { amount: m(paid) })}</legend>
            <label className={'ci-way' + (way === 'refund' ? ' is-on' : '')}>
              <input type="radio" name="ci-way" value="refund" checked={way === 'refund'} onChange={() => setWay('refund')} />
              <span>
                <strong>{tr('We give it back to the customer')}</strong>
                <small>{tr('A refund of {amount} is recorded. The payment and its receipt stay on record, so the money in and the money back both show.', { amount: m(paid) })}</small>
              </span>
            </label>
            {way === 'refund' && (
              <div className="cn-refund">
                <div className="ed-grid">
                  <label className="field">
                    <span className="field-label">{tr('Paid back by')}</span>
                    <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                      {METHODS.map((k) => <option key={k} value={k}>{{ mobile_money: tr('Mobile money'), cash: tr('Cash'), bank_transfer: tr('Bank transfer'), card: tr('Card'), cheque: tr('Cheque') }[k]}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">{tr('Reference (optional)')}</span>
                    <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder={tr('e.g. the MoMo transaction ID')} />
                  </label>
                </div>
              </div>
            )}
            <label className={'ci-way' + (way === 'remove' ? ' is-on' : '') + (paidOnline ? ' is-off' : '')}>
              <input type="radio" name="ci-way" value="remove" checked={way === 'remove'} disabled={paidOnline} onChange={() => setWay('remove')} />
              <span>
                <strong>{tr('The money never came in')}</strong>
                <small>{paidOnline
                  ? tr('Not possible here: it was paid online (card or Mobile Money), so it did come in.')
                  : tr('The payment was recorded by mistake, or twice. Its payments and receipts are taken off.')}</small>
              </span>
            </label>
          </fieldset>
        )}

        <label className="field">
          <span className="field-label">{paid > 0 ? tr('Why is it cancelled?') : tr('Why is it cancelled? (optional)')}</span>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required={paid > 0} autoFocus placeholder={tr('e.g. issued twice, order called off, wrong customer')} />
        </label>

        <ul className="ci-notes">
          {hasStock && <li>{tr('Its stock items go back into stock.')}</li>}
          <li>{tr('A shop order waiting on it is cancelled too.')}</li>
          <li>{tr('Its order or quotation can be invoiced again.')}</li>
        </ul>

        {error && <div className="error-banner" role="alert">{error}</div>}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Keep the invoice')}</button>
          <button type="submit" className="btn btn-danger" disabled={!canSave}>
            {saving ? tr('Cancelling…') : paid > 0 && way === 'refund' ? tr('Cancel and refund {amount}', { amount: m(paid) }) : tr('Cancel the invoice')}
          </button>
        </div>
      </form>
    </div>
  );
}
