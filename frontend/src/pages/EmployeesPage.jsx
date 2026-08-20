import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import EmployeeIdDocsDialog from '../components/EmployeeIdDocsDialog';
import EmployeeProfileDialog from '../components/EmployeeProfileDialog';
import './EmployeesPage.css';

// Ported from Bamboo OS.dc.html's employee directory screen (screens.people
// block) — search/department filter, show-terminated toggle, the
// add/edit employee dialog, and the terminate + purge-terminated
// confirmation dialogs.

function tagClass(status) {
  if (status === 'terminated') return 'tag-accent';
  if (status === 'active') return 'tag-neutral';
  return 'tag-outline';
}

const EMPLOYMENT_TYPES = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'contract', label: 'Contract' },
  { value: 'casual', label: 'Casual' },
  { value: 'intern', label: 'Intern' }
];

const EMPTY_EMPLOYEE_FORM = {
  firstName: '', lastName: '', email: '', phone: '', positionTitle: '',
  departmentId: '', managerId: '', hireDate: new Date().toISOString().slice(0, 10),
  employmentType: 'permanent', status: 'active', roleId: '', payCycle: 'monthly', dailyRate: 0
};

export default function EmployeesPage() {
  const { session, can } = useAuth();
  const canWrite = can('employee.write');
  const canPurge = can('role.manage');
  const canManagePayroll = can('payroll.manage');

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [managers, setManagers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [showTerminated, setShowTerminated] = useState(false);

  // Debounce the search box so typing doesn't fire a request per keystroke —
  // the prototype's synchronous in-memory kernel had no such cost.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const [dialog, setDialog] = useState(null); // 'employee' | 'terminate' | 'purge'
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_EMPLOYEE_FORM);
  const [terminateTarget, setTerminateTarget] = useState(null);
  const [termReason, setTermReason] = useState('');
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [idDocsTarget, setIdDocsTarget] = useState(null);
  const [profileTarget, setProfileTarget] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (deptFilter) params.set('departmentId', deptFilter);
      if (showTerminated) params.set('includeTerminated', 'true');
      const [people, depts] = await Promise.all([
        api.get('/employees?' + params.toString()),
        api.get('/departments')
      ]);
      setEmployees(people);
      setDepartments(depts);
      if (canWrite) {
        const [mgrs, roleList] = await Promise.all([api.get('/employees'), api.get('/roles')]);
        setManagers(mgrs.map((e) => ({ id: e.id, name: e.firstName + ' ' + e.lastName })));
        setRoles(roleList);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [q, deptFilter, showTerminated, canWrite]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function deptName(id) {
    const d = departments.find((x) => x.id === id);
    return d ? d.name : '—';
  }
  function empName(id) {
    const e = employees.find((x) => x.id === id) || managers.find((x) => x.id === id);
    return e ? (e.name || e.firstName + ' ' + e.lastName) : '—';
  }

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_EMPLOYEE_FORM);
    setDialog('employee');
  }

  function openEdit(emp) {
    setDialogError(null);
    setEditId(emp.id);
    setForm({
      firstName: emp.firstName, lastName: emp.lastName, email: emp.email, phone: emp.phone,
      positionTitle: emp.positionTitle, departmentId: emp.departmentId, managerId: emp.managerId || '',
      hireDate: emp.hireDate, employmentType: emp.employmentType, status: emp.status === 'terminated' ? 'active' : emp.status,
      roleId: '', payCycle: emp.payCycle || 'monthly', dailyRate: emp.dailyRate || 0
    });
    setDialog('employee');
  }

  async function submitEmployee(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) {
        const body = {
          firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone,
          positionTitle: form.positionTitle, departmentId: form.departmentId, managerId: form.managerId || null,
          employmentType: form.employmentType, status: form.status
        };
        if (canManagePayroll) {
          body.payCycle = form.payCycle;
          body.dailyRate = form.dailyRate;
        }
        const updated = await api.patch('/employees/' + editId, body);
        setToast('Updated ' + updated.firstName + ' ' + updated.lastName + '.');
      } else {
        const created = await api.post('/employees', {
          firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone,
          positionTitle: form.positionTitle, departmentId: form.departmentId, managerId: form.managerId || null,
          hireDate: form.hireDate, employmentType: form.employmentType,
          createAccount: !!form.roleId, roleId: form.roleId || null
        });
        setToast(created.code + ' — ' + created.firstName + ' ' + created.lastName + ' added.');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openTerminate(emp) {
    setDialogError(null);
    setTermReason('');
    setTerminateTarget(emp);
    setDialog('terminate');
  }

  async function confirmTerminate(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/employees/' + terminateTarget.id + '/terminate', { reason: termReason });
      setToast(terminateTarget.firstName + ' ' + terminateTarget.lastName + ' has been terminated.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmPurge() {
    setSaving(true);
    setDialogError(null);
    try {
      const result = await api.post('/employees/purge-terminated');
      setToast('Permanently removed ' + result.removed + ' employee record(s).');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const terminatedCount = employees.filter((e) => e.status === 'terminated').length;
  const footer = employees.length + ' record(s) visible to your role' +
    (can('employee.read.all') ? ' — company-wide access.' : ' — limited to your department and reporting line.');

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="employees-toolbar">
        <div className="field employees-search">
          <label htmlFor="emp-q">Search name, code, job title</label>
          <input id="emp-q" className="input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="e.g. operator" />
        </div>
        <div className="field employees-dept-filter">
          <label htmlFor="emp-dept">Department</label>
          <select id="emp-dept" className="input" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        {canWrite && <button type="button" className="btn btn-primary employees-add-btn" onClick={openNew}>Add employee</button>}
      </div>

      <div className="employees-options">
        <label className="employees-checkbox">
          <input type="checkbox" checked={showTerminated} onChange={(e) => setShowTerminated(e.target.checked)} />
          Show terminated employees
        </label>
        {canPurge && terminatedCount > 0 && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { setDialogError(null); setDialog('purge'); }}>
            Remove all deleted employees ({terminatedCount})
          </button>
        )}
      </div>

      <table className="table">
        <thead>
          <tr><th>Code</th><th>Name</th><th>Job title</th><th>Department</th><th>Reports to</th><th>Shift</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {employees.map((p) => {
            const canDelete = canWrite && p.status !== 'terminated' && p.id !== (session && session.employee && session.employee.id);
            return (
              <tr key={p.id}>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.code}</td>
                <td style={{ fontWeight: 600 }}>{p.firstName} {p.lastName}</td>
                <td>{p.positionTitle}</td>
                <td>{deptName(p.departmentId)}</td>
                <td>{p.managerId ? empName(p.managerId) : '—'}</td>
                <td className="employees-shift">{p.shift}</td>
                <td><span className={'tag ' + tagClass(p.status)}>{p.status}</span></td>
                <td className="table-actions">
                  <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => setProfileTarget(p.id)}>View</button>
                  {canWrite && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => openEdit(p)}>Edit</button>}
                  {canWrite && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => setIdDocsTarget(p)}>ID docs</button>}
                  {canDelete && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => openTerminate(p)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!employees.length && <p className="table-empty">No employees match this filter.</p>}
      <p className="employees-footer">{footer}</p>

      {dialog === 'employee' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog employees-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitEmployee}>
            <h2 className="employees-dialog-title">{editId ? 'Edit employee' : 'Add employee'}</h2>

            <div className="field"><label htmlFor="emp-fn">First name</label>
              <input id="emp-fn" className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-ln">Last name</label>
              <input id="emp-ln" className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-em">Work email</label>
              <input id="emp-em" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-ph">Phone</label>
              <input id="emp-ph" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="field"><label htmlFor="emp-jt">Job title</label>
              <input id="emp-jt" className="input" value={form.positionTitle} onChange={(e) => setForm({ ...form, positionTitle: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-dept-sel">Department</label>
              <select id="emp-dept-sel" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} required>
                <option value="" disabled>Choose a department</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-mgr">Reports to</label>
              <select id="emp-mgr" className="input" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
                <option value="">Unassigned</option>
                {managers.filter((m) => m.id !== editId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {!editId && (
              <div className="field"><label htmlFor="emp-hire">Hire date</label>
                <input id="emp-hire" className="input" type="date" value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} required />
              </div>
            )}
            <div className="field"><label htmlFor="emp-type">Employment type</label>
              <select id="emp-type" className="input" value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            {editId && (
              <div className="field"><label htmlFor="emp-status">Status</label>
                <select id="emp-status" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            )}
            {!editId && (
              <div className="field"><label htmlFor="emp-role">Create a login with role</label>
                <select id="emp-role" className="input" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                  <option value="">No system access</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            {editId && canManagePayroll && (
              <>
                <div className="field"><label htmlFor="emp-pay-cycle">Pay cycle</label>
                  <select id="emp-pay-cycle" className="input" value={form.payCycle} onChange={(e) => setForm({ ...form, payCycle: e.target.value })}>
                    <option value="monthly">Monthly (5th)</option>
                    <option value="biweekly">Biweekly</option>
                  </select>
                </div>
                <div className="field"><label htmlFor="emp-daily-rate">Daily rate (GHS)</label>
                  <input id="emp-daily-rate" className="input" type="number" min="0" step="0.01" value={form.dailyRate} onChange={(e) => setForm({ ...form, dailyRate: e.target.value })} />
                </div>
              </>
            )}

            {dialogError && <div className="error-banner employees-dialog-span">{dialogError}</div>}

            <div className="dialog-actions employees-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : (editId ? 'Save changes' : 'Create')}
              </button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'terminate' && terminateTarget && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmTerminate}>
            <h2>Delete employee</h2>
            <p className="dialog-body">
              This marks <strong>{terminateTarget.firstName} {terminateTarget.lastName}</strong> as terminated and
              disables their login. Their history (attendance, leave, tasks, documents) is kept for records — this
              does not permanently erase them.
            </p>
            <div className="field">
              <label htmlFor="term-reason">Reason (kept in the audit log)</label>
              <input id="term-reason" className="input" value={termReason} onChange={(e) => setTermReason(e.target.value)} placeholder="Resignation, end of contract…" />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Delete employee'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'purge' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Remove all deleted employees</h2>
            <p className="dialog-body">
              This permanently removes all {terminatedCount} terminated employee record(s) and their logins. Unlike
              deleting a single employee, this cannot be undone — their attendance, leave and task history will
              remain but will no longer show a name.
            </p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={confirmPurge}>
                {saving ? 'Removing…' : 'Remove permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {idDocsTarget && <EmployeeIdDocsDialog employee={idDocsTarget} onClose={() => setIdDocsTarget(null)} />}
      {profileTarget && <EmployeeProfileDialog employeeId={profileTarget} onClose={() => setProfileTarget(null)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
