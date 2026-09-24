import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import { formatDate } from '../lib/dates';
import './TwoStepSettings.css';

// Two-step sign-in, in My space (backend twoStep.service.js). Optional: once
// on, signing in needs the password and a six-digit code, which comes one of
// two ways — the person picks either or both:
//   - an authenticator app (any: Google or Microsoft Authenticator, Authy,
//     2FAS, Aegis, Bitwarden, 1Password …): scan a QR code, type the code it
//     shows to prove it worked;
//   - a text message to their phone (mNotify, on the company's SMS credit):
//     type the number, then the code texted to it.
// The first way turned on shows backup codes once, for a lost phone.

function groupKey(secret) { return String(secret || '').replace(/(.{4})/g, '$1 ').trim(); }

export default function TwoStepSettings() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null); // app: { secret, otpauthUri, qr }
  const [smsSetup, setSmsSetup] = useState(null); // text: { phone, sentTo }
  const [phone, setPhone] = useState('');
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

  const startApp = () => run(async () => {
    const s = await api.post('/me/two-step/setup', {});
    const qr = await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 200 });
    setSmsSetup(null);
    setSetup({ ...s, qr });
    setCode('');
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
    setSetup(null);
    setPhone((status && status.suggestedPhone) || '');
    setSmsSetup({ sentTo: null });
    setCode('');
    setError(null);
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

  const passwordPrompt = asking && (
    <form className="twostep-password" onSubmit={withPassword}>
      <label htmlFor="twostep-pw">
        {asking.action === 'codes' ? tr('Enter your password to make new backup codes (the old ones stop working):')
          : asking.method === 'app' ? tr('Enter your password to remove the authenticator app:')
            : asking.method === 'sms' ? tr('Enter your password to stop codes by text:')
              : tr('Enter your password to turn two-step sign-in off:')}
      </label>
      <input id="twostep-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      <div className="twostep-actions">
        <button type="button" className="btn btn-secondary" onClick={() => { setAsking(null); setPassword(''); }}>{tr('Cancel')}</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {asking.action === 'codes' ? tr('Make new codes') : tr('Turn off')}
        </button>
      </div>
    </form>
  );

  if (backupCodes) {
    return (
      <div className="twostep">
        <div className="twostep-codes">
          <p><strong>{tr('Your backup codes')}</strong></p>
          <p className="twostep-muted">
            {tr('If you lose your phone, each of these signs you in once instead of the code from the app. Keep them somewhere safe — they won\'t be shown again.')}
          </p>
          <ol className="twostep-code-list">{backupCodes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
          <div className="twostep-actions">
            <button type="button" className="btn btn-secondary" onClick={copyCodes}>{copied ? tr('Copied!') : tr('Copy')}</button>
            <button type="button" className="btn btn-secondary" onClick={downloadCodes}>{tr('Download')}</button>
            <button type="button" className="btn btn-primary" onClick={() => setBackupCodes(null)}>{tr('I\'ve saved them')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="twostep">
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="twostep-notice" role="status">{notice}</div>}

      <p className={status.enabled ? undefined : 'twostep-muted'}>
        {status.enabled
          ? <><span className="tag tag-neutral twostep-on">{tr('On')}</span>{' '}{tr('Since {date}. Signing in needs your password and a 6-digit code. Backup codes left: {n}.', { date: formatDate(status.enabledAt), n: status.backupCodesLeft })}</>
          : tr('Off. Turn it on and signing in will also need a 6-digit code — from an app on your phone, or a text message — so someone who learns your password still can\'t get in. Choose one way or both:')}
      </p>

      <div className="twostep-methods">
        {/* ---- authenticator app ---- */}
        <section className="twostep-method">
          <div className="twostep-method-head">
            <strong>{tr('Authenticator app')}</strong>
            {status.app.on && <span className="tag tag-neutral">{tr('On')}</span>}
          </div>
          <p className="twostep-muted">
            {tr('Free, and works without signal. Any authenticator app will do — Google Authenticator, Microsoft Authenticator, Authy, 2FAS, Aegis, Bitwarden, 1Password, or the one built into your password manager.')}
          </p>
          {setup ? (
            <form className="twostep-setup" onSubmit={confirmApp}>
              <ol className="twostep-steps">
                <li>{tr('On your phone, install an authenticator app if you don\'t have one (free, from the Play Store or App Store).')}</li>
                <li>
                  {tr('In the app, add an account and scan this code:')}
                  <div className="twostep-qr"><img src={setup.qr} alt={tr('QR code to scan with your authenticator app')} width="200" height="200" /></div>
                  <div className="twostep-muted">{tr('Can\'t scan? Choose "enter a setup key" in the app and type:')} <code className="twostep-key">{groupKey(setup.secret)}</code></div>
                </li>
                <li>
                  <label htmlFor="twostep-code">{tr('Type the 6-digit code the app now shows:')}</label>
                  <input id="twostep-code" className="input twostep-code-input" inputMode="numeric" autoComplete="one-time-code"
                    value={code} onChange={(e) => setCode(e.target.value)} required />
                </li>
              </ol>
              <div className="twostep-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setSetup(null)}>{tr('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Turn on')}</button>
              </div>
            </form>
          ) : asking && asking.method === 'app' ? passwordPrompt : (
            <div className="twostep-actions">
              {status.app.on
                ? <button type="button" className="btn btn-secondary" onClick={() => setAsking({ action: 'disable', method: 'app' })}>{tr('Remove')}</button>
                : <button type="button" className="btn btn-primary" disabled={busy || !!smsSetup} onClick={startApp}>{tr('Set up the app')}</button>}
            </div>
          )}
        </section>

        {/* ---- text message ---- */}
        <section className="twostep-method">
          <div className="twostep-method-head">
            <strong>{tr('Text message')}</strong>
            {status.sms.on && <span className="tag tag-neutral">{tr('On')}</span>}
          </div>
          <p className="twostep-muted">
            {status.sms.on
              ? tr('Codes are texted to {phone} when you sign in.', { phone: status.sms.phone })
              : tr('A code is texted to your phone each time you sign in. Needs signal; uses the company\'s SMS credit.')}
          </p>
          {!status.sms.on && !status.smsAvailable ? (
            <p className="twostep-muted"><em>{tr('Not available yet — text messages aren\'t set up on the server. Ask an administrator (Company settings → Text messages).')}</em></p>
          ) : smsSetup ? (
            smsSetup.sentTo ? (
              <form className="twostep-setup" onSubmit={confirmSms}>
                <label htmlFor="twostep-sms-code">{tr('Type the 6-digit code we texted to {phone}:', { phone: smsSetup.sentTo })}</label>
                <input id="twostep-sms-code" className="input twostep-code-input" inputMode="numeric" autoComplete="one-time-code"
                  value={code} onChange={(e) => setCode(e.target.value)} required autoFocus />
                <div className="twostep-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSmsSetup(null)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => sendSmsCode()}>{tr('Send a new code')}</button>
                  <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Turn on')}</button>
                </div>
              </form>
            ) : (
              <form className="twostep-setup" onSubmit={sendSmsCode}>
                <label htmlFor="twostep-phone">{tr('Your mobile number:')}</label>
                <input id="twostep-phone" className="input twostep-phone-input" type="tel" autoComplete="tel" placeholder="024 412 3456"
                  value={phone} onChange={(e) => setPhone(e.target.value)} required autoFocus />
                <div className="twostep-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSmsSetup(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Sending…') : tr('Text me a code')}</button>
                </div>
              </form>
            )
          ) : asking && asking.method === 'sms' ? passwordPrompt : (
            <div className="twostep-actions">
              {status.sms.on
                ? <button type="button" className="btn btn-secondary" onClick={() => setAsking({ action: 'disable', method: 'sms' })}>{tr('Remove')}</button>
                : <button type="button" className="btn btn-primary" disabled={busy || !!setup} onClick={startSms}>{tr('Set up text messages')}</button>}
            </div>
          )}
        </section>
      </div>

      {status.enabled && (
        asking && (asking.action === 'codes' || !asking.method) ? passwordPrompt : (
          <div className="twostep-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setAsking({ action: 'codes' })}>{tr('New backup codes')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setAsking({ action: 'disable', method: null })}>{tr('Turn off two-step sign-in')}</button>
          </div>
        )
      )}
    </div>
  );
}
