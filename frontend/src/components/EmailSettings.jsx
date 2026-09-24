import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './SmsSettings.css';

// Company settings → Email (backend mail.service.js). The mailbox is
// connected on the server (SMTP_HOST, SMTP_USER, SMTP_PASS); this shows
// whether it is, and sends a test email to whoever is looking. Only for
// settings.manage.

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
    <div className="sms-settings">
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="sms-notice" role="status">{notice}</div>}

      {data.configured ? (
        <>
          <div className="sms-status">
            <div className="sms-status-item">
              <span className="sms-status-label">{tr('Mail server')}</span>
              <span><span className="tag tag-neutral">{tr('Connected')}</span> {data.host}:{data.port}</span>
            </div>
            <div className="sms-status-item">
              <span className="sms-status-label">{tr('Sent from')}</span>
              <span>{data.from}</span>
            </div>
          </div>
          <div>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={sendTest}>{busy ? tr('Sending…') : tr('Send me a test email')}</button>
          </div>
        </>
      ) : (
        <div className="sms-setup">
          <p><strong>{tr('Not connected yet.')}</strong> {tr('Use a mailbox the company already has, for example no-reply@bplghana.com:')}</p>
          <ol>
            <li>{tr('Find the mailbox\'s outgoing (SMTP) server. Hostinger email: smtp.hostinger.com, port 465. Google Workspace or Gmail: smtp.gmail.com, port 465, with an app password.')}</li>
            <li>{tr('In Render, open the backend service → Environment and add SMTP_HOST, SMTP_PORT, SMTP_USER (the full email address) and SMTP_PASS (its password), then save. MAIL_FROM is optional, e.g. Bamboo OS <no-reply@bplghana.com>.')}</li>
            <li>{tr('The server restarts by itself. Come back here and send yourself a test email.')}</li>
          </ol>
          <p className="sms-muted">{tr('Never paste the mailbox password into a chat or email — only into Render.')}</p>
        </div>
      )}
    </div>
  );
}
