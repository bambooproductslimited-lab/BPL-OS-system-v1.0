import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import DateRangePicker from '../components/DateRangePicker';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
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

// Only employees with at least one actual attendance record in the range
// show up here — same "report what's really there, don't invent absence
// rows for a period with nothing recorded" rule as /attendance/report
// itself (see attendance.service.js). Called out in the UI with a caption
// rather than left as a silent gap.
function aggregateByEmployee(rows) {
  const byEmp = {};
  rows.forEach((r) => {
    if (!byEmp[r.employeeId]) {
      byEmp[r.employeeId] = { employeeId: r.employeeId, name: r.name, code: r.code, department: r.department, present: 0, late: 0, absent: 0, leave: 0, off: 0, total: 0 };
    }
    const e = byEmp[r.employeeId];
    if (e[r.status] !== undefined) e[r.status]++;
    e.total++;
  });
  return Object.values(byEmp).sort((a, b) => a.name.localeCompare(b.name));
}

const CORRECTION_STATUSES = ['present', 'late', 'absent', 'leave', 'off'];

export default function AttendancePage() {
  const { can } = useAuth();
  const canAdjust = can('attendance.adjust');

  const [dateRange, setDateRange] = useState({ from: todayISO(), to: todayISO(), presetKey: 'today', label: 'Today' });
  const isSingleDay = dateRange.from === dateRange.to;
  const [data, setData] = useState({ rows: [], scopeSize: 0 });
  const [periodRows, setPeriodRows] = useState([]); // aggregated per-employee counts, used when the range spans more than one day
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
  const [statusFilter, setStatusFilter] = useState('');

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncRange, setSyncRange] = useState({ startDate: daysAgoISO(7), endDate: todayISO() });
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncCommitting, setSyncCommitting] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null); // { done, total } while committing in batches

  const [reportOpen, setReportOpen] = useState(false);
  const [reportRange, setReportRange] = useState({ from: daysAgoISO(29), to: todayISO(), presetKey: 'last30', label: 'Last 30 days' });
  const [reportData, setReportData] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState(null);
  const reportPrintRef = useRef(null);

  // A single day keeps the exact roster this screen always had (one row per
  // employee, editable). A wider range (a week/month/year picked via the
  // range control below) switches to a per-employee period summary instead
  // — one roster row per employee doesn't mean anything once "the day" is
  // several days, so this reuses the same /attendance/report endpoint the
  // "Download report" dialog already calls, just aggregated into counts.
  const load = useCallback(async () => {
    setError(null);
    try {
      if (isSingleDay) {
        const res = await api.get('/attendance?date=' + dateRange.from);
        setData(res);
      } else {
        const res = await api.get('/attendance/report?from=' + dateRange.from + '&to=' + dateRange.to);
        setPeriodRows(aggregateByEmployee(res.rows));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [dateRange, isSingleDay]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = data.rows || [];
  const visibleRows = rows
    .filter((r) => matchesQuery(search, r.name, r.code, r.department))
    .filter((r) => !statusFilter || r.status === statusFilter);
  const summary = [
    { label: 'In scope', value: rows.length },
    { label: 'Present', value: rows.filter((r) => r.status === 'present').length },
    { label: 'Late', value: rows.filter((r) => r.status === 'late').length },
    { label: 'No record', value: rows.filter((r) => r.status === 'absent').length }
  ];

  const visiblePeriodRows = periodRows
    .filter((r) => matchesQuery(search, r.name, r.code, r.department))
    .filter((r) => !statusFilter || r[statusFilter] > 0);
  const periodSummary = [
    { label: 'Employees with records', value: periodRows.length },
    { label: 'Present days', value: periodRows.reduce((sum, r) => sum + r.present, 0) },
    { label: 'Late days', value: periodRows.reduce((sum, r) => sum + r.late, 0) },
    { label: 'Absent/leave/off days', value: periodRows.reduce((sum, r) => sum + r.absent + r.leave + r.off, 0) }
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
        id: correction.id || undefined, employeeId: correction.employeeId, date: dateRange.from,
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

  // Committed in batches rather than one request — a full-history sync can
  // run into tens of thousands of rows, which is both too large a JSON
  // body for one POST and too slow to write in a single request before
  // something (the browser, a proxy, the server) times out. Each batch is
  // independent, so a failure partway through still leaves everything up
  // to that point written, and the counts below reflect exactly what made
  // it in rather than an all-or-nothing outcome.
  const COMMIT_BATCH_SIZE = 500;

  async function commitAttendanceSync() {
    setSyncCommitting(true);
    setSyncError(null);
    const rows = syncPreview.rows;
    const totals = { created: 0, updated: 0, unchanged: 0, failed: [] };
    setSyncProgress({ done: 0, total: rows.length });
    try {
      for (let i = 0; i < rows.length; i += COMMIT_BATCH_SIZE) {
        const batch = rows.slice(i, i + COMMIT_BATCH_SIZE);
        const result = await api.post('/timestation/attendance/commit', { rows: batch });
        totals.created += result.created;
        totals.updated += result.updated;
        totals.unchanged += result.unchanged;
        totals.failed = totals.failed.concat(result.failed);
        setSyncProgress({ done: Math.min(i + COMMIT_BATCH_SIZE, rows.length), total: rows.length });
      }
      setSyncResult(totals);
      setToast('Synced attendance from TimeStation.');
      await load();
    } catch (err) {
      setSyncError(err.message + ' (' + totals.created + ' created, ' + totals.updated + ' updated so far — already written, not lost)');
      setSyncResult(totals);
    } finally {
      setSyncCommitting(false);
      setSyncProgress(null);
    }
  }

  function openReport() {
    setReportError(null);
    setReportData(null);
    setReportOpen(true);
  }

  async function runReport() {
    setReportLoading(true);
    setReportError(null);
    setReportData(null);
    try {
      setReportData(await api.get('/attendance/report?from=' + reportRange.from + '&to=' + reportRange.to));
    } catch (err) {
      setReportError(err.message);
    } finally {
      setReportLoading(false);
    }
  }

  function summarizeReport(rows) {
    const counts = { present: 0, late: 0, absent: 0, leave: 0, off: 0 };
    rows.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status]++; });
    return counts;
  }

  function downloadReportCsv() {
    if (!reportData) return;
    const counts = summarizeReport(reportData.rows);
    const rows = [
      ['Attendance report', reportRange.from + ' to ' + reportRange.to],
      [],
      ['Status', 'Count'],
      ['Present', counts.present], ['Late', counts.late], ['Absent', counts.absent], ['Leave', counts.leave], ['Off', counts.off],
      ['Total records', reportData.rows.length],
      [],
      ['Date', 'Employee', 'Code', 'Group', 'Clock in', 'Clock out', 'Status', 'Source', 'Note'],
      ...reportData.rows.map((r) => [r.date, r.name, r.code, r.department, r.clockIn || '', r.clockOut || '', r.status, r.source, r.note || ''])
    ];
    downloadCsv('attendance-report-' + reportRange.from + '-to-' + reportRange.to + '.csv', rowsToCsv(rows));
  }

  async function downloadReportPdf() {
    setReportError(null);
    try {
      const filename = 'attendance-report-' + reportRange.from + '-to-' + reportRange.to + '.pdf';
      await shareOrDownloadPdf(reportPrintRef.current, filename, filename, filename);
    } catch (err) {
      setReportError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="attendance-toolbar">
        <div className="field attendance-date">
          <label>Period</label>
          <DateRangePicker value={dateRange} onChange={setDateRange} />
        </div>
        {canAdjust && <button type="button" className="btn btn-secondary" onClick={openSync}>Sync from TimeStation</button>}
        <button type="button" className="btn btn-secondary" onClick={openReport}>Download report</button>
        <div className="attendance-summary">
          {(isSingleDay ? summary : periodSummary).map((s) => (
            <div key={s.label}>
              <div className="attendance-summary-label">{s.label}</div>
              <div className="attendance-summary-value">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, group…" />
        <select className="input" style={{ maxWidth: 200 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="present">Present</option>
          <option value="late">Late</option>
          <option value="absent">Absent</option>
          <option value="leave">Leave</option>
          <option value="off">Off</option>
        </select>
      </div>

      {!isSingleDay && (
        <p className="eyebrow" style={{ marginTop: 12 }}>
          {fmtDate(dateRange.from)} – {fmtDate(dateRange.to)}, per-employee totals. Only employees with at least one
          attendance record in this range are listed — pick a single day above to see and correct individual records.
        </p>
      )}

      {isSingleDay ? (
        <>
          <table className="table" style={{ marginTop: 16 }}>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Group</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Note</th><th /></tr>
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
          {!!rows.length && !visibleRows.length && (
            <p className="table-empty">
              No one matches{search ? ' "' + search + '"' : ''}{statusFilter ? (search ? ' and ' : ' ') + 'status "' + statusFilter + '"' : ''}.
            </p>
          )}
        </>
      ) : (
        <>
          <table className="table" style={{ marginTop: 16 }}>
            <thead>
              <tr><th>Code</th><th>Name</th><th>Group</th><th>Present</th><th>Late</th><th>Absent</th><th>Leave</th><th>Off</th><th>Total</th></tr>
            </thead>
            <tbody>
              {visiblePeriodRows.map((r) => (
                <tr key={r.employeeId}>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.code}</td>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>{r.department}</td>
                  <td>{r.present}</td>
                  <td>{r.late}</td>
                  <td>{r.absent}</td>
                  <td>{r.leave}</td>
                  <td>{r.off}</td>
                  <td style={{ fontWeight: 600 }}>{r.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!periodRows.length && <p className="table-empty">No attendance records in this range.</p>}
          {!!periodRows.length && !visiblePeriodRows.length && (
            <p className="table-empty">
              No one matches{search ? ' "' + search + '"' : ''}{statusFilter ? (search ? ' and ' : ' ') + 'status "' + statusFilter + '"' : ''}.
            </p>
          )}
        </>
      )}

      {correction && (
        <div className="dialog-backdrop" onClick={() => setCorrection(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmCorrection}>
            <h2>Correct attendance</h2>
            <p className="dialog-body">{correction.name} · {fmtDate(dateRange.from)}</p>
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
            <p className="dialog-body">Delete the record for <strong>{deleteTarget.name}</strong> ({fmtDate(dateRange.from)})? This cannot be undone.</p>
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
                <button
                  type="button" className="btn btn-secondary" style={{ fontSize: 12 }}
                  onClick={() => setSyncRange({ startDate: daysAgoISO(15 * 365), endDate: todayISO() })}
                >
                  Use full history (last 15 years)
                </button>
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
                  {syncProgress && (
                    <p className="eyebrow">Syncing {syncProgress.done.toLocaleString()} of {syncProgress.total.toLocaleString()}…</p>
                  )}
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" disabled={syncCommitting} onClick={() => setSyncPreview(null)}>Back</button>
                    <button type="button" className="btn btn-secondary" disabled={syncCommitting} onClick={() => setSyncOpen(false)}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={syncCommitting || !toWrite.length} onClick={commitAttendanceSync}>
                      {syncCommitting ? 'Syncing…' : 'Sync ' + toWrite.length + ' record(s)'}
                    </button>
                  </div>
                </>
              );
            })()}

            {syncResult && (
              <>
                {syncError && <div className="error-banner">{syncError}</div>}
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

      {reportOpen && (() => {
        const DETAIL_ROW_CAP = 2000; // beyond this, rendering every row into the DOM (for the on-screen table and PDF screenshot) gets slow — CSV export still covers the full list either way, since that's built as a plain string, not DOM
        const counts = reportData ? summarizeReport(reportData.rows) : null;
        const showDetailTable = reportData && reportData.rows.length <= DETAIL_ROW_CAP;
        return (
          <div className="dialog-backdrop" onClick={() => setReportOpen(false)}>
            <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
              <h2 className="employees-dialog-title">Attendance report</h2>
              <p className="dialog-body">
                Every attendance record in the date range below, scoped to what you can already see on this page —
                everyone if you have company-wide access, otherwise just your own record.
              </p>
              <div className="field">
                <label>Period</label>
                <DateRangePicker value={reportRange} onChange={setReportRange} />
              </div>
              {reportError && <div className="error-banner">{reportError}</div>}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setReportOpen(false)}>Close</button>
                <button type="button" className="btn btn-primary" disabled={reportLoading} onClick={runReport}>
                  {reportLoading ? 'Running…' : 'Run report'}
                </button>
              </div>

              {reportData && (
                <>
                  <div ref={reportPrintRef}>
                    <p className="itdevices-import-summary">
                      {reportRange.from} to {reportRange.to} — {reportData.rows.length.toLocaleString()} record(s):
                      {' '}{counts.present} present, {counts.late} late, {counts.absent} absent, {counts.leave} leave, {counts.off} off.
                    </p>
                    {!showDetailTable && (
                      <p className="itdevices-import-summary">
                        Too many records ({reportData.rows.length.toLocaleString()}) to list on screen — download the CSV for the full detail.
                      </p>
                    )}
                    {showDetailTable && (
                      <div className="itdevices-import-scroll">
                        <table className="table itdevices-import-table">
                          <thead>
                            <tr><th>Date</th><th>Employee</th><th>Code</th><th>Group</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Source</th></tr>
                          </thead>
                          <tbody>
                            {reportData.rows.map((r, i) => (
                              <tr key={i}>
                                <td>{r.date}</td>
                                <td style={{ fontWeight: 600 }}>{r.name}</td>
                                <td>{r.code}</td>
                                <td>{r.department}</td>
                                <td>{r.clockIn || '—'}</td>
                                <td>{r.clockOut || '—'}</td>
                                <td><span className={'tag ' + tagClass(r.status)}>{r.status}</span></td>
                                <td>{r.source}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {!reportData.rows.length && <p className="table-empty">No attendance records in this range.</p>}
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" onClick={downloadReportCsv}>Download CSV</button>
                    <button type="button" className="btn btn-secondary" onClick={downloadReportPdf}>Download PDF</button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
