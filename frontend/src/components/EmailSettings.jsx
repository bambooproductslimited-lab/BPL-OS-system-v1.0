import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import { SetupSteps, Switch, Glyph } from './SmsSettings';
import './SmsSettings.css';

// Company settings → Email (backend mail.service.js). The mailbox is
// connected on the server (SMTP_HOST, SMTP_USER, SMTP_PASS); this shows
// whether it is, sends a test email to whoever is looking, and switches the
// emails that go to customers on their own (documentEmails.service.js).
// Only for settings.manage. Same look as the Text messages section above it.

const AUTOMATIC = [
  {
    key: 'autoReceipts', icon: 'send',
    label: () => tr('Email customers their receipt when a payment is recorded'),
    hint: () => tr('Straight away, with the receipt attached as a PDF and what is left to pay. Only customers and tenants with an email address on file.')
  },
  {
    key: 'autoReminders', icon: 'bill',
    label: () => tr('Email customers and tenants about their bills'),
    hint: () => tr('3 days before the due date, on the day, then 7 and 30 days late — once each, with the bill attached. Only bills that fell due in the last 45 days.')
  }
];

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

  const [auto, setAuto] = useState(null);
  const load = useCallback(async () => {
    try {
      const d = await api.get('/mail');
      setData(d);
      if (d.configured) setAuto(await api.get('/document-emails/settings'));
    } catch (err) { setError(err.message); }
  }, []);
  async function toggle(key, value) {
    setBusy(true);
    setError(null);
    try { setAuto(await api.put('/document-emails/settings', { [key]: value })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
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
              : tr('Invoices, quotations, receipts and payment reminders to customers, and sign-in codes to staff, sent from one of the company\'s own mailboxes.')}
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

      {data.configured && auto && (
        <>
          <section className="ms-group">
            <div className="ms-group-head">
              <h3 className="ms-group-title">{tr('Emails to customers')}</h3>
              <p className="ms-muted">
                {tr('Invoices, quotations and estimates go only when someone presses Email on the document, after reading the message. These two go on their own; at most {n} automatic reminder emails a day.', { n: auto.dailyLimit })}
              </p>
            </div>
            <ul className="ms-list">
              {AUTOMATIC.map((a) => {
                const on = !!auto.settings[a.key];
                return (
                  <li key={a.key} className={'ms-row' + (on ? ' is-on' : '')}>
                    <span className="ms-row-icon"><Glyph name={a.icon} /></span>
                    <label className="ms-row-text" htmlFor={'ms-mail-' + a.key}>
                      <span className="ms-row-title" id={'ms-mail-' + a.key + '-t'}>{a.label()}</span>
                      <span className="ms-row-sub">{a.hint()}</span>
                    </label>
                    <Switch id={'ms-mail-' + a.key} checked={on} disabled={busy} labelledBy={'ms-mail-' + a.key + '-t'} onChange={(v) => toggle(a.key, v)} />
                  </li>
                );
              })}
            </ul>
            <p className="ms-muted ms-mail-month">
              {tr('This month: {n} emails to customers, {a} of them sent automatically.', { n: auto.thisMonth.total, a: auto.thisMonth.automatic })}
              {!auto.appUrl && ' ' + tr('The OS doesn\'t know its own web address yet, so automatic emails can\'t link to documents. Add APP_URL on the server.')}
            </p>
          </section>
        </>
      )}

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
