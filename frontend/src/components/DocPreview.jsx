import { useRef, useState } from 'react';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { api } from '../api/client';
import './DocPreview.css';
import PrintLayer from './PrintLayer';

import { activeIntlLocale, docTr, tr, msg } from '../lib/i18n.jsx';
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

// No "Never": a share link is a bearer URL to the customer's details and
// the document's figures, so every one expires (see migration 0060). 30
// days is the server's default and its ceiling.
const EXPIRY_OPTIONS = [
  { value: '7', label: msg('7 days') },
  { value: '14', label: msg('14 days') },
  { value: '30', label: msg('30 days') }
];

export default function DocPreview({ docLabel, dateLabel, dateValue, heading, subHeading, blocks, items, subtotal, discountRows, taxRows, payments, isPartial, amountPaid, totalLabel, total, notesLabel, notesValue, termsLabel, termsValue, paymentSchedule, documentType, documentId, shareApi, company, onClose }) {
  const nodeRef = useRef(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);

  const [expiryDays, setExpiryDays] = useState('30');
  const [shareExpiresAt, setShareExpiresAt] = useState(null);
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
      const filename = (docLabel || docTr('Document')).replace(/[^a-zA-Z0-9-]+/g, '-') + '.pdf';
      await shareOrDownloadPdf(nodeRef.current, filename, docLabel, heading);
    } catch (err) {
      if (err.name !== 'AbortError') setShareError(err.message || tr('Could not share this document.'));
    } finally {
      setSharing(false);
    }
  }

  // Poki's invoices are rows in the same table, but its managers hold
  // poki.manage rather than invoice.manage, so they reach share links
  // through their own endpoints. Callers that don't pass shareApi keep the
  // original /shares behaviour.
  const share = shareApi || {
    create: (expiresInDays) => api.post('/shares', { documentType, documentId, expiresInDays: expiresInDays || undefined }),
    whatsapp: (url) => api.post('/shares/whatsapp', { documentType, documentId, url })
  };

  async function generateLink() {
    setLinkError(null);
    setGenerating(true);
    setCopied(false);
    try {
      const res = await share.create(expiryDays);
      setShareUrl(window.location.origin + '/share/' + res.token);
      setShareExpiresAt(res.expiresAt || null);
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
    // Without the WhatsApp Business API the server hands back a WhatsApp
    // link with the message typed, to send from this person's own WhatsApp.
    // The window is opened now, while this still counts as their click —
    // opened after the server answers, it would be blocked as a pop-up.
    const win = window.open('', '_blank');
    try {
      let url = shareUrl;
      if (!url) {
        const res = await share.create(expiryDays);
        url = window.location.origin + '/share/' + res.token;
        setShareExpiresAt(res.expiresAt || null);
        setShareUrl(url);
      }
      const res = await share.whatsapp(url);
      if (res && res.whatsappUrl) {
        if (win) win.location.href = res.whatsappUrl;
        else window.location.href = res.whatsappUrl;
        setWaResult({ ok: true, message: tr('WhatsApp opened with the message ready — press send there.') });
      } else {
        if (win) win.close();
        setWaResult({ ok: true, message: tr('Sent via WhatsApp.') });
      }
    } catch (err) {
      if (win) win.close();
      setWaResult({ ok: false, message: err.message });
    } finally {
      setWaSending(false);
    }
  }

  return (
    <PrintLayer onClose={onClose}>
      <div className="dialog-backdrop" onClick={onClose}>
        <div className="doc-preview" ref={nodeRef} onClick={(e) => e.stopPropagation()}>
          {/* Everything from here to the Communication panel is the document
              itself — what gets printed, made into a PDF and sent to the
              customer — so it is written with docTr(), always in the
              company's document language. The panel and buttons after it
              are the interface, and follow the reader with tr(). */}
          <div className="doc-preview-head">
            <div className="doc-preview-brand">
              {/* The group's logo belongs only on the group's own documents.
                  A sister company heads its paperwork with its own wordmark
                  instead — the name set large and bold, standing in for a
                  logo it doesn't have — so a tenant can see at a glance who
                  is charging them. */}
              {!company && <img src="/logo.png" alt="" className="doc-preview-logo" />}
              {company && company.logoUrl && <img src={company.logoUrl} alt="" className="doc-preview-logo" />}
              <div>
                {company ? (
                  <>
                    <div className="doc-preview-wordmark">{company.name}</div>
                    {company.subtitle && <div className="doc-preview-wordmark-sub">{company.subtitle}</div>}
                    <div className="doc-preview-brand-address">
                      {company.address && <>{company.address}<br /></>}
                      {company.ghanaPostGps && <>{company.ghanaPostGps} (GhanaPostGPS)<br /></>}
                      {company.phone && <>{docTr('WhatsApp:')} {company.phone}<br /></>}
                      {company.email && <>{company.email}</>}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="doc-preview-brand-name">Bamboo Products Limited</div>
                    <div className="doc-preview-brand-address">
                      Poki House<br />
                      35 J K Siaw St, Community 9, Tema, Ghana<br />
                      GT-191-1859 (GhanaPostGPS)<br />
                      WhatsApp: 0591933925
                    </div>
                  </>
                )}
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
          <div className="doc-preview-table-wrap">
          <table className="doc-preview-table">
            <thead><tr><th>{docTr('Items')}</th><th className="doc-preview-num">{docTr('Quantity')}</th><th className="doc-preview-num">{docTr('Price')}</th><th className="doc-preview-num">{docTr('Amount')}</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td className="doc-preview-desc">
                    {it.description}
                    {it.notes && <div className="doc-preview-desc-notes">{it.notes}</div>}
                    {it.discountNote && <div className="doc-preview-desc-adjust">{it.discountNote}</div>}
                    {it.taxNote && <div className="doc-preview-desc-adjust">{it.taxNote}</div>}
                  </td>
                  <td className="doc-preview-num">{it.qty}</td><td className="doc-preview-num">{it.unitPrice}</td><td className="doc-preview-num">{it.lineTotal}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="doc-preview-row">
            <div>{docTr('Subtotal')}</div><div>{subtotal}</div>
          </div>
          {/* Everything between the subtotal and the total is spelled out. It
              used to jump straight from one to the other, so a discount or a
              tax charge simply did not appear on the document at all. */}
          {(discountRows || []).map((r) => (
            <div className="doc-preview-row" key={r.label}>
              <div>{r.label}</div><div>− {r.value}</div>
            </div>
          ))}
          {(taxRows || []).map((r) => (
            <div className="doc-preview-row" key={r.label}>
              <div>{r.label}</div><div>{r.value}</div>
            </div>
          ))}
          {/* Each payment, with the date it was received. A single "amount
              paid" figure tells a customer how much has landed but not when
              or how, which is exactly what they ask about. */}
          {(payments || []).map((pay, i) => (
            <div className="doc-preview-row" key={pay.id || i}>
              <div>
                {docTr('Payment received')} {pay.date}
                {pay.methodLabel && <span className="doc-preview-pay-meta"> · {pay.methodLabel}</span>}
                {pay.reference && <span className="doc-preview-pay-meta"> {docTr('· ref')} {pay.reference}</span>}
              </div>
              <div>− {pay.amount}</div>
            </div>
          ))}
          {isPartial && !(payments || []).length && (
            <div className="doc-preview-row">
              <div>{docTr('Amount paid')}</div><div>{amountPaid}</div>
            </div>
          )}
          <div className="doc-preview-grand-row">
            <div>{totalLabel}</div><div>{total}</div>
          </div>
          {paymentSchedule && paymentSchedule.length > 0 && (
            <div className="doc-preview-schedule">
              <div className="doc-preview-notes-label">{docTr('Payment schedule')}</div>
              {paymentSchedule.map((row, i) => (
                <div className="doc-preview-schedule-row" key={i}>
                  <span>{row.label}</span><span>{docTr('Due')} {row.dueDate}</span><span>{row.amount}</span>
                </div>
              ))}
            </div>
          )}
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
              <div className="doc-preview-notes-label">{tr('Communication')}</div>
              <div className="doc-preview-share-row">
                <label htmlFor="dp-expiry">{tr('Share link expires')}</label>
                <select id="dp-expiry" className="input" value={expiryDays} onChange={(e) => { setExpiryDays(e.target.value); setShareUrl(null); setShareExpiresAt(null); }}>
                  {EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{tr(o.label)}</option>)}
                </select>
                <button type="button" className="btn btn-secondary" disabled={generating} onClick={generateLink}>
                  {generating ? tr('Generating…') : shareUrl ? tr('Regenerate link') : tr('Generate share link')}
                </button>
                <button type="button" className="btn btn-secondary" disabled={waSending} onClick={sendWhatsApp}>
                  {waSending ? tr('Sending…') : tr('Share via WhatsApp')}
                </button>
              </div>
              {linkError && <div className="error-banner">{linkError}</div>}
              {shareUrl && (
                <div className="doc-preview-share-link">
                  <input className="input" readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
                  <button type="button" className="btn btn-secondary" onClick={copyLink}>{copied ? tr('Copied!') : tr('Copy')}</button>
                </div>
              )}
              {shareUrl && shareExpiresAt && (
                // Whoever sends the link should know when it dies, so they can
                // tell the customer rather than field a "the link is broken"
                // call a month later.
                <div className="doc-preview-share-expiry">
                  {tr('Anyone with this link can view the document until {date}.', { date: new Date(shareExpiresAt).toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' }) })}
                </div>
              )}
              {waResult && <div className={waResult.ok ? 'doc-preview-wa-ok' : 'error-banner'}>{waResult.message}</div>}
            </div>
          )}
          {shareError && <div className="error-banner no-print">{shareError}</div>}
          <div className="doc-preview-actions no-print">
            <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print')}</button>
            <button type="button" className="btn btn-primary" disabled={sharing} onClick={handleShare}>
              {sharing ? tr('Preparing…') : tr('Share')}
            </button>
          </div>
        </div>
      </div>
    </PrintLayer>
  );
}
