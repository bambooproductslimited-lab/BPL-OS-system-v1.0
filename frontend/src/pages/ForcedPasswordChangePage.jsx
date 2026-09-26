import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import AuthLayout, { AuthIcon, PasswordField, PasswordRules, passwordProblems } from '../components/AuthLayout';
import { tr } from '../lib/i18n.jsx';

// Shown instead of the app whenever session.mustChangePassword is true —
// set on every new employee login and every admin password reset (see
// backend/src/services/users.service.js). Blocks the rest of the OS both
// here (ProtectedRoute never renders <Outlet/> while this is true) and on
// the server (middleware/auth.js rejects every other route), so this isn't
// just a UI nicety a client could route around.
//
// Shares the sign-in screens' frame (components/AuthLayout.jsx), with the
// rules for a good password ticked off as it is typed.
export default function ForcedPasswordChangePage() {
  const { session, refreshSession, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const email = session ? session.email || '' : '';

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const p = passwordProblems(newPassword, confirmPassword, email);
    if (!p.length || !p.mixed || !p.notEmail || !p.match) { setError(tr('Choose a password that meets every rule below.')); return; }
    if (newPassword === currentPassword) { setError(tr('Choose a password different from the temporary one.')); return; }
    setSubmitting(true);
    try {
      await api.post('/me/password', { currentPassword, newPassword });
      await refreshSession();
    } catch (err) {
      setError(err.message || tr('Something went wrong.'));
    } finally {
      setSubmitting(false);
    }
  }

  const firstName = session && session.employee ? session.employee.firstName : '';

  return (
    <AuthLayout heading={tr('Set your own password')} sub={tr('Your account was created (or reset) with a temporary password. Choose your own before you carry on — only you should know it.')}>
      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <h2 className="auth-title">{firstName ? tr('Welcome, {firstName}', { firstName }) : tr('Set a new password')}</h2>
        <p className="auth-sub">{tr('Enter the temporary password you were given, then choose a new one.')}</p>
        <PasswordField id="fpc-current" label={tr('Temporary password')} value={currentPassword} onChange={setCurrentPassword} autoComplete="current-password" autoFocus
          shown={showCurrent} onToggle={() => setShowCurrent((s) => !s)} />
        <PasswordField id="fpc-new" label={tr('New password')} value={newPassword} onChange={setNewPassword} autoComplete="new-password"
          shown={showNew} onToggle={() => setShowNew((s) => !s)} />
        <PasswordField id="fpc-confirm" label={tr('New password again')} value={confirmPassword} onChange={setConfirmPassword} autoComplete="new-password" shown={showNew} />
        <PasswordRules password={newPassword} confirm={confirmPassword} email={email} />
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={submitting}>
          {submitting ? tr('Saving…') : tr('Set password and continue')}
        </button>
        <button type="button" className="auth-link" onClick={logout}><AuthIcon name="back" />{tr('Sign out instead')}</button>
      </form>
    </AuthLayout>
  );
}
