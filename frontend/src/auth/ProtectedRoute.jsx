import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import ForcedPasswordChangePage from '../pages/ForcedPasswordChangePage';

export default function ProtectedRoute() {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-muted)' }}>
        Loading…
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
