import { money } from '../lib/currency';
import './ReceiptPreview.css';

// Shared receipt preview dialog — originally only on ReceiptsPage, now also
// used from PaymentsPage (each payment has exactly one receipt, created
// alongside it by invoices.service.js's recordPayment — see receipts.service.js's
// paymentId field), so previewing "the payment" and "its receipt" show the
// same document either way.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReceiptPreview({ receipt, previewRef, sharing, shareError, onClose, onShare }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog receipt-preview" ref={previewRef} onClick={(e) => e.stopPropagation()}>
        <div className="receipt-preview-head">
          <div className="receipt-preview-brand">
            <img src="/logo.png" alt="" className="receipt-preview-logo" />
            <div>
              <div className="receipt-preview-brand-name">Bamboo Products Limited</div>
              <div className="receipt-preview-brand-address">
                Poki House, GT-191-1859 (GhanaPostGPS)<br />
                35 J K Siaw St, Community 9, Tema, Ghana<br />
                P.O. Box CO 131, Tema, Ghana<br />
                Tel: 0591933925 / 0249186859
              </div>
            </div>
          </div>
          <div className="receipt-preview-headright">
            <div className="receipt-preview-eyebrow">Receipt</div>
            <div className="receipt-preview-no">{receipt.receiptNo}</div>
            <div className="receipt-preview-date">Date {fmtDate(receipt.date)}</div>
          </div>
        </div>
        <div>
          <div className="receipt-preview-eyebrow receipt-preview-eyebrow-block">Received from</div>
          <div className="receipt-preview-customer">{receipt.customerName}</div>
          <div className="receipt-preview-address">{receipt.customerAddress || '—'}</div>
        </div>
        <div className="receipt-preview-grid">
          <div>Invoice <strong>{receipt.invoiceNo}</strong></div>
          <div>Payment method <strong className="receipts-method">{receipt.method.replace('_', ' ')}</strong></div>
          <div>Transaction reference <strong>{receipt.reference || '—'}</strong></div>
          <div>Received by <strong>{receipt.receivedByName}</strong></div>
        </div>
        <div className="receipt-preview-amounts">
          <div>Remaining balance &nbsp; <strong>{money(receipt.balanceAfter, receipt.currency)}</strong></div>
          <div className="receipt-preview-amount-received">Amount received &nbsp; <strong>{money(receipt.amount, receipt.currency)}</strong></div>
        </div>
        {shareError && <div className="error-banner no-print">{shareError}</div>}
        <div className="dialog-actions no-print">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>Print</button>
          <button type="button" className="btn btn-primary" disabled={sharing} onClick={onShare}>
            {sharing ? 'Preparing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
}
