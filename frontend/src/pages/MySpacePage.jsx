import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './MySpacePage.css';

// Ported from Bamboo OS.dc.html's "My space" screen (screens.myspace block
// + the myAttendance/myBalances/myLeave computed values around its
// render()). Self-service only: your own clock in/out, your leave
// balances, and your own leave requests with self-service cancel.

function tagClass(status) {
  if (['approved', 'present', 'active', 'completed'].includes(status)) return 'tag-neutral';
  if (['pending', 'late', 'in_progress', 'under_review', 'waiting', 'not_started', 'planning'].includes(status)) return 'tag-outline';
  if (['rejected', 'absent', 'disabled', 'cancelled', 'on_hold', 'delayed'].includes(status)) return 'tag-accent';
  return 'tag-neutral';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function MySpacePage() {
  const { session, can } = useAuth();
  const shift = (session && session.employee && session.employee.shift) || 'Day · 08:00–17:00';

  const [leaveTypes, setLeaveTypes] = useState([]);
  const [summary, setSummary] = useState({ todayAttendance: null, balances: [], myLeave: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [clocking, setClocking] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [types, me] = await Promise.all([api.get('/leave/types'), api.get('/me/summary')]);
      setLeaveTypes(types);
      setSummary(me);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const att = summary.todayAttendance;
  const canSelf = can('attendance.self');
  const attendance = {
    headline: att ? (att.clockOut ? att.clockIn + ' → ' + att.clockOut : 'On duty since ' + att.clockIn) : 'Not clocked in',
    detail: att ? (att.status === 'late' ? 'Recorded as late.' : 'Recorded as present.') : 'Clock in to start today’s record.',
    inDisabled: !!att || !canSelf,
    outDisabled: !att || !!(att && att.clockOut) || !canSelf
  };

  async function handleClockIn() {
    setClocking(true);
    setError(null);
    try {
      await api.post('/attendance/clock-in');
      setToast('Clocked in. Have a good shift.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClocking(false);
    }
  }

  async function handleClockOut() {
    setClocking(true);
    setError(null);
    try {
      await api.post('/attendance/clock-out');
      setToast('Clocked out. Your hours are recorded.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClocking(false);
    }
  }

  async function handleCancel(row) {
    try {
      await api.post('/leave/' + row.id + '/cancel');
      setToast('Request cancelled.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function typeName(id) {
    const t = leaveTypes.find((x) => x.id === id);
    return t ? t.name : '—';
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const myLeave = summary.myLeave || [];
  const balances = summary.balances || [];

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="myspace-top">
        <section className="card myspace-clock">
          <div className="myspace-eyebrow">Today · {shift}</div>
          <div className="myspace-headline">{attendance.headline}</div>
          <div className="myspace-detail">{attendance.detail}</div>
          <div className="myspace-actions">
            <button type="button" className="btn btn-primary" disabled={attendance.inDisabled || clocking} onClick={handleClockIn}>Clock in</button>
            <button type="button" className="btn btn-secondary" disabled={attendance.outDisabled || clocking} onClick={handleClockOut}>Clock out</button>
          </div>
        </section>

        <section>
          <h2 className="myspace-section-title">Leave balances · {new Date().getFullYear()}</h2>
          <table className="table">
            <thead><tr><th>Type</th><th>Entitled</th><th>Taken</th><th>Remaining</th></tr></thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.name}>
                  <td>{b.name}</td><td>{b.entitled}</td><td>{b.used}</td><td style={{ fontWeight: 600 }}>{b.left}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section>
        <h2 className="myspace-section-title">My leave requests</h2>
        <table className="table">
          <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Decision note</th><th /></tr></thead>
          <tbody>
            {myLeave.map((l) => (
              <tr key={l.id}>
                <td>{typeName(l.leaveTypeId)}</td>
                <td style={{ fontSize: 13 }}>{fmtDate(l.startDate)} → {fmtDate(l.endDate)}</td>
                <td>{l.days}</td>
                <td><span className={'tag ' + tagClass(l.status)}>{l.status}</span></td>
                <td className="myspace-note">{l.decisionNote || '—'}</td>
                <td className="table-actions">
                  {l.status === 'pending' && (
                    <button type="button" className="btn btn-secondary myspace-row-btn" onClick={() => handleCancel(l)}>Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!myLeave.length && <p className="table-empty">You have no leave requests. Open Leave to submit one.</p>}
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
