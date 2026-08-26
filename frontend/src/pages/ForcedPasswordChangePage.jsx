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
export default function ForcedPasswordChangePage() {
  const { session, refreshSession, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
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
        <img src="/logo.png" alt="Bamboo Products Limited" className="login-logo" />
        <div>
          <h1 className="login-brand-heading">Set a new<br />password</h1>
          <p className="login-brand-sub">
            Your account was created (or reset) with a temporary password.
            <br />You need to set your own before continuing.
          </p>
        </div>
        <div className="login-brand-footer">Internal system · authorised staff only</div>
      </div>

      <div className="login-form-wrap">
        <form className="login-form" onSubmit={handleSubmit}>
          <h1 className="login-form-title">{firstName ? 'Welcome, ' + firstName : 'Set a new password'}</h1>
          <p className="login-form-sub">Enter your current (temporary) password and choose a new one.</p>

          <div className="field">
            <label htmlFor="fpc-current">Current password</label>
            <input
              id="fpc-current" className="input" type="password" autoComplete="current-password"
              value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required
            />
          </div>

          <div className="field">
            <label htmlFor="fpc-new">New password</label>
            <input
              id="fpc-new" className="input" type="password" autoComplete="new-password"
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required
            />
          </div>

          <div className="field">
            <label htmlFor="fpc-confirm">Confirm new password</label>
            <input
              id="fpc-confirm" className="input" type="password" autoComplete="new-password"
              value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required
            />
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
