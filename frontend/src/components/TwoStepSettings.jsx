import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import { formatDate } from '../lib/dates';
import './TwoStepSettings.css';

// Two-step sign-in, in My space (backend twoStep.service.js). Optional: once
// on, signing in needs the password and a six-digit code, which comes one of
// three ways — the person picks any of them:
//   - an authenticator app (any: Google or Microsoft Authenticator, Authy,
//     2FAS, Aegis, Bitwarden, 1Password …): scan a QR code, type the code it
//     shows to prove it worked;
//   - a text message to their phone (mNotify, on the company's SMS credit):
//     type the number, then the code texted to it;
//   - an email to the address they sign in with (the company's mailbox):
//     type back the code emailed to it.
// The first way turned on shows backup codes once, for a lost phone.
//
// Laid out as a status banner (how protected the account is, at a glance),
// one row per way with a single clear action, and set-up opening in place
// under its row as numbered steps — nothing to hunt for, nothing hidden in
// menus.

function groupKey(secret) { return String(secret || '').replace(/(.{4})/g, '$1 ').trim(); }

const PATHS = {
  shield: <><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" /><path d="M9 12l2 2 4-4" /></>,
  shieldOff: <><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" /><path d="M12 8v5M12 16v.01" /></>,
  app: <><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M10.5 18.5h3" /><path d="M9.5 9.5l1.8 1.8 3.2-3.3" /></>,
  sms: <><path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M8 10.5h.01M12 10.5h.01M16 10.5h.01" /></>,
  email: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M4 7l8 6 8-6" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12 19 4M16 6l2.5 2.5M13.5 8.5 16 11" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  download: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M5 19h14" /></>
};
function Glyph({ name, size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

// Six digits, big and spaced; letters and spaces are dropped as typed or
// pasted, so a code copied from a text with a space in it still works.
function CodeInput({ id, value, onChange }) {
  return (
    <input id={id} className="input tss-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}"
      placeholder="000000" maxLength={6} value={value} autoFocus required
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} />
  );
}

function Steps({ children }) { return <ol className="tss-steps">{children}</ol>; }
function Step({ n, title, children, done }) {
  return (
    <li className={'tss-step' + (done ? ' is-done' : '')}>
      <span className="tss-step-n" aria-hidden="true">{n}</span>
      <div className="tss-step-body">
        <div className="tss-step-title">{title}</div>
        {children}
      </div>
    </li>
  );
}

// One way of getting the code: icon, what it is, whether it's on, and the
// one thing you can do with it. Its set-up (or the password to remove it)
// opens underneath.
function MethodRow({ icon, title, badge, summary, state, action, panel }) {
  const stateLabel = state === 'on' ? tr('On') : state === 'unavailable' ? tr('Not available') : tr('Off');
  return (
    <li className={'tss-row is-' + state + (panel ? ' is-open' : '')}>
      <div className="tss-row-main">
        <span className="tss-row-icon"><Glyph name={icon} size={22} /></span>
        <div className="tss-row-text">
          <div className="tss-row-title">
            {title}
            {badge && <span className="tss-badge">{badge}</span>}
          </div>
          <div className="tss-row-sub">{summary}</div>
        </div>
        <span className={'tss-state tss-state-' + state}><span className="tss-state-dot" aria-hidden="true" />{stateLabel}</span>
        <div className="tss-row-action">{action}</div>
      </div>
      {panel && <div className="tss-row-panel">{panel}</div>}
    </li>
  );
}

export default function TwoStepSettings() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null); // app: { secret, otpauthUri, qr }
  const [smsSetup, setSmsSetup] = useState(null); // text: { sentTo }
  const [phone, setPhone] = useState('');
  const [emailSetup, setEmailSetup] = useState(null); // email: { sentTo }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [asking, setAsking] = useState(null); // { action: 'disable', method } | { action: 'codes' } — waiting for the password
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.get('/me/two-step')); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  function closeAll() {
    setSetup(null);
    setSmsSetup(null);
    setEmailSetup(null);
    setAsking(null);
    setPassword('');
    setCode('');
  }

  const startApp = () => run(async () => {
    const s = await api.post('/me/two-step/setup', {});
    const qr = await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 220 });
    closeAll();
    setSetup({ ...s, qr });
  });

  const confirmApp = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/me/two-step/enable', { code });
      if (r.backupCodes) setBackupCodes(r.backupCodes);
      else setNotice(tr('Authenticator app added. Your backup codes still work.'));
      setSetup(null);
      await load();
    });
  };

  const startSms = () => {
    closeAll();
    setError(null);
    setPhone((status && status.suggestedPhone) || '');
    setSmsSetup({ sentTo: null });
  };

  const sendSmsCode = (e) => {
    if (e) e.preventDefault();
    run(async () => {
      const r = await api.post('/me/two-step/sms/setup', { phone });
      setSmsSetup({ sentTo: r.sentTo });
      setCode('');
    });
  };

  const confirmSms = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/me/two-step/sms/enable', { code });
      if (r.backupCodes) setBackupCodes(r.backupCodes);
      else setNotice(tr('Codes by text turned on. Your backup codes still work.'));
      setSmsSetup(null);
      await load();
    });
  };

  const startEmail = () => run(async () => {
    const r = await api.post('/me/two-step/email/setup', {});
    closeAll();
    setEmailSetup({ sentTo: r.sentTo });
  });

  const confirmEmail = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/me/two-step/email/enable', { code });
      if (r.backupCodes) setBackupCodes(r.backupCodes);
      else setNotice(tr('Codes by email turned on. Your backup codes still work.'));
      setEmailSetup(null);
      await load();
    });
  };

  const withPassword = (e) => {
    e.preventDefault();
    run(async () => {
      if (asking.action === 'disable') {
        await api.post('/me/two-step/disable', { password, method: asking.method || undefined });
      } else {
        const r = await api.post('/me/two-step/backup-codes', { password });
        setBackupCodes(r.backupCodes);
      }
      setAsking(null);
      setPassword('');
      await load();
    });
  };

  function ask(what) {
    closeAll();
    setError(null);
    setAsking(what);
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the codes are still on screen to write down */ }
  }

  function downloadCodes() {
    const text = tr('Bamboo OS backup codes — each works once, instead of the code from your app.') + '\n\n' + backupCodes.join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bamboo-os-backup-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (!status) return error ? <div className="error-banner">{error}</div> : null;

  // ---- the backup codes, shown once --------------------------------------------
  if (backupCodes) {
    return (
      <div className="tss">
        <section className="tss-codes" aria-labelledby="tss-codes-title">
          <div className="tss-codes-head">
            <span className="tss-codes-icon"><Glyph name="key" size={22} /></span>
            <div>
              <h3 id="tss-codes-title" className="tss-codes-title">{tr('Your backup codes')}</h3>
              <p className="tss-muted">
                {tr('If you lose your phone, each of these signs you in once instead of the code from the app. Keep them somewhere safe — they won\'t be shown again.')}
              </p>
            </div>
          </div>
          <ol className="tss-code-grid">
            {backupCodes.map((c, i) => <li key={c}><span className="tss-code-n">{i + 1}</span><code>{c}</code></li>)}
          </ol>
          <div className="tss-actions">
            <button type="button" className="btn btn-secondary tss-icon-btn" onClick={copyCodes}><Glyph name="copy" size={16} />{copied ? tr('Copied!') : tr('Copy')}</button>
            <button type="button" className="btn btn-secondary tss-icon-btn" onClick={downloadCodes}><Glyph name="download" size={16} />{tr('Download')}</button>
            <button type="button" className="btn btn-primary tss-push" onClick={() => setBackupCodes(null)}>{tr('I\'ve saved them')}</button>
          </div>
        </section>
      </div>
    );
  }

  const onCount = [status.app.on, status.sms.on, status.email.on].filter(Boolean).length;

  const passwordPanel = asking && (
    <form className="tss-password" onSubmit={withPassword}>
      <label htmlFor="twostep-pw">
        {asking.action === 'codes' ? tr('Enter your password to make new backup codes (the old ones stop working):')
          : asking.method === 'app' ? tr('Enter your password to remove the authenticator app:')
            : asking.method === 'sms' ? tr('Enter your password to stop codes by text:')
              : asking.method === 'email' ? tr('Enter your password to stop codes by email:')
                : tr('Enter your password to turn two-step sign-in off:')}
      </label>
      <div className="tss-inline">
        <input id="twostep-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        <button type="button" className="btn btn-secondary" onClick={() => { setAsking(null); setPassword(''); }}>{tr('Cancel')}</button>
        <button type="submit" className={'btn ' + (asking.action === 'codes' ? 'btn-primary' : 'btn-primary tss-danger-btn')} disabled={busy || !password}>
          {asking.action === 'codes' ? tr('Make new codes') : tr('Turn off')}
        </button>
      </div>
    </form>
  );

  // ---- the three ways --------------------------------------------------------------
  const appPanel = setup ? (
    <form onSubmit={confirmApp}>
      <Steps>
        <Step n={1} title={tr('Get an authenticator app')}>
          <p className="tss-muted">{tr('Any app works: Google or Microsoft Authenticator, Authy, 2FAS, Aegis, Bitwarden, 1Password. Free from the Play Store or App Store.')}</p>
        </Step>
        <Step n={2} title={tr('Scan this QR code with it')}>
          <div className="tss-qr-wrap">
            <img className="tss-qr" src={setup.qr} alt={tr('QR code to scan with your authenticator app')} width="180" height="180" />
            <div className="tss-muted tss-qr-key">
              {tr('Can\'t scan? Choose "enter a setup key" in the app and type:')}
              <code className="tss-key">{groupKey(setup.secret)}</code>
            </div>
          </div>
        </Step>
        <Step n={3} title={tr('Type the 6-digit code the app now shows:')}>
          <div className="tss-inline">
            <CodeInput id="twostep-code" value={code} onChange={setCode} />
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{tr('Turn on')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setSetup(null)}>{tr('Cancel')}</button>
          </div>
        </Step>
      </Steps>
    </form>
  ) : asking && asking.method === 'app' ? passwordPanel : null;

  const smsPanel = smsSetup ? (
    smsSetup.sentTo ? (
      <form onSubmit={confirmSms}>
        <Steps>
          <Step n={1} title={tr('Your mobile number:')} done><p className="tss-muted">{tr('Code sent to {phone}.', { phone: smsSetup.sentTo })}</p></Step>
          <Step n={2} title={tr('Type the 6-digit code we texted to {phone}:', { phone: smsSetup.sentTo })}>
            <div className="tss-inline">
              <CodeInput id="twostep-sms-code" value={code} onChange={setCode} />
              <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{tr('Turn on')}</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => sendSmsCode()}>{tr('Send a new code')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setSmsSetup(null)}>{tr('Cancel')}</button>
            </div>
          </Step>
        </Steps>
      </form>
    ) : (
      <form onSubmit={sendSmsCode}>
        <Steps>
          <Step n={1} title={tr('Your mobile number:')}>
            <div className="tss-inline">
              <input id="twostep-phone" className="input tss-phone" type="tel" autoComplete="tel" placeholder="024 412 3456"
                value={phone} onChange={(e) => setPhone(e.target.value)} required autoFocus />
              <button type="submit" className="btn btn-primary" disabled={busy || !phone.trim()}>{busy ? tr('Sending…') : tr('Text me a code')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setSmsSetup(null)}>{tr('Cancel')}</button>
            </div>
          </Step>
          <Step n={2} title={tr('Enter the code')} />
        </Steps>
      </form>
    )
  ) : asking && asking.method === 'sms' ? passwordPanel : null;

  const emailPanel = emailSetup ? (
    <form onSubmit={confirmEmail}>
      <Steps>
        <Step n={1} title={tr('Code sent to {email}.', { email: emailSetup.sentTo })} done><p className="tss-muted">{tr('Check your inbox — and the spam folder if it isn\'t there within a minute.')}</p></Step>
        <Step n={2} title={tr('Type the 6-digit code we emailed to {email}:', { email: emailSetup.sentTo })}>
          <div className="tss-inline">
            <CodeInput id="twostep-email-code" value={code} onChange={setCode} />
            <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{tr('Turn on')}</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={startEmail}>{tr('Send a new code')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEmailSetup(null)}>{tr('Cancel')}</button>
          </div>
        </Step>
      </Steps>
    </form>
  ) : asking && asking.method === 'email' ? passwordPanel : null;

  const settingUp = !!(setup || smsSetup || emailSetup);
  const actionFor = (on, available, openPanel, onSetUp, method, label) => {
    if (openPanel) return null;
    if (on) return <button type="button" className="btn btn-secondary" onClick={() => ask({ action: 'disable', method })}>{tr('Remove')}</button>;
    if (!available) return null;
    return <button type="button" className="btn btn-primary" disabled={busy || settingUp} onClick={onSetUp}>{label}</button>;
  };

  return (
    <div className="tss">
      {/* ---- status banner ---- */}
      <section className={'tss-hero ' + (status.enabled ? 'is-on' : 'is-off')}>
        <span className="tss-hero-badge"><Glyph name={status.enabled ? 'shield' : 'shieldOff'} size={28} /></span>
        <div className="tss-hero-text">
          <div className="tss-hero-title">{status.enabled ? tr('Your account is protected') : tr('Add a second lock to your account')}</div>
          <div className="tss-hero-sub">
            {status.enabled
              ? tr('Signing in needs your password and a 6-digit code. On since {date}.', { date: formatDate(status.enabledAt) })
              : tr('After your password, you\'ll also type a 6-digit code from your phone or inbox — so someone who learns your password still can\'t get in.')}
          </div>
        </div>
        <div className="tss-meter" role="img" aria-label={tr('{n} of 3 ways on', { n: onCount })}>
          <div className="tss-meter-bars">
            {[0, 1, 2].map((i) => <span key={i} className={i < onCount ? 'is-lit' : undefined} />)}
          </div>
          <div className="tss-meter-label">{tr('{n} of 3 ways on', { n: onCount })}</div>
        </div>
      </section>

      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="tss-notice" role="status">{notice}</div>}

      <ul className="tss-list">
        <MethodRow
          icon="app" title={tr('Authenticator app')} badge={tr('Most secure')}
          summary={tr('Codes from an app on your phone. Free, and works without signal.')}
          state={status.app.on ? 'on' : 'off'}
          action={actionFor(status.app.on, true, appPanel, startApp, 'app', tr('Set up'))}
          panel={appPanel}
        />
        <MethodRow
          icon="sms" title={tr('Text message')}
          summary={status.sms.on
            ? tr('Codes are texted to {phone} when you sign in.', { phone: status.sms.phone })
            : status.smsAvailable ? tr('A code is texted to your phone each time you sign in. Needs signal; uses the company\'s SMS credit.')
              : tr('Not available yet — text messages aren\'t set up on the server. Ask an administrator (Company settings → Text messages).')}
          state={status.sms.on ? 'on' : status.smsAvailable ? 'off' : 'unavailable'}
          action={actionFor(status.sms.on, status.smsAvailable, smsPanel, startSms, 'sms', tr('Set up'))}
          panel={smsPanel}
        />
        <MethodRow
          icon="email" title={tr('Email')}
          summary={status.email.on
            ? tr('Codes are emailed to {email} when you sign in.', { email: status.email.address })
            : status.emailAvailable ? tr('A code is emailed to {email} each time you sign in. Free; only as safe as that mailbox, so keep its password to yourself.', { email: status.email.address })
              : tr('Not available yet — email isn\'t set up on the server. Ask an administrator (Company settings → Email).')}
          state={status.email.on ? 'on' : status.emailAvailable ? 'off' : 'unavailable'}
          action={actionFor(status.email.on, status.emailAvailable, emailPanel, startEmail, 'email', tr('Set up'))}
          panel={emailPanel}
        />
      </ul>

      {/* ---- backup codes and turning it all off ---- */}
      {status.enabled && (
        <section className="tss-footer">
          <div className={'tss-backup' + (status.backupCodesLeft <= 3 ? ' is-low' : '')}>
            <span className="tss-backup-icon"><Glyph name="key" size={20} /></span>
            <div className="tss-backup-text">
              <div className="tss-row-title">{tr('Backup codes')}</div>
              <div className="tss-row-sub">
                {status.backupCodesLeft <= 3
                  ? tr('Only {n} left — make new ones soon.', { n: status.backupCodesLeft })
                  : tr('{n} left — each one signs you in once if you lose your phone.', { n: status.backupCodesLeft })}
              </div>
            </div>
            {!(asking && asking.action === 'codes') && (
              <button type="button" className="btn btn-secondary" onClick={() => ask({ action: 'codes' })}>{tr('Make new codes')}</button>
            )}
          </div>
          {asking && (asking.action === 'codes' || (asking.action === 'disable' && !asking.method)) && <div className="tss-footer-panel">{passwordPanel}</div>}
          {!(asking && asking.action === 'disable' && !asking.method) && (
            <button type="button" className="tss-off-link" onClick={() => ask({ action: 'disable', method: null })}>{tr('Turn off two-step sign-in')}</button>
          )}
        </section>
      )}
    </div>
  );
}
