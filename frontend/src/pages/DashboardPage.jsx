import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './DashboardPage.css';

// Ported from Bamboo OS.dc.html's dashboard screen (screens.dashboard
// block + the kpiDefs/deptStats/attention computed values around its
// render()), then redesigned into a proper "morning briefing" dashboard:
// a personal greeting, clickable icon KPI tiles color-coded by category,
// a filtered attention list with a celebratory empty state, and a
// connected-dot activity timeline. dash.myOpenTasks and
// dash.latestAnnouncement were already computed by the backend but never
// surfaced anywhere — both are now used here, no backend changes needed.
//
// Icon badges get a small border-radius and KPI tiles get a hover lift —
// both scoped to this page's own CSS, same as Messages' bubble rounding:
// a deliberate, contained exception to the app's flat/zero-radius system
// where the exception earns real legibility (an icon chip, a hover cue).

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function fmtToday() {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

const ICON_PATHS = {
  users: <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  box: <><path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M4 8v8l8 4.5 8-4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 12.5V21" stroke="currentColor" strokeWidth="1.6" /></>,
  cart: <><path d="M3 4h2.2l2 11.5h10.6l1.7-8.2H6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /><circle cx="16.5" cy="19.5" r="1.3" stroke="currentColor" strokeWidth="1.6" /></>,
  wrench: <path d="M14.7 5.3a4.3 4.3 0 0 1-5.6 5.6L4.5 15.5l3 3 4.6-4.6a4.3 4.3 0 0 1 5.6-5.6l-2.6 2.6-2.4-2.4 2.6-2.6Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
  document: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  checklist: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  megaphone: <><path d="M3 10v4h3l7 4V6l-7 4H3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M17 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M8 12.5l2.3 2.3L16 9.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  chevron: <path d="M8 5l6 7-6 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
};

function Icon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [dash, setDash] = useState(null);
  const [lateAfter, setLateAfter] = useState('08:15');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const dashData = await api.get('/dashboard');
      setDash(dashData);
    } catch (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    // /settings also carries integration API keys, so it's correctly
    // gated behind employee.read (unlike /dashboard, which any signed-in
    // user can load) -- a viewer without it just keeps the default
    // lateAfter shown below rather than losing the whole dashboard to a
    // Promise.all rejection, which is what used to happen here.
    try {
      const settings = await api.get('/settings');
      if (settings.lateAfter) setLateAfter(settings.lateAfter);
    } catch (err) {
      // ignore — cosmetic fallback only
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const firstName = session && session.employee ? session.employee.firstName : '';

  const kpis = [
    { key: 'headcount', icon: 'users', tone: 'people', label: 'Headcount in scope', value: dash.headcount, note: 'Active employees you can see', route: '/people' },
    { key: 'present', icon: 'clock', tone: 'people', label: 'Clocked in today', value: dash.presentToday, note: (dash.notClockedIn || 0) + ' still to clock in', route: '/attendance' },
    { key: 'late', icon: 'clock', tone: 'warning', label: 'Late today', value: dash.lateToday, note: 'After ' + lateAfter, route: '/attendance' },
    { key: 'onleave', icon: 'calendar', tone: 'people', label: 'On approved leave', value: dash.onLeaveToday, note: 'Away today', route: '/leave' },
    { key: 'pendingleave', icon: 'calendar', tone: 'warning', label: 'Pending leave', value: dash.pendingLeave, note: 'Awaiting a decision', route: '/leave' },
    { key: 'mytasks', icon: 'checklist', tone: 'people', label: 'Your open tasks', value: dash.myOpenTasks, note: 'Assigned to you', route: '/tasks' }
  ];
  if (dash.lowStockCount != null) kpis.push({ key: 'lowstock', icon: 'box', tone: 'ops', label: 'Low stock products', value: dash.lowStockCount, note: 'At or below reorder level', route: '/inventory' });
  if (dash.pendingProcurement != null) kpis.push({ key: 'procure', icon: 'cart', tone: 'ops', label: 'Pending purchase requests', value: dash.pendingProcurement, note: 'Company-wide', route: '/procurement' });
  if (dash.assetsDueService != null) kpis.push({ key: 'assets', icon: 'wrench', tone: 'ops', label: 'Assets due service', value: dash.assetsDueService, note: 'Within 7 days', route: '/assets' });
  if (dash.outstandingInvoices != null) kpis.push({ key: 'invoices', icon: 'document', tone: 'finance', label: 'Outstanding invoices', value: 'GHS ' + dash.outstandingInvoices.toLocaleString(), note: 'Unpaid balance', route: '/invoices' });
  if (dash.pendingExpenses != null) kpis.push({ key: 'expenses', icon: 'document', tone: 'finance', label: 'Pending expense claims', value: dash.pendingExpenses, note: 'Awaiting a decision', route: '/expenses' });

  const attention = [
    { key: 'approvals', icon: 'checklist', count: dash.approvalQueue || 0, label: 'Items in your approval queue', route: '/approvals' },
    { key: 'leave', icon: 'calendar', count: dash.pendingLeave || 0, label: 'Pending leave requests in scope', route: '/leave' },
    { key: 'clockin', icon: 'clock', count: dash.notClockedIn || 0, label: 'People not yet clocked in today', route: '/attendance' }
  ].filter((a) => a.count > 0);

  const sortedDepartments = [...dash.departments].sort((a, b) => b.rate - a.rate);

  return (
    <div>
      <div className="dashboard-greeting">
        <div className="eyebrow">{fmtToday()}</div>
        <h2 className="dashboard-greeting-title">{greeting()}{firstName ? ', ' + firstName : ''}.</h2>
      </div>

      {dash.latestAnnouncement && (
        <button type="button" className="dashboard-announcement" onClick={() => navigate('/announcements')}>
          <span className="dashboard-announcement-icon"><Icon name="megaphone" /></span>
          <span className="dashboard-announcement-text"><strong>Latest announcement</strong> — {dash.latestAnnouncement}</span>
          <span className="dashboard-announcement-arrow"><Icon name="chevron" /></span>
        </button>
      )}

      <div className="dashboard-kpis">
        {kpis.map((k) => (
          <button
            type="button"
            key={k.key}
            className={'dashboard-kpi dashboard-kpi-' + k.tone}
            onClick={() => navigate(k.route)}
          >
            <span className="dashboard-kpi-icon"><Icon name={k.icon} /></span>
            <span className="dashboard-kpi-arrow"><Icon name="chevron" /></span>
            <span className="dashboard-kpi-value">{k.value == null ? '—' : k.value}</span>
            <span className="dashboard-kpi-label">{k.label}</span>
            <span className="dashboard-kpi-note">{k.note}</span>
          </button>
        ))}
      </div>

      <div className="dashboard-columns">
        <section className="card dashboard-card">
          <h2 className="dashboard-section-title">Attendance by group — today</h2>
          <table className="table">
            <thead><tr><th>Group</th><th>Headcount</th><th>Clocked in</th><th style={{ width: 120 }}>Rate</th></tr></thead>
            <tbody>
              {sortedDepartments.map((row) => (
                <tr key={row.code}>
                  <td>{row.name}</td>
                  <td>{row.headcount}</td>
                  <td>{row.present}</td>
                  <td>
                    <div className="dashboard-rate-cell">
                      <div className="dashboard-rate-track">
                        <div
                          className={'dashboard-rate-bar' + (row.rate < 70 ? ' dashboard-rate-bar-low' : row.rate < 90 ? ' dashboard-rate-bar-mid' : '')}
                          style={{ width: row.rate + '%' }}
                        />
                      </div>
                      <span className="dashboard-rate-label">{row.rate}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!dash.departments.length && (
            <p className="dashboard-empty-note">No group attendance is visible to your role. Your own record is on My Space.</p>
          )}
        </section>

        <section className="card dashboard-card">
          <h2 className="dashboard-section-title">Needs your attention</h2>
          {attention.length ? (
            <div className="dashboard-attention">
              {attention.map((row) => (
                <button type="button" className="dashboard-attention-row" key={row.key} onClick={() => navigate(row.route)}>
                  <span className="dashboard-attention-icon"><Icon name={row.icon} /></span>
                  <span className="dashboard-attention-count">{row.count}</span>
                  <span className="dashboard-attention-label">{row.label}</span>
                  <span className="dashboard-attention-chevron"><Icon name="chevron" /></span>
                </button>
              ))}
            </div>
          ) : (
            <div className="dashboard-caughtup">
              <span className="dashboard-caughtup-icon"><Icon name="check" /></span>
              <span>You're all caught up.</span>
            </div>
          )}

          {dash.recentAudit.length > 0 && (
            <>
              <h2 className="dashboard-section-title dashboard-activity-title">Latest activity</h2>
              <div className="dashboard-activity">
                {dash.recentAudit.map((log) => (
                  <div className="dashboard-activity-item" key={log.id}>
                    <span className="dashboard-activity-dot" />
                    <div className="dashboard-activity-summary">{log.summary}</div>
                    <div className="dashboard-activity-meta">{(log.actorName || 'System') + ' · ' + timeAgo(log.at)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
