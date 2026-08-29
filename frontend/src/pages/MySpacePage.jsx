import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './MySpacePage.css';

// Ported from Bamboo OS.dc.html's "My space" screen (screens.myspace block
// + the myAttendance/myBalances/myLeave computed values around its
// render()). Self-service only: your own clock in/out, your leave
// balances, and your own leave requests with self-service cancel.
//
// Redesigned to match the icon/card language established for Dashboard/
// Messages/Login/Kiosk: a live clock + on-duty status pill on the clock
// card, leave balances as small progress cards instead of a plain table,
// and an icon'd empty state. No backend changes — /me/summary already
// returns everything this page shows.

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

function fmtElapsed(hhmm, now) {
  const [h, m] = hhmm.split(':').map(Number);
  const start = new Date(now);
  start.setHours(h, m, 0, 0);
  const diffMs = Math.max(0, now.getTime() - start.getTime());
  const hours = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);
  return hours + 'h ' + mins + 'm';
}

const ICON_PATHS = {
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  exit: <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 12H9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><path d="M16 8l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  calendarCheck: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M9 15l2 2 4-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function MySpacePage() {
  const { session, can } = useAuth();
  const navigate = useNavigate();
  const shift = (session && session.employee && session.employee.shift) || 'Day · 08:00–17:00';
  const now = useClock();

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
  const onDuty = !!(att && !att.clockOut);
  const attendance = {
    headline: att ? (att.clockOut ? att.clockIn + ' → ' + att.clockOut : 'On duty since ' + att.clockIn) : 'Not clocked in',
    detail: att ? (att.status === 'late' ? 'Recorded as late.' : 'Recorded as present.') : 'Clock in to start today’s record.',
    inDisabled: !!att || !canSelf,
    outDisabled: !att || !!(att && att.clockOut) || !canSelf
  };
  const statusLabel = onDuty ? 'On duty' : att ? 'Shift complete' : 'Not clocked in';

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
          <div className="myspace-clock-head">
            <div className="myspace-eyebrow">Today · {shift}</div>
            <div className={'myspace-status-pill' + (onDuty ? ' myspace-status-pill-on' : '')}>
              <span className="myspace-status-dot" />
              {statusLabel}
            </div>
          </div>
          <div className="myspace-live-time">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
          <div className="myspace-headline">{attendance.headline}</div>
          <div className="myspace-detail">
            {attendance.detail}
            {onDuty && att && ' · ' + fmtElapsed(att.clockIn, now) + ' so far'}
          </div>
          <div className="myspace-actions">
            <button type="button" className="btn btn-primary" disabled={attendance.inDisabled || clocking} onClick={handleClockIn}>
              <Icon name="checkCircle" /> Clock in
            </button>
            <button type="button" className="btn btn-secondary" disabled={attendance.outDisabled || clocking} onClick={handleClockOut}>
              <Icon name="exit" /> Clock out
            </button>
          </div>
        </section>

        <section>
          <h2 className="myspace-section-title">Leave balances · {new Date().getFullYear()}</h2>
          <div className="myspace-balance-grid">
            {balances.map((b) => {
              const pct = b.entitled > 0 ? Math.min(100, Math.round((b.used / b.entitled) * 100)) : 0;
              return (
                <div className="myspace-balance-card" key={b.name}>
                  <span className="myspace-balance-icon"><Icon name="calendar" /></span>
                  <div className="myspace-balance-name">{b.name}</div>
                  <div className="myspace-balance-remaining">{b.left}<span className="myspace-balance-unit"> / {b.entitled} left</span></div>
                  <div className="myspace-balance-track"><div className="myspace-balance-bar" style={{ width: pct + '%' }} /></div>
                  <div className="myspace-balance-used">{b.used} used</div>
                </div>
              );
            })}
          </div>
          {!balances.length && <p className="table-empty">No leave balances set up yet.</p>}
        </section>
      </div>

      <section>
        <h2 className="myspace-section-title">My leave requests</h2>
        {myLeave.length ? (
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
        ) : (
          <div className="myspace-empty-state">
            <span className="myspace-empty-icon"><Icon name="calendarCheck" /></span>
            <p className="myspace-empty-title">No leave requests yet</p>
            <p className="myspace-empty-sub">Planning time off? Submit a request from Leave.</p>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/leave')}>Go to Leave</button>
          </div>
        )}
      </section>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
