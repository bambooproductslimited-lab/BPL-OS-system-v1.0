import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './DepartmentsPage.css';

// Ported from Bamboo OS.dc.html's departments screen, then restructured
// around a new Company tier sitting above Departments (see migration
// 0032): Bamboo Products Limited, Star Bar Restaurant and Bamboo Garden
// each hold their own departments, and each department holds its own
// named shift templates. Reuses the same "expandable parent → children"
// list shape CatalogPage.jsx built for items/variations — a company row
// expands to reveal its departments, mirroring an item row expanding to
// reveal its variations.
//
// Redesigned around the icon/avatar language established elsewhere:
// manager avatar per department row, a building badge per company, an
// icon'd empty state.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="11" height="18" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M15 9h5v12h-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7 7h1M11 7h1M7 11h1M11 11h1M7 15h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const EMPTY_COMPANY_FORM = { name: '', code: '' };
const EMPTY_DEPT_FORM = { code: '', name: '', companyId: '', managerId: '' };
const EMPTY_SHIFT_FORM = { name: '', startTime: '', endTime: '' };

export default function DepartmentsPage() {
  const { can } = useAuth();
  const canManage = can('department.manage');

  const [companies, setCompanies] = useState([]);
  const [managers, setManagers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [search, setSearch] = useState('');

  const [companyDialogOpen, setCompanyDialogOpen] = useState(false);
  const [editCompanyId, setEditCompanyId] = useState(null);
  const [companyForm, setCompanyForm] = useState(EMPTY_COMPANY_FORM);
  const [companyDialogError, setCompanyDialogError] = useState(null);
  const [savingCompany, setSavingCompany] = useState(false);

  const [deptDialogOpen, setDeptDialogOpen] = useState(false);
  const [editDeptId, setEditDeptId] = useState(null);
  const [deptForm, setDeptForm] = useState(EMPTY_DEPT_FORM);
  const [deptDialogError, setDeptDialogError] = useState(null);
  const [savingDept, setSavingDept] = useState(false);

  const [shiftsDialog, setShiftsDialog] = useState(null); // { departmentId, departmentName, shifts, loading, error }
  const [shiftForm, setShiftForm] = useState(EMPTY_SHIFT_FORM);
  const [editShiftId, setEditShiftId] = useState(null);
  const [shiftFormError, setShiftFormError] = useState(null);
  const [savingShift, setSavingShift] = useState(false);

  const [deleteCompanyTarget, setDeleteCompanyTarget] = useState(null);
  const [deleteDeptTarget, setDeleteDeptTarget] = useState(null);
  const [deleteShiftTarget, setDeleteShiftTarget] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const visibleCompanies = useMemo(() => {
    if (!search.trim()) return companies;
    return companies.filter((c) => (
      matchesQuery(search, c.code, c.name) ||
      c.departments.some((d) => matchesQuery(search, d.code, d.name, d.managerName))
    ));
  }, [companies, search]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.get('/companies');
      setCompanies(list);
      if (canManage) {
        const employees = await api.get('/employees');
        setManagers(employees.map((e) => ({ id: e.id, name: e.firstName + ' ' + e.lastName })));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function toggleExpanded(id) {
    setExpanded({ ...expanded, [id]: !expanded[id] });
  }

  // Company dialog
  function openNewCompany() {
    setCompanyDialogError(null);
    setEditCompanyId(null);
    setCompanyForm(EMPTY_COMPANY_FORM);
    setCompanyDialogOpen(true);
  }
  function openEditCompany(c) {
    setCompanyDialogError(null);
    setEditCompanyId(c.id);
    setCompanyForm({ name: c.name, code: c.code });
    setCompanyDialogOpen(true);
  }
  async function handleCompanySubmit(e) {
    e.preventDefault();
    setSavingCompany(true);
    setCompanyDialogError(null);
    try {
      const body = { name: companyForm.name, code: companyForm.code };
      const saved = editCompanyId ? await api.put('/companies/' + editCompanyId, body) : await api.post('/companies', body);
      setToast('Company ' + saved.code + ' saved.');
      setCompanyDialogOpen(false);
      await load();
    } catch (err) {
      setCompanyDialogError(err.message);
    } finally {
      setSavingCompany(false);
    }
  }
  async function confirmDeleteCompany() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/companies/' + deleteCompanyTarget.id);
      setToast(deleteCompanyTarget.name + ' deleted.');
      setDeleteCompanyTarget(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  // Department dialog
  function openNewDept(companyId) {
    setDeptDialogError(null);
    setEditDeptId(null);
    setDeptForm({ ...EMPTY_DEPT_FORM, companyId: companyId || '' });
    setDeptDialogOpen(true);
  }
  function openEditDept(companyId, d) {
    setDeptDialogError(null);
    setEditDeptId(d.id);
    setDeptForm({ code: d.code, name: d.name, companyId, managerId: d.managerId || '' });
    setDeptDialogOpen(true);
  }
  async function handleDeptSubmit(e) {
    e.preventDefault();
    setSavingDept(true);
    setDeptDialogError(null);
    try {
      const body = { code: deptForm.code, name: deptForm.name, companyId: deptForm.companyId || undefined, managerId: deptForm.managerId || null };
      const saved = editDeptId ? await api.put('/departments/' + editDeptId, body) : await api.post('/departments', body);
      setToast('Department ' + saved.code + ' saved.');
      setDeptDialogOpen(false);
      await load();
    } catch (err) {
      setDeptDialogError(err.message);
    } finally {
      setSavingDept(false);
    }
  }
  async function confirmDeleteDept() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/departments/' + deleteDeptTarget.id);
      setToast(deleteDeptTarget.name + ' deleted.');
      setDeleteDeptTarget(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  // Shifts dialog (per department)
  async function openShifts(department) {
    setShiftForm(EMPTY_SHIFT_FORM);
    setEditShiftId(null);
    setShiftFormError(null);
    setShiftsDialog({ departmentId: department.id, departmentName: department.name, shifts: [], loading: true, error: null });
    try {
      const shifts = await api.get('/shifts?departmentId=' + department.id);
      setShiftsDialog({ departmentId: department.id, departmentName: department.name, shifts, loading: false, error: null });
    } catch (err) {
      setShiftsDialog({ departmentId: department.id, departmentName: department.name, shifts: [], loading: false, error: err.message });
    }
  }
  async function reloadShifts() {
    if (!shiftsDialog) return;
    try {
      const shifts = await api.get('/shifts?departmentId=' + shiftsDialog.departmentId);
      setShiftsDialog({ ...shiftsDialog, shifts, loading: false, error: null });
    } catch (err) {
      setShiftsDialog({ ...shiftsDialog, loading: false, error: err.message });
    }
  }
  function startEditShift(s) {
    setEditShiftId(s.id);
    setShiftForm({ name: s.name, startTime: s.startTime, endTime: s.endTime });
    setShiftFormError(null);
  }
  function cancelEditShift() {
    setEditShiftId(null);
    setShiftForm(EMPTY_SHIFT_FORM);
    setShiftFormError(null);
  }
  async function handleShiftSubmit(e) {
    e.preventDefault();
    setSavingShift(true);
    setShiftFormError(null);
    try {
      const body = { name: shiftForm.name, startTime: shiftForm.startTime, endTime: shiftForm.endTime, departmentId: shiftsDialog.departmentId };
      if (editShiftId) await api.put('/shifts/' + editShiftId, body);
      else await api.post('/shifts', body);
      setToast(editShiftId ? 'Shift updated.' : 'Shift added.');
      setEditShiftId(null);
      setShiftForm(EMPTY_SHIFT_FORM);
      await reloadShifts();
      await load();
    } catch (err) {
      setShiftFormError(err.message);
    } finally {
      setSavingShift(false);
    }
  }
  async function confirmDeleteShift() {
    setDeleting(true);
    setDialogError(null);
    try {
      await api.del('/shifts/' + deleteShiftTarget.id);
      setToast(deleteShiftTarget.name + ' deleted.');
      setDeleteShiftTarget(null);
      await reloadShifts();
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}
      <div className="departments-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search companies, departments, managers…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNewCompany}>Add company</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th /><th>Company</th><th>Departments</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleCompanies.map((c) => (
            <Fragment key={c.id}>
              <tr className="departments-company-row" onClick={() => toggleExpanded(c.id)}>
                <td className="departments-chevron-cell">
                  <span className={'departments-chevron ' + (expanded[c.id] ? 'departments-chevron-open' : '')}>›</span>
                </td>
                <td>
                  <div className="departments-name-cell">
                    <span className="departments-badge" style={{ background: avatarColor(c.name) }}><BuildingIcon /></span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      <div className="departments-description">{c.code}</div>
                    </div>
                  </div>
                </td>
                <td>{c.departments.length}</td>
                <td><span className={'tag ' + (c.status === 'active' ? 'tag-neutral' : 'tag-accent')}>{c.status === 'active' ? 'Active' : 'Archived'}</span></td>
                <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                  {canManage && <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => openEditCompany(c)}>Edit</button>}
                  {canManage && <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => openNewDept(c.id)}>+ Department</button>}
                  {canManage && c.departments.length === 0 && (
                    <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => { setDialogError(null); setDeleteCompanyTarget(c); }}>Delete</button>
                  )}
                </td>
              </tr>
              {expanded[c.id] && (
                <tr>
                  <td />
                  <td colSpan={4} className="departments-nested-cell">
                    {!c.departments.length && <p className="departments-nested-empty">No departments yet.</p>}
                    {!!c.departments.length && (
                      <table className="table departments-nested-table">
                        <thead>
                          <tr><th>Code</th><th>Department</th><th>Manager</th><th>Headcount</th><th>Shifts</th><th /></tr>
                        </thead>
                        <tbody>
                          {c.departments.map((d) => (
                            <tr key={d.id}>
                              <td>{d.code}</td>
                              <td style={{ fontWeight: 600 }}>{d.name}</td>
                              <td>
                                {d.managerName && d.managerName !== '—' ? (
                                  <div className="departments-manager-cell">
                                    <span className="departments-avatar" style={{ background: avatarColor(d.managerName) }}>{initials(d.managerName)}</span>
                                    {d.managerName}
                                  </div>
                                ) : '—'}
                              </td>
                              <td>{d.headcount}</td>
                              <td>
                                <button type="button" className="btn btn-secondary departments-row-btn departments-shifts-btn" onClick={() => openShifts(d)}>
                                  <ClockIcon /> {d.shiftCount} shift{d.shiftCount === 1 ? '' : 's'}
                                </button>
                              </td>
                              <td className="table-actions">
                                {canManage && <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => openEditDept(c.id, d)}>Edit</button>}
                                {canManage && d.headcount === 0 && (
                                  <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => { setDialogError(null); setDeleteDeptTarget(d); }}>Delete</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!companies.length && (
        <div className="departments-empty-state">
          <span className="departments-empty-icon"><PeopleIcon /></span>
          <p className="departments-empty-title">No companies yet</p>
        </div>
      )}
      {!!companies.length && !visibleCompanies.length && (
        <div className="departments-empty-state">
          <span className="departments-empty-icon"><PeopleIcon /></span>
          <p className="departments-empty-title">No companies match "{search}"</p>
        </div>
      )}

      {companyDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setCompanyDialogOpen(false)}>
          <form className="dialog departments-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleCompanySubmit}>
            <h2 className="departments-dialog-title">{editCompanyId ? 'Edit company' : 'Add company'}</h2>
            {companyDialogError && <div className="error-banner departments-dialog-span">{companyDialogError}</div>}
            <div className="field departments-dialog-span">
              <label htmlFor="company-name">Company name</label>
              <input id="company-name" className="input" value={companyForm.name} onChange={(e) => setCompanyForm({ ...companyForm, name: e.target.value })} placeholder="Bamboo Products Limited" required />
            </div>
            <div className="field">
              <label htmlFor="company-code">Code</label>
              <input id="company-code" className="input" maxLength={8} value={companyForm.code} onChange={(e) => setCompanyForm({ ...companyForm, code: e.target.value })} placeholder="BPL" required />
            </div>
            <div className="dialog-actions departments-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setCompanyDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingCompany}>{savingCompany ? 'Saving…' : (editCompanyId ? 'Save changes' : 'Create')}</button>
            </div>
          </form>
        </div>
      )}

      {deptDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDeptDialogOpen(false)}>
          <form className="dialog departments-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleDeptSubmit}>
            <h2 className="departments-dialog-title">{editDeptId ? 'Edit department' : 'Add department'}</h2>
            {deptDialogError && <div className="error-banner departments-dialog-span">{deptDialogError}</div>}
            <div className="field departments-dialog-span">
              <label htmlFor="dept-company">Company</label>
              <select id="dept-company" className="input" value={deptForm.companyId} onChange={(e) => setDeptForm({ ...deptForm, companyId: e.target.value })} required>
                <option value="" disabled>Select a company…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="dept-code">Code</label>
              <input id="dept-code" className="input" maxLength={5} value={deptForm.code} onChange={(e) => setDeptForm({ ...deptForm, code: e.target.value })} placeholder="PROD" required />
            </div>
            <div className="field">
              <label htmlFor="dept-name">Department name</label>
              <input id="dept-name" className="input" value={deptForm.name} onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })} placeholder="Productions" required />
            </div>
            <div className="field departments-dialog-span">
              <label htmlFor="dept-manager">Manager</label>
              <select id="dept-manager" className="input" value={deptForm.managerId} onChange={(e) => setDeptForm({ ...deptForm, managerId: e.target.value })}>
                <option value="">Unassigned</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="dialog-actions departments-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDeptDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingDept}>{savingDept ? 'Saving…' : (editDeptId ? 'Save changes' : 'Create')}</button>
            </div>
          </form>
        </div>
      )}

      {shiftsDialog && (
        <div className="dialog-backdrop" onClick={() => setShiftsDialog(null)}>
          <div className="dialog departments-shifts-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="departments-dialog-title">Shifts — {shiftsDialog.departmentName}</h2>
            {shiftsDialog.error && <div className="error-banner">{shiftsDialog.error}</div>}
            {shiftsDialog.loading ? (
              <div className="eyebrow">Loading…</div>
            ) : (
              <>
                {!shiftsDialog.shifts.length && <p className="departments-nested-empty">No shifts yet for this department.</p>}
                {!!shiftsDialog.shifts.length && (
                  <table className="table departments-shifts-table">
                    <thead>
                      <tr><th>Shift</th><th>Start</th><th>End</th><th>Assigned</th><th /></tr>
                    </thead>
                    <tbody>
                      {shiftsDialog.shifts.map((s) => (
                        <tr key={s.id}>
                          <td style={{ fontWeight: 600 }}>{s.name}</td>
                          <td>{s.startTime}</td>
                          <td>{s.endTime}</td>
                          <td>{s.assignedCount}</td>
                          <td className="table-actions">
                            {canManage && <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => startEditShift(s)}>Edit</button>}
                            {canManage && s.assignedCount === 0 && (
                              <button type="button" className="btn btn-secondary departments-row-btn" onClick={() => { setDialogError(null); setDeleteShiftTarget(s); }}>Delete</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {canManage && (
                  <form className="departments-shift-form" onSubmit={handleShiftSubmit}>
                    {shiftFormError && <div className="error-banner departments-dialog-span">{shiftFormError}</div>}
                    <div className="field">
                      <label htmlFor="shift-name">Shift name</label>
                      <input id="shift-name" className="input" maxLength={40} value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} placeholder="Day Shift" required />
                    </div>
                    <div className="field">
                      <label htmlFor="shift-start">Start time</label>
                      <input id="shift-start" className="input" type="time" value={shiftForm.startTime} onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })} required />
                    </div>
                    <div className="field">
                      <label htmlFor="shift-end">End time</label>
                      <input id="shift-end" className="input" type="time" value={shiftForm.endTime} onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })} required />
                    </div>
                    {editShiftId && <button type="button" className="btn btn-secondary" onClick={cancelEditShift}>Cancel</button>}
                    <button className="btn btn-primary" type="submit" disabled={savingShift}>
                      {savingShift ? 'Saving…' : (editShiftId ? 'Save changes' : '+ Add shift')}
                    </button>
                  </form>
                )}
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShiftsDialog(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {deleteCompanyTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteCompanyTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete company</h2>
            <p className="dialog-body">Delete <strong>{deleteCompanyTarget.name}</strong>? This cannot be undone.</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteCompanyTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteCompany}>
                {deleting ? 'Deleting…' : 'Delete company'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteDeptTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteDeptTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete department</h2>
            <p className="dialog-body">Delete <strong>{deleteDeptTarget.name}</strong>? This cannot be undone.</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteDeptTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteDept}>
                {deleting ? 'Deleting…' : 'Delete department'}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteShiftTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteShiftTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete shift</h2>
            <p className="dialog-body">Delete <strong>{deleteShiftTarget.name}</strong>? This cannot be undone.</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteShiftTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteShift}>
                {deleting ? 'Deleting…' : 'Delete shift'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
