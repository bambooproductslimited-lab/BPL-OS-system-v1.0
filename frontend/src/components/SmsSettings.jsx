import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './SmsSettings.css';

// Company settings → Text messages (backend sms.service.js). The mNotify
// account is connected on the server (MNOTIFY_API_KEY, MNOTIFY_SENDER_ID);
// this shows whether it is, the credit left, a test text, which automatic
// texts are on, and the last texts sent. Only for settings.manage.

const PURPOSES = {
  two_step: () => tr('Sign-in code'),
  payment_reminder: () => tr('Payment reminder'),
  auto_payment_reminder: () => tr('Payment reminder (automatic)'),
  booking_notice: () => tr('Booking ending'),
  auto_booking_notice: () => tr('Booking ending (automatic)'),
  staff_alert: () => tr('Staff alert'),
  test: () => tr('Test')
};

const AUTOMATIC = [
  {
    key: 'autoPaymentReminders',
    label: () => tr('Text customers and tenants about their bills'),
    hint: () => tr('3 days before the due date, on the day, then 7 and 30 days late — once each. Only bills that fell due in the last 45 days; older debts are for a person to chase.')
  },
  {
    key: 'autoBookingNotices',
    label: () => tr('Text tenants before their booking ends'),
    hint: () => tr('30 days and 7 days before the end date, unless it has been renewed.')
  },
  {
    key: 'staffAlertsBySms',
    label: () => tr('Text staff their alerts too'),
    hint: () => tr('The morning alert and the warnings about expiring documents, to the phone on each person\'s employee record — as well as the notification bell.')
  }
];

function when(at) {
  return new Date(at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function SmsSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [testPhone, setTestPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try { setData(await api.get('/sms')); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggle(key, value) {
    setBusy(true);
    setError(null);
    try { setData(await api.patch('/sms/settings', { [key]: value })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function sendTest(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.post('/sms/test', { phone: testPhone });
      setNotice(tr('Test text sent to {phone}.', { phone: r.to }));
      await load();
    } catch (err) {
      setError(err.message);
      await load();
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
        <div className="sms-status">
          <div className="sms-status-item">
            <span className="sms-status-label">{tr('Provider')}</span>
            <span><span className="tag tag-neutral">{tr('Connected')}</span> mNotify</span>
          </div>
          <div className="sms-status-item">
            <span className="sms-status-label">{tr('Sender name')}</span>
            <span>{data.senderId}</span>
          </div>
          <div className="sms-status-item">
            <span className="sms-status-label">{tr('SMS credit')}</span>
            {data.balance
              ? <span className="sms-balance">{data.balance.balance.toLocaleString(activeIntlLocale())}{data.balance.bonus ? <span className="sms-muted"> + {data.balance.bonus.toLocaleString(activeIntlLocale())} {tr('bonus')}</span> : null}</span>
              : <span className="sms-muted">{data.balanceError || '—'}</span>}
          </div>
          <div className="sms-status-item">
            <span className="sms-status-label">{tr('This month')}</span>
            <span>{tr('{sent} sent · {failed} failed', { sent: data.thisMonth.sent, failed: data.thisMonth.failed })}</span>
          </div>
        </div>
      ) : (
        <div className="sms-setup">
          <p><strong>{tr('Not connected yet.')}</strong> {tr('To connect your mNotify account:')}</p>
          <ol>
            <li>{tr('In the mNotify dashboard, open API and copy your API key. Check your sender name is approved there (up to 11 characters, e.g. BambooProd).')}</li>
            <li>{tr('In Render, open the backend service → Environment, add MNOTIFY_API_KEY (the key) and MNOTIFY_SENDER_ID (the sender name), and save.')}</li>
            <li>{tr('The server restarts by itself. Come back here: your credit balance shows, and you can send a test text.')}</li>
          </ol>
          <p className="sms-muted">{tr('Never paste the API key into a chat or email — only into Render.')}</p>
        </div>
      )}

      {data.configured && (
        <form className="sms-test" onSubmit={sendTest}>
          <label htmlFor="sms-test-phone">{tr('Send a test text to')}</label>
          <div className="sms-test-row">
            <input id="sms-test-phone" className="input" type="tel" placeholder="024 412 3456" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} required />
            <button type="submit" className="btn btn-secondary" disabled={busy}>{busy ? tr('Sending…') : tr('Send test')}</button>
          </div>
        </form>
      )}

      <div className="sms-auto">
        <div className="sms-auto-title">{tr('Automatic texts')}</div>
        <p className="sms-muted">
          {tr('Off unless you turn them on — each text uses credit. At most {n} automatic texts a day, sent between 08:00 and 18:00. Staff can always send a reminder by hand from Payment reminders.', { n: data.dailyLimit })}
        </p>
        {AUTOMATIC.map((a) => (
          <label key={a.key} className="sms-auto-item">
            <input type="checkbox" checked={!!data.settings[a.key]} disabled={busy || !data.configured}
              onChange={(e) => toggle(a.key, e.target.checked)} />
            <span>
              <span className="sms-auto-label">{a.label()}</span>
              <span className="sms-muted sms-auto-hint">{a.hint()}</span>
            </span>
          </label>
        ))}
      </div>

      {data.recent.length > 0 && (
        <div className="sms-log">
          <div className="sms-auto-title">{tr('Recent texts')}</div>
          <div className="sms-log-scroll">
            <table className="table sms-log-table">
              <thead>
                <tr><th>{tr('When')}</th><th>{tr('To')}</th><th>{tr('What')}</th><th>{tr('Status')}</th></tr>
              </thead>
              <tbody>
                {data.recent.map((m) => (
                  <tr key={m.id}>
                    <td className="sms-nowrap">{when(m.at)}</td>
                    <td className="sms-nowrap">{m.to}</td>
                    <td title={m.message}>{(PURPOSES[m.purpose] || (() => m.purpose))()}{m.by ? <span className="sms-muted"> · {m.by}</span> : null}</td>
                    <td>
                      {m.status === 'sent'
                        ? <span className="tag tag-neutral">{tr('Sent')}</span>
                        : <span className="sms-failed" title={m.error || ''}>{tr('Failed')}{m.error ? ' — ' + m.error : ''}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
