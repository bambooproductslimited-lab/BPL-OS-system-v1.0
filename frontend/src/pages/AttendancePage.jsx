import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './AttendancePage.css';

// Ported from Bamboo OS.dc.html's attendance screen (screens.attendance
// block + the attendance/attSummary computed values around its render()).
// Clock in/out lives on the "My space" screen, not here — this screen is
// the manager/HR roster view for a given day.

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Ported from kernel.js's UI helper tag(status).
function tagClass(status) {
  if (['approved', 'present', 'active', 'completed'].includes(status)) return 'tag-neutral';
  if (['pending', 'late', 'in_progress', 'under_review', 'waiting', 'not_started', 'planning'].includes(status)) return 'tag-outline';
  if (['rejected', 'absent', 'disabled', 'cancelled', 'on_hold', 'delayed'].includes(status)) return 'tag-accent';
  return 'tag-neutral';
}

// Ported from Bamboo OS.dc.html's fmtDate().
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const CORRECTION_STATUSES = ['present', 'late', 'absent', 'leave', 'off'];

export default function AttendancePage() {
  const { can } = useAuth();
  const canAdjust = can('attendance.adjust');

  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState({ rows: [], scopeSize: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [correction, setCorrection] = useState(null);
  const [corrForm, setCorrForm] = useState({ clockIn: '', clockOut: '', status: 'present', note: '' });
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get('/attendance?date=' + date);
      setData(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = data.rows || [];
  const summary = [
    { label: 'In scope', value: rows.length },
    { label: 'Present', value: rows.filter((r) => r.status === 'present').length },
    { label: 'Late', value: rows.filter((r) => r.status === 'late').length },
    { label: 'No record', value: rows.filter((r) => r.status === 'absent').length }
  ];

  function openCorrection(row) {
    setDialogError(null);
    setCorrection(row);
    setCorrForm({
      clockIn: row.clockIn || '', clockOut: row.clockOut || '',
      status: row.status === 'absent' ? 'present' : row.status, note: ''
    });
  }

  async function confirmCorrection(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/attendance/adjust', {
        id: correction.id || undefined, employeeId: correction.employeeId, date,
        clockIn: corrForm.clockIn, clockOut: corrForm.clockOut, status: corrForm.status, note: corrForm.note
      });
      setToast('Attendance corrected and logged.');
      setCorrection(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/attendance/' + deleteTarget.id);
      setToast('Attendance record deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="attendance-toolbar">
        <div className="field attendance-date">
          <label htmlFor="att-date">Date</label>
          <input id="att-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="attendance-summary">
          {summary.map((s) => (
            <div key={s.label}>
              <div className="attendance-summary-label">{s.label}</div>
              <div className="attendance-summary-value">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      <table className="table">
        <thead>
          <tr><th>Code</th><th>Name</th><th>Department</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Note</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.employeeId}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.code}</td>
              <td style={{ fontWeight: 600 }}>{r.name}</td>
              <td>{r.department}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.clockIn || '—'}</td>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.clockOut || '—'}</td>
              <td><span className={'tag ' + tagClass(r.status)}>{r.status}</span></td>
              <td className="attendance-note">{r.note || '—'}</td>
              <td className="table-actions">
                {canAdjust && <button type="button" className="btn btn-secondary attendance-row-btn" onClick={() => openCorrection(r)}>Correct</button>}
                {canAdjust && r.id && (
                  <button type="button" className="btn btn-secondary attendance-row-btn" onClick={() => setDeleteTarget(r)}>Delete</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="table-empty">No employees in scope for this date.</p>}

      {correction && (
        <div className="dialog-backdrop" onClick={() => setCorrection(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmCorrection}>
            <h2>Correct attendance</h2>
            <p className="dialog-body">{correction.name} · {fmtDate(date)}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="attendance-correction-grid">
              <div className="field">
                <label htmlFor="corr-in">Clock in</label>
                <input id="corr-in" className="input" value={corrForm.clockIn} onChange={(e) => setCorrForm({ ...corrForm, clockIn: e.target.value })} placeholder="07:55" />
              </div>
              <div className="field">
                <label htmlFor="corr-out">Clock out</label>
                <input id="corr-out" className="input" value={corrForm.clockOut} onChange={(e) => setCorrForm({ ...corrForm, clockOut: e.target.value })} placeholder="17:00" />
              </div>
              <div className="field">
                <label htmlFor="corr-status">Status</label>
                <select id="corr-status" className="input" value={corrForm.status} onChange={(e) => setCorrForm({ ...corrForm, status: e.target.value })}>
                  {CORRECTION_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="corr-note">Reason for the correction</label>
              <input id="corr-note" className="input" value={corrForm.note} onChange={(e) => setCorrForm({ ...corrForm, note: e.target.value })} placeholder="Required — written to the audit log." required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCorrection(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save correction'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete attendance record</h2>
            <p className="dialog-body">Delete the record for <strong>{deleteTarget.name}</strong> ({fmtDate(date)})? This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
