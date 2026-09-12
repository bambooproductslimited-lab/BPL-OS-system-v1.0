import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
//
// Redesigned around the roster/summary/toolbar view — icon summary tiles
// (matching Dashboard's KPI tiles), initials avatars on each row (matching
// Messages/Login/Employees), and an icon'd empty state. The TimeStation
// sync and report dialogs are left functionally and visually as-is: this
// page already carries a lot of write/batch logic, so reskinning the list
// view is the highest-value, lowest-risk change.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

const ICON_PATHS = {
  users: <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>,
  xCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  mapPin: <><path d="M12 21s7-6.4 7-11.5A7 7 0 0 0 5 9.5C5 14.6 12 21 12 21Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="12" cy="9.5" r="2.3" stroke="currentColor" strokeWidth="1.6" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

// Only ever set by a kiosk clock event (see kiosk.service.js) — the kiosk
// is a fixed device, so this is "where the kiosk is", not "where this
// employee was", but it's still useful as a record that the device itself
// hasn't moved. Opens the coordinates in Google Maps rather than trying to
// render an inline map for what's usually a single, rarely-checked lookup.
function LocationLink({ loc }) {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  const href = 'https://maps.google.com/?q=' + loc.lat + ',' + loc.lng;
  const title = loc.lat.toFixed(5) + ', ' + loc.lng.toFixed(5) + (loc.accuracy ? ' (±' + Math.round(loc.accuracy) + 'm)' : '');
  return (
    <a href={href} target="_blank" rel="noreferrer" className="attendance-location-link" title={title} onClick={(e) => e.stopPropagation()}>
      <Icon name="mapPin" />
    </a>
  );
}

function EmptyState({ title, sub }) {
  return (
    <div className="attendance-empty-state">
      <span className="attendance-empty-icon"><Icon name="calendar" /></span>
      <p className="attendance-empty-title">{title}</p>
      {sub && <p className="attendance-empty-sub">{sub}</p>}
    </div>
  );
}

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

// One row per scoped employee, counting a status across every calendar
// day in the range — /attendance/report itself now returns a row per
// employee per day (a day with no clock-in record comes back as 'absent',
// same rule the single-day roster already used), so present+late+absent+
// leave+off always sums to the full number of days in the filtered range.
function aggregateByEmployee(rows) {
  const byEmp = {};
  rows.forEach((r) => {
    if (!byEmp[r.employeeId]) {
      byEmp[r.employeeId] = { employeeId: r.employeeId, name: r.name, code: r.code, department: r.department, company: r.company, present: 0, late: 0, absent: 0, leave: 0, off: 0, total: 0 };
    }
    const e = byEmp[r.employeeId];
    if (e[r.status] !== undefined) e[r.status]++;
    e.total++;
  });
  return Object.values(byEmp).sort((a, b) => a.name.localeCompare(b.name));
}

// Wide, TimeStation-style layout for the downloadable report — one row per
// employee, one column per calendar day in the range, hours computed from
// clock in/out (matching the shape of an actual TimeStation export, which
// this was built to mirror). hourlyRate/totalPay stay null when the field
// isn't on the API payload at all (payroll.manage-gated server-side, see
// attendance.service.js's report()) or isn't set for that employee — the
// CSV/PDF render those as blank rather than 0, so "no rate on file" reads
// differently from "genuinely zero pay."
function hoursBetween(clockIn, clockOut) {
  if (!clockIn || !clockOut) return 0;
  const [inH, inM] = clockIn.split(':').map(Number);
  const [outH, outM] = clockOut.split(':').map(Number);
  let mins = (outH * 60 + outM) - (inH * 60 + inM);
  if (mins < 0) mins += 24 * 60; // crossed midnight
  return Math.round((mins / 60) * 10) / 10;
}

function enumerateDates(from, to) {
  const dates = [];
  let d = new Date(from + 'T00:00');
  const end = new Date(to + 'T00:00');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return dates;
}

function dayHeader(iso) {
  const d = new Date(iso + 'T00:00');
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'short' });
  return weekday + ' ' + iso.slice(5, 7) + '/' + iso.slice(8, 10);
}

function buildPivotReport(rows, from, to) {
  const dates = enumerateDates(from, to);
  const byEmp = {};
  rows.forEach((r) => {
    if (!byEmp[r.employeeId]) {
      byEmp[r.employeeId] = {
        employeeId: r.employeeId, code: r.code, positionTitle: r.positionTitle || '', name: r.name, department: r.department,
        hourlyRate: r.hourlyRate != null ? r.hourlyRate : null, byDate: {}
      };
    }
    const e = byEmp[r.employeeId];
    e.byDate[r.date] = (e.byDate[r.date] || 0) + hoursBetween(r.clockIn, r.clockOut);
  });
  const empRows = Object.values(byEmp).map((e) => {
    const totalHours = Math.round(dates.reduce((sum, d) => sum + (e.byDate[d] || 0), 0) * 10) / 10;
    const totalPay = e.hourlyRate != null ? Math.round(totalHours * e.hourlyRate * 100) / 100 : null;
    return { ...e, totalHours, totalPay };
  });
  empRows.sort((a, b) => a.name.localeCompare(b.name));
  return { dates, rows: empRows };
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
  const [departments, setDepartments] = useState([]);
  const [companyFilter, setCompanyFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

  // Departments already carry companyId/companyName (departments.service.js#list)
  // so the company filter and its department cascade are both derived from
  // one fetch, same pattern as EmployeesPage.jsx.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);

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
  // Own Company/Department pickers, decoupled from the page's own filters
  // above (defaulted from them on open, purely for convenience) — so
  // downloading, say, just Bamboo Garden's report doesn't require first
  // changing what the live roster on this page is filtered to.
  const [reportCompanyId, setReportCompanyId] = useState('');
  const [reportDeptId, setReportDeptId] = useState('');
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
      const scopeParams = new URLSearchParams();
      if (companyFilter) scopeParams.set('companyId', companyFilter);
      if (deptFilter) scopeParams.set('departmentId', deptFilter);
      const [depts] = await Promise.all([api.get('/departments')]);
      setDepartments(depts);
      if (isSingleDay) {
        scopeParams.set('date', dateRange.from);
        const res = await api.get('/attendance?' + scopeParams.toString());
        setData(res);
      } else {
        scopeParams.set('from', dateRange.from);
        scopeParams.set('to', dateRange.to);
        const res = await api.get('/attendance/report?' + scopeParams.toString());
        setPeriodRows(aggregateByEmployee(res.rows));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [dateRange, isSingleDay, companyFilter, deptFilter]);

  useEffect(() => { load(); }, [load]);

  // The single-day and period summary tiles below use different statusFilter
  // vocabularies (a per-day status vs. an aggregated day-count bucket, incl.
  // the period-only "absentLeaveOff" combined key) — clear a tile selection
  // made in one view before it's misread, or matches nothing, in the other.
  useEffect(() => { setStatusFilter(''); }, [isSingleDay]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const rows = data.rows || [];
  const visibleRows = rows
    .filter((r) => matchesQuery(search, r.name, r.code, r.department, r.company))
    .filter((r) => !statusFilter || r.status === statusFilter);
  const summary = [
    { label: 'In scope', value: rows.length, icon: 'users', tone: 'people', filterKey: null },
    { label: 'Present', value: rows.filter((r) => r.status === 'present').length, icon: 'checkCircle', tone: 'people', filterKey: 'present' },
    { label: 'Late', value: rows.filter((r) => r.status === 'late').length, icon: 'clock', tone: 'warning', filterKey: 'late' },
    { label: 'No record', value: rows.filter((r) => r.status === 'absent').length, icon: 'xCircle', tone: 'danger', filterKey: 'absent' }
  ];

  // periodStatusMatches lets the "Absent/leave/off days" tile below filter
  // on all three at once — the one summary bucket with no single matching
  // statusFilter option (present/late/absent/leave/off are otherwise a
  // straight r[key] > 0 lookup, same field names the per-day dropdown uses).
  function periodStatusMatches(r, key) {
    return key === 'absentLeaveOff' ? (r.absent + r.leave + r.off) > 0 : r[key] > 0;
  }
  const visiblePeriodRows = periodRows
    .filter((r) => matchesQuery(search, r.name, r.code, r.department, r.company))
    .filter((r) => !statusFilter || periodStatusMatches(r, statusFilter));
  const periodSummary = [
    { label: 'Employees', value: periodRows.length, icon: 'users', tone: 'people', filterKey: null },
    { label: 'Present days', value: periodRows.reduce((sum, r) => sum + r.present, 0), icon: 'checkCircle', tone: 'people', filterKey: 'present' },
    { label: 'Late days', value: periodRows.reduce((sum, r) => sum + r.late, 0), icon: 'clock', tone: 'warning', filterKey: 'late' },
    { label: 'Absent/leave/off days', value: periodRows.reduce((sum, r) => sum + r.absent + r.leave + r.off, 0), icon: 'xCircle', tone: 'danger', filterKey: 'absentLeaveOff' }
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
    setReportCompanyId(companyFilter);
    setReportDeptId(deptFilter);
    setReportOpen(true);
  }

  async function runReport() {
    setReportLoading(true);
    setReportError(null);
    setReportData(null);
    try {
      const params = new URLSearchParams({ from: reportRange.from, to: reportRange.to });
      if (reportCompanyId) params.set('companyId', reportCompanyId);
      if (reportDeptId) params.set('departmentId', reportDeptId);
      setReportData(await api.get('/attendance/report?' + params.toString()));
    } catch (err) {
      setReportError(err.message);
    } finally {
      setReportLoading(false);
    }
  }

  function reportFilenameBase() {
    const company = reportCompanyId && companies.find((c) => c.id === reportCompanyId);
    const slug = company ? '-' + company.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : '';
    return 'attendance-report' + slug + '-' + reportRange.from + '-to-' + reportRange.to;
  }

  function downloadReportCsv() {
    if (!reportData) return;
    const { dates, rows: pivotRows } = buildPivotReport(reportData.rows, reportRange.from, reportRange.to);
    const header = ['Employee ID', 'Title', 'Employee', 'Department', ...dates.map(dayHeader), 'Total Hours', 'Hourly Rate', 'Total Pay'];
    const body = pivotRows.map((e) => [
      e.code, e.positionTitle, e.name, e.department,
      ...dates.map((d) => e.byDate[d] || 0),
      e.totalHours,
      e.hourlyRate != null ? e.hourlyRate : '',
      e.totalPay != null ? e.totalPay : ''
    ]);
    downloadCsv(reportFilenameBase() + '.csv', rowsToCsv([header, ...body]));
  }

  async function downloadReportPdf() {
    setReportError(null);
    try {
      const filename = reportFilenameBase() + '.pdf';
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
        <div className="attendance-toolbar-actions">
          {canAdjust && <button type="button" className="btn btn-secondary" onClick={openSync}>Sync from TimeStation</button>}
          <button type="button" className="btn btn-secondary" onClick={openReport}>Download report</button>
        </div>
      </div>

      <div className="attendance-summary">
        {(isSingleDay ? summary : periodSummary).map((s) => {
          const active = s.filterKey ? statusFilter === s.filterKey : !statusFilter;
          return (
            <button
              type="button"
              key={s.label}
              className={'attendance-summary-tile attendance-summary-tile-' + s.tone + (active ? ' attendance-summary-tile-active' : '')}
              aria-pressed={active}
              title={s.filterKey ? 'Show only ' + s.label.toLowerCase() : 'Clear the status filter'}
              onClick={() => setStatusFilter(s.filterKey && statusFilter !== s.filterKey ? s.filterKey : '')}
            >
              <span className="attendance-summary-icon glow-badge"><Icon name={s.icon} /></span>
              <div>
                <div className="attendance-summary-value">{s.value}</div>
                <div className="attendance-summary-label">{s.label}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="attendance-filters">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, code, department…" />
        <select
          className="input attendance-status-filter" value={companyFilter} aria-label="Filter by company"
          onChange={(e) => { setCompanyFilter(e.target.value); setDeptFilter(''); }}
        >
          <option value="">All companies</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          className="input attendance-status-filter" value={deptFilter} aria-label="Filter by department"
          onChange={(e) => setDeptFilter(e.target.value)}
        >
          <option value="">All departments</option>
          {departments.filter((d) => !companyFilter || d.companyId === companyFilter).map((d) => (
            <option key={d.id} value={d.id}>{companyFilter ? d.name : d.name + ' — ' + d.companyName}</option>
          ))}
        </select>
        <select className="input attendance-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="present">Present</option>
          <option value="late">Late</option>
          <option value="absent">{isSingleDay ? 'No record' : 'Absent'}</option>
          <option value="leave">Leave</option>
          <option value="off">Off</option>
          {!isSingleDay && <option value="absentLeaveOff">Absent/leave/off</option>}
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
              <tr><th>Code</th><th>Name</th><th>Company</th><th>Department</th><th>Clock in</th><th>Clock out</th><th>Status</th><th>Note</th><th /></tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => (
                <tr key={r.employeeId}>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.code}</td>
                  <td>
                    <div className="attendance-name-cell">
                      <span className="attendance-avatar" style={{ background: avatarColor(r.name) }}>{initials(r.name)}</span>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                    </div>
                  </td>
                  <td>{r.company}</td>
                  <td>{r.department}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.clockIn || '—'} <LocationLink loc={r.clockInLocation} /></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.clockOut || '—'} <LocationLink loc={r.clockOutLocation} /></td>
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
          {!rows.length && <EmptyState title="No employees in scope for this date" />}
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
              <tr><th>Code</th><th>Name</th><th>Company</th><th>Department</th><th>Present</th><th>Late</th><th>Absent</th><th>Leave</th><th>Off</th><th>Total</th></tr>
            </thead>
            <tbody>
              {visiblePeriodRows.map((r) => (
                <tr key={r.employeeId}>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.code}</td>
                  <td>
                    <div className="attendance-name-cell">
                      <span className="attendance-avatar" style={{ background: avatarColor(r.name) }}>{initials(r.name)}</span>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                    </div>
                  </td>
                  <td>{r.company}</td>
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
          {!periodRows.length && <EmptyState title="No employees in scope for this filter" />}
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
        const DETAIL_ROW_CAP = 300; // employee rows, not raw records — beyond this, rendering every row x every day column into the DOM (for the on-screen table and PDF screenshot) gets slow; CSV export still covers the full list either way, since that's built as a plain string, not DOM
        const pivot = reportData ? buildPivotReport(reportData.rows, reportRange.from, reportRange.to) : null;
        const showDetailTable = pivot && pivot.rows.length <= DETAIL_ROW_CAP;
        const canSeePay = reportData && reportData.canViewPay;
        return (
          <div className="dialog-backdrop" onClick={() => setReportOpen(false)}>
            <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
              <h2 className="employees-dialog-title">Attendance report</h2>
              <p className="dialog-body">
                A TimeStation-style timesheet for the date range and company/department below, scoped to what you
                can already see — everyone in the picked scope if you have company-wide access, otherwise just your
                own record. One row per employee, one column per day, hours computed from clock in/out.
              </p>
              <div className="field">
                <label>Period</label>
                <DateRangePicker value={reportRange} onChange={setReportRange} />
              </div>
              <div className="field">
                <label htmlFor="rpt-company">Company</label>
                <select
                  id="rpt-company" className="input" value={reportCompanyId} aria-label="Report company"
                  onChange={(e) => { setReportCompanyId(e.target.value); setReportDeptId(''); }}
                >
                  <option value="">All companies</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rpt-department">Department</label>
                <select
                  id="rpt-department" className="input" value={reportDeptId} aria-label="Report department"
                  onChange={(e) => setReportDeptId(e.target.value)}
                >
                  <option value="">All departments</option>
                  {departments.filter((d) => !reportCompanyId || d.companyId === reportCompanyId).map((d) => (
                    <option key={d.id} value={d.id}>{reportCompanyId ? d.name : d.name + ' — ' + d.companyName}</option>
                  ))}
                </select>
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
                      {(companies.find((c) => c.id === reportCompanyId) || { name: 'All companies' }).name}
                      {reportDeptId ? ' — ' + (departments.find((d) => d.id === reportDeptId) || { name: '' }).name : ''}
                      , {reportRange.from} to {reportRange.to} — {pivot.rows.length.toLocaleString()} employee(s), {reportData.rows.length.toLocaleString()} record(s).
                      {!canSeePay && ' Hourly rate/pay is hidden — your role doesn\'t have payroll access.'}
                    </p>
                    {!showDetailTable && (
                      <p className="itdevices-import-summary">
                        Too many employees ({pivot.rows.length.toLocaleString()}) to list on screen — download the CSV for the full detail.
                      </p>
                    )}
                    {showDetailTable && (
                      <div className="itdevices-import-scroll">
                        <table className="table itdevices-import-table">
                          <thead>
                            <tr>
                              <th>Employee ID</th><th>Title</th><th>Employee</th><th>Department</th>
                              {pivot.dates.map((d) => <th key={d}>{dayHeader(d)}</th>)}
                              <th>Total Hours</th><th>Hourly Rate</th><th>Total Pay</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pivot.rows.map((e) => (
                              <tr key={e.employeeId}>
                                <td>{e.code}</td>
                                <td>{e.positionTitle || '—'}</td>
                                <td style={{ fontWeight: 600 }}>{e.name}</td>
                                <td>{e.department}</td>
                                {pivot.dates.map((d) => <td key={d}>{e.byDate[d] || 0}</td>)}
                                <td style={{ fontWeight: 600 }}>{e.totalHours}</td>
                                <td>{e.hourlyRate != null ? e.hourlyRate : '—'}</td>
                                <td>{e.totalPay != null ? e.totalPay.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</td>
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
