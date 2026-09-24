import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import { SetupSteps } from './SmsSettings';
import './SmsSettings.css';

// Company settings → Email (backend mail.service.js). The mailbox is
// connected on the server (SMTP_HOST, SMTP_USER, SMTP_PASS); this shows
// whether it is, and sends a test email to whoever is looking. Only for
// settings.manage. Same look as the Text messages section above it.

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" /><path d="M4 7l8 6 8-6" />
    </svg>
  );
}

export default function EmailSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api.get('/mail')); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function sendTest() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.post('/mail/test', {});
      setNotice(tr('Test email sent to {email}. Check that inbox (and its spam folder).', { email: r.to }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>;

  return (
    <div className="ms">
      <section className={'ms-hero ' + (data.configured ? 'is-on' : 'is-off')}>
        <span className="ms-hero-badge"><MailGlyph /></span>
        <div className="ms-hero-text">
          <div className="ms-hero-title">{data.configured ? tr('Email is connected') : tr('Not connected yet.')}</div>
          <div className="ms-hero-sub">
            {data.configured
              ? <>{tr('Sent from')} <span className="ms-chip">{data.from}</span> <span className="ms-muted">· {data.host}:{data.port}</span></>
              : tr('Two-step sign-in codes by email, sent from one of the company\'s own mailboxes.')}
          </div>
        </div>
        {data.configured && (
          <button type="button" className="btn btn-primary ms-hero-action" disabled={busy} onClick={sendTest}>
            {busy ? tr('Sending…') : tr('Send me a test email')}
          </button>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="ms-notice" role="status">{notice}</div>}

      {!data.configured && (
        <SetupSteps
          steps={[
            tr('Find the mailbox\'s outgoing (SMTP) server. Hostinger email: smtp.hostinger.com, port 465. Google Workspace or Gmail: smtp.gmail.com, port 465, with an app password.'),
            tr('In Render, open the backend service → Environment and add SMTP_HOST, SMTP_PORT, SMTP_USER (the full email address) and SMTP_PASS (its password), then save. MAIL_FROM is optional, e.g. Bamboo OS <no-reply@bplghana.com>.'),
            tr('The server restarts by itself. Come back here and send yourself a test email.')
          ]}
          footnote={tr('Never paste the mailbox password into a chat or email — only into Render.')}
        />
      )}
    </div>
  );
}
