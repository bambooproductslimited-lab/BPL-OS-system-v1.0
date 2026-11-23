import { useState } from 'react';
import { api } from '../api/client';
import { fmtDate } from './DashKit';
import { tr } from '../lib/i18n.jsx';
import './ReviveDialog.css';

// Reviving a document that ran out (backend quotations / estimates /
// invoices .service.js revive): a quotation or an estimate past its
// valid-until date gets a new one and opens again — a quotation that had
// gone out is "sent" again, so the customer can still say yes; an invoice's
// customer link opens again for 30 days (to see it and pay online), with a
// new due date if wanted. Either way the link the customer already has works
// again (a link lasts 30 days at most). Used by pages/QuotationsPage.jsx,
// EstimatesPage.jsx and InvoicesPage.jsx.

function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function today() { return new Date().toISOString().slice(0, 10); }

export default function ReviveDialog({ kind, doc, onDone, onClose }) {
  const isInvoice = kind === 'invoice';
  const number = isInvoice ? doc.invoiceNo : kind === 'quotation' ? doc.quoteNo : doc.estimateNo;
  const owing = isInvoice && (doc.status === 'unpaid' || doc.status === 'partially_paid');
  const [date, setDate] = useState(() => (isInvoice ? addDays(14) : addDays(30)));
  const [newDue, setNewDue] = useState(() => owing && !!doc.overdue);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const path = (isInvoice ? '/invoices/' : kind === 'quotation' ? '/quotations/' : '/estimates/') + doc.id + '/revive';

  async function go(e) {
    e.preventDefault();
    setErr(null);
    if ((!isInvoice || newDue) && date < today()) { setErr(tr('The new date must be today or later.')); return; }
    setBusy(true);
    try {
      const out = await api.post(path, isInvoice ? (newDue ? { dueDate: date } : {}) : { validUntil: date });
      onDone(out, isInvoice ? (newDue ? date : null) : date);
    } catch (x) { setErr(x.message); setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog rv" role="dialog" aria-modal="true" aria-labelledby="rv-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <h2 id="rv-title">♻️ {tr('Revive {no}', { no: number })}</h2>
        {isInvoice ? (
          <>
            <p className="rv-what">
              {doc.linkExpired
                ? tr('The link the customer has ran out on {date}. It opens again for 30 days, so they can see the invoice and pay it online.', { date: fmtDate(String(doc.linkExpiresAt).slice(0, 10)) })
                : doc.linkExpiresAt
                  ? tr('The link the customer has is renewed for 30 days from today, so they can see the invoice and pay it online.')
                  : tr('This invoice has no customer link yet: share it to make one. You can still give it a new due date here.')}
            </p>
            {owing && (
              <label className="rv-check">
                <input type="checkbox" checked={newDue} onChange={(e) => setNewDue(e.target.checked)} />
                <span>{doc.overdue ? tr('Give it a new due date (it was due {date})', { date: fmtDate(String(doc.dueDate).slice(0, 10)) }) : tr('Give it a new due date')}</span>
              </label>
            )}
            {owing && newDue && (
              <label className="rv-field"><span>{tr('New due date')}</span><input type="date" className="input" value={date} min={today()} onChange={(e) => setDate(e.target.value)} /></label>
            )}
          </>
        ) : (
          <>
            <p className="rv-what">
              {kind === 'quotation'
                ? tr('It ran out on {date}. With a new valid-until date it opens again — sent, if it had gone out — so the customer can still accept it, and the link they already have works again.', { date: fmtDate(String(doc.validUntil).slice(0, 10)) })
                : tr('It ran out on {date}. With a new valid-until date the customer can answer it again, and the link they already have works again.', { date: fmtDate(String(doc.validUntil).slice(0, 10)) })}
            </p>
            <label className="rv-field"><span>{tr('New valid-until date')}</span><input type="date" className="input" value={date} min={today()} onChange={(e) => setDate(e.target.value)} autoFocus /></label>
            <p className="rv-note">{tr('Check the prices first: they are the same as before. A customer link lasts 30 days at most.')}</p>
          </>
        )}
        {err && <p className="rv-err" role="alert">{err}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || (isInvoice && !newDue && !doc.linkExpiresAt)}>{busy ? tr('Reviving…') : '♻️ ' + tr('Revive')}</button>
        </div>
      </form>
    </div>
  );
}
