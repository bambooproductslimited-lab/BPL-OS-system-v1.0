import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { sendLoginCode } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './LoginPage.css';

// Same test accounts backend/README.md documents (backend/src/db/seed.js) —
// password 'bamboo123' for all. Matches the prototype's own hardcoded
// demoAccounts list (Bamboo OS.dc.html's boot() -> this.K.lookups()).
// Redesigned around the same visual language established for Messages/
// Dashboard: initials-avatar chips (same palette + hash), small
// deliberate radius exceptions on an otherwise flat/zero-radius system.
const DEMO_ACCOUNTS = [
  { email: 'kelvin.duho@bplghana.com', name: 'Kelvin Duho', role: 'System Administrator' },
  { email: 'andy.chou@bplghana.com', name: 'Andy Chou', role: 'Executive (MD)' },
  { email: 'albert.awini@bplghana.com', name: 'Albert Awini', role: 'Finance & HR Manager' },
  { email: 'frank.kampewu@bplghana.com', name: 'Frank Kampewu', role: 'General Manager' },
  { email: 'isreal.omozuafo@bplghana.com', name: 'Isreal Omozuafo', role: 'Production Manager' },
  { email: 'emmanuel.chang@bplghana.com', name: 'Emmanuel Chang', role: 'IT Manager' },
  { email: 'alice.kamau@bplghana.com', name: 'Alice Kamau', role: 'Employee' }
];

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name) % AVATAR_COLORS.length]; }

function BambooDecoration() {
  // Abstract bamboo grove — plain lines only, purely decorative.
  const canes = [
    { x: 30, top: 130 }, { x: 85, top: 55 }, { x: 140, top: 190 },
    { x: 205, top: 30 }, { x: 265, top: 150 }, { x: 325, top: 85 }, { x: 380, top: 200 }
  ];
  return (
    <svg className="login-brand-deco" viewBox="0 0 400 500" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMax slice">
      <g stroke="#ffffff" strokeOpacity="0.13" strokeWidth="9" strokeLinecap="round">
        {canes.map((c) => <line key={c.x} x1={c.x} y1="500" x2={c.x} y2={c.top} />)}
      </g>
      <g stroke="#ffffff" strokeOpacity="0.2" strokeWidth="9">
        {canes.map((c) => [220, 320, 420].filter((y) => y > c.top).map((y) => (
          <line key={c.x + '-' + y} x1={c.x - 16} y1={y} x2={c.x + 16} y2={y} />
        )))}
      </g>
    </svg>
  );
}

export default function LoginPage() {
  const { login, verifyCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
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
  const [notice, setNotice] = useState(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [code, setCode] = useState('');
  const [rememberDevice, setRememberDevice] = useState(false);

  const hasApp = methods.includes('app');
  const hasSms = methods.includes('sms');
  const hasEmail = methods.includes('email');

  async function sendMeACode(channel) {
    setSendingCode(channel);
    setError(null);
    setNotice(null);
    try {
      const r = await sendLoginCode(challenge, channel);
      setLastSent(r.channel);
      setNotice(r.channel === 'email' ? tr('Code sent to {email}.', { email: r.sentTo }) : tr('Code sent to {phone}.', { phone: r.sentTo }));
    } catch (err) {
      if (/too long|Sign in again/i.test(err.message || '')) setChallenge(null);
      setError(err.message);
    } finally {
      setSendingCode(false);
    }
  }

  const redirectTo = location.state && location.state.from ? location.state.from : '/dashboard';

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (challenge) {
        await verifyCode(email, challenge, code, rememberDevice);
        navigate(redirectTo, { replace: true });
        return;
      }
      const result = await login(email, password);
      if (result && result.twoStepRequired) {
        setChallenge(result.challenge);
        setMethods(result.methods || ['app']);
        setSmsTo(result.smsTo || null);
        setEmailTo(result.emailTo || null);
        setLastSent(result.codeSent ? result.codeSentVia : null);
        setNotice(!result.codeSent ? null
          : result.codeSentVia === 'email' ? tr('Code sent to {email}.', { email: result.emailTo })
            : tr('Code sent to {phone}.', { phone: result.smsTo }));
        if (result.codeError) setError(result.codeError);
        setCode('');
        return;
      }
      navigate(redirectTo, { replace: true });
    } catch (err) {
      // The code step expires after a few minutes: start over from the password.
      if (challenge && /too long|Sign in again/i.test(err.message || '')) setChallenge(null);
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

  return (
    <div className="login-page">
      <div className="login-brand">
        <BambooDecoration />
        <div className="login-brand-content">
          <img src="/logo.png" alt="Bamboo Products Limited" className="login-logo" />
          <div>
            <h1 className="login-brand-heading">{tr('Company')}<br />{tr('Operating')}<br />{tr('System')}</h1>
            <p className="login-brand-sub">
              {tr('People, attendance, leave and governance for the factory & office.')}
              <br />{tr('Phase 1 foundation.')}
            </p>
          </div>
          <div className="login-brand-footer">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" /></svg>
            {tr('Internal system · authorised staff only')}
          </div>
        </div>
      </div>

      <div className="login-form-wrap">
        <form className="login-form" onSubmit={handleSubmit}>
          {challenge ? (
            <>
              <h1 className="login-form-title">{tr('Two-step sign-in')}</h1>
              <p className="login-form-sub">
                {hasApp && lastSent ? tr('Enter the 6-digit code from your authenticator app, or the one we just sent you.')
                  : hasApp ? tr('Enter the 6-digit code from your authenticator app.')
                    : lastSent === 'sms' ? tr('Enter the 6-digit code we texted to {phone}.', { phone: smsTo })
                      : lastSent === 'email' ? tr('Enter the 6-digit code we emailed to {email}.', { email: emailTo })
                        : tr('Choose where to send your 6-digit code.')}
              </p>
              {notice && <div className="login-code-notice" role="status">{notice}</div>}
              <div className="field">
                <label htmlFor="bpl-code">{tr('Code')}</label>
                <input
                  id="bpl-code"
                  className="input login-code-input"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  required
                />
              </div>
              <label className="login-remember">
                <input type="checkbox" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
                {tr('Don\'t ask again on this device for 30 days')}
              </label>
              {hasSms && (
                <button type="button" className="login-text-code" onClick={() => sendMeACode('sms')} disabled={!!sendingCode}>
                  {sendingCode === 'sms' ? tr('Sending…') : lastSent === 'sms' ? tr('Send a new code by text') : tr('Text me a code ({phone})', { phone: smsTo })}
                </button>
              )}
              {hasEmail && (
                <button type="button" className="login-text-code" onClick={() => sendMeACode('email')} disabled={!!sendingCode}>
                  {sendingCode === 'email' ? tr('Sending…') : lastSent === 'email' ? tr('Send a new code by email') : tr('Email me a code ({email})', { email: emailTo })}
                </button>
              )}
              <p className="login-code-help">
                {tr('Lost your phone? Type one of your backup codes instead, or ask an administrator to turn two-step sign-in off for you.')}
              </p>
              {error && <div className="error-banner">{error}</div>}
              <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
                {submitting ? tr('Checking…') : tr('Verify')}
              </button>
              <button type="button" className="btn btn-secondary btn-block login-back" onClick={() => { setChallenge(null); setError(null); setNotice(null); }}>
                {tr('Back')}
              </button>
            </>
          ) : (
          <>
          <h1 className="login-form-title">{tr('Sign in')}</h1>
          <p className="login-form-sub">{tr('Use your company email address.')}</p>

          <div className="field">
            <label htmlFor="bpl-email">{tr('Work email')}</label>
            <div className="login-input-wrap">
              <svg className="login-input-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
                <path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input
                id="bpl-email"
                className="input login-input"
                type="email"
                autoComplete="username"
                placeholder="name@bplghana.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="bpl-pw">{tr('Password')}</label>
            <div className="login-input-wrap">
              <svg className="login-input-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="5" y="10" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <input
                id="bpl-pw"
                className="input login-input"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="login-input-toggle"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? tr('Hide password') : tr('Show password')}
                tabIndex={-1}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M3 3l18 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    <path d="M9.9 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 6.5 10 6.5a15.4 15.4 0 0 1-3.2 4M6.5 6.8C3.6 8.6 2 12 2 12s3.5 6.5 10 6.5c1.4 0 2.6-.3 3.7-.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M9.9 9.9a2.6 2.6 0 0 0 3.6 3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                    <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
            {submitting ? tr('Signing in…') : tr('Sign in')}
          </button>

          <button type="button" className="login-demo-toggle" onClick={() => setShowDemo((s) => !s)}>
            {showDemo ? tr('Hide test accounts') : tr('Use a test account')}
            <svg className={'login-demo-toggle-chevron' + (showDemo ? ' is-open' : '')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {showDemo && (
            <div className="login-demo">
              <div className="eyebrow">{tr('Test accounts — password bamboo123')}</div>
              <div className="login-demo-list">
                {DEMO_ACCOUNTS.map((acct) => (
                  <button
                    key={acct.email}
                    type="button"
                    className="login-demo-item"
                    onClick={() => fillDemoAccount(acct)}
                  >
                    <span className="login-demo-avatar" style={{ background: avatarColor(acct.name) }}>{initials(acct.name)}</span>
                    <span className="login-demo-text">
                      <span className="login-demo-name">{acct.name}</span>
                      <span className="login-demo-role">{acct.role}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          </>
          )}
        </form>
      </div>
    </div>
  );
}
