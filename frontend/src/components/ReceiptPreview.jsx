import { money } from '../lib/currency';
import './ReceiptPreview.css';
import PrintLayer from './PrintLayer';

import { tr } from '../lib/i18n.jsx';
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
    <PrintLayer onClose={onClose}>
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="dialog receipt-preview" ref={previewRef} onClick={(e) => e.stopPropagation()}>
          <div className="receipt-preview-head">
            <div className="receipt-preview-brand">
              <img src="/logo.png" alt="" className="receipt-preview-logo" />
              <div>
                <div className="receipt-preview-brand-name">{tr('Bamboo Products Limited')}</div>
                <div className="receipt-preview-brand-address">
                  {tr('Poki House')}<br />
                  {tr('35 J K Siaw St, Community 9, Tema, Ghana')}<br />
                  {tr('GT-191-1859 (GhanaPostGPS)')}<br />
                  {tr('WhatsApp: 0591933925')}
                </div>
              </div>
            </div>
            <div className="receipt-preview-headright">
              <div className="receipt-preview-eyebrow">{tr('Receipt')}</div>
              <div className="receipt-preview-no">{receipt.receiptNo}</div>
              <div className="receipt-preview-date">{tr('Date')} {fmtDate(receipt.date)}</div>
            </div>
          </div>
          <div>
            <div className="receipt-preview-eyebrow receipt-preview-eyebrow-block">{tr('Received from')}</div>
            <div className="receipt-preview-customer">{receipt.customerName}</div>
            <div className="receipt-preview-address">{receipt.customerAddress || '—'}</div>
          </div>
          <div className="receipt-preview-grid">
            <div>{tr('Invoice')} <strong>{receipt.invoiceNo}</strong></div>
            <div>{tr('Payment method')} <strong className="receipts-method">{receipt.method.replace('_', ' ')}</strong></div>
            <div>{tr('Transaction reference')} <strong>{receipt.reference || '—'}</strong></div>
            <div>{tr('Received by')} <strong>{receipt.receivedByName}</strong></div>
          </div>
          <div className="receipt-preview-amounts">
            <div>{tr('Remaining balance')}   <strong>{money(receipt.balanceAfter, receipt.currency)}</strong></div>
            <div className="receipt-preview-amount-received">{tr('Amount received')}   <strong>{money(receipt.amount, receipt.currency)}</strong></div>
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
