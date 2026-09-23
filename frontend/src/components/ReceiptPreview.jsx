import { money } from '../lib/currency';
import './ReceiptPreview.css';
import PrintLayer from './PrintLayer';

import { DOCUMENT_INTL_LOCALE, docTr, tr } from '../lib/i18n.jsx';
import { docCodeLabel } from '../lib/codeLabels.js';
// Shared receipt preview dialog — originally only on ReceiptsPage, now also
// used from PaymentsPage (each payment has exactly one receipt, created
// alongside it by invoices.service.js's recordPayment — see receipts.service.js's
// paymentId field), so previewing "the payment" and "its receipt" show the
// same document either way.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(DOCUMENT_INTL_LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReceiptPreview({ receipt, previewRef, sharing, shareError, onClose, onShare }) {
  // The receipt/waybill itself is a customer document, written with docTr()
  // in the company's document language; only the buttons under it (from the
  // no-print error banner down) follow the reader. See docTr in i18n.jsx.
  return (
    <PrintLayer onClose={onClose}>
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog receipt-preview" ref={previewRef} onClick={(e) => e.stopPropagation()}>
          <div className="receipt-preview-head">
            <div className="receipt-preview-brand">
              <img src="/logo.png" alt="" className="receipt-preview-logo" />
              <div>
                <div className="receipt-preview-brand-name">Bamboo Products Limited</div>
                <div className="receipt-preview-brand-address">
                  Poki House<br />
                  35 J K Siaw St, Community 9, Tema, Ghana<br />
                  GT-191-1859 (GhanaPostGPS)<br />
                  WhatsApp: 0591933925
                </div>
              </div>
            </div>
            <div className="receipt-preview-headright">
              <div className="receipt-preview-eyebrow">{docTr('Receipt')}</div>
              <div className="receipt-preview-no">{receipt.receiptNo}</div>
              <div className="receipt-preview-date">{docTr('Date')} {fmtDate(receipt.date)}</div>
            </div>
          </div>
          <div>
            <div className="receipt-preview-eyebrow receipt-preview-eyebrow-block">{docTr('Received from')}</div>
            <div className="receipt-preview-customer">{receipt.customerName}</div>
            <div className="receipt-preview-address">{receipt.customerAddress || '—'}</div>
          </div>
          <div className="receipt-preview-grid">
            <div>{docTr('Invoice')} <strong>{receipt.invoiceNo}</strong></div>
            <div>{docTr('Payment method')} <strong className="receipts-method">{docCodeLabel(receipt.method)}</strong></div>
            <div>{docTr('Transaction reference')} <strong>{receipt.reference || '—'}</strong></div>
            <div>{docTr('Received by')} <strong>{receipt.receivedByName}</strong></div>
          </div>
          <div className="receipt-preview-amounts">
            <div>{docTr('Remaining balance')}   <strong>{money(receipt.balanceAfter, receipt.currency)}</strong></div>
            <div className="receipt-preview-amount-received">{docTr('Amount received')}   <strong>{money(receipt.amount, receipt.currency)}</strong></div>
          </div>
          {shareError && <div className="error-banner no-print">{shareError}</div>}
          <div className="dialog-actions no-print">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print')}</button>
            <button type="button" className="btn btn-primary" disabled={sharing} onClick={onShare}>
              {sharing ? tr('Preparing…') : tr('Share')}
            </button>
          </div>
        </div>
      </div>
    </PrintLayer>
  );
}
