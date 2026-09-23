import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import { adjustmentRows, paymentsForDocument } from '../lib/docItems';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import { docTr, DOCUMENT_INTL_LOCALE } from '../lib/i18n.jsx';
import '../components/DocPreview.css';
import './SharePage.css';

// Public, unauthenticated view for a share link generated from the
// Preview dialog on Quotations/Estimates/Invoices (see DocPreview.jsx's
// Share section and backend/src/services/shares.service.js). Mounted
// outside AppShell/ProtectedRoute in App.jsx — no sidebar, no login,
// nothing but the document itself, since anyone with the link (customer
// included) can open it. Reuses DocPreview.css's classes so a shared
// document looks identical to what staff see in the app's own preview.

// docTr() is safe at module level, unlike tr(): the document language is
// a constant, so there is no later language for this to fall behind.
const DOC_LABEL = { quotation: docTr('Quotation'), estimate: docTr('Estimate'), invoice: docTr('Invoice') };

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value.length > 10 ? value : value + 'T00:00');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(DOCUMENT_INTL_LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
}

// The page behind a share link is what the customer opens, so all of it —
// the document and the Print button alike — is in the company's document
// language. A customer never chose a language; the clerk's choice of one
// for their own screen should not decide what the customer reads.
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

  if (loading) return <div className="share-page-status">{docTr('Loading…')}</div>;
  if (error) return <div className="share-page-status share-page-error">{error}</div>;
  if (!doc) return null;

  const cur = doc.currency;
  const displayItems = groupPackageItems(doc.items, cur);
  const schedule = formatPaymentSchedule(doc.paymentSchedule, cur);
  const isInvoice = doc.documentType === 'invoice';
  const dateLabel = docTr('Issue date');
  const dateValue = fmtDate(doc.dateValue);
  const subHeadingText = isInvoice
    ? docTr('Due {date}', { date: fmtDate(doc.dueDate) })
    : docTr('Valid until {date}', { date: fmtDate(doc.validUntil) });

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
        <h1 className="doc-preview-heading">{doc.title || (docTr('{document} for {name}', { document: DOC_LABEL[doc.documentType], name: doc.customer.name }))}</h1>
        <div className="doc-preview-subheading">{subHeadingText}</div>
        <div className="doc-preview-blocks">
          <div>
            <div className="doc-preview-block-title">{docTr('Customer')}</div>
            <div className="doc-preview-block-line">{doc.customer.name}</div>
            <div className="doc-preview-block-line">{doc.customer.email}</div>
          </div>
          <div>
            <div className="doc-preview-block-title">{DOC_LABEL[doc.documentType]} {docTr('Details')}</div>
            <div className="doc-preview-block-line">{docTr('Issued')} {dateValue}</div>
            <div className="doc-preview-block-line">{money(doc.grandTotal, cur)}</div>
          </div>
          <div>
            <div className="doc-preview-block-title">{isInvoice ? docTr('Payment') : docTr('Validity')}</div>
            <div className="doc-preview-block-line">{subHeadingText}</div>
            <div className="doc-preview-block-line">{money(isInvoice ? doc.balanceDue : doc.grandTotal, cur)}</div>
          </div>
        </div>
        <table className="doc-preview-table">
          <thead><tr><th>{docTr('Items')}</th><th className="doc-preview-num">{docTr('Quantity')}</th><th className="doc-preview-num">{docTr('Price')}</th><th className="doc-preview-num">{docTr('Amount')}</th></tr></thead>
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
          <div>{docTr('Subtotal')}</div><div>{money(doc.subtotal, cur)}</div>
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
        {isInvoice && paymentsForDocument(doc.payments, cur).map((pay, i) => (
          <div className="doc-preview-row" key={i}>
            <div>
              {docTr('Payment received')} {pay.date}
              {pay.methodLabel && <span className="doc-preview-pay-meta"> · {pay.methodLabel}</span>}
              {pay.reference && <span className="doc-preview-pay-meta"> {docTr('· ref')} {pay.reference}</span>}
            </div>
            <div>− {pay.amount}</div>
          </div>
        ))}
        {isInvoice && doc.amountPaid > 0 && doc.balanceDue > 0 && !(doc.payments || []).length && (
          <div className="doc-preview-row">
            <div>{docTr('Amount paid')}</div><div>{money(doc.amountPaid, cur)}</div>
          </div>
        )}
        <div className="doc-preview-grand-row">
          <div>{isInvoice ? docTr('Total Due') : docTr('Grand Total')}</div>
          <div>{money(isInvoice ? doc.balanceDue : doc.grandTotal, cur)}</div>
        </div>
        {schedule.length > 0 && (
          <div className="doc-preview-schedule">
            <div className="doc-preview-notes-label">{docTr('Payment schedule')}</div>
            {schedule.map((row, i) => (
              <div className="doc-preview-schedule-row" key={i}>
                <span>{row.label}</span><span>{docTr('Due')} {row.dueDate}</span><span>{row.amount}</span>
              </div>
            ))}
          </div>
        )}
        {doc.notes && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{isInvoice ? docTr('Payment instructions') : docTr('Notes')}</div>
            <p className="doc-preview-notes-body">{doc.notes}</p>
          </div>
        )}
        {doc.terms && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{docTr('Terms & conditions')}</div>
            <p className="doc-preview-terms-body">{doc.terms}</p>
          </div>
        )}
        <div className="doc-preview-actions no-print">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{docTr('Print')}</button>
        </div>
      </div>
    </div>
  );
}
