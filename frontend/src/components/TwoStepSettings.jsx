import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import { formatDate } from '../lib/dates';
import './TwoStepSettings.css';

// Two-step sign-in, in My space (backend twoStep.service.js). Optional: once
// on, signing in needs the password and the six-digit code from an
// authenticator app on the person's phone. Set-up: scan a QR code with the
// app, type the code it shows to prove it worked, then keep the backup codes
// shown once for a lost phone.

function groupKey(secret) { return String(secret || '').replace(/(.{4})/g, '$1 ').trim(); }

export default function TwoStepSettings() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(null); // { secret, otpauthUri, qr }
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);
  const [asking, setAsking] = useState(null); // 'disable' | 'codes' — waiting for the password
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.get('/me/two-step')); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const start = () => run(async () => {
    const s = await api.post('/me/two-step/setup', {});
    const qr = await QRCode.toDataURL(s.otpauthUri, { margin: 1, width: 200 });
    setSetup({ ...s, qr });
    setCode('');
  });

  const confirm = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api.post('/me/two-step/enable', { code });
      setBackupCodes(r.backupCodes);
      setSetup(null);
      await load();
    });
  };

  const withPassword = (e) => {
    e.preventDefault();
    run(async () => {
      if (asking === 'disable') {
        await api.post('/me/two-step/disable', { password });
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

  return (
    <div className="twostep">
      {error && <div className="error-banner">{error}</div>}

      {backupCodes ? (
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
      ) : setup ? (
        <form className="twostep-setup" onSubmit={confirm}>
          <ol className="twostep-steps">
            <li>{tr('On your phone, install Google Authenticator or Microsoft Authenticator (free, from the Play Store or App Store).')}</li>
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
      ) : status.enabled ? (
        <>
          <p>
            <span className="tag tag-neutral twostep-on">{tr('On')}</span>{' '}
            {tr('Since {date}. Signing in needs your password and the code from your authenticator app. Backup codes left: {n}.', { date: formatDate(status.enabledAt), n: status.backupCodesLeft })}
          </p>
          {asking ? (
            <form className="twostep-password" onSubmit={withPassword}>
              <label htmlFor="twostep-pw">{asking === 'disable' ? tr('Enter your password to turn two-step sign-in off:') : tr('Enter your password to make new backup codes (the old ones stop working):')}</label>
              <input id="twostep-pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <div className="twostep-actions">
                <button type="button" className="btn btn-secondary" onClick={() => { setAsking(null); setPassword(''); }}>{tr('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {asking === 'disable' ? tr('Turn off') : tr('Make new codes')}
                </button>
              </div>
            </form>
          ) : (
            <div className="twostep-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAsking('codes')}>{tr('New backup codes')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setAsking('disable')}>{tr('Turn off')}</button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="twostep-muted">
            {tr('Off. Turn it on and signing in will also need a 6-digit code from a free app on your phone — so someone who learns your password still can\'t get in.')}
          </p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={start}>{tr('Turn on two-step sign-in')}</button>
        </>
      )}
    </div>
  );
}
