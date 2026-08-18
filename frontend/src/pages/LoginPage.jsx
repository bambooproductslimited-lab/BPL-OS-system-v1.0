import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import './LoginPage.css';

// Same test accounts backend/README.md documents (backend/src/db/seed.js) —
// password 'bamboo123' for all. Matches the prototype's own hardcoded
// demoAccounts list (Bamboo OS.dc.html's boot() -> this.K.lookups()).
const DEMO_ACCOUNTS = [
  { email: 'kelvin.duho@bplghana.com', role: 'System Administrator' },
  { email: 'andy.chou@bplghana.com', role: 'Executive (MD)' },
  { email: 'albert.awini@bplghana.com', role: 'Finance & HR Manager' },
  { email: 'frank.kampewu@bplghana.com', role: 'General Manager' },
  { email: 'isreal.omozuafo@bplghana.com', role: 'Production Manager' },
  { email: 'emmanuel.chang@bplghana.com', role: 'IT Manager' },
  { email: 'alice.kamau@bplghana.com', role: 'Employee' }
];

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

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
        <div className="login-brand-name">Bamboo Products Limited</div>
        <div>
          <h1 className="login-brand-heading">Company<br />Operating<br />System</h1>
          <p className="login-brand-sub">
            People, attendance, leave and governance for the factory &amp; office.
            <br />Phase 1 foundation.
          </p>
        </div>
        <div className="login-brand-footer">Internal system · authorised staff only</div>
      </div>

      <div className="login-form-wrap">
        <form className="login-form" onSubmit={handleSubmit}>
          <h1 className="login-form-title">Sign in</h1>
          <p className="login-form-sub">Use your company email address.</p>

          <div className="field">
            <label htmlFor="bpl-email">Work email</label>
            <input
              id="bpl-email"
              className="input"
              type="email"
              autoComplete="username"
              placeholder="name@bplghana.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="bpl-pw">Password</label>
            <input
              id="bpl-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>

          <div className="hr" style={{ margin: '8px 0' }} />

          <div className="eyebrow">Test accounts — password bamboo123</div>
          <div className="login-demo-list">
            {DEMO_ACCOUNTS.map((acct) => (
              <button
                key={acct.email}
                type="button"
                className="btn btn-secondary login-demo-btn"
                onClick={() => fillDemoAccount(acct)}
              >
                <span>{acct.role}</span>
                <span className="login-demo-email">{acct.email.split('@')[0]}</span>
              </button>
            ))}
          </div>
        </form>
      </div>
    </div>
  );
}
