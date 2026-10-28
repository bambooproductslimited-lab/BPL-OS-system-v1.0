import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import ForcedPasswordChangePage from '../pages/ForcedPasswordChangePage';

import { tr } from '../lib/i18n.jsx';
export default function ProtectedRoute() {
  const { session, loading, reconnecting, forgetSignIn } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--color-text-muted)' }}>
        {reconnecting ? (
          <>
            <strong style={{ color: 'var(--color-text)', fontSize: 16 }}>{tr('Reaching the server…')}</strong>
            <span>{tr('It can take up to a minute when it has been quiet. You stay signed in.')}</span>
            <button type="button" className="btn btn-secondary" onClick={forgetSignIn}>{tr('Sign in again')}</button>
          </>
        ) : tr('Loading…')}
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Blocks every screen (not just a route guard the user could navigate
  // around) until a temporary/reset password is replaced — the backend
  // enforces the same thing independently (middleware/auth.js), this just
  // avoids a round trip to find that out.
  if (session.mustChangePassword) {
    return <ForcedPasswordChangePage />;
  }

  return <Outlet />;
}
