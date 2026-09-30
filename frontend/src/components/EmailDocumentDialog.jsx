import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './EmailDocumentDialog.css';

// Emailing an invoice, quotation, estimate or Poki bill to the customer
// (backend documentEmails.service.js), from its preview. The email is
// written for you — to the customer's address on file, with a subject and a
// polite message — and you can change any of it before it goes. The
// document goes as a PDF attachment, with a button to view it online under
// the message. What was sent before, by whom or by the OS itself, is listed
// underneath.

function Glyph({ d, size = 18 }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;
}
const MAIL = <><rect x="3" y="5" width="18" height="14" rx="2.2" /><path d="m4 7 8 6 8-6" /></>;
const CLIP = <path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />;
const LINK = <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>;
const CHECK = <path d="m5 12.5 4.5 4.5L19 7.5" />;

function when(at) {
  return new Date(at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function kindText(h) {
  if (h.kind === 'reminder') return h.automatic ? tr('Payment reminder, sent automatically') : tr('Payment reminder');
  if (h.kind === 'receipt') return h.automatic ? tr('Receipt, sent automatically') : tr('Receipt');
  return tr('The document');
}

export default function EmailDocumentDialog({ documentType, documentId, title, onClose }) {
  const [draft, setDraft] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/document-emails/' + documentType + '/' + documentId)
      .then((d) => { if (!alive) return; setDraft(d); setForm({ to: d.to || '', cc: '', subject: d.subject, message: d.message }); })
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [documentType, documentId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function send(e) {
    e.preventDefault();
    setSending(true); setError(null);
    try {
      const r = await api.post('/document-emails/' + documentType + '/' + documentId, { ...form, origin: window.location.origin });
      setSent(r);
      setDraft((d) => ({ ...d, history: r.history || d.history }));
    } catch (err) { setError(err.message); }
    setSending(false);
  }

  const history = (draft && draft.history) || [];
  return (
    <div className="dialog-backdrop ed-over no-print" onClick={() => !sending && onClose()}>
      <form className="dialog ed" onClick={(e) => e.stopPropagation()} onSubmit={send} role="dialog" aria-modal="true" aria-labelledby="ed-title">
        <div className="ed-head">
          <span className="ed-head-icon"><Glyph d={MAIL} size={20} /></span>
          <div>
            <h2 id="ed-title">{tr('Email {document}', { document: title })}</h2>
            {draft && <p className="ed-sub">{tr('From {company}, through the company mailbox.', { company: draft.from })}</p>}
          </div>
        </div>

        {!draft && !error && <p className="ed-sub">{tr('Loading…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        {draft && !draft.configured && (
          <div className="ed-note is-warn">{tr('Email isn\'t set up yet. An administrator connects the company mailbox in Company settings → Email, then this can be sent.')}</div>
        )}

        {sent ? (
          <div className="ed-done" role="status">
            <span className="ed-done-icon"><Glyph d={CHECK} size={26} /></span>
            <strong>{tr('Sent to {email}', { email: sent.to })}</strong>
            <span>{sent.cc && sent.cc.length ? tr('Copy to {list}', { list: sent.cc.join(', ') }) : tr('With {file} attached.', { file: sent.attachment })}</span>
          </div>
        ) : draft && form && (
          <>
            <div className="ed-grid">
              <label className="field">
                <span className="field-label">{tr('To')}</span>
                <input className="input" type="email" value={form.to} onChange={(e) => set('to', e.target.value)} required placeholder={tr('The customer\'s email address')} autoComplete="off" />
                {!draft.to && <small className="ed-hint">{tr('{name} has no email address on file. Type one here, and add it to the customer for next time.', { name: draft.customerName })}</small>}
              </label>
              <label className="field">
                <span className="field-label">{tr('Copy to (optional)')}</span>
                <input className="input" value={form.cc} onChange={(e) => set('cc', e.target.value)} placeholder={tr('Other addresses, separated by commas')} autoComplete="off" />
              </label>
            </div>
            <label className="field">
              <span className="field-label">{tr('Subject')}</span>
              <input className="input" value={form.subject} onChange={(e) => set('subject', e.target.value)} maxLength={200} required />
            </label>
            <label className="field">
              <span className="field-label">{tr('Message')}</span>
              <textarea className="input ed-message" rows={9} value={form.message} onChange={(e) => set('message', e.target.value)} maxLength={5000} required />
            </label>
            <div className="ed-extras">
              <span className="ed-chip"><Glyph d={CLIP} size={15} />{draft.attachment}</span>
              <span className="ed-chip is-link"><Glyph d={LINK} size={15} />{tr('A button to view it online is added under your message (works for {n} days).', { n: draft.linkDays })}</span>
            </div>
          </>
        )}

        {history.length > 0 && (
          <div className="ed-history">
            <div className="ed-history-title">{tr('Emailed before')}</div>
            <ul>
              {history.map((h, i) => (
                <li key={i}>
                  <span className="ed-dot" aria-hidden="true" />
                  <span className="ed-history-text">
                    <strong>{when(h.at)} · {h.to}</strong>
                    <span>{kindText(h)}{h.by ? ' · ' + tr('by {name}', { name: h.by }) : ''}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="dialog-actions">
          {sent ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
          ) : (
            <>
              <button type="button" className="btn btn-secondary" disabled={sending} onClick={onClose}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={sending || !draft || !draft.configured || !form || !form.to.trim()}>
                {sending ? tr('Sending…') : tr('Send email')}
              </button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}
