import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './AttendancePage.css';

// Ported from Bamboo OS.dc.html's attendance screen (screens.attendance
// block + the attendance/attSummary computed values around its render()).
// Clock in/out lives on the "My space" screen, not here — this screen is
// the manager/HR roster view for a given day.

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
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

  const [search, setSearch] = useState('');

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncRange, setSyncRange] = useState({ startDate: daysAgoISO(7), endDate: todayISO() });
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncCommitting, setSyncCommitting] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

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
  const visibleRows = rows.filter((r) => matchesQuery(search, r.name, r.code, r.department));
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

  function openSync() {
    setSyncError(null);
    setSyncPreview(null);
    setSyncResult(null);
    setSyncOpen(true);
  }

  async function runSyncPreview() {
    setSyncLoading(true);
    setSyncError(null);
    setSyncPreview(null);
    try {
      setSyncPreview(await api.get('/timestation/attendance/preview?startDate=' + syncRange.startDate + '&endDate=' + syncRange.endDate));
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncLoading(false);
    }
  }

  async function commitAttendanceSync() {
    setSyncCommitting(true);
    setSyncError(null);
    try {
      const result = await api.post('/timestation/attendance/commit', { rows: syncPreview.rows });
      setSyncResult(result);
      setToast('Synced attendance from TimeStation.');
      await load();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncCommitting(false);
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
        {canAdjust && <button type="button" className="btn btn-secondary" onClick={openSync}>Sync from TimeStation</button>}
        <div className="attendance-summary">
          {summary.map((s) => (
            <div key={s.label}>
              <div className="attendance-summary-label">{s.label}</div>
              <div className="attendance-summary-value">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, department…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Code</th><th>Name</th><th>Department</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Note</th><th /></tr>
        </thead>
        <tbody>
          {visibleRows.map((r) => (
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
      {!!rows.length && !visibleRows.length && <p className="table-empty">No one matches "{search}".</p>}

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

      {syncOpen && (
        <div className="dialog-backdrop" onClick={() => setSyncOpen(false)}>
          <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="employees-dialog-title">Sync attendance from TimeStation</h2>
            <p className="dialog-body">
              Pulls clock in/out shifts for every employee linked to TimeStation (set via "Sync from TimeStation" on
              the Employees page) over the date range below. TimeStation wins for anyone it covers — this replaces any
              existing attendance record for those dates, including manual corrections. Employees not linked to
              TimeStation are untouched.
            </p>

            {!syncPreview && !syncResult && (
              <>
                <div className="attendance-correction-grid">
                  <div className="field">
                    <label htmlFor="sync-start">Start date</label>
                    <input id="sync-start" className="input" type="date" value={syncRange.startDate} onChange={(e) => setSyncRange({ ...syncRange, startDate: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="sync-end">End date</label>
                    <input id="sync-end" className="input" type="date" value={syncRange.endDate} onChange={(e) => setSyncRange({ ...syncRange, endDate: e.target.value })} />
                  </div>
                </div>
                {syncError && <div className="error-banner">{syncError}</div>}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSyncOpen(false)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={syncLoading} onClick={runSyncPreview}>
                    {syncLoading ? 'Fetching from TimeStation…' : 'Preview'}
                  </button>
                </div>
              </>
            )}

            {syncPreview && !syncResult && (() => {
              const toWrite = syncPreview.rows.filter((r) => r.action !== 'skip' && r.action !== 'unchanged');
              return (
                <>
                  {syncError && <div className="error-banner">{syncError}</div>}
                  <p className="itdevices-import-summary">
                    {syncPreview.rows.length} record(s) found —
                    {' '}{syncPreview.rows.filter((r) => r.action === 'create').length} new,
                    {' '}{syncPreview.rows.filter((r) => r.action === 'update' || r.action === 'overwrite').length} will be updated,
                    {' '}{syncPreview.rows.filter((r) => r.action === 'unchanged').length} unchanged,
                    {' '}{syncPreview.rows.filter((r) => r.action === 'skip').length} skipped.
                  </p>
                  <div className="itdevices-import-scroll">
                    <table className="table itdevices-import-table">
                      <thead>
                        <tr><th>Employee</th><th>Date</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Action</th><th>Notes</th></tr>
                      </thead>
                      <tbody>
                        {syncPreview.rows.map((r, i) => (
                          <tr key={i} className={r.action === 'unchanged' || r.action === 'skip' ? 'itdevices-import-row-skip' : ''}>
                            <td style={{ fontWeight: 600 }}>{r.employeeName}</td>
                            <td>{r.date || '—'}</td>
                            <td>{r.clockIn || '—'}</td>
                            <td>{r.clockOut || '—'}</td>
                            <td>{r.status || '—'}</td>
                            <td style={{ textTransform: 'capitalize' }}>{r.action}</td>
                            <td className="itdevices-import-warnings">
                              {(r.warnings || []).map((w, wi) => <div key={wi}>{w}</div>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setSyncPreview(null)}>Back</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setSyncOpen(false)}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={syncCommitting || !toWrite.length} onClick={commitAttendanceSync}>
                      {syncCommitting ? 'Syncing…' : 'Sync ' + toWrite.length + ' record(s)'}
                    </button>
                  </div>
                </>
              );
            })()}

            {syncResult && (
              <>
                <p className="itdevices-import-summary">
                  {syncResult.created} created, {syncResult.updated} updated, {syncResult.unchanged} unchanged
                  {syncResult.failed.length ? ', ' + syncResult.failed.length + ' failed' : ''}.
                </p>
                {syncResult.failed.length > 0 && (
                  <ul>
                    {syncResult.failed.map((f, i) => <li key={i}>{f.name} ({f.date}) — {f.reason}</li>)}
                  </ul>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setSyncOpen(false)}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
