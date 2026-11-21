import { useRef, useState } from 'react';
import { shareOrDownloadPdf } from '../lib/documentShare';
import PrintLayer from './PrintLayer';
import { docTr, tr } from '../lib/i18n.jsx';
import './PurchaseOrderPreview.css';

// The purchase order as it goes to the supplier or farmer, laid out as
// Bamboo Products' own: "PURCHASE ORDER – BAMBOO POLES", the company, the
// PO number and date; the supplier; the purchase details (no., description,
// specification, quantity, unit price, total); the total purchase value;
// the quality requirements; the delivery; and who prepared it. Printed, or
// shared as a PDF (lib/documentShare.js). The document is written with
// docTr() in the company's document language; the buttons follow the reader.
// The order itself: pages/PurchaseOrdersPage.jsx (backend
// purchaseOrders.service.js).

// 18.11.2026, as on the paper ones.
function poDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return d + '.' + m + '.' + y;
}
function amount(n, decimals) {
  return Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
// The total in words as on the paper: no pesewas when there are none.
function totalText(n) { return Number.isInteger(Math.round(n * 100) / 100) ? amount(n, 0) : amount(n, 2); }
function qtyText(q, unit) {
  const n = Number(q).toLocaleString('en-GB', { maximumFractionDigits: 3 });
  if (!unit) return n;
  return unit.length <= 3 ? n + unit : n + ' ' + unit;
}

export default function PurchaseOrderPreview({ order, actions, onClose }) {
  const nodeRef = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);
  const cur = order.currency || 'GHS';

  async function share() {
    setShareError(null);
    setSharing(true);
    try {
      await shareOrDownloadPdf(nodeRef.current, 'Purchase-order-' + order.number.replace(/\s+/g, '-') + '.pdf',
        docTr('Purchase order {no}', { no: order.number }), docTr('Purchase order {no} from {company}', { no: order.number, company: order.company.name }));
    } catch (err) {
      if (err.name !== 'AbortError') setShareError(err.message || tr('Could not share this purchase order.'));
    } finally {
      setSharing(false);
    }
  }

  return (
    <PrintLayer onClose={onClose}>
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="po-doc" ref={nodeRef} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={docTr('Purchase order {no}', { no: order.number })}>
          {order.status === 'cancelled' && <div className="po-doc-stamp">{docTr('Cancelled')}</div>}
          <h1 className="po-doc-title">{docTr('PURCHASE ORDER')} – {order.title.toUpperCase()}</h1>

          <div className="po-doc-company">{order.company.name.toUpperCase()}</div>
          <div className="po-doc-kind">{docTr('PURCHASE ORDER')}</div>

          <p className="po-doc-lines">
            <b>{docTr('PO No.:')}</b> {order.number}<br />
            <b>{docTr('Date:')}</b> {poDay(order.poDate)}
          </p>

          <h2 className="po-doc-h">{docTr('SUPPLIER')}</h2>
          <p className="po-doc-lines"><b>{docTr('Supplier/Farmer:')}</b> {order.supplier.name}</p>
          <p className="po-doc-lines">
            {order.supplier.location && <><b>{docTr('Location:')}</b> {order.supplier.location}<br /></>}
            {order.supplier.contact && <><b>{docTr('Contact:')}</b> {order.supplier.contact}</>}
          </p>

          <h2 className="po-doc-h">{docTr('PURCHASE DETAILS')}</h2>
          <div className="po-doc-table-wrap">
          <table className="po-doc-table">
            <thead>
              <tr>
                <th className="po-c-no">{docTr('No.')}</th>
                <th>{docTr('Description')}</th>
                <th>{docTr('Specification')}</th>
                <th className="po-c-num">{docTr('Quantity')}</th>
                <th className="po-c-num">{docTr('Unit Price ({cur})', { cur })}</th>
                <th className="po-c-num">{docTr('Total ({cur})', { cur })}</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l, i) => (
                <tr key={l.id || i}>
                  <td className="po-c-no">{i + 1}</td>
                  <td>{l.description}</td>
                  <td>{l.specification}</td>
                  <td className="po-c-num"><b>{qtyText(l.quantity, l.unit)}</b></td>
                  <td className="po-c-num">{amount(l.unitPrice, 2)}</td>
                  <td className="po-c-num"><b>{amount(l.total, 2)}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="po-doc-total">{docTr('TOTAL PURCHASE VALUE:')} {cur} {totalText(order.total)}</p>

          {order.quality.length > 0 && <>
            <h2 className="po-doc-h">{docTr('QUALITY REQUIREMENTS')}</h2>
            <ol className="po-doc-quality">{order.quality.map((q, i) => <li key={i}>{q}</li>)}</ol>
          </>}

          {(order.deliveryLocation || order.deliveryDate) && <>
            <h2 className="po-doc-h">{docTr('DELIVERY')}</h2>
            <p className="po-doc-lines">
              {order.deliveryLocation && <><b>{docTr('Delivery Location:')}</b> {order.deliveryLocation}<br /></>}
              {order.deliveryDate && <><b>{docTr('Expected Delivery Date:')}</b> {poDay(order.deliveryDate)}</>}
            </p>
          </>}

          {order.notes && <>
            <h2 className="po-doc-h">{docTr('NOTES')}</h2>
            <p className="po-doc-lines po-doc-notes">{order.notes}</p>
          </>}

          <h2 className="po-doc-h">{docTr('APPROVAL')}</h2>
          <p className="po-doc-lines">
            <b>{docTr('Prepared by:')}</b><br />
            {docTr('Name:')} {order.preparedBy.name || '—'}<br />
            {docTr('Position:')} {order.preparedBy.position || '—'}<br />
            {docTr('Signature:')} {order.preparedBy.signature || '—'}<br />
            {docTr('Date:')} {poDay(order.preparedBy.on || order.poDate)}
          </p>

          {shareError && <div className="error-banner no-print">{shareError}</div>}
          <div className="po-doc-actions no-print">
            {actions}
            <span className="po-doc-actions-gap" />
            <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print')}</button>
            <button type="button" className="btn btn-primary" disabled={sharing} onClick={share}>{sharing ? tr('Preparing…') : tr('Share or download PDF')}</button>
          </div>
        </div>
      </div>
    </PrintLayer>
  );
}
