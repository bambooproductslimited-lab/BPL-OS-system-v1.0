import { useRef, useState } from 'react';
import { shareOrDownloadPdf } from '../lib/documentShare';
import './WaybillPreview.css';
import PrintLayer from './PrintLayer';

import { tr } from '../lib/i18n.jsx';
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
    <PrintLayer onClose={onClose}>
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="waybill-preview" ref={nodeRef} onClick={(e) => e.stopPropagation()}>
          <div className="waybill-preview-head">
            <div className="waybill-preview-brand">
              <img src="/logo.png" alt="" className="waybill-preview-logo" />
              <div>
                <div className="waybill-preview-brand-name">{tr('Bamboo Products Limited')}</div>
                <div className="waybill-preview-brand-web">{tr('www.bplghana.com')}</div>
                <div className="waybill-preview-brand-address">
                  {tr('Poki House')}<br />
                  {tr('35 J K Siaw St, Community 9, Tema, Ghana')}<br />
                  {tr('GT-191-1859 (GhanaPostGPS)')}<br />
                  {tr('WhatsApp: 0591933925')}
                </div>
              </div>
            </div>
            <div className="waybill-preview-headright">
              <div className="waybill-preview-eyebrow">{tr('Waybill')}</div>
              <div className="waybill-preview-no">{waybill.waybillNo}</div>
              <div className="waybill-preview-date">{tr('Date')} {fmtDate(waybill.createdAt)}</div>
              <div className="waybill-preview-origin">{tr('From')} {waybill.origin === 'factory' ? 'Factory' : 'Showroom'}</div>
            </div>
          </div>
          <div className="waybill-preview-rule" />

          <div className="waybill-preview-blocks">
            <div>
              <div className="waybill-preview-block-title">{tr('Shipped to')}</div>
              <div className="waybill-preview-block-line waybill-preview-shipto-name">{waybill.shippedToName || waybill.destination}</div>
              {waybill.shippedToAddress && <div className="waybill-preview-block-line">{waybill.shippedToAddress}</div>}
              {waybill.shippedToPhone && <div className="waybill-preview-block-line">{tr('Tel:')} {waybill.shippedToPhone}</div>}
              {waybill.shippedToEmail && <div className="waybill-preview-block-line">{waybill.shippedToEmail}</div>}
            </div>
            <div>
              <div className="waybill-preview-block-title">{tr('Shipment details')}</div>
              <div className="waybill-preview-block-line">{tr('Shipping date:')} {fmtDate(waybill.shippingDate)}</div>
              <div className="waybill-preview-block-line">{tr('Driver:')} {waybill.driverName || '—'}</div>
              <div className="waybill-preview-block-line">{tr('Vehicle:')} {waybill.vehicleNo || '—'}</div>
              <div className="waybill-preview-block-line">{tr('Sales rep:')} {waybill.salesRepName || '—'}</div>
            </div>
          </div>

          <table className="waybill-preview-table">
            <thead><tr><th>{tr('S/N')}</th><th>{tr('Description')}</th><th className="waybill-preview-num">{tr('Quantity')}</th></tr></thead>
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
              <div className="waybill-preview-block-title">{tr('Notes')}</div>
              <p className="waybill-preview-notes-body">{waybill.notes}</p>
            </div>
          )}

          <div className="waybill-preview-signoff">
            <div className="waybill-preview-sign">
              <div className="waybill-preview-sign-name">{waybill.packagedBy || ' '}</div>
              <div className="waybill-preview-sign-line" />
              <div className="waybill-preview-sign-label">{tr('Packaged by (name & signature)')}</div>
            </div>
            <div className="waybill-preview-sign">
              <div className="waybill-preview-sign-name">{waybill.receivedBy || ' '}</div>
              <div className="waybill-preview-sign-line" />
              <div className="waybill-preview-sign-label">{tr('Received by (name & signature)')}</div>
            </div>
            <div className="waybill-preview-sign">
              <div className="waybill-preview-sign-name">{waybill.approvedBy || ' '}</div>
              <div className="waybill-preview-sign-line" />
              <div className="waybill-preview-sign-label">{tr('Approved by (name & signature)')}</div>
            </div>
          </div>

          {shareError && <div className="error-banner no-print">{shareError}</div>}
          <div className="waybill-preview-actions no-print">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print')}</button>
            <button type="button" className="btn btn-primary" disabled={sharing} onClick={handleShare}>
              {sharing ? 'Preparing…' : 'Share'}
            </button>
          </div>
        </div>
      </div>
    </PrintLayer>
  );
}
