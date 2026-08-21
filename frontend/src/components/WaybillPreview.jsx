import { useRef, useState } from 'react';
import { shareOrDownloadPdf } from '../lib/documentShare';
import './WaybillPreview.css';

// Printable waybill / packing slip: full company letterhead, a "shipped
// to" contact block, shipment details (date/driver/sales rep), a numbered
// items table (no pricing — this isn't a sales document), and three
// sign-off lines (packaged/received/approved) for physical signatures.

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso.length > 10 ? iso : iso + 'T00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function WaybillPreview({ waybill, onClose }) {
  const nodeRef = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);

  async function handleShare() {
    setShareError(null);
    setSharing(true);
    try {
      const filename = 'Waybill-' + waybill.waybillNo + '.pdf';
      await shareOrDownloadPdf(nodeRef.current, filename, 'Waybill ' + waybill.waybillNo, 'Waybill for ' + (waybill.shippedToName || waybill.destination));
    } catch (err) {
      if (err.name !== 'AbortError') setShareError(err.message || 'Could not share this waybill.');
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="waybill-preview" ref={nodeRef} onClick={(e) => e.stopPropagation()}>
        <div className="waybill-preview-head">
          <div className="waybill-preview-brand">
            <img src="/logo.png" alt="" className="waybill-preview-logo" />
            <div>
              <div className="waybill-preview-brand-name">Bamboo Products Limited</div>
              <div className="waybill-preview-brand-web">www.bplghana.com</div>
              <div className="waybill-preview-brand-address">
                Poki House, GT-191-1859 (GhanaPostGPS)<br />
                35 J K Siaw St, Community 9, Tema, Ghana<br />
                P.O. Box CO 131, Tema, Ghana<br />
                Tel: 0591933925 / 0249186859
              </div>
            </div>
          </div>
          <div className="waybill-preview-headright">
            <div className="waybill-preview-eyebrow">Waybill</div>
            <div className="waybill-preview-no">{waybill.waybillNo}</div>
            <div className="waybill-preview-date">Date {fmtDate(waybill.createdAt)}</div>
            <div className="waybill-preview-origin">From {waybill.origin === 'factory' ? 'Factory' : 'Showroom'}</div>
          </div>
        </div>
        <div className="waybill-preview-rule" />

        <div className="waybill-preview-blocks">
          <div>
            <div className="waybill-preview-block-title">Shipped to</div>
            <div className="waybill-preview-block-line waybill-preview-shipto-name">{waybill.shippedToName || waybill.destination}</div>
            {waybill.shippedToAddress && <div className="waybill-preview-block-line">{waybill.shippedToAddress}</div>}
            {waybill.shippedToPhone && <div className="waybill-preview-block-line">Tel: {waybill.shippedToPhone}</div>}
            {waybill.shippedToEmail && <div className="waybill-preview-block-line">{waybill.shippedToEmail}</div>}
          </div>
          <div>
            <div className="waybill-preview-block-title">Shipment details</div>
            <div className="waybill-preview-block-line">Shipping date: {fmtDate(waybill.shippingDate)}</div>
            <div className="waybill-preview-block-line">Driver: {waybill.driverName || '—'}</div>
            <div className="waybill-preview-block-line">Vehicle: {waybill.vehicleNo || '—'}</div>
            <div className="waybill-preview-block-line">Sales rep: {waybill.salesRepName || '—'}</div>
          </div>
        </div>

        <table className="waybill-preview-table">
          <thead><tr><th>S/N</th><th>Description</th><th className="waybill-preview-num">Quantity</th></tr></thead>
          <tbody>
            {waybill.items.map((it, i) => (
              <tr key={i}>
                <td>{it.itemNo || i + 1}</td>
                <td className="waybill-preview-desc">{it.description}</td>
                <td className="waybill-preview-num">{it.qty} {it.unit !== 'each' ? it.unit : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {waybill.notes && (
          <div className="waybill-preview-notes">
            <div className="waybill-preview-block-title">Notes</div>
            <p className="waybill-preview-notes-body">{waybill.notes}</p>
          </div>
        )}

        <div className="waybill-preview-signoff">
          <div className="waybill-preview-sign">
            <div className="waybill-preview-sign-name">{waybill.packagedBy || ' '}</div>
            <div className="waybill-preview-sign-line" />
            <div className="waybill-preview-sign-label">Packaged by (name &amp; signature)</div>
          </div>
          <div className="waybill-preview-sign">
            <div className="waybill-preview-sign-name">{waybill.receivedBy || ' '}</div>
            <div className="waybill-preview-sign-line" />
            <div className="waybill-preview-sign-label">Received by (name &amp; signature)</div>
          </div>
          <div className="waybill-preview-sign">
            <div className="waybill-preview-sign-name">{waybill.approvedBy || ' '}</div>
            <div className="waybill-preview-sign-line" />
            <div className="waybill-preview-sign-label">Approved by (name &amp; signature)</div>
          </div>
        </div>

        {shareError && <div className="error-banner no-print">{shareError}</div>}
        <div className="waybill-preview-actions no-print">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>Print</button>
          <button type="button" className="btn btn-primary" disabled={sharing} onClick={handleShare}>
            {sharing ? 'Preparing…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  );
}
