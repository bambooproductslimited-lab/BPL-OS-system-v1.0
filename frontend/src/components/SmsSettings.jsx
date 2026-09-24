import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './SmsSettings.css';

// Company settings → Text messages (backend sms.service.js). The mNotify
// account is connected on the server (MNOTIFY_API_KEY, MNOTIFY_SENDER_ID);
// this shows whether it is and the credit left, sends a test text, switches
// the automatic texts on and off, and lists the last texts sent. Only for
// settings.manage.
//
// Laid out like two-step sign-in in My space: a status card at the top that
// answers "is it working, and how much credit is left" at a glance, then
// one row per thing you can do.

const LOW_CREDIT = 50;

const PURPOSES = {
  two_step: () => tr('Sign-in code'),
  payment_reminder: () => tr('Payment reminder'),
  auto_payment_reminder: () => tr('Payment reminder (automatic)'),
  booking_notice: () => tr('Booking ending'),
  auto_booking_notice: () => tr('Booking ending (automatic)'),
  staff_alert: () => tr('Staff alert'),
  test: () => tr('Test')
};

const PATHS = {
  sms: <><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" /></>,
  bill: <><path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" /><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" /></>,
  home: <><path d="M4 11 12 4l8 7" /><path d="M6 10v9a1 1 0 0 0 1 1h3v-5h4v5h3a1 1 0 0 0 1-1v-9" /></>,
  staff: <><circle cx="8" cy="8" r="3" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" /><circle cx="16.5" cy="9" r="2.3" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" /></>,
  send: <><path d="M21 3 10 14" /><path d="M21 3l-7 18-4-7-7-4 18-7Z" /></>,
  plug: <><path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v5" /></>
};
export function Glyph({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

const AUTOMATIC = [
  {
    key: 'autoPaymentReminders', icon: 'bill',
    label: () => tr('Text customers and tenants about their bills'),
    hint: () => tr('3 days before the due date, on the day, then 7 and 30 days late — once each. Only bills that fell due in the last 45 days; older debts are for a person to chase.')
  },
  {
    key: 'autoBookingNotices', icon: 'home',
    label: () => tr('Text tenants before their booking ends'),
    hint: () => tr('30 days and 7 days before the end date, unless it has been renewed.')
  },
  {
    key: 'staffAlertsBySms', icon: 'staff',
    label: () => tr('Text staff their alerts too'),
    hint: () => tr('The morning alert and the warnings about expiring documents, to the phone on each person\'s employee record — as well as the notification bell.')
  }
];

function when(at) {
  return new Date(at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function num(n) { return Number(n).toLocaleString(activeIntlLocale()); }

// An on/off switch that is a real checkbox underneath: keyboard, screen
// readers and labels all behave as usual.
export function Switch({ id, checked, disabled, onChange, labelledBy }) {
  return (
    <span className="ms-switch">
      <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} aria-labelledby={labelledBy}
        onChange={(e) => onChange(e.target.checked)} />
      <span className="ms-switch-track" aria-hidden="true"><span className="ms-switch-thumb" /></span>
    </span>
  );
}

// Numbered set-up steps, shared with the Email section.
export function SetupSteps({ steps, footnote }) {
  return (
    <div className="ms-setup">
      <ol className="ms-setup-steps">
        {steps.map((s, i) => (
          <li key={i}><span className="ms-setup-n" aria-hidden="true">{i + 1}</span><span>{s}</span></li>
        ))}
      </ol>
      {footnote && <p className="ms-muted ms-setup-foot">{footnote}</p>}
    </div>
  );
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

  const credit = data.balance ? data.balance.balance : null;
  const low = credit !== null && credit < LOW_CREDIT;
  const tone = !data.configured ? 'is-off' : data.balanceError || low ? 'is-warn' : 'is-on';

  return (
    <div className="ms">
      {/* ---- status ---- */}
      <section className={'ms-hero ' + tone}>
        <span className="ms-hero-badge"><Glyph name={data.configured ? 'sms' : 'plug'} size={26} /></span>
        <div className="ms-hero-text">
          <div className="ms-hero-title">{data.configured ? tr('Connected to mNotify') : tr('Not connected yet.')}</div>
          <div className="ms-hero-sub">
            {data.configured
              ? <>{tr('Texts come from')} <span className="ms-chip">{data.senderId}</span></>
              : tr('Sign-in codes, payment reminders and booking notices by text, through the company\'s mNotify account.')}
          </div>
          {data.configured && (
            <div className="ms-hero-stats">
              <span><strong>{num(data.thisMonth.sent)}</strong> {tr('sent this month')}</span>
              {data.thisMonth.failed > 0 && <span className="ms-bad"><strong>{num(data.thisMonth.failed)}</strong> {tr('failed')}</span>}
            </div>
          )}
        </div>
        {data.configured && (
          <div className="ms-credit">
            {credit !== null ? (
              <>
                <div className="ms-credit-n">{num(credit)}</div>
                <div className="ms-credit-label">{tr('SMS credit')}{data.balance.bonus ? ' · +' + num(data.balance.bonus) + ' ' + tr('bonus') : ''}</div>
                {low && <div className="ms-credit-low">{tr('Running low — top up on mNotify.')}</div>}
              </>
            ) : (
              <div className="ms-credit-label ms-bad">{data.balanceError || '—'}</div>
            )}
          </div>
        )}
      </section>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="ms-notice" role="status">{notice}</div>}

      {!data.configured ? (
        <SetupSteps
          steps={[
            tr('In the mNotify dashboard, open API and copy your API key. Check your sender name is approved there (up to 11 characters, e.g. BambooProd).'),
            tr('In Render, open the backend service → Environment, add MNOTIFY_API_KEY (the key) and MNOTIFY_SENDER_ID (the sender name), and save.'),
            tr('The server restarts by itself. Come back here: your credit balance shows, and you can send a test text.')
          ]}
          footnote={tr('Never paste the API key into a chat or email — only into Render.')}
        />
      ) : (
        <>
          {/* ---- test ---- */}
          <form className="ms-card ms-test" onSubmit={sendTest}>
            <span className="ms-row-icon"><Glyph name="send" /></span>
            <div className="ms-row-text">
              <label htmlFor="sms-test-phone" className="ms-row-title">{tr('Send a test text to')}</label>
              <div className="ms-row-sub">{tr('Check texts arrive before switching anything on. Uses one credit.')}</div>
            </div>
            <div className="ms-test-form">
              <input id="sms-test-phone" className="input" type="tel" placeholder="024 412 3456" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} required />
              <button type="submit" className="btn btn-primary" disabled={busy || !testPhone.trim()}>{busy ? tr('Sending…') : tr('Send test')}</button>
            </div>
          </form>

          {/* ---- automatic texts ---- */}
          <section className="ms-group">
            <div className="ms-group-head">
              <h3 className="ms-group-title">{tr('Automatic texts')}</h3>
              <p className="ms-muted">
                {tr('Off unless you turn them on — each text uses credit. At most {n} automatic texts a day, sent between 08:00 and 18:00. Staff can always send a reminder by hand from Payment reminders.', { n: data.dailyLimit })}
              </p>
            </div>
            <ul className="ms-list">
              {AUTOMATIC.map((a) => {
                const on = !!data.settings[a.key];
                return (
                  <li key={a.key} className={'ms-row' + (on ? ' is-on' : '')}>
                    <span className="ms-row-icon"><Glyph name={a.icon} /></span>
                    <label className="ms-row-text" htmlFor={'ms-auto-' + a.key}>
                      <span className="ms-row-title" id={'ms-auto-' + a.key + '-t'}>{a.label()}</span>
                      <span className="ms-row-sub">{a.hint()}</span>
                    </label>
                    <Switch id={'ms-auto-' + a.key} checked={on} disabled={busy} labelledBy={'ms-auto-' + a.key + '-t'} onChange={(v) => toggle(a.key, v)} />
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {/* ---- recent texts ---- */}
      {data.recent.length > 0 && (
        <section className="ms-group">
          <div className="ms-group-head">
            <h3 className="ms-group-title">{tr('Recent texts')}</h3>
          </div>
          <ul className="ms-list ms-log">
            {data.recent.map((m) => (
              <li key={m.id} className="ms-log-row" title={m.message}>
                <span className={'ms-dot ' + (m.status === 'sent' ? 'is-ok' : 'is-bad')} aria-hidden="true" />
                <div className="ms-log-main">
                  <div className="ms-log-line">
                    <span className="ms-log-what">{(PURPOSES[m.purpose] || (() => m.purpose))()}</span>
                    <span className="ms-muted">{tr('To')} {m.to}{m.by ? ' · ' + m.by : ''}</span>
                  </div>
                  {m.status !== 'sent' && <div className="ms-bad ms-log-error">{tr('Failed')}{m.error ? ' — ' + m.error : ''}</div>}
                </div>
                <span className="ms-log-when">{when(m.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
