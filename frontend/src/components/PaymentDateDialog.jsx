import { useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { fmtDate } from './DashKit';

// Moves a payment recorded on the wrong day — typed in late with today's
// date, or settled in a clean-up — to the day the money actually came in
// (PATCH /api/payments/:id, payments.service.js changeDate). Its receipt
// follows; the old date, the new one and the reason go in the audit log.
// Used on the Payments page and behind "Money in" on the Saturday sales
// review. payment: { id, amount, currency, date, customerName, invoiceNo, source }.

function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

export default function PaymentDateDialog({ payment, onClose, onSaved }) {
  const was = String(payment.date).slice(0, 10);
  const [date, setDate] = useState(was);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const locked = payment.source === 'square' ? tr('This payment came from Square, and the next Square import would put its date back. Change it in Square.')
    : payment.source === 'refund' ? tr('This is a refund; its date is its credit note\'s.') : null;
  const ok = !locked && date && date !== was && date <= todayIso() && reason.trim();

  async function save(e) {
    e.preventDefault();
    if (!ok) return;
    setSaving(true); setError(null);
    try {
      const r = await api.patch('/payments/' + payment.id, { date, reason: reason.trim() });
      onSaved(r);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop pdd" onClick={() => !saving && onClose()}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>{tr('Change the payment date')}</h2>
        <p className="dialog-body">
          {tr('{amount} from {name} on {invoiceNo}, recorded as received {date}.', { amount: money(payment.amount, payment.currency), name: payment.customerName, invoiceNo: payment.invoiceNo, date: fmtDate(was) })}
        </p>
        {locked ? <p className="error-banner" role="alert">{locked}</p> : (
          <>
            <label className="field">
              <span>{tr('The day the money came in')}</span>
              <input className="input" type="date" max={todayIso()} value={date} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="field">
              <span>{tr('Why it changes')}</span>
              <textarea className="input" rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. paid in September, recorded late')} required />
            </label>
            <p className="dk-muted tl-small">{tr('The receipt shows the new date. The old date, the new one and the reason are kept in the audit log.')}</p>
          </>
        )}
        {error && <p className="error-banner" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{locked ? tr('Close') : tr('Cancel')}</button>
          {!locked && <button type="submit" className="btn btn-primary" disabled={!ok || saving}>{saving ? tr('Saving…') : tr('Move the payment')}</button>}
        </div>
      </form>
    </div>
  );
}
