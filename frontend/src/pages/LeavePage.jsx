import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './LeavePage.css';
import RowMenu from '../components/RowMenu';

import { activeIntlLocale, tr, trNodes } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
// Ported from Bamboo OS.dc.html's leave screen (screens.leave block + the
// leaveRows/leaveFilters/leaveHint computed values around its render()),
// redesigned around the icon/avatar language established for Messages/
// Dashboard/My Space/Employees/Attendance: initials avatars on each row,
// a balance chip on the request form, counts on the status tabs, and an
// icon'd empty state.

// Ported from kernel.js's UI helper tag(status).
function tagClass(status) {
  if (status === 'approved') return 'tag-neutral';
  if (status === 'pending') return 'tag-outline';
  if (status === 'rejected' || status === 'cancelled') return 'tag-accent';
  return 'tag-neutral';
}

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
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  xCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9.5h16M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5V12l3.2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

// Ported from Bamboo OS.dc.html's fmtDate().
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_FORM = { leaveTypeId: '', startDate: '', endDate: '', reason: '' };

export default function LeavePage() {
  const { session, can } = useAuth();
  const employeeId = session && session.employee && session.employee.id;

  const [leaveTypes, setLeaveTypes] = useState([]);
  const [leaveRequests, setLeaveRequests] = useState([]);
  const [balances, setBalances] = useState([]);
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [companyFilter, setCompanyFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');

  // Departments already carry companyId/companyName (departments.service.js#list)
  // so the company list is derived from one fetch, same pattern as
  // EmployeesPage/AttendancePage/PayrollPage.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);

  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const [decisionDialog, setDecisionDialog] = useState(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [dialogError, setDialogError] = useState(null);
  const [deciding, setDeciding] = useState(false);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (companyFilter) params.set('companyId', companyFilter);
      if (deptFilter) params.set('departmentId', deptFilter);
      const [types, requests, me, depts] = await Promise.all([
        api.get('/leave/types'),
        api.get('/leave?' + params.toString()),
        api.get('/me/summary'),
        api.get('/departments')
      ]);
      setLeaveTypes(types);
      setLeaveRequests(requests);
      setBalances(me.balances || []);
      setDepartments(depts);
      setForm((f) => (f.leaveTypeId ? f : { ...f, leaveTypeId: (types[0] && types[0].id) || '' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [companyFilter, deptFilter]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function handleSubmitRequest(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const created = await api.post('/leave', form);
      setToast(tr('Request submitted for approval ({days} day(s)).', { days: created.days }));
      setForm({ ...EMPTY_FORM, leaveTypeId: form.leaveTypeId });
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  function openDecision(row, decision) {
    setDialogError(null);
    setDecisionNote('');
    setDecisionDialog({
      id: row.id, decision, employeeName: row.employeeName, typeName: row.typeName,
      days: row.days, startDate: row.startDate, endDate: row.endDate
    });
  }

  async function confirmDecision(e) {
    e.preventDefault();
    if (!decisionDialog) return;
    setDeciding(true);
    setDialogError(null);
    try {
      await api.post('/leave/' + decisionDialog.id + '/decision', { decision: decisionDialog.decision, note: decisionNote });
      setToast(decisionDialog.decision === 'approved' ? tr('Leave approved.') : tr('Leave rejected.'));
      setDecisionDialog(null);
      await loadAll();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeciding(false);
    }
  }

  async function handleCancel(row) {
    setError(null);
    try {
      await api.post('/leave/' + row.id + '/cancel');
      setToast(tr('Request cancelled.'));
      await loadAll();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const rows = leaveRequests
    .filter((l) => filter === 'all' || l.status === filter)
    .filter((l) => matchesQuery(search, l.employeeName, l.department, l.company, l.typeName));
  const listTitle = can('leave.read.all') ? tr('Leave requests in your scope') : tr('My leave requests');
  const selectedType = leaveTypes.find((t) => t.id === form.leaveTypeId);
  const balance = selectedType && balances.find((b) => b.name === selectedType.name);
  const filterCounts = {
    pending: leaveRequests.filter((l) => l.status === 'pending').length,
    approved: leaveRequests.filter((l) => l.status === 'approved').length,
    rejected: leaveRequests.filter((l) => l.status === 'rejected').length,
    all: leaveRequests.length
  };
  // Same clickable-tile treatment as AttendancePage.jsx's summary row —
  // each tile IS the status filter (no separate segmented control needed).
  const leaveSummary = [
    { key: 'pending', label: tr('Pending'), value: filterCounts.pending, icon: 'clock', tone: 'warning' },
    { key: 'approved', label: tr('Approved'), value: filterCounts.approved, icon: 'checkCircle', tone: 'people' },
    { key: 'rejected', label: tr('Rejected'), value: filterCounts.rejected, icon: 'xCircle', tone: 'danger' },
    { key: 'all', label: tr('All requests'), value: filterCounts.all, icon: 'calendar', tone: 'people' }
  ];

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="leave-summary">
        {leaveSummary.map((s) => (
          <button
            type="button"
            key={s.key}
            className={'leave-summary-tile leave-summary-tile-' + s.tone + (filter === s.key ? ' leave-summary-tile-active' : '')}
            aria-pressed={filter === s.key}
            title={tr('Show {label}', { label: s.label.toLowerCase() })}
            onClick={() => setFilter(s.key)}
          >
            <span className="leave-summary-icon glow-badge"><Icon name={s.icon} /></span>
            <div>
              <div className="leave-summary-value">{s.value}</div>
              <div className="leave-summary-label">{s.label}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="leave-grid">
        {can('leave.request') && (
          <form className="card leave-form" onSubmit={handleSubmitRequest}>
            <h2 className="leave-form-title">{tr('Request leave')}</h2>

            <div className="field">
              <label htmlFor="leave-type">{tr('Type')}</label>
              <select
                id="leave-type"
                className="input"
                value={form.leaveTypeId}
                onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}
                required
              >
                {leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            <div className="leave-form-dates">
              <div className="field">
                <label htmlFor="leave-start">{tr('From')}</label>
                <input
                  id="leave-start" className="input" type="date" value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })} required
                />
              </div>
              <div className="field">
                <label htmlFor="leave-end">{tr('To')}</label>
                <input
                  id="leave-end" className="input" type="date" value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })} required
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="leave-reason">{tr('Reason')}</label>
              <textarea
                id="leave-reason" className="input" value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder={tr('Kept on the record for HR.')} required
              />
            </div>

            {balance && (
              <div className={'leave-balance-chip' + (balance.left <= 0 ? ' leave-balance-chip-empty' : '')}>
                <span className="leave-balance-chip-icon"><Icon name="calendar" /></span>
                <span>{trNodes('{left} of {entitled} day(s) remaining', { left: <strong>{balance.left}</strong>, entitled: balance.entitled })}</span>
              </div>
            )}
            <div className="leave-hint">{tr('Sundays are not counted as leave days.')}</div>

            <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
              {submitting ? tr('Submitting…') : tr('Submit request')}
            </button>
          </form>
        )}

        <section className="leave-list-section">
          <div className="leave-list-header">
            <h2 className="leave-list-title">{listTitle}</h2>
          </div>

          <div className="leave-filters-row">
            <SearchInput value={search} onChange={setSearch} placeholder={tr('Search employee, department, type…')} />
            <select
              className="input leave-company-filter" value={companyFilter} aria-label={tr('Filter by company')}
              onChange={(e) => { setCompanyFilter(e.target.value); setDeptFilter(''); }}
            >
              <option value="">{tr('All companies')}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select
              className="input leave-company-filter" value={deptFilter} aria-label={tr('Filter by department')}
              onChange={(e) => setDeptFilter(e.target.value)}
            >
              <option value="">{tr('All departments')}</option>
              {departments.filter((d) => !companyFilter || d.companyId === companyFilter).map((d) => (
                <option key={d.id} value={d.id}>{companyFilter ? d.name : d.name + ' — ' + d.companyName}</option>
              ))}
            </select>
          </div>

          {rows.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr><th>{tr('Employee')}</th><th>{tr('Type')}</th><th>{tr('Dates')}</th><th>{tr('Days')}</th><th>{tr('Status')}</th><th /></tr>
                </thead>
                <tbody>
                  {rows.map((l) => {
                    const decidable = l.status === 'pending' && can('leave.approve') && l.employeeId !== employeeId;
                    const cancellable = l.status === 'pending' && l.employeeId === employeeId;
                    return (
                      <tr key={l.id}>
                        <td>
                          <div className="leave-name-cell">
                            <span className="leave-avatar" style={{ background: avatarColor(l.employeeName) }}>{initials(l.employeeName)}</span>
                            <div>
                              <div style={{ fontWeight: 600 }}>{l.employeeName}</div>
                              <div className="leave-dept">{l.department} · {l.company}</div>
                            </div>
                          </div>
                        </td>
                        <td>{l.typeName}</td>
                        <td style={{ fontSize: 13 }}>{fmtDate(l.startDate)} → {fmtDate(l.endDate)}</td>
                        <td>{l.days}</td>
                        <td><span className={'tag ' + tagClass(l.status)}>{codeLabel(l.status)}</span></td>
                        <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                          <RowMenu actions={[
                            { label: tr('Approve'), onClick: () => openDecision(l, 'approved'), hidden: !(decidable) },
                            { label: tr('Reject'), onClick: () => openDecision(l, 'rejected'), danger: true, hidden: !(decidable) },
                            { label: tr('Cancel'), onClick: () => handleCancel(l), danger: true, hidden: !(cancellable) },
                          ]} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!rows.length && (
            <div className="leave-empty-state">
              <span className="leave-empty-icon"><Icon name="calendar" /></span>
              <p className="leave-empty-title">{tr('Nothing matches this filter')}</p>
              <p className="leave-empty-sub">{tr('Try a different status or search.')}</p>
            </div>
          )}
        </section>
      </div>

      {decisionDialog && (
        <div className="dialog-backdrop" onClick={() => setDecisionDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmDecision}>
            <h2>{decisionDialog.decision === 'approved' ? tr('Approve leave') : tr('Reject leave')}</h2>
            <p className="dialog-body">
              {tr('{employeeName} · {typeName} · {days} day(s), {date} → {date2}', { employeeName: decisionDialog.employeeName, typeName: decisionDialog.typeName, days: decisionDialog.days, date: fmtDate(decisionDialog.startDate), date2: fmtDate(decisionDialog.endDate) })}
            </p>
            <div className="field">
              <label htmlFor="decision-note">{tr('Note for the record')}</label>
              <textarea
                id="decision-note" className="input" value={decisionNote}
                onChange={(e) => setDecisionNote(e.target.value)}
                placeholder={tr('Optional for approval, expected for a rejection.')}
              />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDecisionDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={deciding}>
                {deciding ? tr('Saving…') : (decisionDialog.decision === 'approved' ? tr('Approve request') : tr('Reject request'))}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
