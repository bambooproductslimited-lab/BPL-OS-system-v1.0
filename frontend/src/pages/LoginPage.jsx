import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
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
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showDemo, setShowDemo] = useState(false);

  const redirectTo = location.state && location.state.from ? location.state.from : '/dashboard';

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err.message || 'Something went wrong.');
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
            <h1 className="login-brand-heading">Company<br />Operating<br />System</h1>
            <p className="login-brand-sub">
              People, attendance, leave and governance for the factory &amp; office.
              <br />Phase 1 foundation.
            </p>
          </div>
          <div className="login-brand-footer">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" /></svg>
            Internal system · authorised staff only
          </div>
        </div>
      </div>

      <div className="login-form-wrap">
        <form className="login-form" onSubmit={handleSubmit}>
          <h1 className="login-form-title">Sign in</h1>
          <p className="login-form-sub">Use your company email address.</p>

          <div className="field">
            <label htmlFor="bpl-email">Work email</label>
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
            <label htmlFor="bpl-pw">Password</label>
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
                aria-label={showPassword ? 'Hide password' : 'Show password'}
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
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <button type="button" className="login-demo-toggle" onClick={() => setShowDemo((s) => !s)}>
            {showDemo ? 'Hide test accounts' : 'Use a test account'}
            <svg className={'login-demo-toggle-chevron' + (showDemo ? ' is-open' : '')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {showDemo && (
            <div className="login-demo">
              <div className="eyebrow">Test accounts — password bamboo123</div>
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
        </form>
      </div>
    </div>
  );
}
