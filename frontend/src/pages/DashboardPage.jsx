import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import './DashboardPage.css';

// Ported from Bamboo OS.dc.html's dashboard screen (screens.dashboard
// block + the kpiDefs/deptStats/attention computed values around its
// render()). The prototype's dashboardFocus prop ('operations' vs
// 'executive') is a design-tool-only setting with no in-app control, so
// this always renders the full ('operations') KPI set — the superset the
// prototype falls back to.

function fmtLog(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ', ' + d.toTimeString().slice(0, 5);
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [dash, setDash] = useState(null);
  const [lateAfter, setLateAfter] = useState('08:15');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [dashData, settings] = await Promise.all([api.get('/dashboard'), api.get('/settings')]);
      setDash(dashData);
      if (settings.lateAfter) setLateAfter(settings.lateAfter);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const kpis = [
    { label: 'Headcount in scope', value: dash.headcount, note: 'Active employees you can see' },
    { label: 'Clocked in today', value: dash.presentToday, note: (dash.notClockedIn || 0) + ' still to clock in' },
    { label: 'Late today', value: dash.lateToday, note: 'After ' + lateAfter },
    { label: 'On approved leave', value: dash.onLeaveToday, note: 'Away today' },
    { label: 'Pending leave', value: dash.pendingLeave, note: 'Awaiting a decision' }
  ];
  if (dash.lowStockCount != null) kpis.push({ label: 'Low stock products', value: dash.lowStockCount, note: 'At or below reorder level' });
  if (dash.pendingProcurement != null) kpis.push({ label: 'Pending purchase requests', value: dash.pendingProcurement, note: 'Company-wide' });
  if (dash.assetsDueService != null) kpis.push({ label: 'Assets due service', value: dash.assetsDueService, note: 'Within 7 days' });
  if (dash.outstandingInvoices != null) kpis.push({ label: 'Outstanding invoices', value: 'GHS ' + dash.outstandingInvoices.toLocaleString(), note: 'Unpaid balance' });
  if (dash.pendingExpenses != null) kpis.push({ label: 'Pending expense claims', value: dash.pendingExpenses, note: 'Awaiting a decision' });

  const attention = [
    { count: dash.approvalQueue || 0, label: 'Items in your approval queue', go: () => navigate('/approvals') },
    { count: dash.pendingLeave || 0, label: 'Pending leave requests in scope', go: () => navigate('/leave') },
    { count: dash.notClockedIn || 0, label: 'People not yet clocked in today', go: () => navigate('/attendance') }
  ];

  return (
    <div>
      <div className="dashboard-kpis">
        {kpis.map((k) => (
          <div className="dashboard-kpi" key={k.label}>
            <div className="dashboard-kpi-label">{k.label}</div>
            <div className="dashboard-kpi-value">{k.value == null ? '—' : k.value}</div>
            <div className="dashboard-kpi-note">{k.note}</div>
          </div>
        ))}
      </div>

      <div className="dashboard-columns">
        <section>
          <h2 className="dashboard-section-title">Attendance by group — today</h2>
          <table className="table">
            <thead><tr><th>Group</th><th>Headcount</th><th>Clocked in</th><th style={{ width: 120 }}>Rate</th></tr></thead>
            <tbody>
              {dash.departments.map((row) => (
                <tr key={row.code}>
                  <td>{row.name}</td>
                  <td>{row.headcount}</td>
                  <td>{row.present}</td>
                  <td>
                    <div className="dashboard-rate-cell">
                      <div className="dashboard-rate-track"><div className="dashboard-rate-bar" style={{ width: row.rate + '%' }} /></div>
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

        <section>
          <h2 className="dashboard-section-title">Needs your attention</h2>
          <div className="dashboard-attention">
            {attention.map((row) => (
              <button type="button" className="dashboard-attention-row" key={row.label} onClick={row.go}>
                <span className="dashboard-attention-count">{row.count}</span>
                <span className="dashboard-attention-label">{row.label}</span>
              </button>
            ))}
          </div>

          {dash.recentAudit.length > 0 && (
            <>
              <h2 className="dashboard-section-title dashboard-activity-title">Latest activity</h2>
              <div className="dashboard-activity">
                {dash.recentAudit.map((log) => (
                  <div className="dashboard-activity-item" key={log.id}>
                    <div>{log.summary}</div>
                    <div className="dashboard-activity-meta">{(log.actorName || 'System') + ' · ' + fmtLog(log.at)}</div>
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
