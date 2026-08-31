import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './LoginPage.css';

// Shown instead of the app whenever session.mustChangePassword is true —
// set on every new employee login and every admin password reset (see
// backend/src/services/users.service.js). Blocks the rest of the OS both
// here (ProtectedRoute never renders <Outlet/> while this is true) and on
// the server (middleware/auth.js rejects every other route), so this isn't
// just a UI nicety a client could route around.
//
// Redesigned to match the Login page's visual language, which it shares a
// stylesheet with: the same decorative bamboo-grove brand panel and
// icon-prefixed, show/hide-toggled password inputs.

function BambooDecoration() {
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

function LockIcon() {
  return (
    <svg className="login-input-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function EyeToggleIcon({ shown }) {
  return shown ? (
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
  );
}

export default function ForcedPasswordChangePage() {
  const { session, refreshSession, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return; }

    setSubmitting(true);
    try {
      await api.post('/me/password', { currentPassword, newPassword });
      await refreshSession();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  const firstName = session && session.employee ? session.employee.firstName : '';

  return (
    <div className="login-page">
      <div className="login-brand">
        <BambooDecoration />
        <div className="login-brand-content">
          <img src="/logo.png" alt="Bamboo Products Limited" className="login-logo" />
          <div>
            <h1 className="login-brand-heading">Set a new<br />password</h1>
            <p className="login-brand-sub">
              Your account was created (or reset) with a temporary password.
              <br />You need to set your own before continuing.
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
          <h1 className="login-form-title">{firstName ? 'Welcome, ' + firstName : 'Set a new password'}</h1>
          <p className="login-form-sub">Enter your current (temporary) password and choose a new one.</p>

          <div className="field">
            <label htmlFor="fpc-current">Current password</label>
            <div className="login-input-wrap">
              <LockIcon />
              <input
                id="fpc-current" className="input login-input" type={showCurrent ? 'text' : 'password'} autoComplete="current-password"
                value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required
              />
              <button type="button" className="login-input-toggle" onClick={() => setShowCurrent((s) => !s)} aria-label={showCurrent ? 'Hide password' : 'Show password'} tabIndex={-1}>
                <EyeToggleIcon shown={showCurrent} />
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="fpc-new">New password</label>
            <div className="login-input-wrap">
              <LockIcon />
              <input
                id="fpc-new" className="input login-input" type={showNew ? 'text' : 'password'} autoComplete="new-password"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required
              />
              <button type="button" className="login-input-toggle" onClick={() => setShowNew((s) => !s)} aria-label={showNew ? 'Hide password' : 'Show password'} tabIndex={-1}>
                <EyeToggleIcon shown={showNew} />
              </button>
            </div>
          </div>

          <div className="field">
            <label htmlFor="fpc-confirm">Confirm new password</label>
            <div className="login-input-wrap">
              <LockIcon />
              <input
                id="fpc-confirm" className="input login-input" type={showNew ? 'text' : 'password'} autoComplete="new-password"
                value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required
              />
            </div>
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Set password and continue'}
          </button>

          <button type="button" className="btn btn-secondary btn-block" onClick={logout}>Sign out instead</button>
        </form>
      </div>
    </div>
  );
}
