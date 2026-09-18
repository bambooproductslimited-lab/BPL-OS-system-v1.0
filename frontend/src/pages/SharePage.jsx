import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import { adjustmentRows } from '../lib/docItems';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
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
  const displayItems = groupPackageItems(doc.items, cur);
  const schedule = formatPaymentSchedule(doc.paymentSchedule, cur);
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
                WhatsApp: 0591933925
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
            {displayItems.map((it, i) => (
              <tr key={i}>
                <td className="doc-preview-desc">
                  {it.description}
                  {it.notes && <div className="doc-preview-desc-notes">{it.notes}</div>}
                  {it.discountNote && <div className="doc-preview-desc-adjust">{it.discountNote}</div>}
                  {it.taxNote && <div className="doc-preview-desc-adjust">{it.taxNote}</div>}
                </td>
                <td className="doc-preview-num">{it.qty}</td>
                <td className="doc-preview-num">{it.unitPrice}</td>
                <td className="doc-preview-num">{it.lineTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="doc-preview-row">
          <div>Subtotal</div><div>{money(doc.subtotal, cur)}</div>
        </div>
        {/* The customer opening this link gets the same breakdown as the
            printed copy — what was taken off, and what was added. */}
        {adjustmentRows(doc, cur).discountRows.map((r) => (
          <div className="doc-preview-row" key={r.label}>
            <div>{r.label}</div><div>− {r.value}</div>
          </div>
        ))}
        {adjustmentRows(doc, cur).taxRows.map((r) => (
          <div className="doc-preview-row" key={r.label}>
            <div>{r.label}</div><div>{r.value}</div>
          </div>
        ))}
        {isInvoice && doc.amountPaid > 0 && doc.balanceDue > 0 && (
          <div className="doc-preview-row">
            <div>Amount paid</div><div>{money(doc.amountPaid, cur)}</div>
          </div>
        )}
        <div className="doc-preview-grand-row">
          <div>{isInvoice ? 'Total Due' : 'Grand Total'}</div>
          <div>{money(isInvoice ? doc.balanceDue : doc.grandTotal, cur)}</div>
        </div>
        {schedule.length > 0 && (
          <div className="doc-preview-schedule">
            <div className="doc-preview-notes-label">Payment schedule</div>
            {schedule.map((row, i) => (
              <div className="doc-preview-schedule-row" key={i}>
                <span>{row.label}</span><span>Due {row.dueDate}</span><span>{row.amount}</span>
              </div>
            ))}
          </div>
        )}
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
