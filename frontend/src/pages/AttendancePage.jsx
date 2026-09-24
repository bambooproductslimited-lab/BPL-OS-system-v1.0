import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import DateRangePicker from '../components/DateRangePicker';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import './AttendancePage.css';
import RowMenu from '../components/RowMenu';

import { activeIntlLocale, tr, trNodes } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import {
  CompanySwitcher, Glossary, Hero, Insights, Section, jump
} from '../components/DashKit';
// Ported from Bamboo OS.dc.html's attendance screen (screens.attendance
// block + the attendance/attSummary computed values around its render()).
// Clock in/out lives on the "My space" screen, not here — this screen is
// the manager/HR roster view for a given day.
//
// Laid out like the other dashboards: a company switcher (All companies,
// then each company, remembered on this device), a header with the day's
// or period's key numbers (press one to filter the roster to it), a "what
// stands out" list written from the figures, attendance by group, then the
// roster itself. A day on approved leave shows as leave, and a late
// arrival says how many minutes after the shift start.
//
// Earlier: redesigned around the roster/summary/toolbar view — icon summary tiles
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
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

// One row per scoped employee, counting a status across every calendar
// day in the range — /attendance/report itself now returns a row per
// employee per day (a day with no clock-in record comes back as 'absent',
// or 'off' on that employee's rest day — see attendance.service.js's
// isRestDay: Sunday is a rest day for Bamboo Products Limited staff other
// than Security, while Star Bar, Bamboo Garden, and BPL Security work
// every day). Total is the number of days they actually came to work
// (present + late) — Off already keeps rest days out of Absent, so Absent
// only ever means "was scheduled to work, didn't show up," and Total only
// ever means "did show up."
function aggregateByEmployee(rows) {
  const byEmp = {};
  rows.forEach((r) => {
    if (!byEmp[r.employeeId]) {
      byEmp[r.employeeId] = { employeeId: r.employeeId, name: r.name, code: r.code, department: r.department, company: r.company, present: 0, late: 0, absent: 0, leave: 0, off: 0, total: 0 };
    }
    const e = byEmp[r.employeeId];
    if (e[r.status] !== undefined) e[r.status]++;
  });
  Object.values(byEmp).forEach((e) => { e.total = e.present + e.late; });
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
  const weekday = d.toLocaleDateString(activeIntlLocale(), { weekday: 'short' });
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

// "No one matches "kofi" and status "Late"." as whole sentences, so each
// language can arrange them its own way.
function noMatchText(search, statusFilter) {
  const status = statusFilter === 'absentLeaveOff' ? tr('Absent/leave/off') : codeLabel(statusFilter);
  if (search && statusFilter) return tr('No one matches "{search}" and status "{status}".', { search, status });
  if (search) return tr('No one matches "{search}".', { search });
  if (statusFilter) return tr('No one matches status "{status}".', { status });
  return tr('No one matches.');
}

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
  const [companyCode, setCompanyCode] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('company');
    if (q) return q.toUpperCase();
    try { return localStorage.getItem('bos.attendanceCompany') || 'ALL'; } catch { return 'ALL'; }
  });
  const [deptFilter, setDeptFilter] = useState('');

  // Departments already carry companyId/companyName (departments.service.js#list)
  // so the company filter and its department cascade are both derived from
  // one fetch, same pattern as EmployeesPage.jsx.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    // Bamboo Products first, then the rest by name, as on the other dashboards.
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);

  // The switcher works in company codes (?company=SB); the API in ids.
  useEffect(() => {
    if (!companies.length) return;
    const co = companies.find((c) => c.code === companyCode);
    const id = co ? co.id : '';
    if (!co && companyCode !== 'ALL') setCompanyCode('ALL');
    if (id !== companyFilter) { setCompanyFilter(id); setDeptFilter(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies, companyCode]);
  function pickCompany(code) {
    setCompanyCode(code);
    try { localStorage.setItem('bos.attendanceCompany', code); } catch { /* remembered for this visit only */ }
    window.history.replaceState({}, '', window.location.pathname + (code !== 'ALL' ? '?company=' + code : ''));
  }

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncRange, setSyncRange] = useState({ startDate: daysAgoISO(7), endDate: todayISO() });
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncCommitting, setSyncCommitting] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncProgress, setSyncProgress] = useState(null); // { done, total } while committing in batches

  const [lateOpen, setLateOpen] = useState(false);
  const [lateData, setLateData] = useState(null);
  const [lateUnassigned, setLateUnassigned] = useState(null);
  const [lateLoading, setLateLoading] = useState(false);
  const [lateError, setLateError] = useState(null);
  const [showUnassigned, setShowUnassigned] = useState(false);

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
      setToast(tr('Attendance corrected and logged.'));
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
      setToast(tr('Attendance record deleted.'));
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
      setToast(tr('Synced attendance from TimeStation.'));
      await load();
    } catch (err) {
      setSyncError(tr('{message} ({created} created, {updated} updated so far — already written, not lost)', { message: err.message, created: totals.created, updated: totals.updated }));
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

  function openLateness() {
    setLateError(null);
    setLateData(null);
    setLateUnassigned(null);
    setShowUnassigned(false);
    setReportCompanyId(companyFilter);
    setReportDeptId(deptFilter);
    setLateOpen(true);
  }

  async function runLateness() {
    setLateLoading(true);
    setLateError(null);
    setLateData(null);
    try {
      const params = new URLSearchParams({ from: reportRange.from, to: reportRange.to });
      if (reportCompanyId) params.set('companyId', reportCompanyId);
      if (reportDeptId) params.set('departmentId', reportDeptId);
      // Both together: the lateness figures mean nothing for anyone with no
      // shift, so the list of those people is fetched alongside and shown
      // above the numbers rather than filed away on another screen.
      const [late, unassigned] = await Promise.all([
        api.get('/attendance/lateness?' + params.toString()),
        api.get('/attendance/unassigned-shifts?' + params.toString())
      ]);
      setLateData(late);
      setLateUnassigned(unassigned);
    } catch (err) {
      setLateError(err.message);
    } finally {
      setLateLoading(false);
    }
  }

  function downloadLatenessCsv() {
    if (!lateData) return;
    const header = [tr('Employee ID'), tr('Employee'), tr('Title'), tr('Department'), tr('Company'), tr('Shift'),
      tr('Days recorded'), tr('Days late'), tr('Late %'), tr('Total minutes late'), tr('Average minutes late'),
      tr('Worst minutes'), tr('Worst day'), tr('Measured against')];
    const body = lateData.rows.map((r) => [
      r.code, r.name, r.positionTitle || '', r.department || '', r.company || '',
      r.hasShift ? (r.shiftName || tr('shift times on the employee')) : tr('NO SHIFT ASSIGNED'),
      r.daysRecorded, r.daysLate, r.latePercent, r.minutesLate, r.averageMinutesLate,
      r.worstMinutes, r.worstDate || '',
      r.hasShift ? tr('their own shift start + grace') : tr('company cutoff {time} — not meaningful', { time: lateData.fallbackCutoff })
    ]);
    downloadCsv('attendance-lateness-' + reportRange.from + '-to-' + reportRange.to + '.csv',
      rowsToCsv([header, ...body]));
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
    const header = [tr('Employee ID'), tr('Title'), tr('Employee'), tr('Department'), ...dates.map(dayHeader), tr('Total Hours'), tr('Hourly Rate'), tr('Total Pay')];
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

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page says about itself ──────────────────────────────────
  const isToday = isSingleDay && dateRange.from === todayISO();
  const scopeName = companyFilter ? (companies.find((c) => c.id === companyFilter) || {}).name : tr('all companies');
  const dayCounts = {
    in: rows.filter((r) => r.status === 'present' || r.status === 'late').length,
    late: rows.filter((r) => r.status === 'late').length,
    absent: rows.filter((r) => r.status === 'absent').length,
    leave: rows.filter((r) => r.status === 'leave').length,
    off: rows.filter((r) => r.status === 'off').length,
    auto: rows.filter((r) => r.autoClockedOut).length
  };
  const dayExpected = rows.length - dayCounts.off - dayCounts.leave;
  const dayRate = dayExpected ? Math.round((dayCounts.in / dayExpected) * 100) : 0;
  const periodTotals = periodRows.reduce((t, r) => ({
    present: t.present + r.present, late: t.late + r.late, absent: t.absent + r.absent, leave: t.leave + r.leave, off: t.off + r.off
  }), { present: 0, late: 0, absent: 0, leave: 0, off: 0 });
  const periodWorked = periodTotals.present + periodTotals.late;
  const periodExpected = periodWorked + periodTotals.absent;
  const periodRate = periodExpected ? Math.round((periodWorked / periodExpected) * 100) : 0;

  // Attendance by group: who came in out of who was expected (leave and
  // rest days are not expected).
  const groups = (() => {
    const by = {};
    if (isSingleDay) {
      rows.forEach((r) => {
        const k = r.company + '|' + r.department;
        const g = by[k] || (by[k] = { key: k, name: r.department, company: r.company, total: 0, came: 0, late: 0, missing: 0, away: 0 });
        g.total++;
        if (r.status === 'present' || r.status === 'late') g.came++;
        if (r.status === 'late') g.late++;
        if (r.status === 'absent') g.missing++;
        if (r.status === 'leave' || r.status === 'off') g.away++;
      });
    } else {
      periodRows.forEach((r) => {
        const k = r.company + '|' + r.department;
        const g = by[k] || (by[k] = { key: k, name: r.department, company: r.company, total: 0, came: 0, late: 0, missing: 0, away: 0 });
        g.total++;
        g.came += r.present + r.late;
        g.late += r.late;
        g.missing += r.absent;
        g.away += r.leave + r.off;
      });
    }
    return Object.values(by).map((g) => {
      const expected = g.came + g.missing;
      return { ...g, rate: expected ? Math.round((g.came / expected) * 100) : null };
    }).sort((a, b) => (a.rate === null ? 101 : a.rate) - (b.rate === null ? 101 : b.rate));
  })();
  const showCompany = !companyFilter && companies.length > 1;

  const insights = [];
  if (isSingleDay) {
    if (dayExpected > 0) {
      insights.push({ tone: dayRate >= 90 ? 'good' : dayRate < 70 ? 'warn' : 'info', icon: 'people', text: tr('{came} of {expected} people expected have clocked in ({rate}%).', { came: dayCounts.in, expected: dayExpected, rate: dayRate }) });
    }
    const lates = rows.filter((r) => r.status === 'late' && r.minutesLate != null);
    if (dayCounts.late) {
      const worst = lates.slice().sort((a, b) => b.minutesLate - a.minutesLate)[0];
      const avg = lates.length ? Math.round(lates.reduce((s, r) => s + r.minutesLate, 0) / lates.length) : null;
      insights.push({ tone: 'warn', icon: 'clock', text: avg !== null
        ? tr('{n} came in late, {avg} minutes on average. {name} was the latest, {worst} minutes after their shift start.', { n: dayCounts.late, avg, name: worst.name, worst: worst.minutesLate })
        : tr('{n} came in late.', { n: dayCounts.late }),
        action: { label: tr('Show them'), run: () => { setStatusFilter('late'); jump('att-roster'); } } });
    }
    if (dayCounts.absent) {
      insights.push({ tone: isToday ? 'info' : 'bad', icon: 'warn', text: isToday
        ? tr('{n} people have not clocked in yet. Some may start later in the day.', { n: dayCounts.absent })
        : tr('{n} people have no record for this day: not clocked in and not on leave.', { n: dayCounts.absent }),
        action: { label: tr('Show them'), run: () => { setStatusFilter('absent'); jump('att-roster'); } } });
    }
    if (dayCounts.leave) insights.push({ tone: 'info', icon: 'calendar', text: dayCounts.leave === 1 ? tr('1 person is on approved leave.') : tr('{n} people are on approved leave.', { n: dayCounts.leave }) });
    if (dayCounts.auto) {
      insights.push({ tone: 'warn', icon: 'clock', text: dayCounts.auto === 1 ? tr('1 person forgot to clock out and was clocked out by the system. Correct it if you know the real time.') : tr('{n} people forgot to clock out and were clocked out by the system. Correct them if you know the real times.', { n: dayCounts.auto }) });
    }
  } else if (periodRows.length) {
    if (periodExpected) {
      insights.push({ tone: periodRate >= 90 ? 'good' : periodRate < 75 ? 'warn' : 'info', icon: 'people', text: tr('People came to work on {rate}% of the days they were expected ({worked} of {expected} days).', { rate: periodRate, worked: periodWorked, expected: periodExpected }) });
    }
    const mostAbsent = periodRows.slice().sort((a, b) => b.absent - a.absent)[0];
    if (mostAbsent && mostAbsent.absent >= 2) {
      insights.push({ tone: 'bad', icon: 'warn', text: tr('{name} missed the most days: {n} without a record or leave.', { name: mostAbsent.name, n: mostAbsent.absent }), action: { label: tr('Show them'), run: () => { setStatusFilter('absent'); jump('att-roster'); } } });
    }
    const mostLate = periodRows.slice().sort((a, b) => b.late - a.late)[0];
    if (mostLate && mostLate.late >= 2) {
      insights.push({ tone: 'warn', icon: 'clock', text: tr('{name} was late most often: {n} days.', { name: mostLate.name, n: mostLate.late }), action: { label: tr('Lateness report'), run: openLateness } });
    }
    const perfect = periodRows.filter((r) => r.absent === 0 && r.late === 0 && r.present > 0).length;
    if (perfect) insights.push({ tone: 'good', icon: 'check', text: perfect === 1 ? tr('1 person came in on time every day they were expected.') : tr('{n} people came in on time every day they were expected.', { n: perfect }) });
    if (periodTotals.leave) insights.push({ tone: 'info', icon: 'calendar', text: tr('{n} days were taken as approved leave.', { n: periodTotals.leave }) });
  }
  const lowGroup = groups.find((g) => g.rate !== null && g.total >= 3);
  if (lowGroup && groups.length > 1 && lowGroup.rate < 80) {
    insights.push({ tone: 'warn', icon: 'people', text: tr('{group} has the lowest attendance: {rate}%.', { group: lowGroup.name + (showCompany ? ' (' + lowGroup.company + ')' : ''), rate: lowGroup.rate }) });
  }

  function statTile(key) { return () => { setStatusFilter(statusFilter === key ? '' : key); jump('att-roster'); }; }
  const stats = isSingleDay ? [
    { icon: 'people', value: dayCounts.in + '/' + dayExpected, label: isToday ? tr('in today') : tr('came in'), note: dayExpected ? tr('{rate}% of those expected', { rate: dayRate }) : tr('nobody expected'), onClick: statTile('') },
    { icon: 'clock', value: String(dayCounts.late), label: tr('late'), note: tr('after their start time'), tone: dayCounts.late ? 'alert' : '', onClick: statTile('late') },
    { icon: 'warn', value: String(dayCounts.absent), label: isToday ? tr('not in yet') : tr('no record'), note: tr('not clocked in, not on leave'), tone: dayCounts.absent && !isToday ? 'bad' : '', onClick: statTile('absent') },
    { icon: 'calendar', value: String(dayCounts.leave + dayCounts.off), label: tr('away'), note: tr('{l} on leave · {o} rest day', { l: dayCounts.leave, o: dayCounts.off }), onClick: statTile(dayCounts.leave ? 'leave' : 'off') }
  ] : [
    { icon: 'people', value: periodRate + '%', label: tr('attendance'), note: tr('{worked} of {expected} expected days worked', { worked: periodWorked, expected: periodExpected }), onClick: statTile('') },
    { icon: 'clock', value: String(periodTotals.late), label: tr('late days'), note: tr('across {n} people', { n: periodRows.filter((r) => r.late).length }), tone: periodTotals.late ? 'alert' : '', onClick: statTile('late') },
    { icon: 'warn', value: String(periodTotals.absent), label: tr('missed days'), note: tr('no record and no leave'), tone: periodTotals.absent ? 'bad' : '', onClick: statTile('absent') },
    { icon: 'calendar', value: String(periodTotals.leave), label: tr('leave days'), note: tr('{n} rest days besides', { n: periodTotals.off }), onClick: statTile('leave') }
  ];

  return (
    <>
    <div className="dk att">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={companyFilter ? (companies.find((c) => c.id === companyFilter) || {}).code : 'ALL'}
          onPick={pickCompany} describe={(co) => (co.code === 'ALL' ? tr('Everyone together') : tr('{n} groups', { n: departments.filter((d) => d.companyId === co.id).length }))} />
      )}

      <Hero
        eyebrow={isSingleDay ? fmtDate(dateRange.from) : fmtDate(dateRange.from) + ' – ' + fmtDate(dateRange.to)}
        title={isToday ? tr('Today\'s attendance') : isSingleDay ? tr('Attendance on this day') : tr('Attendance over the period')}
        sub={isSingleDay
          ? tr('Who came in, who was late and by how much, and who is away, for {scope}. Press a number to show only those people below.', { scope: scopeName })
          : tr('Days worked, late and missed per person for {scope}. Pick a single day to see and correct individual records.', { scope: scopeName })}
        actions={<>
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          {canAdjust && <button type="button" className="btn btn-secondary" onClick={openSync}>{tr('Sync from TimeStation')}</button>}
          <button type="button" className="btn btn-secondary" onClick={openReport}>{tr('Download report')}</button>
          <button type="button" className="btn btn-secondary" onClick={openLateness}>{tr('Lateness')}</button>
        </>}
        stats={stats} />

      <Insights items={insights.slice(0, 7)} />

      {groups.length > 1 && (
        <Section title={tr('By group')} sub={isSingleDay ? tr('Who came in out of who was expected. People on leave or on a rest day are not expected.') : tr('Days worked out of days expected, per group.')}>
          <div className="att-groups">
            {groups.map((g) => (
              <button key={g.key} type="button" className="att-group" onClick={() => {
                const dep = departments.find((d) => d.name === g.name && d.companyName === g.company);
                if (dep) { setDeptFilter(dep.id); jump('att-roster'); }
              }}>
                <span className="att-group-top">
                  <span className="att-group-name">{g.name}{showCompany && <span className="att-group-co">{g.company}</span>}</span>
                  <strong className={'att-group-rate' + (g.rate === null ? '' : g.rate < 70 ? ' is-low' : g.rate < 90 ? ' is-mid' : '')}>{g.rate === null ? '—' : g.rate + '%'}</strong>
                </span>
                <span className="dk-track" aria-hidden="true"><span className={g.rate < 70 ? 'is-low' : g.rate < 90 ? 'is-mid' : ''} style={{ width: (g.rate || 0) + '%' }} /></span>
                <span className="dk-muted att-group-meta">
                  {isSingleDay ? tr('{came} of {expected} in', { came: g.came, expected: g.came + g.missing }) : tr('{came} of {expected} days', { came: g.came, expected: g.came + g.missing })}
                  {g.late ? ' · ' + tr('{n} late', { n: g.late }) : ''}
                  {g.away ? ' · ' + tr('{n} away', { n: g.away }) : ''}
                </span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section id="att-roster" title={isSingleDay ? tr('Everyone') : tr('Per person')}
        sub={isSingleDay
          ? (canAdjust ? tr('One row per person. Use the menu on a row to correct a record; every correction is written to the audit log.') : tr('One row per person.'))
          : tr('Total is days actually worked (present + late). Off is a rest day (e.g. Sundays for most Bamboo Products staff), so Absent only counts real missed workdays.')}>
      <div className="attendance-filters">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search name, code, department…')} />
        <select
          className="input attendance-status-filter" value={deptFilter} aria-label={tr('Filter by department')}
          onChange={(e) => setDeptFilter(e.target.value)}
        >
          <option value="">{tr('All departments')}</option>
          {departments.filter((d) => !companyFilter || d.companyId === companyFilter).map((d) => (
            <option key={d.id} value={d.id}>{companyFilter ? d.name : d.name + ' — ' + d.companyName}</option>
          ))}
        </select>
        <select className="input attendance-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={tr('Filter by status')}>
          <option value="">{tr('All statuses')}</option>
          <option value="present">{tr('Present')}</option>
          <option value="late">{tr('Late')}</option>
          <option value="absent">{isSingleDay ? tr('No record') : tr('Absent')}</option>
          <option value="leave">{tr('Leave')}</option>
          <option value="off">{tr('Off')}</option>
          {!isSingleDay && <option value="absentLeaveOff">{tr('Absent/leave/off')}</option>}
        </select>
        {(statusFilter || deptFilter || search) && (
          <button type="button" className="btn btn-secondary" onClick={() => { setStatusFilter(''); setDeptFilter(''); setSearch(''); }}>{tr('Clear filters')}</button>
        )}
      </div>

      {isSingleDay ? (
        <>
          <div className="table-scroll"><table className="table">
            <thead>
              <tr><th>{tr('Code')}</th><th>{tr('Name')}</th><th>{tr('Company')}</th><th>{tr('Department')}</th><th>{tr('Clock in')}</th><th>{tr('Clock out')}</th><th>{tr('Status')}</th><th>{tr('Note')}</th><th /></tr>
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
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.clockIn ? String(r.clockIn).slice(0, 5) : '—'} <LocationLink loc={r.clockInLocation} /></td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {r.clockOut ? String(r.clockOut).slice(0, 5) : '—'} <LocationLink loc={r.clockOutLocation} />
                    {r.autoClockedOut && (
                      <span className="tag tag-warning attendance-auto-tag" title={tr('Nobody clocked out, so the system did after the shift ran its limit. Correct it if you know the real time.')}>{tr('Auto')}</span>
                    )}
                  </td>
                  <td>
                    <span className={'tag ' + tagClass(r.status)}>{codeLabel(r.status)}</span>
                    {r.status === 'late' && r.minutesLate != null && <span className="attendance-late-by">{tr('{n} min', { n: r.minutesLate })}</span>}
                  </td>
                  <td className="attendance-note">{r.note || '—'}</td>
                  <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                    <RowMenu actions={[
                      { label: tr('Correct'), onClick: () => openCorrection(r), hidden: !(canAdjust) },
                      { label: tr('Delete'), onClick: () => setDeleteTarget(r), danger: true, hidden: !(canAdjust && r.id) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {!rows.length && <EmptyState title={tr('No employees in scope for this date')} />}
          {!!rows.length && !visibleRows.length && (
            <p className="table-empty">
              {noMatchText(search, statusFilter)}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="table-scroll"><table className="table">
            <thead>
              <tr><th>{tr('Code')}</th><th>{tr('Name')}</th><th>{tr('Company')}</th><th>{tr('Department')}</th><th>{tr('Present')}</th><th>{tr('Late')}</th><th>{tr('Absent')}</th><th>{tr('Leave')}</th><th>{tr('Off')}</th><th title={tr('Days they actually came to work (present + late)')}>{tr('Total')}</th></tr>
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
          </table></div>
          {!periodRows.length && <EmptyState title={tr('No employees in scope for this filter')} />}
          {!!periodRows.length && !visiblePeriodRows.length && (
            <p className="table-empty">
              {noMatchText(search, statusFilter)}
            </p>
          )}
        </>
      )}
      </Section>

      <Glossary items={[
        [tr('Present'), tr('Clocked in on time.')],
        [tr('Late'), tr('Clocked in after their shift start plus the grace period, or after the company cutoff if they have no shift.')],
        [tr('No record'), tr('Expected at work but no clock-in and no approved leave. Today, it can simply mean they have not arrived yet.')],
        [tr('Leave'), tr('On approved leave that day.')],
        [tr('Off'), tr('A rest day, such as Sunday for most Bamboo Products staff.')],
        [tr('Auto'), tr('Nobody clocked out, so the system did after the shift ran its limit.')],
        [tr('Attendance rate'), tr('Days people came in out of the days they were expected. Leave and rest days are not expected.')]
      ]} />
    </div>

      {correction && (
        <div className="dialog-backdrop" onClick={() => setCorrection(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmCorrection}>
            <h2>{tr('Correct attendance')}</h2>
            <p className="dialog-body">{correction.name} · {fmtDate(dateRange.from)}</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="attendance-correction-grid">
              <div className="field">
                <label htmlFor="corr-in">{tr('Clock in')}</label>
                <input id="corr-in" className="input" value={corrForm.clockIn} onChange={(e) => setCorrForm({ ...corrForm, clockIn: e.target.value })} placeholder="07:55" />
              </div>
              <div className="field">
                <label htmlFor="corr-out">{tr('Clock out')}</label>
                <input id="corr-out" className="input" value={corrForm.clockOut} onChange={(e) => setCorrForm({ ...corrForm, clockOut: e.target.value })} placeholder="17:00" />
              </div>
              <div className="field">
                <label htmlFor="corr-status">{tr('Status')}</label>
                <select id="corr-status" className="input" value={corrForm.status} onChange={(e) => setCorrForm({ ...corrForm, status: e.target.value })}>
                  {CORRECTION_STATUSES.map((s) => <option key={s} value={s}>{codeLabel(s)}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="corr-note">{tr('Reason for the correction')}</label>
              <input id="corr-note" className="input" value={corrForm.note} onChange={(e) => setCorrForm({ ...corrForm, note: e.target.value })} placeholder={tr('Required — written to the audit log.')} required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCorrection(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save correction')}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete attendance record')}</h2>
            <p className="dialog-body">{trNodes('Delete the record for {name} ({date})? This cannot be undone.', { name: <strong>{deleteTarget.name}</strong>, date: fmtDate(dateRange.from) })}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {syncOpen && (
        <div className="dialog-backdrop" onClick={() => setSyncOpen(false)}>
          <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="employees-dialog-title">{tr('Sync attendance from TimeStation')}</h2>
            <p className="dialog-body">
              {tr('Pulls clock in/out shifts for every employee linked to TimeStation (set via "Sync from TimeStation" on the Employees page) over the date range below. TimeStation wins for anyone it covers — this replaces any existing attendance record for those dates, including manual corrections. Employees not linked to TimeStation are untouched.')}
            </p>

            {!syncPreview && !syncResult && (
              <>
                <div className="attendance-correction-grid">
                  <div className="field">
                    <label htmlFor="sync-start">{tr('Start date')}</label>
                    <input id="sync-start" className="input" type="date" value={syncRange.startDate} onChange={(e) => setSyncRange({ ...syncRange, startDate: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="sync-end">{tr('End date')}</label>
                    <input id="sync-end" className="input" type="date" value={syncRange.endDate} onChange={(e) => setSyncRange({ ...syncRange, endDate: e.target.value })} />
                  </div>
                </div>
                <button
                  type="button" className="btn btn-secondary" style={{ fontSize: 12 }}
                  onClick={() => setSyncRange({ startDate: daysAgoISO(15 * 365), endDate: todayISO() })}
                >
                  {tr('Use full history (last 15 years)')}
                </button>
                {syncError && <div className="error-banner">{syncError}</div>}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setSyncOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={syncLoading} onClick={runSyncPreview}>
                    {syncLoading ? tr('Fetching from TimeStation…') : tr('Preview')}
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
                    {tr('{found} record(s) found — {created} new, {updated} will be updated, {unchanged} unchanged, {skipped} skipped.', {
                      found: syncPreview.rows.length,
                      created: syncPreview.rows.filter((r) => r.action === 'create').length,
                      updated: syncPreview.rows.filter((r) => r.action === 'update' || r.action === 'overwrite').length,
                      unchanged: syncPreview.rows.filter((r) => r.action === 'unchanged').length,
                      skipped: syncPreview.rows.filter((r) => r.action === 'skip').length
                    })}
                  </p>
                  <div className="itdevices-import-scroll">
                    <table className="table itdevices-import-table">
                      <thead>
                        <tr><th>{tr('Employee')}</th><th>{tr('Date')}</th><th>{tr('Clock in')}</th><th>{tr('Clock out')}</th><th>{tr('Status')}</th><th>{tr('Action')}</th><th>{tr('Notes')}</th></tr>
                      </thead>
                      <tbody>
                        {syncPreview.rows.map((r, i) => (
                          <tr key={i} className={r.action === 'unchanged' || r.action === 'skip' ? 'itdevices-import-row-skip' : ''}>
                            <td style={{ fontWeight: 600 }}>{r.employeeName}</td>
                            <td>{r.date || '—'}</td>
                            <td>{r.clockIn || '—'}</td>
                            <td>{r.clockOut || '—'}</td>
                            <td>{codeLabel(r.status) || '—'}</td>
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
                    <p className="eyebrow">{tr('Syncing {done} of {total}…', { done: syncProgress.done.toLocaleString(), total: syncProgress.total.toLocaleString() })}</p>
                  )}
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" disabled={syncCommitting} onClick={() => setSyncPreview(null)}>{tr('Back')}</button>
                    <button type="button" className="btn btn-secondary" disabled={syncCommitting} onClick={() => setSyncOpen(false)}>{tr('Cancel')}</button>
                    <button type="button" className="btn btn-primary" disabled={syncCommitting || !toWrite.length} onClick={commitAttendanceSync}>
                      {syncCommitting ? tr('Syncing…') : tr('Sync {n} record(s)', { n: toWrite.length })}
                    </button>
                  </div>
                </>
              );
            })()}

            {syncResult && (
              <>
                {syncError && <div className="error-banner">{syncError}</div>}
                <p className="itdevices-import-summary">
                  {syncResult.failed.length
                    ? tr('{created} created, {updated} updated, {unchanged} unchanged, {failed} failed.', { created: syncResult.created, updated: syncResult.updated, unchanged: syncResult.unchanged, failed: syncResult.failed.length })
                    : tr('{created} created, {updated} updated, {unchanged} unchanged.', { created: syncResult.created, updated: syncResult.updated, unchanged: syncResult.unchanged })}
                </p>
                {syncResult.failed.length > 0 && (
                  <ul>
                    {syncResult.failed.map((f, i) => <li key={i}>{f.name} ({f.date}) — {f.reason}</li>)}
                  </ul>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setSyncOpen(false)}>{tr('Done')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {lateOpen && (
        <div className="dialog-backdrop" onClick={() => setLateOpen(false)}>
          <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 940 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="employees-dialog-title">{tr('Lateness')}</h2>
            <p className="dialog-body">
              {tr('Who arrived after their own shift start plus the grace period, over the range below. Anyone with no shift assigned is listed but kept out of the totals — there is no shift to measure them against, so their minutes are counted from the company-wide cutoff and mean nothing.')}
            </p>
            <div className="field">
              <label>{tr('Period')}</label>
              <DateRangePicker value={reportRange} onChange={setReportRange} />
            </div>
            <div className="field">
              <label htmlFor="late-company">{tr('Company')}</label>
              <select id="late-company" className="input" value={reportCompanyId} aria-label={tr('Lateness company')}
                onChange={(e) => { setReportCompanyId(e.target.value); setReportDeptId(''); }}>
                <option value="">{tr('All companies')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="late-department">{tr('Department')}</label>
              <select id="late-department" className="input" value={reportDeptId} aria-label={tr('Lateness department')}
                onChange={(e) => setReportDeptId(e.target.value)}>
                <option value="">{tr('All departments')}</option>
                {departments.filter((d) => !reportCompanyId || d.companyId === reportCompanyId)
                  .map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>

            {lateError && <div className="error-banner">{lateError}</div>}

            {lateUnassigned && lateUnassigned.rows.length > 0 && (
              <div className="attendance-noshift">
                <div className="attendance-noshift-head">
                  <strong>{lateUnassigned.rows.length === 1 ? tr('1 person has no shift assigned.') : tr('{n} people have no shift assigned.', { n: lateUnassigned.rows.length })}</strong>
                  <button type="button" className="btn btn-secondary attendance-noshift-btn"
                    onClick={() => setShowUnassigned((v) => !v)}>
                    {showUnassigned ? tr('Hide') : tr('Show who')}
                  </button>
                </div>
                <p className="attendance-noshift-body">
                  {tr('Their arrival is measured against the company cutoff of {fallbackCutoff}, which describes a day shift. A guard arriving on time at 18:00 scores as 640 minutes late against it; one arriving at 01:00 scores as on time. Assign each of them a shift and these figures become real. Until then they are excluded from the totals below.', { fallbackCutoff: lateUnassigned.fallbackCutoff })}
                </p>
                {showUnassigned && (
                  <table className="table attendance-noshift-table">
                    <thead><tr><th>{tr('ID')}</th><th>{tr('Employee')}</th><th>{tr('Department')}</th><th className="attendance-num">{tr('Days mis-scored')}</th></tr></thead>
                    <tbody>
                      {lateUnassigned.rows.map((r) => (
                        <tr key={r.employeeId}>
                          <td>{r.code}</td>
                          <td>{r.name}</td>
                          <td>{r.department}</td>
                          <td className="attendance-num">{tr('{lateRecords} of {daysRecorded}', { lateRecords: r.lateRecords, daysRecorded: r.daysRecorded })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            {lateData && (
              <>
                <p className="dialog-body">
                  {tr('{daysLate} late day(s) out of {daysRecorded} recorded, across {employees} employee(s) with a shift — {minutesLate} minutes in total.', {
                    daysLate: lateData.totals.daysLate, daysRecorded: lateData.totals.daysRecorded,
                    employees: lateData.totals.employees, minutesLate: lateData.totals.minutesLate
                  })}
                  {lateData.totals.withoutShift > 0 && tr(' {withoutShift} more excluded for having no shift.', { withoutShift: lateData.totals.withoutShift })}
                </p>
                {lateData.rows.length === 0
                  ? <p className="table-empty">{tr('Nobody clocked in during this period.')}</p>
                  : (
                    <div className="table-scroll">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>{tr('ID')}</th><th>{tr('Employee')}</th><th>{tr('Department')}</th><th>{tr('Shift')}</th>
                            <th className="attendance-num">{tr('Late')}</th>
                            <th className="attendance-num col-mid">{tr('Late %')}</th>
                            <th className="attendance-num">{tr('Minutes')}</th>
                            <th className="attendance-num col-wide">{tr('Average')}</th>
                            <th className="col-wide">{tr('Worst')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lateData.rows.map((r) => (
                            <tr key={r.employeeId} className={r.hasShift ? undefined : 'attendance-unscored'}>
                              <td>{r.code}</td>
                              <td>{r.name}</td>
                              <td>{r.department}</td>
                              <td>{r.hasShift
                                ? (r.shiftName || <span className="attendance-muted">{tr('own hours')}</span>)
                                : <span className="tag tag-warning">{tr('no shift')}</span>}</td>
                              <td className="attendance-num">{r.daysLate} / {r.daysRecorded}</td>
                              <td className="attendance-num col-mid">{r.latePercent}%</td>
                              <td className="attendance-num">{r.minutesLate}</td>
                              <td className="attendance-num col-wide">{r.averageMinutesLate}</td>
                              <td className="col-wide">{r.worstDate ? tr('{worstMinutes} min · {worstDate}', { worstMinutes: r.worstMinutes, worstDate: r.worstDate }) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
              </>
            )}

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setLateOpen(false)}>{tr('Close')}</button>
              {lateData && lateData.rows.length > 0 && (
                <button type="button" className="btn btn-secondary" onClick={downloadLatenessCsv}>{tr('Download CSV')}</button>
              )}
              <button type="button" className="btn btn-primary" disabled={lateLoading} onClick={runLateness}>
                {lateLoading ? tr('Working…') : tr('Run')}
              </button>
            </div>
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
              <h2 className="employees-dialog-title">{tr('Attendance report')}</h2>
              <p className="dialog-body">
                {tr('A TimeStation-style timesheet for the date range and company/department below, scoped to what you can already see — everyone in the picked scope if you have company-wide access, otherwise just your own record. One row per employee, one column per day, hours computed from clock in/out.')}
              </p>
              <div className="field">
                <label>{tr('Period')}</label>
                <DateRangePicker value={reportRange} onChange={setReportRange} />
              </div>
              <div className="field">
                <label htmlFor="rpt-company">{tr('Company')}</label>
                <select
                  id="rpt-company" className="input" value={reportCompanyId} aria-label={tr('Report company')}
                  onChange={(e) => { setReportCompanyId(e.target.value); setReportDeptId(''); }}
                >
                  <option value="">{tr('All companies')}</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rpt-department">{tr('Department')}</label>
                <select
                  id="rpt-department" className="input" value={reportDeptId} aria-label={tr('Report department')}
                  onChange={(e) => setReportDeptId(e.target.value)}
                >
                  <option value="">{tr('All departments')}</option>
                  {departments.filter((d) => !reportCompanyId || d.companyId === reportCompanyId).map((d) => (
                    <option key={d.id} value={d.id}>{reportCompanyId ? d.name : d.name + ' — ' + d.companyName}</option>
                  ))}
                </select>
              </div>
              {reportError && <div className="error-banner">{reportError}</div>}
              <div className="dialog-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setReportOpen(false)}>{tr('Close')}</button>
                <button type="button" className="btn btn-primary" disabled={reportLoading} onClick={runReport}>
                  {reportLoading ? tr('Running…') : tr('Run report')}
                </button>
              </div>

              {reportData && (
                <>
                  <div ref={reportPrintRef}>
                    <p className="itdevices-import-summary">
                      {tr('{scope}, {from} to {to} — {employees} employee(s), {records} record(s).', {
                        scope: (companies.find((c) => c.id === reportCompanyId) || { name: tr('All companies') }).name +
                          (reportDeptId ? ' — ' + (departments.find((d) => d.id === reportDeptId) || { name: '' }).name : ''),
                        from: reportRange.from, to: reportRange.to,
                        employees: pivot.rows.length.toLocaleString(), records: reportData.rows.length.toLocaleString()
                      })}
                      {!canSeePay && tr(' Hourly rate/pay is hidden — your role doesn\'t have payroll access.')}
                    </p>
                    {!showDetailTable && (
                      <p className="itdevices-import-summary">
                        {tr('Too many employees ({n}) to list on screen — download the CSV for the full detail.', { n: pivot.rows.length.toLocaleString() })}
                      </p>
                    )}
                    {showDetailTable && (
                      <div className="itdevices-import-scroll">
                        <table className="table itdevices-import-table">
                          <thead>
                            <tr>
                              <th>{tr('Employee ID')}</th><th>{tr('Title')}</th><th>{tr('Employee')}</th><th>{tr('Department')}</th>
                              {pivot.dates.map((d) => <th key={d}>{dayHeader(d)}</th>)}
                              <th>{tr('Total Hours')}</th><th>{tr('Hourly Rate')}</th><th>{tr('Total Pay')}</th>
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
                    {!reportData.rows.length && <p className="table-empty">{tr('No attendance records in this range.')}</p>}
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" onClick={downloadReportCsv}>{tr('Download CSV')}</button>
                    <button type="button" className="btn btn-secondary" onClick={downloadReportPdf}>{tr('Download PDF')}</button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
