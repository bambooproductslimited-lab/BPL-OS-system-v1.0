import { useRef, useState } from 'react';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { api } from '../api/client';
import './DocPreview.css';

// Shared print-style preview modal for Estimates/Quotations/Invoices,
// ported from Bamboo OS.dc.html's dialog.estimatePreview / .quotationPreview
// / .invoicePreview blocks (nearly identical white-page layouts, only the
// label text and the third detail column differ per document kind).
//
// documentType/documentId (only present once the document actually exists
// — never during DocWizard's create flow) enable the Communication section:
// a generated, unauthenticated /share/:token link (see SharePage.jsx and
// backend/src/services/shares.service.js) with an optional expiry, and a
// one-click send of that link through the existing WhatsApp Business
// integration — Square's own "Share via email/text/link" step, minus
// email/SMS, which need a real provider this app doesn't have configured
// yet (see shares.service.js's comments).

const EXPIRY_OPTIONS = [
  { value: '', label: 'Never' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' }
];

export default function DocPreview({ docLabel, dateLabel, dateValue, heading, subHeading, blocks, items, subtotal, isPartial, amountPaid, totalLabel, total, notesLabel, notesValue, termsLabel, termsValue, documentType, documentId, onClose }) {
  const nodeRef = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);

  const [expiryDays, setExpiryDays] = useState('');
  const [shareUrl, setShareUrl] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [waSending, setWaSending] = useState(false);
  const [waResult, setWaResult] = useState(null);

  async function handleShare() {
    setShareError(null);
    setSharing(true);
    try {
      const filename = (docLabel || 'Document').replace(/[^a-zA-Z0-9-]+/g, '-') + '.pdf';
      await shareOrDownloadPdf(nodeRef.current, filename, docLabel, heading);
    } catch (err) {
      if (err.name !== 'AbortError') setShareError(err.message || 'Could not share this document.');
    } finally {
      setSharing(false);
    }
  }

  async function generateLink() {
    setLinkError(null);
    setGenerating(true);
    setCopied(false);
    try {
      const res = await api.post('/shares', { documentType, documentId, expiresInDays: expiryDays || undefined });
      setShareUrl(window.location.origin + '/share/' + res.token);
    } catch (err) {
      setLinkError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard permission denied — link is still selectable text */ }
  }

  async function sendWhatsApp() {
    setWaResult(null);
    setWaSending(true);
    try {
      let url = shareUrl;
      if (!url) {
        const res = await api.post('/shares', { documentType, documentId, expiresInDays: expiryDays || undefined });
        url = window.location.origin + '/share/' + res.token;
        setShareUrl(url);
      }
      await api.post('/shares/whatsapp', { documentType, documentId, url });
      setWaResult({ ok: true, message: 'Sent via WhatsApp.' });
    } catch (err) {
      setWaResult({ ok: false, message: err.message });
    } finally {
      setWaSending(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="doc-preview" ref={nodeRef} onClick={(e) => e.stopPropagation()}>
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
            <div className="doc-preview-docno">{docLabel}</div>
            <div className="doc-preview-datelabel">{dateLabel}</div>
            <div className="doc-preview-datevalue">{dateValue}</div>
          </div>
        </div>
        <div className="doc-preview-rule" />
        <h1 className="doc-preview-heading">{heading}</h1>
        <div className="doc-preview-subheading">{subHeading}</div>
        <div className="doc-preview-blocks">
          {blocks.map((b, i) => (
            <div key={i}>
              <div className="doc-preview-block-title">{b.title}</div>
              {b.lines.map((line, j) => <div key={j} className="doc-preview-block-line">{line}</div>)}
            </div>
          ))}
        </div>
        <table className="doc-preview-table">
          <thead><tr><th>Items</th><th className="doc-preview-num">Quantity</th><th className="doc-preview-num">Price</th><th className="doc-preview-num">Amount</th></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td className="doc-preview-desc">
                  {it.description}
                  {it.notes && <div className="doc-preview-desc-notes">{it.notes}</div>}
                </td>
                <td className="doc-preview-num">{it.qty}</td><td className="doc-preview-num">{it.unitPrice}</td><td className="doc-preview-num">{it.lineTotal}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="doc-preview-row">
          <div>Subtotal</div><div>{subtotal}</div>
        </div>
        {isPartial && (
          <div className="doc-preview-row">
            <div>Amount paid</div><div>{amountPaid}</div>
          </div>
        )}
        <div className="doc-preview-grand-row">
          <div>{totalLabel}</div><div>{total}</div>
        </div>
        {notesValue && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{notesLabel}</div>
            <p className="doc-preview-notes-body">{notesValue}</p>
          </div>
        )}
        {termsValue && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{termsLabel}</div>
            <p className="doc-preview-terms-body">{termsValue}</p>
          </div>
        )}
        {documentType && documentId && (
          <div className="doc-preview-communication no-print">
            <div className="doc-preview-notes-label">Communication</div>
            <div className="doc-preview-share-row">
              <label htmlFor="dp-expiry">Share link expires</label>
              <select id="dp-expiry" className="input" value={expiryDays} onChange={(e) => { setExpiryDays(e.target.value); setShareUrl(null); }}>
                {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button type="button" className="btn btn-secondary" disabled={generating} onClick={generateLink}>
                {generating ? 'Generating…' : shareUrl ? 'Regenerate link' : 'Generate share link'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={waSending} onClick={sendWhatsApp}>
                {waSending ? 'Sending…' : 'Share via WhatsApp'}
              </button>
            </div>
            {linkError && <div className="error-banner">{linkError}</div>}
            {shareUrl && (
              <div className="doc-preview-share-link">
                <input className="input" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-secondary" onClick={copyLink}>{copied ? 'Copied!' : 'Copy'}</button>
              </div>
            )}
            {waResult && <div className={waResult.ok ? 'doc-preview-wa-ok' : 'error-banner'}>{waResult.message}</div>}
          </div>
        )}
        {shareError && <div className="error-banner no-print">{shareError}</div>}
        <div className="doc-preview-actions no-print">
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
