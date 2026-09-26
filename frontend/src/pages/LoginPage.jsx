import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { forgotPassword, resetPassword, sendLoginCode } from '../api/client';
import AuthLayout, { AuthIcon, PasswordField, PasswordRules, passwordProblems } from '../components/AuthLayout';
import { tr } from '../lib/i18n.jsx';

// The sign-in screens: email and password; the two-step code for accounts
// that have it on (from the authenticator app, a text or an email, or a
// backup code); and "Forgot your password?" — a code sent to the account's
// email (or phone, when email isn't set up on the server) and a new
// password (auth.routes.js /password/forgot and /password/reset). A reset
// never skips two-step sign-in: after it, signing in carries on as usual.
//
// The last email used on this device is remembered to save typing; the
// test accounts only show on a development copy, never on the live site.

// Same test accounts backend/README.md documents (backend/src/db/seed.js) —
// password 'bamboo123' for all.
const DEMO_ACCOUNTS = [
  { email: 'kelvin.duho@bplghana.com', name: 'Kelvin Duho', role: 'System Administrator' },
  { email: 'andy.chou@bplghana.com', name: 'Andy Chou', role: 'Executive (MD)' },
  { email: 'albert.awini@bplghana.com', name: 'Albert Awini', role: 'Finance & HR Manager' },
  { email: 'frank.kampewu@bplghana.com', name: 'Frank Kampewu', role: 'General Manager' },
  { email: 'isreal.omozuafo@bplghana.com', name: 'Isreal Omozuafo', role: 'Production Manager' },
  { email: 'emmanuel.chang@bplghana.com', name: 'Emmanuel Chang', role: 'IT Manager' },
  { email: 'alice.kamau@bplghana.com', name: 'Alice Kamau', role: 'Employee' }
];
const SHOW_TEST_ACCOUNTS = import.meta.env.DEV;
const LAST_EMAIL_KEY = 'bos.lastEmail';
function recallEmail() { try { return localStorage.getItem(LAST_EMAIL_KEY) || ''; } catch { return ''; } }
function rememberEmail(email) { try { localStorage.setItem(LAST_EMAIL_KEY, email); } catch { /* not remembered */ } }

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export default function LoginPage() {
  const { login, verifyCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('signin'); // signin | twostep | forgot | reset
  const [email, setEmail] = useState(recallEmail);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showDemo, setShowDemo] = useState(false);
  // Two-step sign-in: after a right password, the code from the app, a text
  // or an email. methods says which this person has; smsTo / emailTo are
  // where a sent code goes ("•••• 3456", "ly•••@bplghana.com"); lastSent is
  // the way the latest code went.
  const [challenge, setChallenge] = useState(null);
  const [methods, setMethods] = useState([]);
  const [smsTo, setSmsTo] = useState(null);
  const [emailTo, setEmailTo] = useState(null);
  const [lastSent, setLastSent] = useState(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);
  // Forgot password: where the code went, and the new password.
  const [resetTo, setResetTo] = useState(null); // { channel, sentTo, expiresInMinutes }
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showNew, setShowNew] = useState(false);

  const hasApp = methods.includes('app');
  const hasSms = methods.includes('sms');
  const hasEmail = methods.includes('email');
  const redirectTo = location.state && location.state.from ? location.state.from : '/dashboard';

  function go(next) { setMode(next); setError(null); setNotice(null); setSubmitting(false); }

  async function sendMeACode(channel) {
    setSendingCode(channel);
    setError(null);
    setNotice(null);
    try {
      const r = await sendLoginCode(challenge, channel);
      setLastSent(r.channel);
      setNotice(r.channel === 'email' ? tr('Code sent to {email}.', { email: r.sentTo }) : tr('Code sent to {phone}.', { phone: r.sentTo }));
    } catch (err) {
      if (/too long|Sign in again/i.test(err.message || '')) { setChallenge(null); setMode('signin'); }
      setError(err.message);
    } finally {
      setSendingCode(false);
    }
  }

  // Signs in, and moves to the two-step code when the account has it on.
  async function signIn(withPassword) {
    const result = await login(email, withPassword);
    rememberEmail(email.trim().toLowerCase());
    if (result && result.twoStepRequired) {
      setChallenge(result.challenge);
      setMethods(result.methods || ['app']);
      setSmsTo(result.smsTo || null);
      setEmailTo(result.emailTo || null);
      setLastSent(result.codeSent ? result.codeSentVia : null);
      setCode('');
      setMode('twostep');
      setNotice(!result.codeSent ? null
        : result.codeSentVia === 'email' ? tr('Code sent to {email}.', { email: result.emailTo })
          : tr('Code sent to {phone}.', { phone: result.smsTo }));
      setError(result.codeError || null);
      return;
    }
    navigate(redirectTo, { replace: true });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'twostep') {
        await verifyCode(email, challenge, code, rememberDevice);
        navigate(redirectTo, { replace: true });
      } else if (mode === 'forgot') {
        const r = await forgotPassword(email);
        rememberEmail(email.trim().toLowerCase());
        setResetTo(r);
        setCode('');
        setNewPassword('');
        setConfirm('');
        setMode('reset');
      } else if (mode === 'reset') {
        const p = passwordProblems(newPassword, confirm, email);
        if (!p.length || !p.mixed || !p.notEmail || !p.match) { setError(tr('Choose a password that meets every rule below.')); return; }
        await resetPassword(email, code, newPassword);
        setPassword('');
        setNotice(tr('Your password is changed. Signing you in…'));
        await signIn(newPassword);
      } else {
        await signIn(password);
      }
    } catch (err) {
      // The code step expires after a few minutes: start over from the password.
      if (mode === 'twostep' && /too long|Sign in again/i.test(err.message || '')) { setChallenge(null); setMode('signin'); }
      setError(err.message || tr('Something went wrong.'));
    } finally {
      setSubmitting(false);
    }
  }

  function fillDemoAccount(acct) {
    setEmail(acct.email);
    setPassword('bamboo123');
    setError(null);
  }

  const emailField = (autoFocus) => (
    <div className="field">
      <label htmlFor="bpl-email">{tr('Work email')}</label>
      <div className="auth-input">
        <AuthIcon name="mail" />
        <input id="bpl-email" className="input" type="email" autoComplete="username" placeholder="name@bplghana.com" autoFocus={autoFocus}
          value={email} onChange={(e) => setEmail(e.target.value)} required />
      </div>
    </div>
  );

  return (
    <AuthLayout>
      <form className="auth-form" onSubmit={handleSubmit} noValidate={mode === 'reset'}>
        {mode === 'signin' && (
          <>
            <h2 className="auth-title">{tr('Sign in')}</h2>
            <p className="auth-sub">{tr('Use your company email address and your password.')}</p>
            {emailField(!email)}
            <PasswordField id="bpl-pw" label={tr('Password')} value={password} onChange={setPassword} autoComplete="current-password" autoFocus={!!email}
              shown={showPassword} onToggle={() => setShowPassword((s) => !s)} />
            <div className="auth-row">
              <button type="button" className="auth-link" onClick={() => go('forgot')}>{tr('Forgot your password?')}</button>
            </div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={submitting}>
              {submitting ? tr('Signing in…') : tr('Sign in')}
            </button>
            <p className="auth-help">{tr('New here? HR gives you a temporary password with your account; you choose your own the first time you sign in.')}</p>

            {SHOW_TEST_ACCOUNTS && (
              <>
                <button type="button" className="auth-demo-toggle" onClick={() => setShowDemo((s) => !s)}>
                  {showDemo ? tr('Hide test accounts') : tr('Use a test account')}
                </button>
                {showDemo && (
                  <div className="auth-demo">
                    <div className="eyebrow">{tr('Test accounts — password bamboo123')}</div>
                    <div className="auth-demo-list">
                      {DEMO_ACCOUNTS.map((acct) => (
                        <button key={acct.email} type="button" className="auth-demo-item" onClick={() => fillDemoAccount(acct)}>
                          <span className="auth-demo-avatar" style={{ background: avatarColor(acct.name) }}>{initials(acct.name)}</span>
                          <span className="auth-demo-text"><strong>{acct.name}</strong><span>{acct.role}</span></span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {mode === 'twostep' && (
          <>
            <button type="button" className="auth-back" onClick={() => { setChallenge(null); go('signin'); }}><AuthIcon name="back" />{tr('Back')}</button>
            <h2 className="auth-title">{tr('Two-step sign-in')}</h2>
            <p className="auth-sub">
              {hasApp && lastSent ? tr('Enter the 6-digit code from your authenticator app, or the one we just sent you.')
                : hasApp ? tr('Enter the 6-digit code from your authenticator app.')
                  : lastSent === 'sms' ? tr('Enter the 6-digit code we texted to {phone}.', { phone: smsTo })
                    : lastSent === 'email' ? tr('Enter the 6-digit code we emailed to {email}.', { email: emailTo })
                      : tr('Choose where to send your 6-digit code.')}
            </p>
            {notice && <div className="auth-notice" role="status"><AuthIcon name="check" />{notice}</div>}
            <div className="field">
              <label htmlFor="bpl-code">{tr('Code')}</label>
              <input id="bpl-code" className="input auth-code" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000 000"
                value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <label className="auth-check">
              <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
              {tr('Don\'t ask again on this device for 30 days')}
            </label>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={submitting}>
              {submitting ? tr('Checking…') : tr('Verify')}
            </button>
            {(hasSms || hasEmail) && (
              <div className="auth-ways">
                <p className="auth-ways-title">{tr('Didn\'t get a code?')}</p>
                {hasApp && <div className="auth-way is-static"><AuthIcon name="app" /><span>{tr('Open your authenticator app')}</span></div>}
                {hasSms && (
                  <button type="button" className="auth-way" onClick={() => sendMeACode('sms')} disabled={!!sendingCode}>
                    <AuthIcon name="phone" />
                    <span>{sendingCode === 'sms' ? tr('Sending…') : lastSent === 'sms' ? tr('Send a new code by text') : tr('Text me a code ({phone})', { phone: smsTo })}</span>
                  </button>
                )}
                {hasEmail && (
                  <button type="button" className="auth-way" onClick={() => sendMeACode('email')} disabled={!!sendingCode}>
                    <AuthIcon name="mail" />
                    <span>{sendingCode === 'email' ? tr('Sending…') : lastSent === 'email' ? tr('Send a new code by email') : tr('Email me a code ({email})', { email: emailTo })}</span>
                  </button>
                )}
              </div>
            )}
            <p className="auth-help"><AuthIcon name="key" />{tr('Lost your phone? Type one of your backup codes instead, or ask an administrator to turn two-step sign-in off for you.')}</p>
          </>
        )}

        {mode === 'forgot' && (
          <>
            <button type="button" className="auth-back" onClick={() => go('signin')}><AuthIcon name="back" />{tr('Back to sign in')}</button>
            <h2 className="auth-title">{tr('Forgot your password?')}</h2>
            <p className="auth-sub">{tr('Enter the email you sign in with. We\'ll send you a 6-digit code to choose a new password.')}</p>
            {emailField(true)}
            {error && <div className="error-banner" role="alert">{error}</div>}
            <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={submitting}>
              {submitting ? tr('Sending…') : tr('Send me a code')}
            </button>
            <p className="auth-help">{tr('No email or phone on your account? Ask HR or an administrator to reset your password for you.')}</p>
          </>
        )}

        {mode === 'reset' && (
          <>
            <button type="button" className="auth-back" onClick={() => go('forgot')}><AuthIcon name="back" />{tr('Back')}</button>
            <h2 className="auth-title">{tr('Choose a new password')}</h2>
            <div className="auth-notice" role="status">
              <AuthIcon name={resetTo && resetTo.channel === 'sms' ? 'phone' : 'mail'} />
              {resetTo && resetTo.channel === 'sms'
                ? tr('If {email} has an account, we\'ve texted a code to the phone on it. It works for {n} minutes.', { email, n: resetTo.expiresInMinutes })
                : tr('If {email} has an account, we\'ve emailed a code to it. It works for {n} minutes.', { email: resetTo ? resetTo.sentTo : email, n: resetTo ? resetTo.expiresInMinutes : 10 })}
            </div>
            <div className="field">
              <label htmlFor="bpl-reset-code">{tr('Code')}</label>
              <input id="bpl-reset-code" className="input auth-code" inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="000 000"
                value={code} onChange={(e) => setCode(e.target.value)} required />
            </div>
            <PasswordField id="bpl-new" label={tr('New password')} value={newPassword} onChange={setNewPassword} autoComplete="new-password" shown={showNew} onToggle={() => setShowNew((s) => !s)} />
            <PasswordField id="bpl-confirm" label={tr('New password again')} value={confirm} onChange={setConfirm} autoComplete="new-password" shown={showNew} />
            <PasswordRules password={newPassword} confirm={confirm} email={email} />
            {error && <div className="error-banner" role="alert">{error}</div>}
            {notice && !error && <div className="auth-notice" role="status"><AuthIcon name="check" />{notice}</div>}
            <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={submitting}>
              {submitting ? tr('Saving…') : tr('Save and sign in')}
            </button>
            <button type="button" className="auth-link" onClick={() => go('forgot')}>{tr('Send a new code')}</button>
          </>
        )}
      </form>
    </AuthLayout>
  );
}
