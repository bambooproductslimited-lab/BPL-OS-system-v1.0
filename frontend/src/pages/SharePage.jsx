import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import '../components/DocPreview.css';
import './SharePage.css';

// Public, unauthenticated view for a share link generated from the
// Preview dialog on Quotations/Estimates/Invoices (see DocPreview.jsx's
// Share section and backend/src/services/shares.service.js). Mounted
// outside AppShell/ProtectedRoute in App.jsx — no sidebar, no login,
// nothing but the document itself, since anyone with the link (customer
// included) can open it. Reuses DocPreview.css's classes so a shared
// document looks identical to what staff see in the app's own preview.

const DOC_LABEL = { quotation: 'Quotation', estimate: 'Estimate', invoice: 'Invoice' };

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value.length > 10 ? value : value + 'T00:00');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function lineTotal(it) {
  const line = (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
  const disc = it.discountType === 'percent' ? (line * (Number(it.discount) || 0)) / 100 : Number(it.discount) || 0;
  return Math.max(0, line - disc);
}

export default function SharePage() {
  const { token } = useParams();
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/share/' + token)
      .then(setDoc)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) return <div className="share-page-status">Loading…</div>;
  if (error) return <div className="share-page-status share-page-error">{error}</div>;
  if (!doc) return null;

  const cur = doc.currency;
  const isInvoice = doc.documentType === 'invoice';
  const dateLabel = isInvoice ? 'Issue date' : 'Issue date';
  const dateValue = fmtDate(doc.dateValue);
  const subHeadingText = isInvoice
    ? 'Due ' + fmtDate(doc.dueDate)
    : 'Valid until ' + fmtDate(doc.validUntil);

  return (
    <div className="share-page">
      <div className="doc-preview">
        <div className="doc-preview-head">
          <div className="doc-preview-brand">
            <img src="/logo.png" alt="" className="doc-preview-logo" />
            <div>
              <div className="doc-preview-brand-name">Bamboo Products Limited</div>
              <div className="doc-preview-brand-address">
                Poki House<br />
                35 J K Siaw St, Community 9, Tema, Ghana<br />
                GT-191-1859 (GhanaPostGPS)<br />
                Tel: 0591933925
              </div>
            </div>
          </div>
          <div className="doc-preview-headright">
            <div className="doc-preview-docno">{DOC_LABEL[doc.documentType]} #{doc.docNo}</div>
            <div className="doc-preview-datelabel">{dateLabel}</div>
            <div className="doc-preview-datevalue">{dateValue}</div>
          </div>
        </div>
        <div className="doc-preview-rule" />
        <h1 className="doc-preview-heading">{doc.title || (DOC_LABEL[doc.documentType] + ' for ' + doc.customer.name)}</h1>
        <div className="doc-preview-subheading">{subHeadingText}</div>
        <div className="doc-preview-blocks">
          <div>
            <div className="doc-preview-block-title">Customer</div>
            <div className="doc-preview-block-line">{doc.customer.name}</div>
            <div className="doc-preview-block-line">{doc.customer.email}</div>
          </div>
          <div>
            <div className="doc-preview-block-title">{DOC_LABEL[doc.documentType]} Details</div>
            <div className="doc-preview-block-line">Issued {dateValue}</div>
            <div className="doc-preview-block-line">{money(doc.grandTotal, cur)}</div>
          </div>
          <div>
            <div className="doc-preview-block-title">{isInvoice ? 'Payment' : 'Validity'}</div>
            <div className="doc-preview-block-line">{subHeadingText}</div>
            <div className="doc-preview-block-line">{money(isInvoice ? doc.balanceDue : doc.grandTotal, cur)}</div>
          </div>
        </div>
        <table className="doc-preview-table">
          <thead><tr><th>Items</th><th className="doc-preview-num">Quantity</th><th className="doc-preview-num">Price</th><th className="doc-preview-num">Amount</th></tr></thead>
          <tbody>
            {doc.items.map((it, i) => (
              <tr key={i}>
                <td className="doc-preview-desc">
                  {it.description}
                  {it.notes && <div className="doc-preview-desc-notes">{it.notes}</div>}
                </td>
                <td className="doc-preview-num">{it.qty}</td>
                <td className="doc-preview-num">{money(it.unitPrice, cur)}</td>
                <td className="doc-preview-num">{money(lineTotal(it), cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="doc-preview-row">
          <div>Subtotal</div><div>{money(doc.subtotal, cur)}</div>
        </div>
        {isInvoice && doc.amountPaid > 0 && doc.balanceDue > 0 && (
          <div className="doc-preview-row">
            <div>Amount paid</div><div>{money(doc.amountPaid, cur)}</div>
          </div>
        )}
        <div className="doc-preview-grand-row">
          <div>{isInvoice ? 'Total Due' : 'Grand Total'}</div>
          <div>{money(isInvoice ? doc.balanceDue : doc.grandTotal, cur)}</div>
        </div>
        {doc.notes && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{isInvoice ? 'Payment instructions' : 'Notes'}</div>
            <p className="doc-preview-notes-body">{doc.notes}</p>
          </div>
        )}
        {doc.terms && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">Terms &amp; conditions</div>
            <p className="doc-preview-terms-body">{doc.terms}</p>
          </div>
        )}
        <div className="doc-preview-actions no-print">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>Print</button>
        </div>
      </div>
    </div>
  );
}
