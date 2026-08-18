import { useAuth } from '../auth/AuthContext';

export default function DashboardPage() {
  const { session } = useAuth();
  const employee = session && session.employee;

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>Welcome</div>
      <h2 style={{ fontSize: 20, marginBottom: 8 }}>
        {employee ? employee.firstName + ' ' + employee.lastName : 'Welcome back'}
      </h2>
      <p style={{ margin: 0, color: 'var(--color-text-muted)' }}>
        You're signed in as {(session && session.roleNames || []).join(', ')}. The dashboard's live
        data (headcount, attendance, approvals, etc.) isn't wired up in this pass — this first slice
        proves out login, session handling, and the permission-scoped navigation shell against the
        real API.
      </p>
    </div>
  );
}
